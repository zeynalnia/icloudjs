/**
 * IcloudAuthService — TypeScript port of `pyicloud.base.PyiCloudService`
 * (the auth-lifecycle facade, `base.py:192-617`).
 *
 * Responsibilities:
 *   - the async `create()` factory (no network in constructors — the Python
 *     `__init__` authenticated eagerly; here all network I/O happens in
 *     `create()` / `authenticate()`);
 *   - the exact sign-in flow: try-validate-token → one-factor-service → full
 *     OAuth `signin` → `accountLogin`;
 *   - 2FA (HSA2) and 2SA (HSA1/legacy) verification + session trust;
 *   - resolving the per-account `webservices` URL map;
 *   - FIX #1: populating the shared `params` bag (`dsid` + `clientId` + build
 *     numbers) so Drive / Ubiquity / Photos work (the Python source left
 *     `params` an empty `{}`);
 *   - lazy, cached service accessors (§3.4) that hand each service its resolved
 *     `service_root`, the shared HTTP layer, and the shared `params` bag.
 *
 * China mode (preserve): the three host bases switch to `.com.cn`, but the OAuth
 * widget key / client id / redirect URI in `getAuthHeaders` stay GLOBAL
 * (`https://www.icloud.com`) — matches Apple's auth widget, do not "fix".
 *
 * Secrets: the password and harvested auth tokens are never logged.
 */
import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { v1 as uuidv1 } from 'uuid';

import { BUILD, DEFAULT_USER_AGENT, ENDPOINTS, OAUTH } from '../constants';
import {
  GsaSrpAuthenticator,
  ServerSrpInitResponse,
} from './gsa-srp';
import {
  PyiCloudAPIResponseException,
  PyiCloudException,
  PyiCloudFailedLoginException,
  PyiCloudServiceNotActivatedException,
} from '../exceptions/icloud.exceptions';
import { AccountLoginData } from '../interfaces/login-response.interface';
import { IcloudModuleOptions } from '../interfaces/options.interface';
import { Webservices } from '../interfaces/webservices.interface';
import { SecretsService } from '../secrets/secrets.service';
import { SessionKeyService } from '../secrets/session-key.service';
import {
  Endpoints,
  IcloudAuthLike,
  IcloudHttpService,
} from '../session/icloud-http.service';
import { SessionCipher } from '../session/session-cipher';
import { SessionStore } from '../session/session-store';

// Service classes (constructed lazily by the accessors below). These are plain
// classes — NOT Nest providers — because they need a runtime-resolved
// `service_root` that only exists after login (§3.1).
import { AccountService } from '../services/account.service';
import { CalendarService } from '../services/calendar.service';
import { ContactsService } from '../services/contacts.service';
import { DriveService } from '../services/drive.service';
import { FindMyiPhoneService } from '../services/findmyiphone.service';
import { PhotosService } from '../services/photos.service';
import { RemindersService } from '../services/reminders.service';
import { UbiquityService } from '../services/ubiquity.service';

/** Options accepted by {@link IcloudAuthService.authenticate}. */
export interface AuthenticateOptions {
  /** Skip the validate-token fast path and force a full re-authentication. */
  forceRefresh?: boolean;
  /** One-factor service name (e.g. `'find'`) for the credentials-service path. */
  service?: string;
}

@Injectable()
export class IcloudAuthService implements IcloudAuthLike {
  private readonly logger = new Logger(IcloudAuthService.name);

  /** Full account-login payload (`dsInfo`, `webservices`, `apps`, HSA flags). */
  data: AccountLoginData = {} as AccountLoginData;

  /** Shared, mutable query-param bag threaded into every downstream service. */
  params: Record<string, string> = {};

  /** Apple ID + password. Only `accountName` is read by the HTTP layer; never logged. */
  readonly user: { accountName: string; password: string };

  /** Whether device commands default to including family devices. */
  readonly withFamily: boolean;

  /** Resolved endpoint bases (CN-aware). */
  private readonly endpoints: Endpoints;

  /** Persisted handshake state + cookie jar. */
  private readonly store: SessionStore;

  /** Shared authenticated HTTP layer. */
  private readonly http: IcloudHttpService;

  /** Local client id (also sent as `X-Apple-OAuth-State`); persisted across runs. */
  private readonly clientId: string;

  /** Webservices URL map, set after `authenticate()`. */
  private webservices: Webservices = {};

  // Lazily-constructed, cached service instances (§3.4).
  private _drive?: DriveService;
  private _account?: AccountService;
  private _files?: UbiquityService;
  private _photos?: PhotosService;
  private _calendar?: CalendarService;
  private _contacts?: ContactsService;
  private _reminders?: RemindersService;
  private _fmip?: FindMyiPhoneService;

  private constructor(
    user: { accountName: string; password: string },
    endpoints: Endpoints,
    store: SessionStore,
    http: IcloudHttpService,
    clientId: string,
    withFamily: boolean,
  ) {
    this.user = user;
    this.endpoints = endpoints;
    this.store = store;
    this.http = http;
    this.clientId = clientId;
    this.withFamily = withFamily;
  }

  // -------------------------------------------------------------------------
  // Factory (§3.3) — the single async entry point; network I/O happens here.
  // -------------------------------------------------------------------------

  static async create(
    options: IcloudModuleOptions,
    secrets: SecretsService,
    sessionKey: SessionKeyService = new SessionKeyService(),
  ): Promise<IcloudAuthService> {
    // 1. CN vs global endpoints.
    const base = options.chinaMainland ? ENDPOINTS.china : ENDPOINTS.global;
    const endpoints: Endpoints = {
      AUTH: base.AUTH,
      HOME: base.HOME,
      SETUP: base.SETUP,
      verify: options.verify,
    };

    // 2. Resolve the password (explicit, else from the keyring).
    const password =
      options.password ??
      (await secrets.getPasswordFromKeyring(options.accountName));

    // 3. Sanitise the account name to filename-safe word characters.
    const sanitized = options.accountName.replace(/[^A-Za-z0-9_]/g, '');

    // 4. Cookie directory (default = platform-appropriate per-user state dir,
    //    mode 0o700). See defaultCookieDir() for the platform layout.
    const cookieDir = options.cookieDir ?? IcloudAuthService.defaultCookieDir();
    await fs.mkdir(cookieDir, { recursive: true, mode: 0o700 });

    // 5. Resolve the at-rest encryption key (encryption is default-on; `null`
    //    means plaintext) and build the cipher. A `null` key yields no cipher,
    //    so SessionStore behaves byte-identically to the old plaintext path.
    const key = await sessionKey.resolveKey({
      accountName: options.accountName,
      encrypt: options.encrypt !== false,
      encryptionKeyFile: options.encryptionKeyFile,
    });
    const cipher = key ? new SessionCipher(key) : undefined;

    // 6. Load the persisted session-data + cookie jar.
    const store = await SessionStore.load(cookieDir, sanitized, cipher);

    // 7. client_id: explicit option → persisted → fresh `auth-<uuidv1>`. Persist
    //    it back so trusted-session continuity survives restarts.
    const clientId =
      options.clientId ??
      store.sessionData.client_id ??
      `auth-${uuidv1().toLowerCase()}`;
    store.sessionData.client_id = clientId;
    await store.saveSessionData();

    // 8. HTTP layer with default Origin/Referer + a browser-like User-Agent
    //    (Apple 503s non-browser clients; see DEFAULT_USER_AGENT).
    const http = new IcloudHttpService(store, endpoints, {
      Origin: endpoints.HOME,
      Referer: `${endpoints.HOME}/`,
      'User-Agent': options.userAgent ?? DEFAULT_USER_AGENT,
    });

    // 9. Construct the orchestrator and wire it into the HTTP layer (for the
    //    findme retry re-auth and the 2SA-aware error normalization).
    const svc = new IcloudAuthService(
      { accountName: options.accountName, password },
      endpoints,
      store,
      http,
      clientId,
      options.withFamily ?? true,
    );
    http.bindAuth(svc);

    // 10. Authenticate (network).
    await svc.authenticate();

    // 11. FIX #1 — populate the shared params bag.
    svc.populateParams();

    return svc;
  }

  /**
   * Default cookie/session directory: a stable, per-user, OS-appropriate state
   * directory. We use durable per-user state (not <tmpdir>) so the trusted
   * session survives reboots/tmp cleanup, and rely on the home dir being
   * per-user (no os-username segment needed). Tolerant of headless envs where
   * os.homedir() may throw or be empty — falls back to <tmpdir>/jsicloud.
   */
  private static defaultCookieDir(): string {
    try {
      const home = os.homedir();
      if (home) {
        if (process.platform === 'win32') {
          const base =
            process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
          return path.join(base, 'jsicloud');
        }
        if (process.platform === 'darwin') {
          return path.join(home, 'Library', 'Application Support', 'jsicloud');
        }
        const base =
          process.env.XDG_STATE_HOME || path.join(home, '.local', 'state');
        return path.join(base, 'jsicloud');
      }
    } catch {
      // fall through to the tmpdir fallback below.
    }
    return path.join(os.tmpdir(), 'jsicloud');
  }

  // -------------------------------------------------------------------------
  // Authentication lifecycle (§2.3)
  // -------------------------------------------------------------------------

  /**
   * Handle authentication, persisting cookies so subsequent logins do not
   * trigger additional emails from Apple. Exact flow:
   *   1. session_token present and not forceRefresh → try `_validateToken`;
   *   2. else a one-factor service login when the app supports it;
   *   3. else full OAuth `signin` → `accountLogin`.
   * Then resolve the webservices map.
   */
  async authenticate(opts: AuthenticateOptions = {}): Promise<void> {
    const { forceRefresh = false, service } = opts;
    let loginSuccessful = false;

    if (this.store.sessionData.session_token && !forceRefresh) {
      this.logger.debug('Checking session token validity');
      try {
        this.data = await this._validateToken();
        loginSuccessful = true;
      } catch (err) {
        if (err instanceof PyiCloudAPIResponseException) {
          this.logger.debug(
            'Invalid authentication token, will log in from scratch.',
          );
        } else {
          throw err;
        }
      }
    }

    if (!loginSuccessful && service !== undefined) {
      const app = this.data.apps?.[service];
      if (app && app.canLaunchWithOneFactor) {
        this.logger.debug(
          `Authenticating as ${this.user.accountName} for ${service}`,
        );
        try {
          await this._authenticateWithCredentialsService(service);
          loginSuccessful = true;
        } catch {
          this.logger.debug(
            'Could not log into service. Attempting brand new login.',
          );
        }
      }
    }

    if (!loginSuccessful) {
      this.logger.debug(`Authenticating as ${this.user.accountName}`);

      try {
        await this._signInWithSrp();
      } catch (error) {
        if (error instanceof PyiCloudAPIResponseException) {
          throw new PyiCloudFailedLoginException(
            'Invalid email/password combination.',
            error,
          );
        }
        throw error;
      }

      await this._authenticateWithToken();
    }

    this.webservices = this.data.webservices ?? {};
    this.logger.debug('Authentication completed successfully');
  }

  /**
   * Full sign-in via Apple's GSA SRP-6a handshake (§2.3, modern flow):
   *   1. `POST {AUTH}/signin/init`  — send the SRP public value `A`, receive
   *      the server salt/`B`/iteration/protocol/challenge.
   *   2. `POST {AUTH}/signin/complete?isRememberMeEnabled=true` — prove the
   *      password with `M1`/`M2` (+ rememberMe + any trust token).
   *
   * This replaces the deprecated plaintext `POST /signin`, which Apple now
   * answers with `503 Service Temporarily Unavailable`. The password never
   * leaves the process: only `A`/`M1`/`M2` are transmitted.
   *
   * A `GET {AUTH}/authorize/signin` warm-up runs first: it establishes the
   * server-side OAuth state/cookies the SRP endpoints require — without it Apple
   * answers `signin/init` with `404 Not Found`.
   */
  private async _signInWithSrp(): Promise<void> {
    const authenticator = new GsaSrpAuthenticator(this.user.accountName);

    await this._authorizeSignin();

    const init = await authenticator.getInit();
    const initResp = await this.http.request<ServerSrpInitResponse>(
      'POST',
      `${this.endpoints.AUTH}/signin/init`,
      { data: JSON.stringify(init), headers: this.getAuthHeaders() },
    );

    const proof = await authenticator.getComplete(
      this.user.password,
      initResp.data,
    );

    const trustTokens = this.store.sessionData.trust_token
      ? [this.store.sessionData.trust_token]
      : [];

    await this.http.request('POST', `${this.endpoints.AUTH}/signin/complete`, {
      params: { isRememberMeEnabled: 'true' },
      data: JSON.stringify({ ...proof, rememberMe: true, trustTokens }),
      headers: this.getAuthHeaders(),
    });
  }

  /**
   * `GET {AUTH}/authorize/signin` — the OAuth widget warm-up. Apple requires
   * this before the SRP `signin/init`/`signin/complete` calls (it seeds the
   * server state/cookies they key off); skipping it yields `404` on init. The
   * HTML body is ignored — only the resulting cookies matter, and they are
   * captured by the shared cookie jar.
   */
  private async _authorizeSignin(): Promise<void> {
    await this.http.request('GET', `${this.endpoints.AUTH}/authorize/signin`, {
      params: {
        frame_id: this.clientId,
        skVersion: '7',
        iframeid: this.clientId,
        client_id: OAUTH.CLIENT_ID,
        response_type: 'code',
        redirect_uri: OAUTH.REDIRECT_URI,
        response_mode: 'web_message',
        state: this.clientId,
        authVersion: 'latest',
      },
      responseType: 'arraybuffer',
    });
  }

  /** Exchange the harvested `session_token` for the full account payload. */
  private async _authenticateWithToken(): Promise<void> {
    const data = {
      accountCountryCode: this.store.sessionData.account_country,
      dsWebAuthToken: this.store.sessionData.session_token,
      extended_login: true,
      trustToken: this.store.sessionData.trust_token ?? '',
    };

    try {
      const resp = await this.http.request<AccountLoginData>(
        'POST',
        `${this.endpoints.SETUP}/accountLogin`,
        { data: JSON.stringify(data) },
      );
      this.data = resp.data;
    } catch (error) {
      if (error instanceof PyiCloudAPIResponseException) {
        throw new PyiCloudFailedLoginException(
          'Invalid authentication token.',
          error,
        );
      }
      throw error;
    }
  }

  /** One-factor service login (`{SETUP}/accountLogin` then `_validateToken`). */
  private async _authenticateWithCredentialsService(
    service: string,
  ): Promise<void> {
    const data = {
      appName: service,
      apple_id: this.user.accountName,
      password: this.user.password,
    };

    try {
      await this.http.request('POST', `${this.endpoints.SETUP}/accountLogin`, {
        data: JSON.stringify(data),
      });
      this.data = await this._validateToken();
    } catch (error) {
      if (error instanceof PyiCloudAPIResponseException) {
        throw new PyiCloudFailedLoginException(
          'Invalid email/password combination.',
        );
      }
      throw error;
    }
  }

  /**
   * Validate the current session token: `POST {SETUP}/validate` with the raw
   * body literal string `'null'` (Content-Type application/json). Returns the
   * dsInfo/webservices payload.
   */
  private async _validateToken(): Promise<AccountLoginData> {
    this.logger.debug('Checking session token validity');
    const resp = await this.http.request<AccountLoginData>(
      'POST',
      `${this.endpoints.SETUP}/validate`,
      { data: 'null', headers: { 'Content-Type': 'application/json' } },
    );
    this.logger.debug('Session token is still valid');
    return resp.data;
  }

  // -------------------------------------------------------------------------
  // OAuth auth headers (§2.4)
  // -------------------------------------------------------------------------

  /**
   * Build the OAuth headers sent on `signin`, 2FA verify, and trust calls. The
   * widget key / client id / redirect URI are GLOBAL even in China mode
   * (preserve). `scnt` and `X-Apple-ID-Session-Id` are echoed from sessionData
   * when present; `overrides` win (2FA sets `Accept: application/json`).
   */
  getAuthHeaders(overrides?: Record<string, string>): Record<string, string> {
    // The AUTH (idmsa) calls must present an idmsa Origin/Referer and the fraud
    // -detection client-info header, or Apple answers the SRP endpoints with
    // `404 Not Found` (matches the working `icloud.js` AUTH_HEADERS). The Origin
    // tracks the (possibly `.com.cn`) auth host; the OAuth widget/redirect stay
    // GLOBAL even in CN (preserve — matches Apple's auth widget).
    const authOrigin = new URL(this.endpoints.AUTH).origin;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: authOrigin,
      Referer: `${authOrigin}/`,
      'X-Apple-OAuth-Client-Id': OAUTH.CLIENT_ID,
      'X-Apple-OAuth-Client-Type': 'firstPartyAuth',
      'X-Apple-OAuth-Redirect-URI': OAUTH.REDIRECT_URI,
      'X-Apple-OAuth-Require-Grant-Code': 'true',
      'X-Apple-OAuth-Response-Mode': 'web_message',
      'X-Apple-OAuth-Response-Type': 'code',
      'X-Apple-OAuth-State': this.clientId,
      'X-Apple-Widget-Key': OAUTH.CLIENT_ID,
      'X-Apple-I-FD-Client-Info': JSON.stringify({
        U: DEFAULT_USER_AGENT,
        L: 'en-US',
        Z: 'GMT+00:00',
        V: '1.1',
        F: '',
      }),
    };

    // Echo the multi-step handshake headers (the HTTP request interceptor also
    // echoes these, but the Python source sets them explicitly here too).
    if (this.store.sessionData.scnt) {
      headers.scnt = this.store.sessionData.scnt;
    }
    if (this.store.sessionData.session_id) {
      headers['X-Apple-ID-Session-Id'] = this.store.sessionData.session_id;
    }

    if (overrides) {
      Object.assign(headers, overrides);
    }
    return headers;
  }

  // -------------------------------------------------------------------------
  // FIX #1 — params population
  // -------------------------------------------------------------------------

  /**
   * Populate the shared `params` bag after login. The Python source left
   * `self.params = {}` (latent regression) yet Drive needs `params.clientId` and
   * Ubiquity needs `params.dsid`, so we populate both here, plus the build-number
   * constants. NOTE: no fixture pins the build-number strings (Python never
   * populated params at all) — tests assert only `clientId` + `dsid` presence.
   */
  populateParams(): void {
    this.params = {
      clientBuildNumber: BUILD.clientBuildNumber,
      clientMasteringNumber: BUILD.clientMasteringNumber,
      ckjsBuildVersion: BUILD.ckjsBuildVersion,
      clientId: this.store.sessionData.client_id ?? this.clientId,
      dsid: String(this.data.dsInfo?.dsid ?? ''),
    };
  }

  // -------------------------------------------------------------------------
  // 2FA / 2SA state (§2.6-2.8) — hardened with optional chaining (FIX #5).
  // -------------------------------------------------------------------------

  /**
   * True when two-factor (HSA2) authentication is required.
   *
   * FIX #5: hardened with optional chaining (`data?.dsInfo?.hsaVersion`) — the
   * Python `requires_2fa` indexed `data['dsInfo']` directly and raised KeyError
   * when `dsInfo` was absent (asymmetric with `requires_2sa`).
   */
  get requires2fa(): boolean {
    return (
      this.data?.dsInfo?.hsaVersion === 2 &&
      (!!this.data?.hsaChallengeRequired || !this.isTrustedSession)
    );
  }

  /** True when two-step (HSA1/legacy) authentication is required. */
  get requires2sa(): boolean {
    return (
      (this.data?.dsInfo?.hsaVersion ?? 0) >= 1 &&
      (!!this.data?.hsaChallengeRequired || !this.isTrustedSession)
    );
  }

  /** True when the current browser/session is already trusted. */
  get isTrustedSession(): boolean {
    return this.data?.hsaTrustedBrowser ?? false;
  }

  /** Devices trusted for two-step authentication (`{SETUP}/listDevices`). */
  get trustedDevices(): Promise<Array<Record<string, unknown>>> {
    return (async () => {
      const resp = await this.http.request<{
        devices?: Array<Record<string, unknown>>;
      }>('GET', `${this.endpoints.SETUP}/listDevices`, { params: this.params });
      return resp.data.devices ?? [];
    })();
  }

  /** Request that a verification code be sent to `device` (`{SETUP}/sendVerificationCode`). */
  async sendVerificationCode(device: Record<string, unknown>): Promise<boolean> {
    const resp = await this.http.request<{ success?: boolean }>(
      'POST',
      `${this.endpoints.SETUP}/sendVerificationCode`,
      { params: this.params, data: JSON.stringify(device) },
    );
    return resp.data.success ?? false;
  }

  /**
   * Verify a 2SA verification code received on a trusted device. A `-21669`
   * error code (wrong code) resolves to `false` rather than throwing. On success
   * the session is trusted and `!requires2sa` is returned.
   */
  async validateVerificationCode(
    device: Record<string, unknown>,
    code: string,
  ): Promise<boolean> {
    const payload = { ...device, verificationCode: code, trustBrowser: true };

    try {
      await this.http.request(
        'POST',
        `${this.endpoints.SETUP}/validateVerificationCode`,
        { params: this.params, data: JSON.stringify(payload) },
      );
    } catch (error) {
      if (
        error instanceof PyiCloudAPIResponseException &&
        error.code === -21669
      ) {
        return false; // Wrong verification code.
      }
      throw error;
    }

    await this.trustSession();
    return !this.requires2sa;
  }

  /**
   * Ask Apple to deliver an HSA2 verification code.
   *
   * Unlike the legacy plaintext flow, Apple does **not** auto-push a code for
   * API (non-browser) SRP sessions — it must be requested explicitly. This
   * triggers the trusted-device push (`GET {AUTH}/verify/trusteddevice`) and,
   * when the account has a trusted phone number, an SMS
   * (`PUT {AUTH}/verify/phone` with `mode: 'sms'`). Best-effort: individual
   * delivery failures are swallowed (one channel succeeding is enough), and the
   * whole call is a no-op when 2FA is not required.
   */
  async requestTwoFactorCode(): Promise<void> {
    if (!this.requires2fa) {
      return;
    }
    const headers = this.getAuthHeaders({ Accept: 'application/json' });

    // Discover trusted phone numbers (for the SMS fallback).
    let phoneId: number | string | undefined;
    try {
      const opts = await this.http.request<{
        trustedPhoneNumbers?: Array<{ id: number | string }>;
        trustedPhoneNumber?: { id: number | string };
      }>('GET', this.endpoints.AUTH, { headers });
      const numbers = opts.data?.trustedPhoneNumbers;
      phoneId =
        opts.data?.trustedPhoneNumber?.id ??
        (Array.isArray(numbers) && numbers.length ? numbers[0].id : undefined);
    } catch {
      // Ignore — still attempt the trusted-device push below.
    }

    // Trusted-device push.
    try {
      await this.http.request(
        'GET',
        `${this.endpoints.AUTH}/verify/trusteddevice`,
        { headers },
      );
      this.logger.debug('Requested 2FA code via trusted device push');
    } catch {
      this.logger.debug('Could not request 2FA device push');
    }

    // SMS fallback when a trusted phone number is known.
    if (phoneId !== undefined) {
      try {
        await this.http.request('PUT', `${this.endpoints.AUTH}/verify/phone`, {
          data: JSON.stringify({ phoneNumber: { id: phoneId }, mode: 'sms' }),
          headers,
        });
        this.logger.debug('Requested 2FA code via SMS');
      } catch {
        this.logger.debug('Could not request 2FA SMS code');
      }
    }
  }

  /**
   * Verify a 2FA code received via Apple's HSA2 system. A `-21669` error code
   * (wrong code) resolves to `false`. On success the session is trusted and
   * `!requires2sa` is returned.
   */
  async validate2faCode(code: string): Promise<boolean> {
    const data = { securityCode: { code } };
    const headers = this.getAuthHeaders({ Accept: 'application/json' });

    try {
      await this.http.request(
        'POST',
        `${this.endpoints.AUTH}/verify/trusteddevice/securitycode`,
        { data: JSON.stringify(data), headers },
      );
    } catch (error) {
      if (
        error instanceof PyiCloudAPIResponseException &&
        error.code === -21669
      ) {
        this.logger.error('Code verification failed.');
        return false; // Wrong verification code.
      }
      throw error;
    }

    this.logger.debug('Code verification successful.');
    await this.trustSession();
    return !this.requires2sa;
  }

  /**
   * Request session trust (`GET {AUTH}/2sv/trust`) so future logins avoid the
   * verification prompt. The `X-Apple-TwoSV-Trust-Token` response header is
   * harvested by the HTTP interceptor; we then re-run `_authenticateWithToken`.
   * Returns `false` (not throwing) on a caught API failure.
   */
  async trustSession(): Promise<boolean> {
    const headers = this.getAuthHeaders();
    try {
      await this.http.request('GET', `${this.endpoints.AUTH}/2sv/trust`, {
        headers,
      });
      await this._authenticateWithToken();
      return true;
    } catch (error) {
      if (error instanceof PyiCloudException) {
        this.logger.error('Session trust failed.');
        return false;
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Webservice URL resolution (§2.10)
  // -------------------------------------------------------------------------

  /** Resolve a webservice root URL; throws if the service is not activated. */
  getWebserviceUrl(key: string): string {
    const entry = this.webservices[key];
    if (!entry || !entry.url) {
      throw new PyiCloudServiceNotActivatedException(
        'Webservice not available',
        key,
      );
    }
    return entry.url;
  }

  // -------------------------------------------------------------------------
  // Lazy, cached service accessors (§3.4)
  //
  // Each accessor resolves the service_root at call time (it only exists after
  // login) and hands the service the shared HTTP layer + the shared `params`
  // bag. Services requiring async init (`findMyiPhone`, `photos`, `reminders`,
  // `contacts`) are exposed via async methods that call `init()` once.
  // -------------------------------------------------------------------------

  /** iCloud Drive (CloudDocs). Lazy + cached. */
  get drive(): DriveService {
    return (this._drive ??= new DriveService(
      this.getWebserviceUrl('drivews'),
      this.getWebserviceUrl('docws'),
      this.http,
      this.params,
    ));
  }

  /** Account service (devices, family, storage). Lazy + cached. */
  get account(): AccountService {
    return (this._account ??= new AccountService(
      this.getWebserviceUrl('account'),
      this.http,
      this.params,
      this.endpoints.SETUP, // FIX #2: CN-aware storage URL.
    ));
  }

  /** Legacy Ubiquity file service (read-only). Lazy + cached. */
  get files(): UbiquityService {
    return (this._files ??= new UbiquityService(
      this.getWebserviceUrl('ubiquity'),
      this.http,
      this.params,
    ));
  }

  /** Calendar service. Lazy + cached. */
  get calendar(): CalendarService {
    return (this._calendar ??= new CalendarService(
      this.getWebserviceUrl('calendar'),
      this.http,
      this.params,
    ));
  }

  /** Contacts service. Lazy + cached. */
  get contacts(): ContactsService {
    return (this._contacts ??= new ContactsService(
      this.getWebserviceUrl('contacts'),
      this.http,
      this.params,
    ));
  }

  /** Photos service (CloudKit). Async init runs the indexing probe once. */
  async photos(): Promise<PhotosService> {
    if (!this._photos) {
      const svc = new PhotosService(
        this.getWebserviceUrl('ckdatabasews'),
        this.http,
        this.params,
      );
      await svc.init();
      this._photos = svc;
    }
    return this._photos;
  }

  /** Reminders service. Async init runs the startup refresh once. */
  async reminders(): Promise<RemindersService> {
    if (!this._reminders) {
      const svc = new RemindersService(
        this.getWebserviceUrl('reminders'),
        this.http,
        this.params,
      );
      await svc.init();
      this._reminders = svc;
    }
    return this._reminders;
  }

  /** Find My iPhone service. Async init runs the device-list refresh once. */
  async findMyiPhone(): Promise<FindMyiPhoneService> {
    if (!this._fmip) {
      const svc = new FindMyiPhoneService(
        this.getWebserviceUrl('findme'),
        this.http,
        this.params,
        this.withFamily,
      );
      await svc.init();
      this._fmip = svc;
    }
    return this._fmip;
  }
}
