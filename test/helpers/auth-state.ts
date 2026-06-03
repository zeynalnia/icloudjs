/**
 * Closure-based auth state machine for the nock mock router.
 *
 * This mirrors the stateful behaviour of the Python test session mock
 * (`tests/__init__.py::PyiCloudSessionMock`) and binds its constants to the
 * ported fixtures (`tests/const*.py`). Whereas the Python mock cheats by
 * mutating `session_data['session_token']` directly, this machine threads the
 * multi-step handshake the way Apple really does: `signin` issues a session
 * token (returned by the router as the `X-Apple-Session-Token` response header,
 * harvested by the HTTP response interceptor) which then gates the subsequent
 * `accountLogin` branch.
 *
 * The state is a module-level singleton reset between tests via
 * {@link resetAuthState} (call it in an `afterEach`, alongside `nock.cleanAll`),
 * which also fixes the Python `TRUSTED_DEVICE_1.update(...)` test-isolation
 * hazard — the trusted-device comparison here clones the fixture per check
 * instead of mutating a shared singleton.
 *
 * NOTE: the constants below are bound to `tests/const.py` /
 * `tests/const_account_family.py` and the ported fixtures, NOT hard-coded
 * literals: `AUTHENTICATED_USER === PRIMARY_EMAIL`, and `VALID_USERS` includes
 * the `APPLE_ID_EMAIL` / `ICLOUD_ID_EMAIL` aliases. Keep PERSON_ID / email
 * derivations consistent with the fixtures (`PERSON_ID = (first+last).lower()`,
 * emails `@{hotmail.fr,me.com,icloud.com}`).
 */

// ---------------------------------------------------------------------------
// Constants (bound to tests/const_account_family.py + tests/const.py)
// ---------------------------------------------------------------------------

/** `(FIRST_NAME + LAST_NAME).toLowerCase()` — see const_account_family.py. */
export const FIRST_NAME = 'Quentin';
export const LAST_NAME = 'TARANTINO';
export const FULL_NAME = `${FIRST_NAME} ${LAST_NAME}`;
export const PERSON_ID = (FIRST_NAME + LAST_NAME).toLowerCase();

/** Primary Apple ID + the two aliases (`@hotmail.fr` / `@me.com` / `@icloud.com`). */
export const PRIMARY_EMAIL = `${PERSON_ID}@hotmail.fr`;
export const APPLE_ID_EMAIL = `${PERSON_ID}@me.com`;
export const ICLOUD_ID_EMAIL = `${PERSON_ID}@icloud.com`;

/** `AUTHENTICATED_USER === PRIMARY_EMAIL` (const.py). */
export const AUTHENTICATED_USER = PRIMARY_EMAIL;

/** The user whose signin yields a 2FA-required session token. */
export const REQUIRES_2FA_USER = 'requires_2fa_user';
export const REQUIRES_2FA_TOKEN = 'requires_2fa_token';

/** Every accountName accepted by `signin`. */
export const VALID_USERS: readonly string[] = [
  AUTHENTICATED_USER,
  REQUIRES_2FA_USER,
  APPLE_ID_EMAIL,
  ICLOUD_ID_EMAIL,
];

export const VALID_PASSWORD = 'valid_password';
export const VALID_COOKIE = 'valid_cookie';
export const VALID_TOKEN = 'valid_token';

/** Tokens accepted by `accountLogin` (`dsWebAuthToken`). */
export const VALID_TOKENS: readonly string[] = [VALID_TOKEN, REQUIRES_2FA_TOKEN];

/**
 * 2FA security-code path value (`verify/trusteddevice/securitycode`). The 2SA
 * `validateVerificationCode` path uses a DIFFERENT value (`verificationCode:'0'`,
 * see {@link TRUSTED_DEVICE_VERIFICATION_CODE}) — do not cross them.
 */
export const VALID_2FA_CODE = '000000';

export const CLIENT_ID = 'client_id';

/** `{authType:'hsa2'}` returned by a successful `signin` (const_login.py). */
export const AUTH_OK = { authType: 'hsa2' } as const;

/**
 * The single 2SA trusted device (const_login.py `TRUSTED_DEVICE_1`).
 * Exported as a deep-clone factory so tests never share a mutable singleton.
 */
export function trustedDevice1(): Record<string, unknown> {
  return {
    deviceType: 'SMS',
    areaCode: '',
    phoneNumber: '*******58',
    deviceId: '1',
  };
}

/**
 * The value the 2SA `validateVerificationCode` path compares against. The
 * Python source mutates the module-level `TRUSTED_DEVICE_1` fixture in place
 * (`TRUSTED_DEVICE_1.update({verificationCode:'0', trustBrowser:true})`); here
 * we clone instead. This is the string `'0'`, NOT the 2FA `'000000'`.
 */
export const TRUSTED_DEVICE_VERIFICATION_CODE = '0';

// ---------------------------------------------------------------------------
// Apple auth response headers (harvested by the HTTP response interceptor)
// ---------------------------------------------------------------------------

/**
 * The five `HEADER_DATA` headers the response interceptor copies into
 * sessionData, plus `scnt`. Stable test values; `X-Apple-Session-Token` is
 * filled in dynamically per response by the state machine.
 */
export const SCNT_VALUE = 'test-scnt';
export const SESSION_ID_VALUE = 'test-session-id';
export const ACCOUNT_COUNTRY_VALUE = 'FRA';
export const TRUST_TOKEN_VALUE = 'test-trust-token';

// ---------------------------------------------------------------------------
// Closure state machine
// ---------------------------------------------------------------------------

export interface AuthMachineState {
  /** The session token last issued by `signin` (echoed as the response header). */
  issuedSessionToken: string | null;
  /** Whether `2sv/trust` has been completed in this test. */
  trusted: boolean;
}

function freshState(): AuthMachineState {
  return { issuedSessionToken: null, trusted: false };
}

let state: AuthMachineState = freshState();

/** Current mutable auth-machine state (per test). */
export function getAuthState(): AuthMachineState {
  return state;
}

/** Reset between tests (call in `afterEach`, alongside `nock.cleanAll()`). */
export function resetAuthState(): void {
  state = freshState();
}

// ---------------------------------------------------------------------------
// Routing decisions (pure-ish; only `signin`/`trust` mutate machine state)
// ---------------------------------------------------------------------------

/** Result for a routed request: a JSON body (+optional headers) or a 204. */
export interface RouteResult {
  status: number;
  /** Parsed JSON body to return; `undefined`/empty string for 204. */
  body?: unknown;
  /** Extra response headers (e.g. the harvested X-Apple-* family). */
  headers?: Record<string, string>;
}

/** A normalised error the router converts into an iCloud error response body. */
export interface RouteError {
  /** Mirrors `_raise_error(code, reason)` — reason becomes `errorMessage`. */
  reason: string;
  code?: string | number;
  status?: number;
}

export function isRouteError(x: RouteResult | RouteError): x is RouteError {
  return (x as RouteError).reason !== undefined;
}

/**
 * Build the harvested auth-response header bag. Always returns session_id /
 * scnt / account_country; includes `X-Apple-Session-Token` when a token is
 * issued and the trust token only after `2sv/trust`.
 */
function authHeaders(sessionToken?: string, includeTrust = false): Record<string, string> {
  const h: Record<string, string> = {
    'X-Apple-ID-Session-Id': SESSION_ID_VALUE,
    scnt: SCNT_VALUE,
    'X-Apple-ID-Account-Country': ACCOUNT_COUNTRY_VALUE,
  };
  if (sessionToken) h['X-Apple-Session-Token'] = sessionToken;
  if (includeTrust) h['X-Apple-TwoSV-Trust-Token'] = TRUST_TOKEN_VALUE;
  return h;
}

/**
 * `POST {AUTH}/signin` — validate credentials, issue a session token (returned
 * as `X-Apple-Session-Token`), and return `AUTH_OK`. The issued token gates the
 * subsequent `accountLogin` branch (VALID_TOKEN vs REQUIRES_2FA_TOKEN).
 */
export function decideSignin(body: Record<string, any>): RouteResult | RouteError {
  const accountName = body?.accountName;
  const password = body?.password;
  if (!VALID_USERS.includes(accountName) || password !== VALID_PASSWORD) {
    return { reason: 'Unknown reason' };
  }
  const token = accountName === REQUIRES_2FA_USER ? REQUIRES_2FA_TOKEN : VALID_TOKEN;
  state.issuedSessionToken = token;
  return { status: 200, body: { ...AUTH_OK }, headers: authHeaders(token) };
}

/**
 * `POST {SETUP}/accountLogin` — exchange `dsWebAuthToken` for the full payload.
 * Returns the 2FA login fixture for the 2FA token, else the working login.
 */
export function decideAccountLogin(
  body: Record<string, any>,
  loginWorking: unknown,
  login2fa: unknown,
): RouteResult | RouteError {
  const token = body?.dsWebAuthToken;
  if (!VALID_TOKENS.includes(token)) {
    return { reason: 'Unknown reason' };
  }
  if (token === REQUIRES_2FA_TOKEN) {
    return { status: 200, body: login2fa };
  }
  return { status: 200, body: loginWorking };
}

/**
 * `POST {SETUP}/validate` — requires the `X-APPLE-WEBAUTH-TOKEN` cookie/header
 * to equal `VALID_COOKIE`, else `'Session expired'`.
 */
export function decideValidate(
  webauthToken: string | undefined,
  loginWorking: unknown,
): RouteResult | RouteError {
  if (webauthToken === VALID_COOKIE) {
    return { status: 200, body: loginWorking };
  }
  return { reason: 'Session expired' };
}

/**
 * `POST {AUTH}/verify/trusteddevice/securitycode` (2FA). `-21669`-style wrong
 * code yields an error (`'Incorrect code'`); the correct `VALID_2FA_CODE`
 * yields a 204 and re-issues a VALID session token.
 */
export function decideSecurityCode(body: Record<string, any>): RouteResult | RouteError {
  const code = body?.securityCode?.code;
  if (code !== VALID_2FA_CODE) {
    return { reason: 'Incorrect code' };
  }
  state.issuedSessionToken = VALID_TOKEN;
  return { status: 204, headers: authHeaders(VALID_TOKEN) };
}

/**
 * `POST {SETUP}/sendVerificationCode` (2SA) — success iff the posted body
 * equals the trusted-device fixture exactly.
 */
export function decideSendVerificationCode(
  body: Record<string, any>,
  verificationOk: unknown,
  verificationKo: unknown,
): RouteResult {
  if (deepEqual(body, trustedDevice1())) {
    return { status: 200, body: verificationOk };
  }
  return { status: 200, body: verificationKo };
}

/**
 * `POST {SETUP}/validateVerificationCode` (2SA) — compares the posted body
 * against the trusted device augmented with `verificationCode:'0'` and
 * `trustBrowser:true`. Match → success; otherwise error (`'FOUND_CODE'`).
 */
export function decideValidateVerificationCode(
  body: Record<string, any>,
  verificationOk: unknown,
): RouteResult | RouteError {
  const expected = {
    ...trustedDevice1(),
    verificationCode: TRUSTED_DEVICE_VERIFICATION_CODE,
    trustBrowser: true,
  };
  if (deepEqual(body, expected)) {
    // Successful 2SA verification re-issues a VALID session token (mirrors the
    // 2FA `securitycode` path) so the subsequent `trustSession` →
    // `accountLogin` exchange returns the trusted working-login payload.
    state.issuedSessionToken = VALID_TOKEN;
    return { status: 200, body: verificationOk, headers: authHeaders(VALID_TOKEN) };
  }
  return { reason: 'FOUND_CODE' };
}

/** `GET {AUTH}/2sv/trust` — 204 + the harvested trust token; marks trusted. */
export function decideTrust(): RouteResult {
  state.trusted = true;
  return { status: 204, headers: authHeaders(undefined, true) };
}

// ---------------------------------------------------------------------------
// Small deep-equality helper (avoids a dep; mirrors Python dict `==`)
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual((a as any)[k], (b as any)[k])) return false;
  }
  return true;
}
