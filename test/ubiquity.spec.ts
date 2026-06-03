/**
 * ubiquity.spec.ts — UbiquityService + UbiquityNode
 * (`src/services/ubiquity.service.ts`), the legacy read-only file store.
 *
 * No Python test fixture exists for Ubiquity, so this is a self-contained
 * wire-level test (real {@link IcloudHttpService} over nock) asserting the
 * plan §4.5 contract:
 *
 *  - INTEGER node ids; the root node id is `0`;
 *  - URL template `{serviceRoot}/ws/{dsid}/{variant}/{nodeId}` with `dsid` taken
 *    from the shared params bag and `variant` ∈ {item, parent, file};
 *  - `getChildren` reads `{ item_list: [...] }`;
 *  - node `modified` parses `%Y-%m-%dT%H:%M:%SZ` (UTC);
 *  - `dir()` / `get(name)` / `open()` (file stream).
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import nock from 'nock';

import { SessionStore } from '../src/session/session-store';
import {
  Endpoints,
  IcloudHttpService,
} from '../src/session/icloud-http.service';
import {
  UbiquityNode,
  UbiquityService,
} from '../src/services/ubiquity.service';

// ---------------------------------------------------------------------------
// Constants / fixtures
// ---------------------------------------------------------------------------

const HOST = 'https://p31-ubiquityws.icloud.test';
const SERVICE_ROOT = `${HOST}:443`;
const DSID = '123456789';

const ORIGIN = 'https://www.icloud.com';
const ENDPOINTS: Endpoints = {
  AUTH: 'https://idmsa.apple.com/appleauth/auth',
  HOME: ORIGIN,
  SETUP: 'https://setup.icloud.com/setup/ws/1',
};
const DEFAULT_HEADERS = { Origin: ORIGIN, Referer: `${ORIGIN}/` };

/** Root node (id 0). */
const ROOT_NODE = {
  item_id: 0,
  name: 'mobile.documents',
  type: 'folder',
  modified: '2020-04-27T21:37:36Z',
};

/** Root children (`item_list`). */
const ROOT_CHILDREN = {
  item_list: [
    {
      item_id: 1,
      name: 'Documents',
      type: 'folder',
      modified: '2020-04-27T21:37:36Z',
    },
    {
      item_id: 2,
      name: 'notes.txt',
      type: 'file',
      size: '128',
      modified: '2020-05-03T00:15:17Z',
    },
  ],
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

afterEach(async () => {
  nock.cleanAll();
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** Build an HTTP service backed by a fresh temp cookie store. */
async function makeHttp(): Promise<IcloudHttpService> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsicloud-ubiq-'));
  tmpDirs.push(dir);
  const store = await SessionStore.load(dir, 'tester');
  return new IcloudHttpService(store, ENDPOINTS, DEFAULT_HEADERS);
}

/** Build a UbiquityService with the standard params bag (dsid populated). */
async function makeService(): Promise<UbiquityService> {
  const http = await makeHttp();
  return new UbiquityService(SERVICE_ROOT, http, { dsid: DSID });
}

/** Install the canned Ubiquity routes for this host. */
function mockUbiquity(): nock.Scope {
  const scope = nock(SERVICE_ROOT).persist();
  scope.get(`/ws/${DSID}/item/0`).reply(200, ROOT_NODE);
  scope.get(`/ws/${DSID}/parent/0`).reply(200, ROOT_CHILDREN);
  scope.get(`/ws/${DSID}/parent/1`).reply(200, { item_list: [] });
  scope
    .get(`/ws/${DSID}/file/2`)
    .reply(200, () => Readable.from(Buffer.from('note-bytes')));
  return scope;
}

// ---------------------------------------------------------------------------
// 1. Root node + integer ids
// ---------------------------------------------------------------------------

describe('UbiquityService — root node', () => {
  it('fetches the root via the integer id 0 and the dsid in the path', async () => {
    mockUbiquity();
    const svc = await makeService();

    const root = await svc.root();
    expect(root).toBeInstanceOf(UbiquityNode);
    expect(root.itemId).toBe(0);
    expect(root.name).toBe('mobile.documents');
    expect(root.type).toBe('folder');
  });

  it('builds node URLs from the {dsid}/{variant}/{nodeId} template', async () => {
    const svc = await makeService();
    expect(svc.getNodeUrl(0)).toBe(`${SERVICE_ROOT}/ws/${DSID}/item/0`);
    expect(svc.getNodeUrl(5, 'parent')).toBe(
      `${SERVICE_ROOT}/ws/${DSID}/parent/5`,
    );
    expect(svc.getNodeUrl(7, 'file')).toBe(`${SERVICE_ROOT}/ws/${DSID}/file/7`);
  });
});

// ---------------------------------------------------------------------------
// 2. Children (item_list) + dir / get
// ---------------------------------------------------------------------------

describe('UbiquityService — children', () => {
  it('parses the item_list into UbiquityNodes', async () => {
    mockUbiquity();
    const svc = await makeService();

    const children = await svc.getChildren(0);
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.name)).toEqual(['Documents', 'notes.txt']);
    expect(children[0].itemId).toBe(1);
    expect(children[1].itemId).toBe(2);
  });

  it('lists root child names via dir()', async () => {
    mockUbiquity();
    const svc = await makeService();
    expect(await svc.dir()).toEqual(['Documents', 'notes.txt']);
  });

  it('fetches a child by name via get()', async () => {
    mockUbiquity();
    const svc = await makeService();
    const file = await svc.get('notes.txt');
    expect(file.itemId).toBe(2);
    expect(file.type).toBe('file');
  });

  it('throws on a missing child name', async () => {
    mockUbiquity();
    const svc = await makeService();
    await expect(svc.get('nope')).rejects.toThrow('No child named nope exists');
  });
});

// ---------------------------------------------------------------------------
// 3. Node metadata: size + modified date
// ---------------------------------------------------------------------------

describe('UbiquityNode — metadata', () => {
  it('parses size as a number and modified as a UTC Date', async () => {
    mockUbiquity();
    const svc = await makeService();
    const root = await svc.root();
    const file = (await root.getChildren()).find((c) => c.name === 'notes.txt')!;

    expect(file.size).toBe(128);
    expect(file.modified?.toISOString()).toBe('2020-05-03T00:15:17.000Z');
  });

  it('returns null size when unparseable / absent', async () => {
    const node = new UbiquityNode(await makeService(), {
      item_id: 9,
      name: 'x',
    });
    expect(node.size).toBeNull();
  });

  it('parses the root modified date', async () => {
    mockUbiquity();
    const svc = await makeService();
    const root = await svc.root();
    expect(root.modified?.toISOString()).toBe('2020-04-27T21:37:36.000Z');
  });
});

// ---------------------------------------------------------------------------
// 4. File streaming (file variant)
// ---------------------------------------------------------------------------

describe('UbiquityNode — open (file stream)', () => {
  it('streams the node bytes via the file variant url', async () => {
    mockUbiquity();
    const svc = await makeService();
    const file = await svc.get('notes.txt');

    const stream = await file.open();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString('utf-8')).toBe('note-bytes');
  });
});

// ---------------------------------------------------------------------------
// 5. Caching: root + children fetched once
// ---------------------------------------------------------------------------

describe('UbiquityService — caching', () => {
  it('caches the root node and children across calls', async () => {
    mockUbiquity();
    const svc = await makeService();
    const http = (svc as unknown as { http: IcloudHttpService }).http;
    const reqSpy = jest.spyOn(http, 'request');

    const root1 = await svc.root();
    const root2 = await svc.root();
    expect(root1).toBe(root2);

    await root1.getChildren();
    await root1.getChildren();

    const itemCalls = reqSpy.mock.calls.filter(
      ([, u]) => typeof u === 'string' && u.includes('/item/0'),
    );
    const parentCalls = reqSpy.mock.calls.filter(
      ([, u]) => typeof u === 'string' && u.includes('/parent/0'),
    );
    expect(itemCalls).toHaveLength(1);
    expect(parentCalls).toHaveLength(1);

    reqSpy.mockRestore();
  });
});
