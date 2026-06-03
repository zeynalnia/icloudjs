/**
 * nock-based mock router mirroring the Python test session mock
 * (`tests/__init__.py::PyiCloudSessionMock`) at the WIRE level. Unlike the
 * Python mock (which subclasses the session and cheats by mutating
 * `session_data` directly), this intercepts real HTTP so the ported
 * `authenticate()` / parsing / header-harvesting code is genuinely exercised.
 *
 * Contract reproduced exactly (see ARCHITECTURE_MAP §6.2 / plan §5.1, §5.4):
 *  - Match on substring-in-URL + exact method (host-agnostic, like Python).
 *  - Ordering: `validateVerificationCode` is checked BEFORE `validate`
 *    (substring overlap).
 *  - Drive `retrieveItemDetailsInFolders` sends a JSON ARRAY body; route on
 *    `body[0].drivewsid`.
 *  - Drive `upload/web` replies an ARRAY (`[{document_id,url}]`); the reserved
 *    upload url replies an OBJECT (`{singleFile:{…}}`).
 *  - Auth responses return the five harvested X-Apple-* headers + `scnt`.
 *  - `securitycode` and `2sv/trust` reply 204.
 *  - China hosts (`.com.cn`) match because routing is path-based.
 *  - Unmatched route → THROW `Unexpected request: METHOD URL` (fixes the
 *    Python latent bug where the mock returns `None`).
 *
 * Usage:
 *   beforeEach(() => installMockRouter());
 *   afterEach(() => { nock.cleanAll(); resetAuthState(); });
 */
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import nock from 'nock';

import {
  decideAccountLogin,
  decideSecurityCode,
  decideSendVerificationCode,
  decideSignin,
  decideSigninInit,
  decideSigninComplete,
  decideTrust,
  decideValidate,
  decideValidateVerificationCode,
  isRouteError,
  RouteError,
  RouteResult,
} from './auth-state';

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

function fixture<T = any>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8')) as T;
}

/** Lazily-loaded canned bodies (parsed fresh per call to avoid shared mutation). */
const FIX = {
  loginWorking: () => fixture('account-login'),
  login2fa: () => fixture('account-login-2fa'),
  validate: () => fixture('validate'),
  trustedDevices: () => fixture('trusted-devices'),
  verificationOk: () => fixture('verification-code-ok'),
  verificationKo: () => fixture('verification-code-ko'),
  accountDevices: () => fixture('account-devices'),
  family: () => fixture('family-details'),
  storage: () => fixture('storage'),
  driveRoot: () => fixture('drive-root'),
  driveRootInvalid: () => fixture('drive-root-invalid'),
  driveFolder: () => fixture('drive-folder-test'),
  driveSubfolder: () => fixture('drive-subfolder'),
  driveDownload: () => fixture('drive-file-download'),
  fmi: () => fixture('fmi-refresh'),
  contactsStartup: () => fixture('contacts-startup'),
  contactsList: () => fixture('contacts-list'),
};

// ---------------------------------------------------------------------------
// Drive upload saga response shapes (plan §4.5 / §5.4 — ARRAY then OBJECT)
// ---------------------------------------------------------------------------

const RESERVED_UPLOAD_URL = 'https://p31-docws.icloud.com:443/_reserved_upload_target';

/** `upload/web` reserve reply — an ARRAY; impl reads `[0].document_id`/`[0].url`. */
function uploadReserveBody(): unknown {
  return [{ document_id: 'UPLOADED_DOC_ID', url: RESERVED_UPLOAD_URL }];
}

/** Reserved-url upload reply — an OBJECT; impl reads `.singleFile`. */
function uploadSingleFileBody(): unknown {
  return {
    singleFile: {
      fileChecksum: 'file_checksum',
      wrappingKey: 'wrapping_key==',
      referenceChecksum: 'reference_checksum',
      size: 42,
      receipt: 'receipt',
    },
  };
}

// ---------------------------------------------------------------------------
// Request introspection helpers
// ---------------------------------------------------------------------------

interface ParsedRequest {
  method: string;
  url: string; // full href
  pathWithQuery: string; // path + querystring
  query: Record<string, string>;
  headers: Record<string, string>;
  body: any; // parsed JSON (or {} / raw string)
}

function parseQuery(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  const qs = search.startsWith('?') ? search.slice(1) : search;
  if (!qs) return out;
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const idx = pair.indexOf('=');
    const k = idx === -1 ? pair : pair.slice(0, idx);
    const v = idx === -1 ? '' : pair.slice(idx + 1);
    out[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return out;
}

function parseBody(raw: unknown): any {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw; // nock pre-parsed JSON
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '' ) return {};
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw; // non-JSON (e.g. multipart) — keep raw
    }
  }
  return {};
}

function lowerHeaders(h: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h || {})) {
    out[k.toLowerCase()] = Array.isArray(v) ? String(v[0]) : String(v);
  }
  return out;
}

/** Read a header case-insensitively. */
function header(req: ParsedRequest, name: string): string | undefined {
  return req.headers[name.toLowerCase()];
}

// ---------------------------------------------------------------------------
// Core routing — returns a RouteResult, a RouteError, or a stream payload.
// ---------------------------------------------------------------------------

interface StreamResult {
  status: number;
  stream: Readable;
  headers?: Record<string, string>;
}

function isStreamResult(x: unknown): x is StreamResult {
  return !!x && typeof x === 'object' && 'stream' in (x as object);
}

class UnexpectedRequestError extends Error {
  constructor(method: string, url: string) {
    super(`Unexpected request: ${method} ${url}`);
    this.name = 'UnexpectedRequestError';
  }
}

function route(req: ParsedRequest): RouteResult | RouteError | StreamResult {
  const { method, pathWithQuery, query, body } = req;
  const u = pathWithQuery;

  // ----- Authentication / Setup -----------------------------------------

  // SETUP endpoints (path-based; matches both .com and .com.cn).
  if (u.includes('accountLogin') && method === 'POST') {
    return decideAccountLogin(body, FIX.loginWorking(), FIX.login2fa());
  }
  if (u.includes('listDevices') && method === 'GET') {
    return { status: 200, body: FIX.trustedDevices() };
  }
  if (u.includes('sendVerificationCode') && method === 'POST') {
    return decideSendVerificationCode(body, FIX.verificationOk(), FIX.verificationKo());
  }
  // ORDER MATTERS: validateVerificationCode BEFORE validate (substring overlap).
  if (u.includes('validateVerificationCode') && method === 'POST') {
    return decideValidateVerificationCode(body, FIX.verificationOk());
  }
  if (u.includes('validate') && method === 'POST') {
    return decideValidate(header(req, 'X-APPLE-WEBAUTH-TOKEN'), FIX.validate());
  }

  // AUTH (idmsa) endpoints. ORDER MATTERS: the SRP init/complete sub-paths must
  // be checked before the legacy `signin` catch-all (both contain 'signin').
  if (u.includes('signin/init') && method === 'POST') {
    return decideSigninInit(body);
  }
  if (u.includes('signin/complete') && method === 'POST') {
    return decideSigninComplete(body);
  }
  if (u.includes('signin') && method === 'POST') {
    return decideSignin(body);
  }
  if (u.includes('securitycode') && method === 'POST') {
    return decideSecurityCode(body);
  }
  if (u.includes('trust') && method === 'GET') {
    return decideTrust();
  }

  // ----- Account ---------------------------------------------------------

  if (u.includes('device/getDevices') && method === 'GET') {
    return { status: 200, body: FIX.accountDevices() };
  }
  if (u.includes('family/getFamilyDetails') && method === 'GET') {
    return { status: 200, body: FIX.family() };
  }
  if (u.includes('storageUsageInfo') && method === 'GET') {
    return { status: 200, body: FIX.storage() };
  }
  if (u.includes('family/getMemberPhoto') && method === 'GET') {
    // Streamed image bytes — any non-empty body suffices.
    return { status: 200, stream: Readable.from(Buffer.from('photo-bytes')) };
  }

  // ----- Drive: upload saga (check BEFORE generic docws routing) ---------

  if (u.includes('com.apple.CloudDocs/upload/web') && method === 'POST') {
    // Reserve: reply an ARRAY (impl reads [0].document_id / [0].url).
    return { status: 200, body: uploadReserveBody() };
  }
  if (u.includes('/_reserved_upload_target') && method === 'POST') {
    // Upload to reserved url: reply an OBJECT (impl reads .singleFile).
    return { status: 200, body: uploadSingleFileBody() };
  }
  if (u.includes('com.apple.CloudDocs/update/documents') && method === 'POST') {
    // Commit — echo a minimal node so the impl can resolve the new file.
    return { status: 200, body: { status: 'OK', items: [] } };
  }
  if (u.includes('createFolders') && method === 'POST') {
    return { status: 200, body: { destinationDrivewsId: '', folders: [] } };
  }
  if (u.includes('renameItems') && method === 'POST') {
    return { status: 200, body: { items: [] } };
  }
  if (u.includes('moveItemsToTrash') && method === 'POST') {
    return { status: 200, body: { items: [] } };
  }
  if (u.includes('retrieveAppLibraries') && method === 'GET') {
    return { status: 200, body: { items: [] } };
  }

  // ----- Drive: folder metadata (ARRAY body, route on body[0].drivewsid) -

  if (u.includes('retrieveItemDetailsInFolders') && method === 'POST') {
    const drivewsid = Array.isArray(body) ? body[0]?.drivewsid : undefined;
    switch (drivewsid) {
      case 'FOLDER::com.apple.CloudDocs::root':
        return { status: 200, body: FIX.driveRoot() };
      case 'FOLDER::com.apple.CloudDocs::documents':
        return { status: 200, body: FIX.driveRootInvalid() };
      case 'FOLDER::com.apple.CloudDocs::1C7F1760-D940-480F-8C4F-005824A4E05B':
        return { status: 200, body: FIX.driveFolder() };
      case 'FOLDER::com.apple.CloudDocs::D5AA0425-E84F-4501-AF5D-60F1D92648CF':
        return { status: 200, body: FIX.driveSubfolder() };
      default:
        break;
    }
  }

  // ----- Drive: download (2-hop) ----------------------------------------

  if (u.includes('com.apple.CloudDocs/download/by_id') && method === 'GET') {
    if (query.document_id === '516C896C-6AA5-4A30-B30E-5502C2333DAE') {
      return { status: 200, body: FIX.driveDownload() };
    }
  }
  // The CDN host lives in the URL HOST, not the path — match on the full href.
  if (req.url.includes('icloud-content.com') && method === 'GET') {
    // CDN bytes — return a non-empty stream so `.raw`/stream is truthy.
    return { status: 200, stream: Readable.from(Buffer.from('pdf-bytes')) };
  }

  // ----- Contacts: two-step sequential handshake -------------------------
  // ORDER MATTERS: `co/contacts` (step 2) must be checked BEFORE `co/startup`
  // is NOT required (distinct paths), but we check the more specific
  // `co/contacts` first for clarity. Step 2 asserts that step 1's tokens were
  // threaded into the query string and that `limit=0` (all) was sent — if not,
  // it errors, so a passing test PROVES the sequential token threading.

  if (u.includes('co/contacts') && method === 'GET') {
    if (query.prefToken !== FIX.contactsStartup().prefToken) {
      return { reason: 'Missing or wrong prefToken from startup', status: 400 };
    }
    if (query.syncToken !== FIX.contactsStartup().syncToken) {
      return { reason: 'Missing or wrong syncToken from startup', status: 400 };
    }
    if (query.limit !== '0') {
      return { reason: 'Contacts must request limit=0 (all)', status: 400 };
    }
    return { status: 200, body: FIX.contactsList() };
  }
  if (u.includes('co/startup') && method === 'GET') {
    return { status: 200, body: FIX.contactsStartup() };
  }

  // ----- Find My iPhone (substring 'fmi', POST) --------------------------

  if (u.includes('fmi') && method === 'POST') {
    return { status: 200, body: FIX.fmi() };
  }

  // ----- Unmatched: THROW (fixes Python None latent bug) -----------------

  throw new UnexpectedRequestError(method, req.url);
}

// ---------------------------------------------------------------------------
// nock wiring
// ---------------------------------------------------------------------------

/** Error-body shape mirroring `_raise_error` reason/code extraction. */
function errorBody(err: RouteError): { status: number; body: unknown } {
  const body: Record<string, unknown> = { errorMessage: err.reason };
  if (err.code !== undefined) body.errorCode = err.code;
  return { status: err.status ?? 200, body };
}

/**
 * Resolve a parsed request through {@link route} and apply the result to the
 * nock reply callback. Returns a nock reply tuple `[status, body, headers]`.
 */
function handle(req: ParsedRequest): nock.ReplyFnResult {
  const result = route(req);

  if (isStreamResult(result)) {
    return [result.status, result.stream as never, (result.headers ?? {}) as never];
  }
  if (isRouteError(result)) {
    const { status, body } = errorBody(result);
    return [status, body as never];
  }
  const r = result as RouteResult;
  // 204 carries no body; an empty string keeps content-type non-JSON.
  const payload = (r.status === 204 ? '' : (r.body ?? {})) as never;
  return [r.status, payload, (r.headers ?? {}) as never];
}

/**
 * Build a ParsedRequest from nock's reply-callback arguments.
 * `uri` is the path+query; `this.req` exposes method/headers/host.
 */
function buildRequest(
  scope: { req: any },
  uri: string,
  requestBody: unknown,
): ParsedRequest {
  const req = scope.req;
  const method: string = (req.method || 'GET').toUpperCase();
  const headers = lowerHeaders(req.headers || {});
  const host: string = headers['host'] || req.options?.host || '';
  const proto = req.options?.protocol || 'https:';
  const qIdx = uri.indexOf('?');
  const search = qIdx === -1 ? '' : uri.slice(qIdx);
  return {
    method,
    url: `${proto}//${host}${uri}`,
    pathWithQuery: uri,
    query: parseQuery(search),
    headers,
    body: parseBody(requestBody),
  };
}

const ANY_HOST = /^https?:\/\/[^/]+$/;

/**
 * Install the router: a single persistent nock interceptor per HTTP method,
 * matching ANY host and ANY path, dispatching through {@link route}.
 *
 * Returns the nock scope so callers can `scope.done()` if desired (not
 * required — `afterEach(nock.cleanAll)` tears everything down).
 */
export function installMockRouter(): nock.Scope {
  const scope = nock(ANY_HOST).persist();

  // Callback form so a thrown UnexpectedRequestError is surfaced to the client
  // as a request error (axios rejects) instead of hanging — making unmatched
  // routes fail loudly per the contract.
  const replyFn = function (
    this: nock.ReplyFnContext,
    uri: string,
    body: nock.Body,
    cb: (err: NodeJS.ErrnoException | null, result: nock.ReplyFnResult) => void,
  ): void {
    const parsed = buildRequest(this as unknown as { req: any }, uri, body);
    try {
      cb(null, handle(parsed));
    } catch (err) {
      cb(err as NodeJS.ErrnoException, [500, '']);
    }
  };

  // Register all verbs the client uses; path matcher accepts everything so the
  // substring routing in `route()` is authoritative.
  scope.get(() => true).reply(replyFn);
  scope.post(() => true).reply(replyFn);
  scope.put(() => true).reply(replyFn);
  scope.delete(() => true).reply(replyFn);

  return scope;
}

export { RESERVED_UPLOAD_URL, UnexpectedRequestError };
