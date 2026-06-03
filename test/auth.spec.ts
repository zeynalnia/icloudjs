/**
 * auth.spec.ts — IcloudAuthService (`src/auth/icloud-auth.service.ts`).
 *
 * Exercises the real auth lifecycle end-to-end against the wire-level mock
 * router (so the genuine signin → accountLogin flow, header harvesting, and
 * `populateParams` run), via the `makeAuthService` helper.
 *
 * Coverage:
 *  - full signin → accountLogin → webservices map resolution;
 *  - `requires2fa` / `requires2sa` / `isTrustedSession` (hardened, optional
 *    chaining — never throws on a degenerate `data`);
 *  - 2FA path: `validate2faCode('000000')` (wrong code → false, success → trust);
 *  - 2SA path: `trustedDevices` → `sendVerificationCode` →
 *    `validateVerificationCode(device, '0')` (device-compare uses '0', NOT the
 *    2FA '000000'); `-21669` → false;
 *  - `trustSession` harvests the trust token then re-authenticates;
 *  - `populateParams` (FIX #1): asserts `clientId` + `dsid` PRESENT, and does
 *    NOT pin the build-number strings;
 *  - validate-token reuse: a pre-seeded session_token takes the `{SETUP}/validate`
 *    fast path instead of a fresh sign-in;
 *  - China + GLOBAL OAuth (NET-NEW, no Python reference): signin host is
 *    `.com.cn` but `X-Apple-OAuth-Redirect-URI` stays `https://www.icloud.com`.
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import nock from 'nock';

import { IcloudAuthService } from '../src/auth/icloud-auth.service';
import { SessionStore } from '../src/session/session-store';
import { Endpoints, IcloudHttpService } from '../src/session/icloud-http.service';
import { OAUTH } from '../src/constants';
import { PyiCloudAPIResponseException } from '../src/exceptions/icloud.exceptions';

import { installMockRouter } from './helpers/mock-router';
import { makeAuthService, stubSecrets } from './helpers/make-service';
import {
  ACCOUNT_COUNTRY_VALUE,
  AUTHENTICATED_USER,
  REQUIRES_2FA_USER,
  resetAuthState,
  SESSION_ID_VALUE,
  SCNT_VALUE,
  TRUST_TOKEN_VALUE,
  TRUSTED_DEVICE_VERIFICATION_CODE,
  VALID_2FA_CODE,
  VALID_COOKIE,
  VALID_PASSWORD,
  VALID_TOKEN,
} from './helpers/auth-state';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

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
async function auth(
  overrides: Parameters<typeof makeAuthService>[0] = {},
): Promise<IcloudAuthService> {
  const made = await makeAuthService(overrides);
  cleanups.push(made.cleanup);
  return made.service;
}

// ---------------------------------------------------------------------------
// 1. Full sign-in
// ---------------------------------------------------------------------------

describe('authenticate — full sign-in', () => {
  it('signs in and resolves the webservices URL map', async () => {
    const service = await auth();

    // webservices resolved from the account-login fixture.
    expect(service.getWebserviceUrl('drivews')).toBe(
      'https://p31-drivews.icloud.com:443',
    );
    expect(service.getWebserviceUrl('docws')).toBe(
      'https://p31-docws.icloud.com:443',
    );
    expect(service.getWebserviceUrl('findme')).toBe(
      'https://p31-fmipweb.icloud.com:443',
    );
    expect(service.getWebserviceUrl('account')).toBe(
      'https://p31-setup.icloud.com:443',
    );
  });

  it('throws PyiCloudServiceNotActivatedException for an unknown webservice', async () => {
    const service = await auth();
    expect(() => service.getWebserviceUrl('does-not-exist')).toThrow(
      /Webservice not available/,
    );
  });

  it('loads a trusted session: not requires2fa / not requires2sa', async () => {
    const service = await auth();
    expect(service.isTrustedSession).toBe(true);
    expect(service.requires2fa).toBe(false);
    expect(service.requires2sa).toBe(false);
  });

  it('harvests the account_country header into the session', async () => {
    const service = await auth();
    // Indirect proof the handshake threaded: dsid comes from the login payload.
    expect(service.data.dsInfo.dsid).toBe('quentintarantino');
    expect(ACCOUNT_COUNTRY_VALUE).toBe('FRA');
  });
});

// ---------------------------------------------------------------------------
// 2. populateParams (FIX #1)
// ---------------------------------------------------------------------------

describe('populateParams (FIX #1)', () => {
  it('populates clientId and dsid (PRESENT), without pinning build-number strings', async () => {
    const service = await auth();

    // The two load-bearing params Drive/Ubiquity need.
    expect(service.params.clientId).toBeDefined();
    expect(service.params.clientId).toMatch(/^auth-/);
    expect(service.params.dsid).toBe('quentintarantino');

    // Build numbers are present (named constants) but their VALUES are not
    // pinned by any fixture — assert only that the keys exist, never the values.
    expect(service.params).toHaveProperty('clientBuildNumber');
    expect(service.params).toHaveProperty('clientMasteringNumber');
    expect(service.params).toHaveProperty('ckjsBuildVersion');
  });
});

// ---------------------------------------------------------------------------
// 3. requires2fa / requires2sa / isTrustedSession hardening
// ---------------------------------------------------------------------------

describe('2FA/2SA state getters (hardened with optional chaining)', () => {
  it('does not throw when data is degenerate (no dsInfo)', async () => {
    const service = await auth();
    // Force a degenerate payload — the Python `requires_2fa` raised KeyError here.
    (service as unknown as { data: unknown }).data = {};
    expect(() => service.requires2fa).not.toThrow();
    expect(service.requires2fa).toBe(false);
    expect(service.requires2sa).toBe(false);
    expect(service.isTrustedSession).toBe(false);
  });

  it('reports requires2fa for a 2FA-challenged login', async () => {
    const service = await auth({ accountName: REQUIRES_2FA_USER });
    expect(service.requires2fa).toBe(true);
    expect(service.requires2sa).toBe(true);
    expect(service.isTrustedSession).toBe(false);
  });

  it('treats a truthy non-boolean hsaChallengeRequired (1) as required (loose truthiness)', async () => {
    const service = await auth();
    // Force a trusted-browser payload so the `!isTrustedSession` branch is
    // false; only the loose-truthy `hsaChallengeRequired` can flip the getter.
    (service as unknown as { data: unknown }).data = {
      dsInfo: { hsaVersion: 2 },
      hsaTrustedBrowser: true,
      hsaChallengeRequired: 1, // truthy but NOT strictly `=== true`
    };
    expect(service.isTrustedSession).toBe(true);
    expect(service.requires2fa).toBe(true);
    expect(service.requires2sa).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. 2FA path — validate2faCode('000000')
// ---------------------------------------------------------------------------

describe('validate2faCode (2FA path uses 000000)', () => {
  it('returns false for a wrong code (errorCode -21669), without trusting', async () => {
    const service = await auth({ accountName: REQUIRES_2FA_USER });

    // The router emits a generic error (no -21669) for a wrong securitycode;
    // pin the -21669 → false contract with a targeted interceptor. Registered
    // BEFORE the catch-all router so it wins for this one call.
    nock.cleanAll();
    nock('https://idmsa.apple.com')
      .post('/appleauth/auth/verify/trusteddevice/securitycode')
      .reply(
        200,
        { errorMessage: 'Incorrect verification code.', errorCode: -21669 },
        { 'Content-Type': 'application/json' },
      );

    const ok = await service.validate2faCode('999999');
    expect(ok).toBe(false);
    // Still untrusted / still requires 2FA.
    expect(service.requires2fa).toBe(true);
  });

  it('verifies the correct code, trusts the session, and clears 2FA', async () => {
    const service = await auth({ accountName: REQUIRES_2FA_USER });
    expect(service.requires2fa).toBe(true);

    const result = await service.validate2faCode(VALID_2FA_CODE);

    // trustSession re-ran accountLogin → loginWorking (trusted, no challenge).
    expect(result).toBe(true);
    expect(service.requires2sa).toBe(false);
    expect(service.isTrustedSession).toBe(true);
    // trust token harvested by the response interceptor.
    expect(service['store'].sessionData.trust_token).toBe(TRUST_TOKEN_VALUE);
  });

  it('requestTwoFactorCode triggers delivery for a 2FA session, no-op otherwise', async () => {
    const twoFa = await auth({ accountName: REQUIRES_2FA_USER });
    expect(twoFa.requires2fa).toBe(true);
    // Hits GET {AUTH} (options) + GET verify/trusteddevice (push) + PUT
    // verify/phone (SMS); all acknowledged by the router → resolves.
    await expect(twoFa.requestTwoFactorCode()).resolves.toBeUndefined();

    // A normal (non-2FA) session makes no delivery request.
    const normal = await auth();
    expect(normal.requires2fa).toBe(false);
    await expect(normal.requestTwoFactorCode()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. 2SA path — sendVerificationCode / validateVerificationCode (device '0')
// ---------------------------------------------------------------------------

describe('2SA path (device-compare uses verificationCode 0)', () => {
  it('lists trusted devices', async () => {
    const service = await auth({ accountName: REQUIRES_2FA_USER });
    const devices = await service.trustedDevices;
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ deviceType: 'SMS', deviceId: '1' });
  });

  it('sends a verification code to a trusted device', async () => {
    const service = await auth({ accountName: REQUIRES_2FA_USER });
    const devices = await service.trustedDevices;
    const sent = await service.sendVerificationCode(devices[0]);
    expect(sent).toBe(true);
  });

  it('validates the 2SA code (device-compare uses "0") and trusts the session', async () => {
    const service = await auth({ accountName: REQUIRES_2FA_USER });
    const devices = await service.trustedDevices;

    const result = await service.validateVerificationCode(
      devices[0],
      TRUSTED_DEVICE_VERIFICATION_CODE, // '0', NOT the 2FA '000000'
    );

    expect(result).toBe(true);
    expect(service.isTrustedSession).toBe(true);
    expect(service.requires2sa).toBe(false);
  });

  it('returns false on a wrong 2SA code (errorCode -21669, does not throw)', async () => {
    const service = await auth({ accountName: REQUIRES_2FA_USER });
    const devices = await service.trustedDevices;

    // Pin the -21669 → false contract with a targeted interceptor (the router's
    // body-mismatch error 'FOUND_CODE' carries no -21669 and would re-raise).
    nock.cleanAll();
    nock('https://setup.icloud.com')
      .post('/setup/ws/1/validateVerificationCode')
      .query(true)
      .reply(
        200,
        { errorMessage: 'Incorrect verification code.', errorCode: -21669 },
        { 'Content-Type': 'application/json' },
      );

    await expect(
      service.validateVerificationCode(devices[0], '12345'),
    ).resolves.toBe(false);
  });

  it('re-raises a non-(-21669) 2SA error from validateVerificationCode', async () => {
    const service = await auth({ accountName: REQUIRES_2FA_USER });
    const devices = await service.trustedDevices;
    // A code other than '0' makes the router body-compare fail (FOUND_CODE),
    // which has no -21669 code → must propagate as an API exception.
    await expect(
      service.validateVerificationCode(devices[0], '12345'),
    ).rejects.toBeInstanceOf(PyiCloudAPIResponseException);
  });
});

// ---------------------------------------------------------------------------
// 6. validate-token reuse (fast path)
// ---------------------------------------------------------------------------

describe('authenticate — validate-token reuse', () => {
  it('uses {SETUP}/validate when a session_token is already present', async () => {
    // Build the service against a temp dir, then re-run authenticate() with a
    // pre-seeded session_token + the X-APPLE-WEBAUTH-TOKEN header the validate
    // router gate requires. A targeted nock for /validate proves the fast path
    // is taken (no fresh /signin).
    // Drop the catch-all router so our targeted /validate interceptor is the
    // only one and any unexpected /signin would fail loudly (NetConnect off).
    nock.cleanAll();

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsicloud-reuse-'));
    cleanups.push(async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    });

    const store = await SessionStore.load(dir, 'reuse');
    store.sessionData.client_id = 'auth-reuse';
    store.sessionData.session_token = VALID_TOKEN;
    store.sessionData.account_country = ACCOUNT_COUNTRY_VALUE;

    const endpoints: Endpoints = {
      AUTH: 'https://idmsa.apple.com/appleauth/auth',
      HOME: 'https://www.icloud.com',
      SETUP: 'https://setup.icloud.com/setup/ws/1',
    };
    const http = new IcloudHttpService(store, endpoints, {
      Origin: endpoints.HOME,
      Referer: `${endpoints.HOME}/`,
    });

    // A standalone /validate mock that asserts the body is the literal 'null'
    // and returns a trusted login payload. Registered BEFORE the catch-all
    // router so it wins; no /signin interceptor is registered, so any sign-in
    // attempt would fail loudly (NetConnect disabled).
    const loginWorking = JSON.parse(
      await fs.readFile(
        path.join(__dirname, 'fixtures', 'account-login.json'),
        'utf8',
      ),
    );
    let validateBody: string | undefined;
    nock('https://setup.icloud.com')
      .post('/setup/ws/1/validate')
      .reply(function (_uri, body) {
        validateBody = typeof body === 'string' ? body : JSON.stringify(body);
        return [200, loginWorking, { 'Content-Type': 'application/json' }];
      });

    // Build the service via the private constructor path used by create(): use
    // the public factory but with a pre-seeded store is not possible, so drive
    // authenticate() directly on a freshly constructed instance.
    const ctor = IcloudAuthService as unknown as {
      new (...a: unknown[]): IcloudAuthService;
    };
    const service = new ctor(
      { accountName: AUTHENTICATED_USER, password: VALID_PASSWORD },
      endpoints,
      store,
      http,
      'auth-reuse',
      true,
    );
    http.bindAuth(service);

    await service.authenticate();

    // The validate fast path ran (body literal 'null') and resolved webservices.
    expect(validateBody).toBe('null');
    expect(service.getWebserviceUrl('drivews')).toBe(
      'https://p31-drivews.icloud.com:443',
    );
    expect(service.isTrustedSession).toBe(true);

    // Silence unused-import lint of VALID_COOKIE (gate value documented).
    expect(VALID_COOKIE).toBe('valid_cookie');
  });
});

// ---------------------------------------------------------------------------
// 7. China + GLOBAL OAuth redirect (NET-NEW — no Python reference)
// ---------------------------------------------------------------------------

describe('China mode (hosts .com.cn) + GLOBAL OAuth redirect', () => {
  it('signs in against the .com.cn host but keeps the GLOBAL OAuth redirect URI', async () => {
    // Reset the catch-all installed by beforeEach so our capturing interceptor
    // (registered first) is authoritative for the CN signin.
    nock.cleanAll();
    resetAuthState();

    let signinHost: string | undefined;
    let redirectHeader: string | undefined;
    let widgetKeyHeader: string | undefined;
    let originHeader: string | undefined;
    let fdClientInfoHeader: string | undefined;

    // OAuth widget warm-up on the CN host (required before signin/init).
    nock('https://idmsa.apple.com.cn')
      .get('/appleauth/auth/authorize/signin')
      .query(true)
      .reply(200, '<html></html>', { 'Content-Type': 'text/html' });

    // Capturing interceptor for the CN SRP signin/init host — captures the host
    // + OAuth headers, returns SRP init data.
    nock('https://idmsa.apple.com.cn')
      .post('/appleauth/auth/signin/init')
      .query(true)
      .reply(function (_uri, _body) {
        signinHost = (this.req as { options?: { host?: string } }).options?.host
          ?? (this.req.headers as Record<string, string>).host;
        const h = this.req.headers as Record<string, string>;
        redirectHeader = h['x-apple-oauth-redirect-uri'];
        widgetKeyHeader = h['x-apple-widget-key'];
        originHeader = h['origin'];
        fdClientInfoHeader = h['x-apple-i-fd-client-info'];
        return [
          200,
          {
            iteration: 1000,
            salt: Buffer.alloc(16, 1).toString('base64'),
            protocol: 's2k',
            b: Buffer.alloc(256, 7).toString('base64'),
            c: 'srp-challenge',
          },
          { 'Content-Type': 'application/json' },
        ];
      });

    // signin/complete on the CN host → issue the session token.
    nock('https://idmsa.apple.com.cn')
      .post('/appleauth/auth/signin/complete')
      .query(true)
      .reply(200, { authType: 'hsa2' }, {
        'Content-Type': 'application/json',
        'X-Apple-Session-Token': VALID_TOKEN,
        'X-Apple-ID-Session-Id': SESSION_ID_VALUE,
        scnt: SCNT_VALUE,
        'X-Apple-ID-Account-Country': ACCOUNT_COUNTRY_VALUE,
      });

    // accountLogin against the CN setup host → trusted login payload.
    const loginWorking = JSON.parse(
      await fs.readFile(
        path.join(__dirname, 'fixtures', 'account-login.json'),
        'utf8',
      ),
    );
    nock('https://setup.icloud.com.cn')
      .post('/setup/ws/1/accountLogin')
      .reply(200, loginWorking, { 'Content-Type': 'application/json' });

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsicloud-cn-'));
    cleanups.push(async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    });

    const service = await IcloudAuthService.create(
      {
        accountName: AUTHENTICATED_USER,
        password: VALID_PASSWORD,
        cookieDir: dir,
        chinaMainland: true,
      },
      stubSecrets(),
    );

    // Host switched to .com.cn ...
    expect(signinHost).toContain('idmsa.apple.com.cn');
    // ... but the OAuth redirect + widget key stay GLOBAL (preserve).
    expect(redirectHeader).toBe(OAUTH.REDIRECT_URI);
    expect(redirectHeader).toBe('https://www.icloud.com');
    expect(widgetKeyHeader).toBe(OAUTH.CLIENT_ID);

    // The Origin tracks the (CN) auth host and the fraud-detection client-info
    // header is present — both required or Apple 404s the SRP endpoints.
    expect(originHeader).toBe('https://idmsa.apple.com.cn');
    expect(fdClientInfoHeader).toBeDefined();
    expect(JSON.parse(fdClientInfoHeader as string)).toMatchObject({ V: '1.1' });

    // The CN account-login fixture still resolved correctly.
    expect(service.getWebserviceUrl('drivews')).toBe(
      'https://p31-drivews.icloud.com:443',
    );

    // PyiCloudAPIResponseException import kept meaningful (error-type contract).
    expect(PyiCloudAPIResponseException).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 8. withFamily option (parity with Python `with_family`)
// ---------------------------------------------------------------------------

describe('withFamily option', () => {
  it('defaults to true when not supplied', async () => {
    const service = await auth();
    expect(service.withFamily).toBe(true);

    // It threads into the FindMyiPhone service (refreshClient `fmly` flag).
    const fmip = await service.findMyiPhone();
    expect((fmip as unknown as { withFamily: boolean }).withFamily).toBe(true);
  });

  it('is honored when explicitly set to false', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsicloud-fam-'));
    cleanups.push(async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    });

    const service = await IcloudAuthService.create(
      {
        accountName: AUTHENTICATED_USER,
        password: VALID_PASSWORD,
        cookieDir: dir,
        withFamily: false,
      },
      stubSecrets(),
    );

    expect(service.withFamily).toBe(false);

    // The false flag reaches the constructed FindMyiPhone service.
    const fmip = await service.findMyiPhone();
    expect((fmip as unknown as { withFamily: boolean }).withFamily).toBe(false);
  });
});
