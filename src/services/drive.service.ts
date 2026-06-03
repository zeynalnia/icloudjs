/**
 * Drive service — TypeScript port of `pyicloud/services/drive.py`
 * (`DriveService` + `DriveNode`), the modern iCloud **CloudDocs** storage.
 *
 * Plan §4.5 / §8.3 — load-bearing behaviour reproduced here:
 *
 *  - TWO base roots: `serviceRoot` (drivews — metadata/folder ops) and
 *    `documentRoot` (docws — download/upload).
 *  - `getNodeData` POSTs a JSON **array** body and reads index `[0]` of the
 *    response array.
 *  - The upload saga is THREE POSTs with DIFFERENT response shapes:
 *      1. reserve (`upload/web`) → response is an **ARRAY**; read `[0].document_id`
 *         and `[0].url`;
 *      2. upload to the reserved url (multipart) → response is an **OBJECT**;
 *         read `.singleFile` (the `sf_info`);
 *      3. commit (`update/documents`) → maps the EXACT `sf_info` keys (§8.3):
 *         `signature⇐fileChecksum`, `wrapping_key⇐wrappingKey`,
 *         `reference_signature⇐referenceChecksum`, `size⇐size`,
 *         `receipt⇐receipt` (OMITTED when falsy / size 0).
 *  - `Content-Type: text/plain` is MANDATORY on `upload/web`, `update/documents`
 *    and `createFolders` (iCloud rejects `application/json` there).
 *  - `open()` short-circuits 0-byte files to an EMPTY stream with NO HTTP call
 *    (iCloud 400s on a 0-byte `download/by_id`).
 *  - `_getTokenFromCookie()` scans the cookie jar for `X-APPLE-WEBAUTH-VALIDATE`
 *    and extracts the `t=` token via the regex `\bt=([^:]+)` (required for upload).
 *  - FIX #4: `DriveNode.upload(fileName, stream, size)` has an EXPLICIT signature
 *    (the Python `upload(**kwargs)` forwarded kwargs into a no-kwargs `send_file`,
 *    which would raise; here the signature is pinned and no kwargs leak).
 *
 * Node id conventions: folders `FOLDER::com.apple.CloudDocs::<guid|root>`
 * (`drivewsid`); files `FILE::com.apple.CloudDocs::<guid>`. `docwsid` is the bare
 * guid (`root`/`documents`/guid) used for download/upload/children-fetch; `etag`
 * (e.g. `32::2x`) is required for rename/delete (optimistic concurrency).
 */
import { Readable } from 'stream';
import * as path from 'path';

import { PyiCloudAPIResponseException } from '../exceptions/icloud.exceptions';
import { dateToUtc } from '../util/date';
import { IcloudHttpService } from '../session/icloud-http.service';

/** Raw CloudDocs node metadata returned by drivews. */
export interface DriveItem {
  drivewsid: string;
  docwsid?: string;
  zone?: string;
  name: string;
  parentId?: string;
  etag?: string;
  type?: string;
  extension?: string;
  size?: number;
  dateChanged?: string;
  dateModified?: string;
  dateCreated?: string;
  lastOpenTime?: string;
  status?: string;
  items?: DriveItem[];
  [key: string]: unknown;
}

/** Signed download-token block (`data_token` / `package_token`). */
interface DownloadToken {
  url?: string;
  [key: string]: unknown;
}

/** Response of `download/by_id` (signed CDN tokens). */
interface DownloadResponse {
  data_token?: DownloadToken;
  package_token?: DownloadToken;
  [key: string]: unknown;
}

/** The `singleFile` (`sf_info`) block returned by the reserved-url upload POST. */
interface SingleFileInfo {
  fileChecksum: string;
  wrappingKey: string;
  referenceChecksum: string;
  size: number;
  receipt?: string;
  [key: string]: unknown;
}

/**
 * The 'Drive' iCloud service (CloudDocs). Facade over the two base roots; lazily
 * builds and caches the root {@link DriveNode}, and proxies dir/get to it.
 */
export class DriveService {
  /** A private copy of the shared params bag (Python `dict(params)`). */
  private readonly params: Record<string, string>;

  /** Cached root node (lazy). */
  private _root?: DriveNode;

  constructor(
    private readonly serviceRoot: string,
    private readonly documentRoot: string,
    private readonly http: IcloudHttpService,
    params: Record<string, string>,
  ) {
    // Drive stores a COPY of params (matches Python `self.params = dict(params)`).
    this.params = { ...params };
  }

  // -------------------------------------------------------------------------
  // Metadata / folder operations (drivews)
  // -------------------------------------------------------------------------

  /**
   * Fetch a node's metadata. Body is a JSON **array** with a single entry; the
   * response is also an array and we return index `[0]`.
   */
  async getNodeData(nodeId: string): Promise<DriveItem> {
    const resp = await this.http.request<DriveItem[]>(
      'POST',
      `${this.serviceRoot}/retrieveItemDetailsInFolders`,
      {
        params: this.params,
        data: JSON.stringify([
          {
            drivewsid: `FOLDER::com.apple.CloudDocs::${nodeId}`,
            partialData: false,
          },
        ]),
      },
    );
    this.raiseIfError(resp.status);
    return resp.data[0];
  }

  /**
   * Download a file by document id. Two hops: first resolve the signed CDN
   * tokens via `download/by_id`, then stream the bytes from the
   * `data_token.url` (fallback `package_token.url`).
   */
  async getFile(fileId: string): Promise<Readable> {
    const resp = await this.http.request<DownloadResponse>(
      'GET',
      `${this.documentRoot}/ws/com.apple.CloudDocs/download/by_id`,
      { params: { ...this.params, document_id: fileId } },
    );
    this.raiseIfError(resp.status);

    const dataToken = resp.data.data_token;
    const packageToken = resp.data.package_token;
    const url = dataToken?.url ?? packageToken?.url;
    if (!url) {
      // Matches Python `KeyError("'data_token' nor 'package_token'")`.
      throw new Error("'data_token' nor 'package_token'");
    }

    const dl = await this.http.request<Readable>('GET', url, {
      params: this.params,
      responseType: 'stream',
    });
    return dl.data;
  }

  /** Return the app library (previously Ubiquity) — `retrieveAppLibraries`. */
  async getAppData(): Promise<DriveItem[]> {
    const resp = await this.http.request<{ items: DriveItem[] }>(
      'GET',
      `${this.serviceRoot}/retrieveAppLibraries`,
      { params: this.params },
    );
    this.raiseIfError(resp.status);
    return resp.data.items;
  }

  /** Create a new folder under `parent`. `text/plain` Content-Type is mandatory. */
  async createFolders(parent: string, name: string): Promise<unknown> {
    const resp = await this.http.request(
      'POST',
      `${this.serviceRoot}/createFolders`,
      {
        params: this.params,
        headers: { 'Content-Type': 'text/plain' },
        data: JSON.stringify({
          destinationDrivewsId: parent,
          folders: [{ clientId: this.params.clientId, name }],
        }),
      },
    );
    this.raiseIfError(resp.status);
    return resp.data;
  }

  /** Rename a node (optimistic concurrency via `etag`). */
  async renameItems(id: string, etag: string, name: string): Promise<unknown> {
    const resp = await this.http.request(
      'POST',
      `${this.serviceRoot}/renameItems`,
      {
        params: this.params,
        data: JSON.stringify({ items: [{ drivewsid: id, etag, name }] }),
      },
    );
    this.raiseIfError(resp.status);
    return resp.data;
  }

  /** Move a node to the trash bin (soft delete). */
  async moveItemsToTrash(id: string, etag: string): Promise<unknown> {
    const resp = await this.http.request(
      'POST',
      `${this.serviceRoot}/moveItemsToTrash`,
      {
        params: this.params,
        data: JSON.stringify({
          items: [{ drivewsid: id, etag, clientId: this.params.clientId }],
        }),
      },
    );
    this.raiseIfError(resp.status);
    return resp.data;
  }

  // -------------------------------------------------------------------------
  // Upload saga (docws) — THREE POSTs, two different response shapes (§4.5/§8.3)
  // -------------------------------------------------------------------------

  /**
   * Upload a new file into the folder identified by `folderId` (a docwsid).
   *
   * FIX #4 — explicit signature `(folderId, fileName, stream, size)`: no kwargs
   * leak into this method (the Python `DriveNode.upload(**kwargs)` forwarded
   * kwargs to a no-kwargs `send_file`).
   */
  async sendFile(
    folderId: string,
    fileName: string,
    stream: Readable,
    size: number,
  ): Promise<void> {
    // 1. Reserve an upload target (response is an ARRAY → read [0]).
    const [documentId, contentUrl] = await this.getUploadContentwsUrl(
      fileName,
      size,
    );

    // 2. Upload the bytes (multipart/form-data; boundary set automatically).
    //    Response is an OBJECT → read `.singleFile` (the sf_info).
    const sfInfo = await this.uploadToReservedUrl(contentUrl, fileName, stream);

    // 3. Commit.
    await this.updateContentws(folderId, sfInfo, documentId, fileName, size);
  }

  /**
   * Reserve a contentWS upload URL. POST `upload/web` with `text/plain`; the
   * response body is an **ARRAY** — read `[0].document_id` and `[0].url`.
   * Requires the `X-APPLE-WEBAUTH-VALIDATE` cookie token (merged into params).
   */
  private async getUploadContentwsUrl(
    fileName: string,
    size: number,
  ): Promise<[string, string]> {
    const contentType = guessContentType(fileName);

    const fileParams = {
      ...this.params,
      ...(await this.getTokenFromCookie()),
    };

    const resp = await this.http.request<
      Array<{ document_id: string; url: string }>
    >('POST', `${this.documentRoot}/ws/com.apple.CloudDocs/upload/web`, {
      params: fileParams,
      headers: { 'Content-Type': 'text/plain' },
      data: JSON.stringify({
        filename: fileName,
        type: 'FILE',
        content_type: contentType,
        size,
      }),
    });
    this.raiseIfError(resp.status);

    // Response body is an ARRAY; read index [0] (Python `request.json()[0]`).
    return [resp.data[0].document_id, resp.data[0].url];
  }

  /**
   * Upload the file bytes to the reserved URL as multipart/form-data. The
   * response body is an **OBJECT** — read `.singleFile` (the `sf_info` block
   * threaded into the commit step).
   */
  private async uploadToReservedUrl(
    contentUrl: string,
    fileName: string,
    stream: Readable,
  ): Promise<SingleFileInfo> {
    // The field name is the file name (matches Python `files={name: fobj}`).
    const form = new FormData();
    const buffer = await streamToBuffer(stream);
    form.append(
      fileName,
      new Blob([buffer]) as unknown as Blob,
      fileName,
    );

    const resp = await this.http.request<{ singleFile: SingleFileInfo }>(
      'POST',
      contentUrl,
      // No explicit Content-Type: the multipart boundary is set automatically.
      { data: form },
    );
    this.raiseIfError(resp.status);

    // Response body is an OBJECT; read `.singleFile` (Python `['singleFile']`).
    return resp.data.singleFile;
  }

  /**
   * Commit the uploaded file (`update/documents`, `text/plain`). The `data`
   * block maps the EXACT `sf_info` keys (§8.3); `receipt` is OMITTED when falsy
   * (0-byte files carry no receipt).
   */
  private async updateContentws(
    folderId: string,
    sfInfo: SingleFileInfo,
    documentId: string,
    fileName: string,
    size: number,
  ): Promise<unknown> {
    const now = Date.now();

    const data: Record<string, unknown> = {
      data: {
        signature: sfInfo.fileChecksum,
        wrapping_key: sfInfo.wrappingKey,
        reference_signature: sfInfo.referenceChecksum,
        size: sfInfo.size,
      },
      command: 'add_file',
      create_short_guid: true,
      document_id: documentId,
      path: {
        starting_document_id: folderId,
        path: fileName,
      },
      allow_conflict: true,
      file_flags: {
        is_writable: true,
        is_executable: false,
        is_hidden: false,
      },
      mtime: now,
      btime: now,
    };

    // §8.3 — receipt only when present (absent for 0-sized files). `size` is
    // passed through so callers can reason about the 0-byte case explicitly,
    // but the authoritative gate is the (falsy) receipt itself.
    if (sfInfo.receipt && size !== 0) {
      (data.data as Record<string, unknown>).receipt = sfInfo.receipt;
    }

    const resp = await this.http.request(
      'POST',
      `${this.documentRoot}/ws/com.apple.CloudDocs/update/documents`,
      {
        params: this.params,
        headers: { 'Content-Type': 'text/plain' },
        data: JSON.stringify(data),
      },
    );
    this.raiseIfError(resp.status);
    return resp.data;
  }

  // -------------------------------------------------------------------------
  // Root node + delegation
  // -------------------------------------------------------------------------

  /** Return the root node (lazy, cached). */
  async root(): Promise<DriveNode> {
    if (!this._root) {
      this._root = new DriveNode(this, await this.getNodeData('root'));
    }
    return this._root;
  }

  /** Convenience: list the root folder's child names (delegates to the root). */
  async dir(): Promise<string[] | null> {
    return (await this.root()).dir();
  }

  /** Convenience: fetch a root child node by name (delegates to the root). */
  async get(name: string): Promise<DriveNode> {
    return (await this.root()).get(name);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Extract the upload token from the `X-APPLE-WEBAUTH-VALIDATE` cookie. The
   * cookie value contains a `t=<token>` segment; we capture it with the regex
   * `\bt=([^:]+)`. Required for the upload reserve call.
   *
   * We scan the ENTIRE cookie jar (`getAllCookies`), not just the cookies
   * scoped to the docws host, mirroring the Python source which iterates
   * `self.session.cookies`. Apple sets this cookie on the home/login host
   * (e.g. www.icloud.com), not on the per-account docws host, so a
   * domain-filtered lookup against `documentRoot` would never find it.
   */
  private async getTokenFromCookie(): Promise<{ token: string }> {
    const cookies = await this.http.getAllCookies();
    for (const cookie of cookies) {
      if (cookie.key === 'X-APPLE-WEBAUTH-VALIDATE') {
        const match = /\bt=([^:]+)/.exec(cookie.value);
        if (!match) {
          throw new Error(
            'Could not extract upload token from X-APPLE-WEBAUTH-VALIDATE cookie (no t= segment)',
          );
        }
        return { token: match[1] };
      }
    }
    throw new Error('Token cookie not found');
  }

  /** Raise a typed API exception when the HTTP status is not ok (Python `_raise_if_error`). */
  private raiseIfError(status: number): void {
    if (status < 200 || status >= 400) {
      throw new PyiCloudAPIResponseException(`HTTP ${status}`, status);
    }
  }
}

/**
 * A node in the iCloud Drive tree (folder / file / app library). Wraps the raw
 * metadata, lazily fetches + caches children, and proxies operations back to
 * the {@link DriveService}.
 */
export class DriveNode {
  /** Cached children (lazy). */
  private _children?: DriveNode[];

  constructor(
    private readonly connection: DriveService,
    public data: DriveItem,
  ) {}

  /** The node name (`<name>.<extension>` when an extension is present). */
  get name(): string {
    if (this.data.extension !== undefined) {
      return `${this.data.name}.${this.data.extension}`;
    }
    return this.data.name;
  }

  /** The node type (lower-cased): `folder` / `file` / `app_library`. */
  get type(): string | undefined {
    const t = this.data.type;
    return t ? t.toLowerCase() : t;
  }

  /** The node size (folders have none → `undefined`). */
  get size(): number | undefined {
    const size = this.data.size;
    if (!size) {
      return undefined;
    }
    return Number(size);
  }

  /** The node changed date in UTC (folders have none → `null`). */
  get dateChanged(): Date | null {
    return dateToUtc(this.data.dateChanged);
  }

  /** The node modified date in UTC (folders have none → `null`). */
  get dateModified(): Date | null {
    return dateToUtc(this.data.dateModified);
  }

  /** The node last-open date in UTC (folders have none → `null`). */
  get dateLastOpen(): Date | null {
    return dateToUtc(this.data.lastOpenTime);
  }

  /**
   * Fetch (and cache) the node's children. If `items` is missing, fetch via
   * `getNodeData(docwsid)` and MERGE the result into `data`; if still missing,
   * throw mirroring Python's `KeyError("No items in folder, status: <status>")`.
   */
  async getChildren(): Promise<DriveNode[]> {
    if (!this._children) {
      if (!this.data.items) {
        const fetched = await this.connection.getNodeData(
          this.data.docwsid as string,
        );
        // Merge fetched fields into data (matches Python `self.data.update(...)`).
        Object.assign(this.data, fetched);
      }
      if (!this.data.items) {
        throw new Error(`No items in folder, status: ${this.data.status}`);
      }
      this._children = this.data.items.map(
        (item) => new DriveNode(this.connection, item),
      );
    }
    return this._children;
  }

  /** List child names; `null` for a file (matches Python). */
  async dir(): Promise<string[] | null> {
    if (this.type === 'file') {
      return null;
    }
    return (await this.getChildren()).map((child) => child.name);
  }

  /** Fetch a child node by name; throws when no such child exists. */
  async get(name: string): Promise<DriveNode> {
    if (this.type === 'file') {
      // Python returns None for files; here `get` on a file is a programming
      // error, so surface it as a thrown error to match the index-access path.
      throw new Error(`No child named '${name}' exists`);
    }
    const children = await this.getChildren();
    const match = children.find((child) => child.name === name);
    if (!match) {
      throw new Error(`No child named '${name}' exists`);
    }
    return match;
  }

  /**
   * Open the node's file as a stream.
   *
   * 0-byte short-circuit: when `size === 0` return an EMPTY stream with NO HTTP
   * call (iCloud returns 400 for a 0-byte `download/by_id`).
   */
  async open(): Promise<Readable> {
    if (this.data.size === 0) {
      return Readable.from([]);
    }
    return this.connection.getFile(this.data.docwsid as string);
  }

  /**
   * Upload a new file into this (folder) node.
   *
   * FIX #4 — EXPLICIT signature `(fileName, stream, size)`; no kwargs forwarded.
   */
  async upload(fileName: string, stream: Readable, size: number): Promise<void> {
    return this.connection.sendFile(
      this.data.docwsid as string,
      fileName,
      stream,
      size,
    );
  }

  /** Create a sub-folder under this node. */
  async mkdir(folder: string): Promise<unknown> {
    return this.connection.createFolders(this.data.drivewsid, folder);
  }

  /** Rename this node. */
  async rename(name: string): Promise<unknown> {
    return this.connection.renameItems(
      this.data.drivewsid,
      this.data.etag as string,
      name,
    );
  }

  /** Move this node to the trash bin (soft delete). */
  async delete(): Promise<unknown> {
    return this.connection.moveItemsToTrash(
      this.data.drivewsid,
      this.data.etag as string,
    );
  }
}

/**
 * Guess a file's content type from its extension. Mirrors Python
 * `mimetypes.guess_type(name)[0]`, defaulting to `''` when unknown.
 */
function guessContentType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const map: Record<string, string> = {
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.js': 'text/javascript',
    '.xml': 'text/xml',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.doc': 'application/msword',
    '.bin': 'application/octet-stream',
  };
  return map[ext] ?? '';
}

/** Collect a readable stream into a single Buffer (for the multipart upload). */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
