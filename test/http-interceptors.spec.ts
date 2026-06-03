/**
 * http-interceptors.spec.ts — NET-NEW tests for `IcloudHttpService`
 * (`src/session/icloud-http.service.ts`).
 *
 * These have NO Python reference (the Python suite mocks the session and cheats
 * by mutating `session_data` directly, so it never exercises real header
 * harvesting or the explicit retry). They are derived from the source REQUEST
 * code (`base.py:request`) and the plan §4.2 items 1-6 + §8.1.
 *
 * Coverage:
 *  - header harvest: the five HEADER_DATA headers are copied into sessionData;
 *  - echo: scnt + X-Apple-ID-Session-Id are sent back on the next request;
 *  - single retry + guard: 421/450/500 → exactly ONE retry, then raise (no loop);
 *  - 421 / 450 / 500 each trigger the retry path;
 *  - findme re-auth branch: 450 → full sign-in, else → 'find'; non-findme → no re-auth;
 *  - error key-priority: extractReasonCode order surfaces in the thrown message;
 *  - successful stream/arraybuffer downloads never enter retry/parse;
 *  - no-secret-logging: password / harvested tokens never reach the logger.
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import nock from 'nock';

import { SessionStore } from '../src/session/session-store';
import {
  Endpoints,
  IcloudAuthLike,
  IcloudHttpService,
} from '../src/session/icloud-http.service';
import {
  PyiCloud2SARequiredException,
  PyiCloudAPIResponseException,
  PyiCloudServiceNotActivatedException,
} from '../src/exceptions/icloud.exceptions';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const ORIGIN = 'https://www.icloud.com';
const BASE = 'https://example.icloud.test';
const FINDME = 'https://p99-fmipweb.icloud.test/fmipservice/client/web';

const ENDPOINTS: Endpoints = {
  AUTH: 'https://idmsa.apple.com/appleauth/auth',
  HOME: ORIGIN,
  SETUP: 'https://setup.icloud.com/setup/ws/1',
};

const DEFAULT_HEADERS = { Origin: ORIGIN, Referer: `${ORIGIN}/` };

/** A configurable fake of the auth orchestrator slice the HTTP layer needs. */
interface FakeAuth extends IcloudAuthLike {
  authenticate: jest.Mock<
    Promise<void>,
    [opts?: { forceRefresh?: boolean; service?: string }]
  >;
}

function makeAuth(overrides: Partial<IcloudAuthLike> = {}): FakeAuth {
  const auth: FakeAuth = {
    user: { accountName: 'tester@icloud.test', password: 'super-secret-pw' },
    requires2sa: false,
    getWebserviceUrl: (key: string) => {
      if (key === 'findme') return FINDME;
      throw new Error(`no url for ${key}`);
    },
    authenticate: jest.fn(async () => undefined),
    ...overrides,
  } as FakeAuth;
  return auth;
}

async function makeStore(): Promise<{ store: SessionStore; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsicloud-http-'));
  const store = await SessionStore.load(dir, 'tester');
  return { store, dir };
}

async function makeService(
  auth: IcloudAuthLike = makeAuth(),
): Promise<{ http: IcloudHttpService; store: SessionStore; dir: string }> {
  const { store, dir } = await makeStore();
  const http = new IcloudHttpService(store, ENDPOINTS, DEFAULT_HEADERS);
  http.bindAuth(auth);
  return { http, store, dir };
}

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

async function service(auth?: IcloudAuthLike): Promise<{
  http: IcloudHttpService;
  store: SessionStore;
}> {
  const { http, store, dir } = await makeService(auth);
  tmpDirs.push(dir);
  return { http, store };
}

// ---------------------------------------------------------------------------
// 1. Header harvest
// ---------------------------------------------------------------------------

describe('response interceptor — header harvest', () => {
  it('copies the five HEADER_DATA headers into sessionData', async () => {
    const { http, store } = await service();

    nock(BASE)
      .get('/probe')
      .reply(
        200,
        { ok: true },
        {
          'Content-Type': 'application/json',
          'X-Apple-ID-Account-Country': 'FRA',
          'X-Apple-ID-Session-Id': 'sess-123',
          'X-Apple-Session-Token': 'tok-456',
          'X-Apple-TwoSV-Trust-Token': 'trust-789',
          scnt: 'scnt-abc',
        },
      );

    await http.request('GET', `${BASE}/probe`);

    expect(store.sessionData).toMatchObject({
      account_country: 'FRA',
      session_id: 'sess-123',
      session_token: 'tok-456',
      trust_token: 'trust-789',
      scnt: 'scnt-abc',
    });
  });

  it('does not overwrite existing sessionData when headers are absent', async () => {
    const { http, store } = await service();
    store.sessionData.session_token = 'pre-existing';

    nock(BASE).get('/noheaders').reply(200, { ok: true }, { 'Content-Type': 'application/json' });

    await http.request('GET', `${BASE}/noheaders`);

    expect(store.sessionData.session_token).toBe('pre-existing');
  });

  it('persists sessionData + cookies to disk after a response', async () => {
    const { http, store } = await service();
    const spy = jest.spyOn(store, 'persistAll');

    nock(BASE)
      .get('/persist')
      .reply(200, { ok: true }, { 'Content-Type': 'application/json', scnt: 'scnt-1' });

    await http.request('GET', `${BASE}/persist`);

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Request interceptor — echo
// ---------------------------------------------------------------------------

describe('request interceptor — echo + default headers', () => {
  it('echoes scnt + X-Apple-ID-Session-Id from sessionData on the next request', async () => {
    const { http, store } = await service();
    store.sessionData.scnt = 'scnt-echo';
    store.sessionData.session_id = 'sid-echo';

    let seen: Record<string, string> = {};
    nock(BASE)
      .get('/echo')
      .reply(function () {
        seen = this.req.headers as unknown as Record<string, string>;
        return [200, { ok: true }, { 'Content-Type': 'application/json' }];
      });

    await http.request('GET', `${BASE}/echo`);

    expect(seen.scnt).toBe('scnt-echo');
    expect(seen['x-apple-id-session-id']).toBe('sid-echo');
  });

  it('harvests scnt from response N then echoes it on request N+1', async () => {
    const { http } = await service();

    nock(BASE)
      .get('/first')
      .reply(200, { ok: true }, { 'Content-Type': 'application/json', scnt: 'harvested-scnt' });

    let echoed: string | undefined;
    nock(BASE)
      .get('/second')
      .reply(function () {
        echoed = (this.req.headers as Record<string, string>).scnt;
        return [200, { ok: true }, { 'Content-Type': 'application/json' }];
      });

    await http.request('GET', `${BASE}/first`);
    await http.request('GET', `${BASE}/second`);

    expect(echoed).toBe('harvested-scnt');
  });

  it('merges the default Origin/Referer headers', async () => {
    const { http } = await service();

    let seen: Record<string, string> = {};
    nock(BASE)
      .get('/origin')
      .reply(function () {
        seen = this.req.headers as unknown as Record<string, string>;
        return [200, { ok: true }, { 'Content-Type': 'application/json' }];
      });

    await http.request('GET', `${BASE}/origin`);

    expect(seen.origin).toBe(ORIGIN);
    expect(seen.referer).toBe(`${ORIGIN}/`);
  });
});

// ---------------------------------------------------------------------------
// 3. Single retry + guard (421/450/500)
// ---------------------------------------------------------------------------

describe('single retry + _retried guard', () => {
  it.each([421, 450, 500])('retries exactly once on status %i then succeeds', async (status) => {
    const { http } = await service();

    const scope = nock(BASE)
      .get('/retry')
      .reply(status, { errorMessage: 'transient' }, { 'Content-Type': 'application/json' })
      .get('/retry')
      .reply(200, { ok: true }, { 'Content-Type': 'application/json' });

    const res = await http.request('GET', `${BASE}/retry`);

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ ok: true });
    expect(scope.isDone()).toBe(true); // both interceptors consumed → exactly one retry
  });

  it('does NOT retry a second time — a persistent 421 raises after one retry', async () => {
    const { http } = await service();

    const scope = nock(BASE)
      .get('/persist-fail')
      .reply(421, { errorMessage: 'still failing' }, { 'Content-Type': 'application/json' })
      .get('/persist-fail')
      .reply(421, { errorMessage: 'still failing' }, { 'Content-Type': 'application/json' });

    await expect(http.request('GET', `${BASE}/persist-fail`)).rejects.toBeInstanceOf(
      PyiCloudAPIResponseException,
    );
    // Exactly two requests were made (original + one retry), no third.
    expect(scope.isDone()).toBe(true);
  });

  it('raises "Authentication required for Account." on a persistent 450', async () => {
    const { http } = await service();

    nock(BASE)
      .get('/p450')
      .twice()
      .reply(450, { errorMessage: 'nope' }, { 'Content-Type': 'application/json' });

    await expect(http.request('GET', `${BASE}/p450`)).rejects.toMatchObject({
      reason: 'Authentication required for Account.',
      code: 450,
    });
  });

  it('does NOT retry a non-JSON 404 — it falls straight through to raiseError', async () => {
    const { http } = await service();

    const scope = nock(BASE)
      .get('/notfound')
      .reply(404, 'Not Found', { 'Content-Type': 'text/plain' });

    await expect(http.request('GET', `${BASE}/notfound`)).rejects.toBeInstanceOf(
      PyiCloudAPIResponseException,
    );
    // Only ONE request — no retry for a non-421/450/500 status.
    expect(scope.isDone()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Find My iPhone re-auth branch
// ---------------------------------------------------------------------------

describe('findme re-auth branch', () => {
  it('450 on the findme URL → full sign-in (service undefined), then retries', async () => {
    const auth = makeAuth();
    const { http } = await service(auth);

    nock(FINDME)
      .post('/refreshClient')
      .reply(450, { errorMessage: 'auth required' }, { 'Content-Type': 'application/json' })
      .post('/refreshClient')
      .reply(200, { content: [] }, { 'Content-Type': 'application/json' });

    const res = await http.request('POST', `${FINDME}/refreshClient`, { data: {} });

    expect(res.status).toBe(200);
    expect(auth.authenticate).toHaveBeenCalledTimes(1);
    expect(auth.authenticate).toHaveBeenCalledWith({ forceRefresh: true, service: undefined });
  });

  it.each([421, 500])(
    'status %i on the findme URL → one-factor re-auth (service "find"), then retries',
    async (status) => {
      const auth = makeAuth();
      const { http } = await service(auth);

      nock(FINDME)
        .post('/refreshClient')
        .reply(status, { errorMessage: 'auth required' }, { 'Content-Type': 'application/json' })
        .post('/refreshClient')
        .reply(200, { content: [] }, { 'Content-Type': 'application/json' });

      await http.request('POST', `${FINDME}/refreshClient`, { data: {} });

      expect(auth.authenticate).toHaveBeenCalledWith({ forceRefresh: true, service: 'find' });
    },
  );

  it('swallows a re-auth failure and still retries once', async () => {
    const auth = makeAuth({
      authenticate: jest.fn(async () => {
        throw new PyiCloudAPIResponseException('re-auth boom');
      }),
    });
    const { http } = await service(auth);

    nock(FINDME)
      .post('/refreshClient')
      .reply(450, { errorMessage: 'auth required' }, { 'Content-Type': 'application/json' })
      .post('/refreshClient')
      .reply(200, { content: [] }, { 'Content-Type': 'application/json' });

    const res = await http.request('POST', `${FINDME}/refreshClient`, { data: {} });

    expect(res.status).toBe(200);
    expect(auth.authenticate).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-authenticate for a 450 on a non-findme URL (generic retry only)', async () => {
    const auth = makeAuth();
    const { http } = await service(auth);

    nock(BASE)
      .get('/not-findme')
      .reply(450, { errorMessage: 'auth required' }, { 'Content-Type': 'application/json' })
      .get('/not-findme')
      .reply(200, { ok: true }, { 'Content-Type': 'application/json' });

    const res = await http.request('GET', `${BASE}/not-findme`);

    expect(res.status).toBe(200);
    expect(auth.authenticate).not.toHaveBeenCalled();
  });

  it('does not re-auth on the findme URL when already retried (guard holds)', async () => {
    const auth = makeAuth();
    const { http } = await service(auth);

    // First 450 → re-auth + retry; second 450 → guard blocks further re-auth → raise.
    nock(FINDME)
      .post('/refreshClient')
      .twice()
      .reply(450, { errorMessage: 'auth required' }, { 'Content-Type': 'application/json' });

    await expect(
      http.request('POST', `${FINDME}/refreshClient`, { data: {} }),
    ).rejects.toBeInstanceOf(PyiCloudAPIResponseException);

    // Re-auth happened exactly once (only on the first, non-retried attempt).
    expect(auth.authenticate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Error normalization — key priority
// ---------------------------------------------------------------------------

describe('error normalization — reason/code key priority', () => {
  it('prefers errorMessage over reason/errorReason/error', async () => {
    const { http } = await service();
    nock(BASE)
      .get('/e')
      .reply(
        200,
        {
          errorMessage: 'the-message',
          reason: 'the-reason',
          errorReason: 'the-error-reason',
          error: 'the-error',
        },
        { 'Content-Type': 'application/json' },
      );

    await expect(http.request('GET', `${BASE}/e`)).rejects.toMatchObject({
      reason: 'the-message',
    });
  });

  it('falls back to reason when errorMessage is absent', async () => {
    const { http } = await service();
    nock(BASE)
      .get('/e')
      .reply(200, { reason: 'only-reason' }, { 'Content-Type': 'application/json' });

    await expect(http.request('GET', `${BASE}/e`)).rejects.toMatchObject({
      reason: 'only-reason',
    });
  });

  it('uses "Unknown reason" when only a truthy non-string error is present', async () => {
    const { http } = await service();
    nock(BASE)
      .get('/e')
      .reply(200, { error: { nested: true } }, { 'Content-Type': 'application/json' });

    await expect(http.request('GET', `${BASE}/e`)).rejects.toMatchObject({
      reason: 'Unknown reason',
    });
  });

  it('prefers errorCode over serverErrorCode', async () => {
    const { http } = await service();
    nock(BASE)
      .get('/e')
      .reply(
        200,
        { errorMessage: 'm', errorCode: 'EC', serverErrorCode: 'SEC' },
        { 'Content-Type': 'application/json' },
      );

    await expect(http.request('GET', `${BASE}/e`)).rejects.toMatchObject({
      reason: 'm',
      code: 'EC',
    });
  });

  it('maps ZONE_NOT_FOUND / AUTHENTICATION_FAILED to ServiceNotActivated', async () => {
    const { http } = await service();
    nock(BASE)
      .get('/e')
      .reply(
        200,
        { errorMessage: 'gone', errorCode: 'ZONE_NOT_FOUND' },
        { 'Content-Type': 'application/json' },
      );

    await expect(http.request('GET', `${BASE}/e`)).rejects.toBeInstanceOf(
      PyiCloudServiceNotActivatedException,
    );
  });

  it('maps the 2SA missing-cookie reason to PyiCloud2SARequiredException', async () => {
    const auth = makeAuth({ requires2sa: true });
    const { http } = await service(auth);
    nock(BASE)
      .get('/e')
      .reply(
        200,
        { errorMessage: 'Missing X-APPLE-WEBAUTH-TOKEN cookie' },
        { 'Content-Type': 'application/json' },
      );

    await expect(http.request('GET', `${BASE}/e`)).rejects.toBeInstanceOf(
      PyiCloud2SARequiredException,
    );
  });

  it('returns the response (no throw) when a JSON 200 carries no error keys', async () => {
    const { http } = await service();
    nock(BASE)
      .get('/ok')
      .reply(200, { data: 'value' }, { 'Content-Type': 'application/json' });

    const res = await http.request('GET', `${BASE}/ok`);
    expect(res.data).toEqual({ data: 'value' });
  });
});

// ---------------------------------------------------------------------------
// 6. Successful stream / arraybuffer downloads bypass retry + parse
// ---------------------------------------------------------------------------

describe('successful non-JSON downloads bypass retry/parse', () => {
  it('returns a 200 stream untouched (no retry, no error parse) for non-JSON content-type', async () => {
    const auth = makeAuth();
    const { http } = await service(auth);

    nock(BASE)
      .get('/blob')
      .reply(200, 'binary-bytes', { 'Content-Type': 'application/octet-stream' });

    const res = await http.request('GET', `${BASE}/blob`, { responseType: 'arraybuffer' });

    expect(res.status).toBe(200);
    expect(auth.authenticate).not.toHaveBeenCalled();
    // Body is returned raw (arraybuffer), never JSON-parsed for an error reason.
    expect(Buffer.from(res.data as ArrayBuffer).toString()).toBe('binary-bytes');
  });
});

// ---------------------------------------------------------------------------
// 7. No-secret logging
// ---------------------------------------------------------------------------

describe('no-secret logging', () => {
  it('never logs the account password or the harvested tokens', async () => {
    const auth = makeAuth();
    const { http } = await service(auth);
    const password = auth.user.password;

    const logged: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'debug')
      .mockImplementation((msg: unknown) => {
        logged.push(String(msg));
      });

    nock(BASE)
      .post('/login')
      .reply(
        200,
        { ok: true },
        {
          'Content-Type': 'application/json',
          'X-Apple-Session-Token': 'secret-session-token',
          'X-Apple-TwoSV-Trust-Token': 'secret-trust-token',
          scnt: 'secret-scnt',
        },
      );

    // Pass the password inside the request body to verify it is scrubbed.
    await http.request('POST', `${BASE}/login`, {
      data: { accountName: auth.user.accountName, password },
    });

    spy.mockRestore();

    const all = logged.join('\n');
    expect(all).not.toContain(password);
    expect(all).not.toContain('secret-session-token');
    expect(all).not.toContain('secret-trust-token');
    expect(all).not.toContain('secret-scnt');
  });

  it('never logs harvested tokens echoed back inside a request BODY', async () => {
    // Reproduces the real accountLogin/signin paths: a token harvested from an
    // EARLIER auth response (into sessionData) is then POSTed back inside a
    // LATER request body (dsWebAuthToken / trustToken / trustTokens). The body
    // is serialized into the DEBUG log, so redacting only the password would
    // leak the session_token and trust_token in cleartext.
    const auth = makeAuth();
    const { http, store } = await service(auth);

    // Simulate tokens harvested from a prior handshake response.
    store.sessionData.session_token = 'harvested-session-token';
    store.sessionData.trust_token = 'harvested-trust-token';
    store.sessionData.session_id = 'harvested-session-id';
    store.sessionData.scnt = 'harvested-scnt';

    const logged: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'debug')
      .mockImplementation((msg: unknown) => {
        logged.push(String(msg));
      });

    nock(BASE).post('/accountLogin').reply(200, { ok: true }, {
      'Content-Type': 'application/json',
    });

    // Mirrors IcloudAuthService._authenticateWithToken() / signin() bodies.
    await http.request('POST', `${BASE}/accountLogin`, {
      data: {
        accountCountryCode: 'FRA',
        dsWebAuthToken: store.sessionData.session_token,
        trustToken: store.sessionData.trust_token,
        trustTokens: [store.sessionData.trust_token],
      },
    });

    spy.mockRestore();

    const all = logged.join('\n');
    // The actual harvested token values must NOT appear anywhere in the logs,
    // even though they are present verbatim in the request body.
    expect(all).not.toContain('harvested-session-token');
    expect(all).not.toContain('harvested-trust-token');
    expect(all).not.toContain('harvested-session-id');
    expect(all).not.toContain('harvested-scnt');
    // The non-secret field names / values are still allowed to be logged.
    expect(all).toContain('accountCountryCode');
  });
});
