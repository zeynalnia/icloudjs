/**
 * IcloudHttpService — TypeScript port of `pyicloud.base.PyiCloudSession`
 * (`base.py:request`, lines 64-161).
 *
 * This is the single authenticated HTTP chokepoint shared by every iCloud
 * service client. It owns:
 *
 *   - an axios instance wrapped by `axios-cookiejar-support` so the
 *     tough-cookie jar (the `X-APPLE-WEBAUTH-*` cookie family) is sent and
 *     harvested automatically on every call;
 *   - a REQUEST interceptor that echoes the multi-step handshake headers
 *     (`scnt` + `X-Apple-ID-Session-Id`) back from `sessionData`, plus the
 *     default Origin/Referer headers;
 *   - a RESPONSE interceptor that harvests the five `HEADER_DATA` response
 *     headers into the mutable `sessionData` and then persists session-data +
 *     cookies to disk (mirrors the Python per-request persist, needed to resume
 *     a trusted session);
 *   - error normalization (`validateStatus` is ALWAYS true, so axios never
 *     throws on status — we parse the body and raise typed exceptions
 *     ourselves);
 *   - a SINGLE transparent retry guarded by `_retried`, firing ONLY when the
 *     status is in {421,450,500}; with a Find-My-iPhone re-auth branch
 *     (450 → full sign-in, else → `'find'` one-factor) before the retry.
 *
 * Secrets (the password and the harvested auth tokens) are NEVER logged: debug
 * logging is scrubbed through `redactSecret` and never emits header values.
 *
 * §8.1 (precise retry semantics): the outer gate
 *   `!ok AND (content-type not JSON OR status in {421,450,500})`
 * only decides error-handling-vs-raw-return. The actual single retry (both the
 * findme re-auth path AND the generic retry) fires ONLY when
 * `status ∈ {421,450,500} AND !_retried`. A non-JSON response that is NOT
 * 421/450/500 falls straight through to `raiseError` with NO retry. And a
 * SUCCESSFUL (ok) stream/arraybuffer download — which also has a non-JSON
 * content-type — never enters the retry/raise/parse path at all, because the
 * gate requires `!ok` first.
 */
import { Injectable, Logger } from '@nestjs/common';
import axios, {
  AxiosInstance,
  AxiosResponse,
  Method,
  RawAxiosRequestHeaders,
} from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { Cookie, Store } from 'tough-cookie';

import { HEADER_DATA } from '../constants';
import { SessionData } from '../interfaces/session-data.interface';
import { redactSecret } from '../util/redact';
import { SessionStore } from './session-store';
import { extractReasonCode, raiseError } from './error-normalizer';

/** Endpoint bases handed to the HTTP layer (AUTH/HOME/SETUP + TLS toggle). */
export interface Endpoints {
  AUTH: string;
  HOME: string;
  SETUP: string;
  /** TLS verification toggle / CA bundle path; `false` disables verification. */
  verify?: boolean | string;
}

/**
 * The slice of `IcloudAuthService` that the HTTP layer needs for re-auth and
 * 2SA-aware error normalization. Declared as an interface (not the concrete
 * class) to avoid a circular import between the session and auth layers.
 */
export interface IcloudAuthLike {
  /** Apple ID + password; only `accountName` is read here (never logged). */
  readonly user: { accountName: string; password: string };
  /** True when the account currently requires two-step authentication. */
  readonly requires2sa: boolean;
  /** Resolve a webservice root URL (throws if the service is not activated). */
  getWebserviceUrl(key: string): string;
  /** Re-authenticate (used by the findme retry branch). */
  authenticate(opts?: { forceRefresh?: boolean; service?: string }): Promise<void>;
}

/** Options for {@link IcloudHttpService.request}. */
export interface IcloudRequestOptions {
  /** Raw request body (string or object); pyicloud passes `json.dumps` as `data=`. */
  data?: unknown;
  /** Query-string params. */
  params?: Record<string, string>;
  /** Per-request headers (merged over the echoed/default headers). */
  headers?: Record<string, string>;
  /** Response handling: JSON parse (default), or a binary download. */
  responseType?: 'json' | 'stream' | 'arraybuffer';
  /**
   * Internal single-retry guard. When already `true`, a 421/450/500 response is
   * raised instead of retried (exactly one retry). Callers never set this.
   */
  _retried?: boolean;
}

/** HTTP statuses that trigger the single re-auth/retry (matches pyicloud). */
const RETRY_STATUSES = [421, 450, 500];

/** Content types treated as JSON for error-vs-raw handling (matches pyicloud). */
const JSON_MIMETYPES = ['application/json', 'text/json'];

@Injectable()
export class IcloudHttpService {
  private readonly logger = new Logger(IcloudHttpService.name);

  /** axios instance wrapped with cookie-jar support. */
  private readonly client: AxiosInstance;

  /** Bound after construction via {@link bindAuth} (for retry re-auth + 2SA ctx). */
  private auth?: IcloudAuthLike;

  constructor(
    private readonly store: SessionStore,
    private readonly endpoints: Endpoints,
    private readonly defaultHeaders: Record<string, string>,
  ) {
    // validateStatus ALWAYS true: axios never throws on an HTTP status; we do
    // all error handling ourselves in request() so the Python error/retry
    // semantics are reproduced exactly.
    const base = axios.create({
      jar: this.store.jar,
      withCredentials: true,
      validateStatus: () => true,
      // TLS verification: `false` disables cert checks (testing only).
      ...(this.endpoints.verify === false
        ? { httpsAgent: undefined }
        : {}),
    } as never);

    this.client = wrapper(base);

    this.registerRequestInterceptor();
    this.registerResponseInterceptor();
  }

  /** The live, mutable handshake bag (harvested from response headers). */
  get sessionData(): SessionData {
    return this.store.sessionData;
  }

  /**
   * Read the cookies the jar would send for `url` as structured tough-cookie
   * objects (each exposing `.key` and `.value`). Used by the Drive service to
   * extract the `X-APPLE-WEBAUTH-VALIDATE` upload token from the cookie jar
   * (the Python source iterates `self.session.cookies` directly).
   */
  async getCookies(url: string): Promise<Array<{ key: string; value: string }>> {
    return this.store.jar.getCookies(url);
  }

  /**
   * Return EVERY cookie in the jar, regardless of domain/path scoping. This
   * mirrors the Python source, which iterates `self.session.cookies` directly
   * (drive.py `_get_token_from_cookie`). Apple sets the
   * `X-APPLE-WEBAUTH-VALIDATE` upload token on the home/login host
   * (e.g. www.icloud.com), NOT on the per-account docws host — so a
   * domain-scoped `getCookies(docwsUrl)` lookup would miss it. We reach into
   * the jar's underlying tough-cookie store and pull the full list.
   */
  async getAllCookies(): Promise<Cookie[]> {
    // `CookieJar.store` is not surfaced by @types/tough-cookie but is part of
    // the runtime contract (the default MemoryCookieStore exposes
    // getAllCookies). Cast through the typed Store to call it safely.
    const store = (this.store.jar as unknown as { store: Store }).store;
    return new Promise<Cookie[]>((resolve, reject) => {
      store.getAllCookies((err, cookies) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(cookies);
      });
    });
  }

  /**
   * Wire the auth orchestrator in after both objects exist (resolves the
   * session↔auth cycle). Needed for the findme retry re-auth and for the 2SA
   * branch of error normalization.
   */
  bindAuth(auth: IcloudAuthLike): void {
    this.auth = auth;
  }

  // -------------------------------------------------------------------------
  // Interceptors
  // -------------------------------------------------------------------------

  /**
   * REQUEST interceptor: echo the handshake headers from sessionData
   * (`scnt`, `X-Apple-ID-Session-Id`) and merge the default Origin/Referer.
   * Per-request headers supplied by the caller still win (they are applied in
   * request() before this runs, so we only fill in what is missing).
   */
  private registerRequestInterceptor(): void {
    this.client.interceptors.request.use((config) => {
      const headers = config.headers;

      // Default headers (Origin/Referer) — only set when absent.
      for (const [key, value] of Object.entries(this.defaultHeaders)) {
        if (headers.get(key) === undefined || headers.get(key) === null) {
          headers.set(key, value);
        }
      }

      // Echo the multi-step handshake headers back to Apple.
      const sd = this.store.sessionData;
      if (sd.scnt) {
        headers.set('scnt', sd.scnt);
      }
      if (sd.session_id) {
        headers.set('X-Apple-ID-Session-Id', sd.session_id);
      }

      return config;
    });
  }

  /**
   * RESPONSE interceptor: harvest the five `HEADER_DATA` response headers into
   * the mutable sessionData, then persist session-data + cookies to disk.
   *
   * Runs on EVERY response (including error statuses, since validateStatus is
   * always true so axios resolves rather than rejects).
   */
  private registerResponseInterceptor(): void {
    this.client.interceptors.response.use(async (response) => {
      for (const [header, key] of Object.entries(HEADER_DATA)) {
        const value = this.readHeader(response, header);
        if (value !== undefined) {
          // Harvest into the mutable handshake bag (never logged).
          (this.store.sessionData as Record<string, unknown>)[key] = value;
        }
      }

      // Persist session_data JSON + cookie jar (mirrors per-request persist).
      await this.store.persistAll();

      return response;
    });
  }

  // -------------------------------------------------------------------------
  // Public request entrypoint
  // -------------------------------------------------------------------------

  /**
   * Perform an authenticated request, reproducing `PyiCloudSession.request`:
   * harvest headers (in the interceptor), then apply error normalization and
   * the single 421/450/500 retry (with the findme re-auth branch).
   */
  async request<T = unknown>(
    method: Method,
    url: string,
    opts: IcloudRequestOptions = {},
  ): Promise<AxiosResponse<T>> {
    const retried = opts._retried === true;

    // Never log the body or any secret value: scrub the account password AND
    // every harvested handshake token (session_token, session_id, scnt,
    // trust_token, ...) that may be echoed back inside an auth request body
    // (e.g. accountLogin's `dsWebAuthToken`/`trustToken`, signin's
    // `trustTokens`). See DoD §5/§7.5: the password and the harvested tokens
    // must never appear in logs.
    this.logger.debug(
      `${method} ${url} ${this.redactAllSecrets(this.describeBody(opts.data))}`,
    );

    const response = await this.client.request<T>({
      method,
      url,
      data: opts.data,
      params: opts.params,
      headers: (opts.headers ?? {}) as RawAxiosRequestHeaders,
      // 'json' is axios's default and parses the body; 'stream'/'arraybuffer'
      // return the raw payload untouched.
      responseType: opts.responseType ?? 'json',
    });

    const contentType = this.contentType(response);
    const isJson = JSON_MIMETYPES.includes(contentType);
    const ok = this.isOk(response.status);

    // --- Error/retry gate (only when NOT ok). ------------------------------
    // §8.1: a successful (ok) stream/arraybuffer download has a non-JSON
    // content-type but MUST NOT enter this block — the gate requires !ok first.
    if (!ok && (!isJson || RETRY_STATUSES.includes(response.status))) {
      // Branch A — Find My iPhone re-authentication (status in {421,450,500},
      // not yet retried, and the URL targets the findme root). The whole block
      // swallows ALL exceptions (incl. webservice-URL-resolution failures),
      // mirroring the Python outer try/except.
      try {
        const fmipUrl = this.auth?.getWebserviceUrl('findme');
        if (
          !retried &&
          RETRY_STATUSES.includes(response.status) &&
          fmipUrl &&
          url.includes(fmipUrl)
        ) {
          this.logger.debug('Re-authenticating Find My iPhone service');
          try {
            // 450 → full sign-in (service undefined); else → 'find' one-factor.
            const service = response.status === 450 ? undefined : 'find';
            await this.auth?.authenticate({ forceRefresh: true, service });
          } catch (reauthErr) {
            // Swallow re-auth failure (matches `except PyiCloudAPIResponseException`).
            this.logger.debug('Re-authentication failed');
            void reauthErr;
          }
          return this.request<T>(method, url, { ...opts, _retried: true });
        }
      } catch {
        // Swallow any failure resolving the findme URL (Python outer try/except).
      }

      // Branch B — generic single retry for 421/450/500 when not yet retried.
      if (!retried && RETRY_STATUSES.includes(response.status)) {
        this.logger.debug(
          `Authentication required for Account (${response.status}). Retrying ...`,
        );
        return this.request<T>(method, url, { ...opts, _retried: true });
      }

      // No retry path applies (e.g. a non-JSON 404, or a persistent 421 after
      // the single retry) → raise. Reason comes from the JSON body when
      // available, else the HTTP status text.
      const { reason, code } = this.extractError(response);
      this.raise(code ?? response.status, reason ?? this.statusText(response));
    }

    // --- Raw (non-JSON) success: return untouched (streams/arraybuffers). ---
    if (!isJson) {
      return response;
    }

    // --- JSON body: extract an embedded error (2xx-but-error). -------------
    const { reason, code } = this.extractError(response);
    if (reason) {
      this.raise(code, reason);
    }

    return response;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Throw via the shared normalizer, supplying the 2SA context from auth. */
  private raise(code: string | number | undefined, reason: string): never {
    raiseError(code, reason, {
      requires2sa: this.auth?.requires2sa ?? false,
      appleId: this.auth?.user.accountName ?? '',
    });
  }

  /** Extract `{reason, code}` from a (parsed) JSON response body. */
  private extractError(response: AxiosResponse): {
    reason?: string;
    code?: string | number;
  } {
    return extractReasonCode(response.data);
  }

  /** axios resolves header values via either a Headers-like API or a plain map. */
  private readHeader(response: AxiosResponse, name: string): string | undefined {
    const headers = response.headers as unknown as
      | { get?: (n: string) => unknown }
      | Record<string, unknown>;

    // axios >=1 may expose an AxiosHeaders with a case-insensitive get().
    if (headers && typeof (headers as { get?: unknown }).get === 'function') {
      const v = (headers as { get: (n: string) => unknown }).get(name);
      return v == null || v === '' ? undefined : String(v);
    }

    // Plain object: look up case-insensitively.
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (k.toLowerCase() === lower) {
        return v == null || v === '' ? undefined : String(Array.isArray(v) ? v[0] : v);
      }
    }
    return undefined;
  }

  /** First token of the Content-Type header (before any `;`), lower-cased. */
  private contentType(response: AxiosResponse): string {
    const raw = this.readHeader(response, 'Content-Type') ?? '';
    return raw.split(';')[0].trim().toLowerCase();
  }

  /** HTTP status text (`response.statusText`), defaulting to a generic label. */
  private statusText(response: AxiosResponse): string {
    return response.statusText || 'Unknown reason';
  }

  /** `requests.Response.ok` equivalent: 2xx/3xx (status < 400). */
  private isOk(status: number): boolean {
    return status >= 200 && status < 400;
  }

  /**
   * Scrub every sensitive value from a loggable string: the account password
   * plus every truthy harvested handshake token currently in `sessionData`
   * (session_token, session_id, scnt, trust_token, account_country, client_id).
   * These can be echoed back inside auth request bodies (accountLogin posts
   * `dsWebAuthToken`/`trustToken`, signin posts `trustTokens`), so redacting
   * only the password would leak them in cleartext at DEBUG level.
   */
  private redactAllSecrets(text: string): string {
    let out = redactSecret(text, this.auth?.user.password);
    for (const value of Object.values(this.store.sessionData)) {
      if (typeof value === 'string' && value) {
        out = redactSecret(out, value);
      }
    }
    return out;
  }

  /** A loggable, secret-free description of the request body. */
  private describeBody(data: unknown): string {
    if (data === undefined || data === null) {
      return '';
    }
    if (typeof data === 'string') {
      return data;
    }
    try {
      return JSON.stringify(data);
    } catch {
      return '[unserializable body]';
    }
  }
}
