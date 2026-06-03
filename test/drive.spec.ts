/**
 * drive.spec.ts — DriveService + DriveNode (`src/services/drive.service.ts`).
 *
 * Mirrors the Python `tests/test_drive.py` assertions (root/folder/subfolder
 * dir listings, file metadata, 0-byte-style open) and adds the §4.5/§8.3
 * load-bearing checks that have no Python reference:
 *
 *  - root `dir()` === ['Keynote','Numbers','Pages','Preview','pyiCloud'];
 *  - subfolder `Test` === ['Document scanné 2.pdf','Scanned document 1.pdf'];
 *  - the `retrieveItemDetailsInFolders` body is a JSON ARRAY routed on
 *    `body[0].drivewsid`, and the response is read at index `[0]`;
 *  - `text/plain` Content-Type on `upload/web`, `update/documents`, `createFolders`;
 *  - the upload saga: reserve reads `[0].document_id`/`[0].url` (ARRAY response),
 *    the reserved-url upload reads `.singleFile` (OBJECT response), and the commit
 *    maps the EXACT sf_info keys and OMITS `receipt` when size === 0;
 *  - 0-byte `open()` makes NO HTTP call;
 *  - the cookie-token regex extracts `t=<token>` from `X-APPLE-WEBAUTH-VALIDATE`;
 *  - the 2-hop download streams CDN bytes.
 *
 * It runs the REAL authenticated `IcloudAuthService` against the wire-level mock
 * router, so the genuine HTTP chokepoint, params bag, and Drive parsing run.
 */
import { Readable } from 'stream';
import nock from 'nock';

import { DriveService } from '../src/services/drive.service';
import { IcloudHttpService } from '../src/session/icloud-http.service';
import { IcloudAuthService } from '../src/auth/icloud-auth.service';

import { installMockRouter, RESERVED_UPLOAD_URL } from './helpers/mock-router';
import { makeAuthService } from './helpers/make-service';
import { resetAuthState } from './helpers/auth-state';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * The first scanned PDF's name uses an NFD-decomposed accent (`e` + U+0301) in
 * the fixture, exactly as Apple returns it. Build it explicitly so the
 * comparison is independent of THIS source file's Unicode normalization form.
 */
const SCANNED_2 = 'Document scanné 2.pdf'.normalize('NFD');

const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  installMockRouter();
});

afterEach(async () => {
  nock.cleanAll();
  resetAuthState();
  while (cleanups.length) {
    const c = cleanups.pop();
    if (c) await c();
  }
});

/** Build an authenticated service and register its cleanup. */
async function auth(): Promise<IcloudAuthService> {
  const made = await makeAuthService();
  cleanups.push(made.cleanup);
  return made.service;
}

// ---------------------------------------------------------------------------
// 1. Root folder (mirrors test_drive.py::test_root)
// ---------------------------------------------------------------------------

describe('DriveService — root folder', () => {
  it('parses the root node and lists its children', async () => {
    const drive = (await auth()).drive;
    const root = await drive.root();

    expect(root.name).toBe('');
    expect(root.type).toBe('folder');
    expect(root.size).toBeUndefined();
    expect(root.dateChanged).toBeNull();
    expect(root.dateModified).toBeNull();
    expect(root.dateLastOpen).toBeNull();

    expect(await root.dir()).toEqual([
      'Keynote',
      'Numbers',
      'Pages',
      'Preview',
      'pyiCloud',
    ]);
  });

  it('exposes dir() via the service delegate', async () => {
    const drive = (await auth()).drive;
    expect(await drive.dir()).toEqual([
      'Keynote',
      'Numbers',
      'Pages',
      'Preview',
      'pyiCloud',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. App-library folder (mirrors test_folder_app)
// ---------------------------------------------------------------------------

describe('DriveService — Preview (app library)', () => {
  it('reads the app-library node but throws on dir() (ID_INVALID)', async () => {
    const drive = (await auth()).drive;
    const folder = await drive.get('Preview');

    expect(folder.name).toBe('Preview');
    expect(folder.type).toBe('app_library');
    expect(folder.size).toBeUndefined();

    // docwsid 'documents' routes to the ID_INVALID fixture (no items).
    await expect(folder.dir()).rejects.toThrow(
      'No items in folder, status: ID_INVALID',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Missing child (mirrors test_folder_not_exists)
// ---------------------------------------------------------------------------

describe('DriveService — missing child', () => {
  it('throws when a named child does not exist', async () => {
    const drive = (await auth()).drive;
    await expect(drive.get('not_exists')).rejects.toThrow(
      "No child named 'not_exists' exists",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Folder + subfolder (mirrors test_folder / test_subfolder)
// ---------------------------------------------------------------------------

describe('DriveService — pyiCloud folder + Test subfolder', () => {
  it('lists the pyiCloud folder', async () => {
    const drive = (await auth()).drive;
    const folder = await drive.get('pyiCloud');

    expect(folder.name).toBe('pyiCloud');
    expect(folder.type).toBe('folder');
    expect(folder.size).toBeUndefined();
    expect(await folder.dir()).toEqual(['Test']);
  });

  it('lists the Test subfolder === the two scanned PDFs', async () => {
    const drive = (await auth()).drive;
    const pyicloud = await drive.get('pyiCloud');
    const test = await pyicloud.get('Test');

    expect(test.name).toBe('Test');
    expect(test.type).toBe('folder');
    // Normalise the accented name to NFD on both sides (Apple returns NFD).
    const names = (await test.dir())!.map((n) => n.normalize('NFD'));
    expect(names).toEqual([SCANNED_2, 'Scanned document 1.pdf']);
  });
});

// ---------------------------------------------------------------------------
// 5. File metadata + dates (mirrors test_subfolder_file)
// ---------------------------------------------------------------------------

describe('DriveService — file node', () => {
  it('parses file size + UTC-normalised dates', async () => {
    const drive = (await auth()).drive;
    const test = await (await drive.get('pyiCloud')).get('Test');
    const file = await test.get('Scanned document 1.pdf');

    expect(file.name).toBe('Scanned document 1.pdf');
    expect(file.type).toBe('file');
    expect(file.size).toBe(21644358);

    // dateModified is already UTC (Z); dateChanged carries a -07:00 offset that
    // is subtracted to UTC (== modified + 1h here); lastOpenTime is Z.
    expect(file.dateModified?.toISOString()).toBe('2020-05-03T00:15:17.000Z');
    expect(file.dateChanged?.toISOString()).toBe('2020-05-03T00:16:17.000Z');
    expect(file.dateLastOpen?.toISOString()).toBe('2020-05-03T00:24:25.000Z');

    // dir() on a file is null.
    expect(await file.dir()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Download — 2 hops (mirrors test_file_open)
// ---------------------------------------------------------------------------

describe('DriveService — download (2-hop)', () => {
  it('resolves the signed CDN token then streams the bytes', async () => {
    const drive = (await auth()).drive;
    const file = await (
      await (await drive.get('pyiCloud')).get('Test')
    ).get('Scanned document 1.pdf');

    const stream = await file.open();
    const bytes = await streamToString(stream);
    expect(bytes).toBe('pdf-bytes');
  });
});

// ---------------------------------------------------------------------------
// 7. 0-byte open() — NO HTTP call
// ---------------------------------------------------------------------------

describe('DriveNode.open — 0-byte short-circuit', () => {
  it('returns an empty stream WITHOUT any HTTP request', async () => {
    const drive = (await auth()).drive;
    const test = await (await drive.get('pyiCloud')).get('Test');
    const zeroNode = await test.get(SCANNED_2);
    // Force the size to 0 to exercise the short-circuit deterministically.
    (zeroNode as unknown as { data: { size: number } }).data.size = 0;

    // Spy on the HTTP chokepoint: open() on a 0-byte node must NOT call it.
    const http = (drive as unknown as { http: IcloudHttpService }).http;
    const reqSpy = jest.spyOn(http, 'request');

    const stream = await zeroNode.open();
    const bytes = await streamToString(stream);
    expect(bytes).toBe('');
    expect(reqSpy).not.toHaveBeenCalled();

    reqSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 8. Array body routing + index-[0] response (retrieveItemDetailsInFolders)
// ---------------------------------------------------------------------------

describe('DriveService — getNodeData array body', () => {
  it('sends a JSON ARRAY body and reads response index [0]', async () => {
    const drive = (await auth()).drive;
    const http = (drive as unknown as { http: IcloudHttpService }).http;
    const reqSpy = jest.spyOn(http, 'request');

    const node = await drive.getNodeData('root');
    expect(node.drivewsid).toBe('FOLDER::com.apple.CloudDocs::root');

    const call = reqSpy.mock.calls.find(
      ([, url]) =>
        typeof url === 'string' && url.includes('retrieveItemDetailsInFolders'),
    );
    expect(call).toBeDefined();
    const body = JSON.parse((call![2] as { data: string }).data);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].drivewsid).toBe('FOLDER::com.apple.CloudDocs::root');
    expect(body[0].partialData).toBe(false);

    reqSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 9. Upload saga — ARRAY reserve, OBJECT singleFile, text/plain, sf_info mapping
// ---------------------------------------------------------------------------

describe('DriveService — sendFile upload saga', () => {
  it('reserves [0], reads .singleFile, commits with text/plain + sf_info keys', async () => {
    const service = await auth();
    seedValidateCookie(service);
    const drive = service.drive;
    const http = (drive as unknown as { http: IcloudHttpService }).http;
    const reqSpy = jest.spyOn(http, 'request');

    await drive.sendFile(
      'documents',
      'hello.txt',
      Readable.from([Buffer.from('hello world')]),
      11,
    );

    const calls = reqSpy.mock.calls;

    // Reserve POST: text/plain, body has filename/type/size.
    const reserve = calls.find(
      ([, u]) => typeof u === 'string' && u.includes('upload/web'),
    )!;
    expect(reserve).toBeDefined();
    expect((reserve[2] as { headers: Record<string, string> }).headers['Content-Type']).toBe(
      'text/plain',
    );
    const reserveBody = JSON.parse((reserve[2] as { data: string }).data);
    expect(reserveBody.filename).toBe('hello.txt');
    expect(reserveBody.type).toBe('FILE');
    expect(reserveBody.size).toBe(11);

    // Upload POST to the reserved url (multipart — no text/plain header).
    const upload = calls.find(
      ([, u]) => typeof u === 'string' && u.includes('_reserved_upload_target'),
    );
    expect(upload).toBeDefined();

    // Commit POST: text/plain, sf_info keys mapped exactly, receipt present (size!=0).
    const commit = calls.find(
      ([, u]) => typeof u === 'string' && u.includes('update/documents'),
    )!;
    expect(commit).toBeDefined();
    expect((commit[2] as { headers: Record<string, string> }).headers['Content-Type']).toBe(
      'text/plain',
    );
    const commitBody = JSON.parse((commit[2] as { data: string }).data);
    expect(commitBody.command).toBe('add_file');
    expect(commitBody.document_id).toBe('UPLOADED_DOC_ID');
    expect(commitBody.path.starting_document_id).toBe('documents');
    expect(commitBody.path.path).toBe('hello.txt');
    // §8.3 — exact key mapping from singleFile (sf_info).
    expect(commitBody.data.signature).toBe('file_checksum');
    expect(commitBody.data.wrapping_key).toBe('wrapping_key==');
    expect(commitBody.data.reference_signature).toBe('reference_checksum');
    expect(commitBody.data.size).toBe(42);
    expect(commitBody.data.receipt).toBe('receipt');

    reqSpy.mockRestore();
  });

  it('OMITS receipt from the commit body when size === 0', async () => {
    const service = await auth();
    seedValidateCookie(service);
    const drive = service.drive;
    const http = (drive as unknown as { http: IcloudHttpService }).http;

    // Override the reserved-url upload to return a 0-byte singleFile (no receipt).
    const origRequest = http.request.bind(http);
    const reqSpy = jest
      .spyOn(http, 'request')
      .mockImplementation(async (method, url, opts) => {
        if (typeof url === 'string' && url.includes('_reserved_upload_target')) {
          return {
            status: 200,
            data: {
              singleFile: {
                fileChecksum: 'c0',
                wrappingKey: 'w0',
                referenceChecksum: 'r0',
                size: 0,
              },
            },
          } as never;
        }
        return origRequest(method, url, opts);
      });

    await drive.sendFile(
      'documents',
      'empty.txt',
      Readable.from([]),
      0,
    );

    const commit = reqSpy.mock.calls.find(
      ([, u]) => typeof u === 'string' && u.includes('update/documents'),
    )!;
    const commitBody = JSON.parse((commit[2] as { data: string }).data);
    expect(commitBody.data.size).toBe(0);
    expect('receipt' in commitBody.data).toBe(false);

    reqSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 10. createFolders — text/plain + clientId from params
// ---------------------------------------------------------------------------

describe('DriveService — createFolders', () => {
  it('sends text/plain and includes the clientId from params', async () => {
    const service = await auth();
    const drive = service.drive;
    const http = (drive as unknown as { http: IcloudHttpService }).http;
    const reqSpy = jest.spyOn(http, 'request');

    await drive.createFolders('FOLDER::com.apple.CloudDocs::root', 'NewFolder');

    const call = reqSpy.mock.calls.find(
      ([, u]) => typeof u === 'string' && u.includes('createFolders'),
    )!;
    expect((call[2] as { headers: Record<string, string> }).headers['Content-Type']).toBe(
      'text/plain',
    );
    const body = JSON.parse((call[2] as { data: string }).data);
    expect(body.destinationDrivewsId).toBe('FOLDER::com.apple.CloudDocs::root');
    expect(body.folders[0].name).toBe('NewFolder');
    // clientId is populated by IcloudAuthService.populateParams (FIX #1).
    expect(body.folders[0].clientId).toBe(service.params.clientId);
    expect(body.folders[0].clientId).toBeTruthy();

    reqSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 11. cookie-token regex (_getTokenFromCookie)
// ---------------------------------------------------------------------------

describe('DriveService — cookie token extraction', () => {
  it('extracts the t=<token> from X-APPLE-WEBAUTH-VALIDATE on upload reserve', async () => {
    const service = await auth();
    seedValidateCookie(service, 'extracted-token-123');
    const drive = service.drive;
    const http = (drive as unknown as { http: IcloudHttpService }).http;
    const reqSpy = jest.spyOn(http, 'request');

    await drive.sendFile(
      'documents',
      'tok.txt',
      Readable.from([Buffer.from('x')]),
      1,
    );

    const reserve = reqSpy.mock.calls.find(
      ([, u]) => typeof u === 'string' && u.includes('upload/web'),
    )!;
    const params = (reserve[2] as { params: Record<string, string> }).params;
    expect(params.token).toBe('extracted-token-123');

    reqSpy.mockRestore();
  });

  it('extracts the token when the validate cookie is scoped to the HOME host (not docws)', async () => {
    // Apple sets X-APPLE-WEBAUTH-VALIDATE on www.icloud.com, NOT on the
    // per-account docws host. The token scan must walk the whole jar
    // (mirroring Python's `for cookie in self.session.cookies`), so a docws
    // upload still finds it.
    const service = await auth();
    seedValidateCookieOnHome(service, 'home-scoped-token-456');
    const drive = service.drive;
    const http = (drive as unknown as { http: IcloudHttpService }).http;
    const reqSpy = jest.spyOn(http, 'request');

    await drive.sendFile(
      'documents',
      'home.txt',
      Readable.from([Buffer.from('y')]),
      1,
    );

    const reserve = reqSpy.mock.calls.find(
      ([, u]) => typeof u === 'string' && u.includes('upload/web'),
    )!;
    const params = (reserve[2] as { params: Record<string, string> }).params;
    expect(params.token).toBe('home-scoped-token-456');

    reqSpy.mockRestore();
  });

  it('throws when the validate cookie is absent', async () => {
    const service = await auth();
    const drive = service.drive;
    await expect(
      drive.sendFile('documents', 'x.txt', Readable.from([]), 0),
    ).rejects.toThrow('Token cookie not found');
  });
});

// ---------------------------------------------------------------------------
// 12. rename / delete bodies
// ---------------------------------------------------------------------------

describe('DriveService — rename / moveToTrash', () => {
  it('renameItems sends drivewsid + etag + name', async () => {
    const drive = (await auth()).drive;
    const http = (drive as unknown as { http: IcloudHttpService }).http;
    const reqSpy = jest.spyOn(http, 'request');

    await drive.renameItems('FILE::com.apple.CloudDocs::abc', '32::2x', 'new');

    const call = reqSpy.mock.calls.find(
      ([, u]) => typeof u === 'string' && u.includes('renameItems'),
    )!;
    const body = JSON.parse((call[2] as { data: string }).data);
    expect(body.items[0]).toEqual({
      drivewsid: 'FILE::com.apple.CloudDocs::abc',
      etag: '32::2x',
      name: 'new',
    });
    reqSpy.mockRestore();
  });

  it('moveItemsToTrash sends drivewsid + etag + clientId', async () => {
    const service = await auth();
    const drive = service.drive;
    const http = (drive as unknown as { http: IcloudHttpService }).http;
    const reqSpy = jest.spyOn(http, 'request');

    await drive.moveItemsToTrash('FILE::com.apple.CloudDocs::abc', '32::2x');

    const call = reqSpy.mock.calls.find(
      ([, u]) => typeof u === 'string' && u.includes('moveItemsToTrash'),
    )!;
    const body = JSON.parse((call[2] as { data: string }).data);
    expect(body.items[0].drivewsid).toBe('FILE::com.apple.CloudDocs::abc');
    expect(body.items[0].etag).toBe('32::2x');
    expect(body.items[0].clientId).toBe(service.params.clientId);
    reqSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed the `X-APPLE-WEBAUTH-VALIDATE` cookie (carries the upload `t=` token). */
function seedValidateCookie(
  service: IcloudAuthService,
  token = 'reservedupload',
): void {
  const http = (service as unknown as { http: IcloudHttpService }).http;
  const store = (
    http as unknown as { store: { jar: { setCookieSync: (c: string, u: string) => void } } }
  ).store;
  // docws host (the upload reserve targets documentRoot).
  store.jar.setCookieSync(
    `X-APPLE-WEBAUTH-VALIDATE="v=1:t=${token}:other"; Domain=p31-docws.icloud.com; Path=/`,
    'https://p31-docws.icloud.com:443',
  );
}

/**
 * Seed the `X-APPLE-WEBAUTH-VALIDATE` cookie on the HOME/login host
 * (www.icloud.com) — the way Apple actually scopes it in production. This
 * cookie is NOT scoped to the per-account docws host, so a domain-filtered
 * lookup against documentRoot would miss it; the token scan must walk the
 * whole jar.
 */
function seedValidateCookieOnHome(
  service: IcloudAuthService,
  token = 'reservedupload',
): void {
  const http = (service as unknown as { http: IcloudHttpService }).http;
  const store = (
    http as unknown as { store: { jar: { setCookieSync: (c: string, u: string) => void } } }
  ).store;
  store.jar.setCookieSync(
    `X-APPLE-WEBAUTH-VALIDATE="v=1:t=${token}:other"; Domain=www.icloud.com; Path=/`,
    'https://www.icloud.com',
  );
}

/** Read a Readable stream into a UTF-8 string. */
async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// Mark RESERVED_UPLOAD_URL as referenced (documents the reserved target host).
void RESERVED_UPLOAD_URL;
void DriveService;
