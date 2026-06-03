/**
 * Ubiquity service — TypeScript port of `pyicloud/services/ubiquity.py`
 * (`UbiquityService` + `UbiquityNode`), the LEGACY read-only iCloud file store.
 *
 * Kept entirely separate from Drive's CloudDocs guid scheme (plan §4.5):
 *
 *  - Node ids are INTEGERS; the root node id is `0`.
 *  - URL template: `{serviceRoot}/ws/{dsid}/{variant}/{nodeId}` where `variant`
 *    is `item` (metadata), `parent` (children) or `file` (bytes). `dsid` is read
 *    from the shared `params` bag (populated by `IcloudAuthService.populateParams`).
 *  - `getChildren` reads `{ item_list: [...] }`.
 *  - Node `modified` parses the `%Y-%m-%dT%H:%M:%SZ` (always-UTC) format.
 *
 * Read-only: there are no create/rename/delete operations.
 */
import { Readable } from 'stream';

import { parseUbiquityDate } from '../util/date';
import { IcloudHttpService } from '../session/icloud-http.service';

/** Raw Ubiquity node metadata. */
export interface UbiquityItem {
  item_id?: number;
  name?: string;
  type?: string;
  size?: string | number;
  modified?: string;
  [key: string]: unknown;
}

/**
 * The 'Ubiquity' iCloud service (legacy, read-only). Lazily builds and caches
 * the root {@link UbiquityNode}, and proxies dir/get to it.
 */
export class UbiquityService {
  /** URL template `{serviceRoot}/ws/{dsid}/{variant}/{nodeId}`. */
  private readonly nodeUrl: string;

  /** Cached root node (lazy). */
  private _root?: UbiquityNode;

  constructor(
    serviceRoot: string,
    private readonly http: IcloudHttpService,
    private readonly params: Record<string, string>,
  ) {
    this.nodeUrl = `${serviceRoot}/ws/%s/%s/%s`;
  }

  /** Build a node URL for the given id + variant (`item` / `parent` / `file`). */
  getNodeUrl(nodeId: number, variant: 'item' | 'parent' | 'file' = 'item'): string {
    return this.nodeUrl
      .replace('%s', this.params.dsid)
      .replace('%s', variant)
      .replace('%s', String(nodeId));
  }

  /** Fetch a node's metadata. */
  async getNode(nodeId: number): Promise<UbiquityNode> {
    const resp = await this.http.request<UbiquityItem>(
      'GET',
      this.getNodeUrl(nodeId, 'item'),
    );
    return new UbiquityNode(this, resp.data);
  }

  /** Fetch a node's children (`{ item_list: [...] }`). */
  async getChildren(nodeId: number): Promise<UbiquityNode[]> {
    const resp = await this.http.request<{ item_list: UbiquityItem[] }>(
      'GET',
      this.getNodeUrl(nodeId, 'parent'),
    );
    return resp.data.item_list.map((item) => new UbiquityNode(this, item));
  }

  /** Stream a node's file bytes. */
  async getFile(nodeId: number): Promise<Readable> {
    const resp = await this.http.request<Readable>(
      'GET',
      this.getNodeUrl(nodeId, 'file'),
      { responseType: 'stream' },
    );
    return resp.data;
  }

  /** Return the root node (id `0`); lazy + cached. */
  async root(): Promise<UbiquityNode> {
    if (!this._root) {
      this._root = await this.getNode(0);
    }
    return this._root;
  }

  /** Convenience: list the root's child names (delegates to the root). */
  async dir(): Promise<string[]> {
    return (await this.root()).dir();
  }

  /** Convenience: fetch a root child node by name (delegates to the root). */
  async get(name: string): Promise<UbiquityNode> {
    return (await this.root()).get(name);
  }
}

/** A node in the legacy Ubiquity tree. Wraps raw metadata; children lazy + cached. */
export class UbiquityNode {
  /** Cached children (lazy). */
  private _children?: UbiquityNode[];

  constructor(
    private readonly connection: UbiquityService,
    public data: UbiquityItem,
  ) {}

  /** The integer node id. */
  get itemId(): number | undefined {
    return this.data.item_id;
  }

  /** The node name. */
  get name(): string | undefined {
    return this.data.name;
  }

  /** The node type. */
  get type(): string | undefined {
    return this.data.type;
  }

  /** The node size (parsed to a number; `null` when unparseable). */
  get size(): number | null {
    const n = Number(this.data.size);
    return Number.isNaN(n) ? null : n;
  }

  /** The node modified date (`%Y-%m-%dT%H:%M:%SZ`, always UTC). */
  get modified(): Date | null {
    return parseUbiquityDate(this.data.modified);
  }

  /** Stream this node's file bytes. */
  async open(): Promise<Readable> {
    return this.connection.getFile(this.itemId as number);
  }

  /** Fetch (and cache) this node's children. */
  async getChildren(): Promise<UbiquityNode[]> {
    if (!this._children) {
      this._children = await this.connection.getChildren(this.itemId as number);
    }
    return this._children;
  }

  /** List child names. */
  async dir(): Promise<string[]> {
    return (await this.getChildren()).map((child) => child.name as string);
  }

  /** Fetch a child node by name; throws when no such child exists. */
  async get(name: string): Promise<UbiquityNode> {
    const children = await this.getChildren();
    const match = children.find((child) => child.name === name);
    if (!match) {
      throw new Error(`No child named ${name} exists`);
    }
    return match;
  }
}
