/**
 * SessionStore — port of pyicloud's on-disk session persistence (`base.py`).
 *
 * Holds the two pieces of state that must survive across runs:
 *   - `sessionData`: the mutable handshake bag harvested from auth response
 *     headers (see HEADER_DATA in constants.ts) plus the local `client_id`.
 *     Persisted as JSON to `<dir>/<name>.session` (byte-compatible field names
 *     with the Python `.session` file).
 *   - `jar`: a tough-cookie CookieJar carrying the `X-APPLE-WEBAUTH-*` cookie
 *     family that authenticates every downstream service call. Persisted as
 *     tough-cookie's JSON serialization to `<dir>/<name>.cookies.json`.
 *
 * Divergence from Python (documented): the cookie jar is stored as
 * tough-cookie JSON rather than the LWP/Netscape format used by Python's
 * `LWPCookieJar`. This is a greenfield port and the LWP format is not standard
 * in JS; the `.session` JSON file IS kept byte-compatible.
 *
 * Corruption tolerance: if either file is missing or fails to parse, we start
 * from empty state (an empty `sessionData` / a fresh jar). The next successful
 * authentication rebuilds both, so a corrupt or stale file never blocks login.
 *
 * No network here — pure filesystem + in-memory cookie jar.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { CookieJar } from 'tough-cookie';

/** tough-cookie's serialized-jar JSON shape (re-aliased for readability). */
type SerializedCookieJar = CookieJar.Serialized;

import { SessionData } from '../interfaces/session-data.interface';
import { SessionCipher } from './session-cipher';

export class SessionStore {
  /** Mutable handshake state; mutated in place by the HTTP response interceptor. */
  sessionData: SessionData;

  /** tough-cookie jar; carries the X-APPLE-WEBAUTH-* auth cookies. */
  readonly jar: CookieJar;

  /** Absolute path of the `<name>.session` JSON file. */
  private readonly sessionPath: string;

  /** Absolute path of the `<name>.cookies.json` jar file. */
  private readonly cookiePath: string;

  /**
   * Optional at-rest cipher. When `undefined` the store reads/writes plaintext
   * exactly as before; when present, files are written encrypted and read with
   * transparent legacy-plaintext migration (see {@link load}).
   */
  private readonly cipher?: SessionCipher;

  private constructor(
    sessionData: SessionData,
    jar: CookieJar,
    sessionPath: string,
    cookiePath: string,
    cipher?: SessionCipher,
  ) {
    this.sessionData = sessionData;
    this.jar = jar;
    this.sessionPath = sessionPath;
    this.cookiePath = cookiePath;
    this.cipher = cipher;
  }

  /**
   * Load (or initialise) a store for `<dir>/<sanitizedName>`.
   *
   * `sanitizedName` is expected to already be reduced to filename-safe word
   * characters by the caller (`IcloudAuthService.create`), mirroring the
   * Python `re.sub(r'\W', '', accountName)` sanitisation.
   *
   * Both the `.session` JSON and the `.cookies.json` jar are loaded best-effort:
   * any read/parse error is swallowed and the corresponding piece starts empty.
   *
   * When `cipher` is supplied, an on-disk blob that {@link SessionCipher.looksEncrypted}
   * is decrypted (a decrypt failure PROPAGATES so a wrong key is loud), while a
   * legacy plaintext file is still read as-is — the transparent migration path
   * that lets it be re-written encrypted on the next persist.
   */
  static async load(
    dir: string,
    sanitizedName: string,
    cipher?: SessionCipher,
  ): Promise<SessionStore> {
    const sessionPath = path.join(dir, `${sanitizedName}.session`);
    const cookiePath = path.join(dir, `${sanitizedName}.cookies.json`);

    const sessionData = await SessionStore.loadSessionData(sessionPath, cipher);
    const jar = await SessionStore.loadJar(cookiePath, cipher);

    return new SessionStore(sessionData, jar, sessionPath, cookiePath, cipher);
  }

  /**
   * Read a file as a Buffer and turn it into a UTF-8 string, decrypting when the
   * blob is encrypted and a `cipher` is present.
   *
   *   - missing file -> `undefined` (caller starts from empty state)
   *   - cipher present AND the blob looks encrypted -> decrypt (failure PROPAGATES)
   *   - else (no cipher, or a legacy plaintext blob) -> `buf.toString('utf-8')`,
   *     which is the transparent plaintext→encrypted migration path.
   */
  private static async readDecoded(
    filePath: string,
    cipher?: SessionCipher,
  ): Promise<string | undefined> {
    let buf: Buffer;
    try {
      buf = await fs.readFile(filePath);
    } catch {
      // Missing or unreadable — caller falls back to empty state.
      return undefined;
    }
    if (cipher && SessionCipher.looksEncrypted(buf)) {
      // A wrong key / tampered file must be loud — do NOT swallow.
      return cipher.decrypt(buf);
    }
    return buf.toString('utf-8');
  }

  /** Read + parse the `.session` JSON; tolerate missing/corrupt files. */
  private static async loadSessionData(
    sessionPath: string,
    cipher?: SessionCipher,
  ): Promise<SessionData> {
    const raw = await SessionStore.readDecoded(sessionPath, cipher);
    if (raw === undefined) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      // Guard against a file that parses to a non-object (e.g. `null`, `[]`).
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as SessionData;
      }
      return {};
    } catch {
      // Corrupt plaintext body — start from an empty handshake bag.
      return {};
    }
  }

  /** Deserialize the tough-cookie jar JSON; tolerate missing/corrupt files. */
  private static async loadJar(
    cookiePath: string,
    cipher?: SessionCipher,
  ): Promise<CookieJar> {
    const raw = await SessionStore.readDecoded(cookiePath, cipher);
    if (raw === undefined) {
      // Missing file — fresh jar.
      return new CookieJar();
    }

    let serialized: SerializedCookieJar | undefined;
    try {
      serialized = JSON.parse(raw) as SerializedCookieJar;
    } catch {
      // Unparseable JSON — fresh jar.
      return new CookieJar();
    }

    try {
      return await new Promise<CookieJar>((resolve, reject) => {
        CookieJar.deserialize(serialized as SerializedCookieJar, (err, jar) => {
          if (err || !jar) {
            reject(err ?? new Error('CookieJar.deserialize returned no jar'));
            return;
          }
          resolve(jar);
        });
      });
    } catch {
      // Structurally valid JSON but not a valid serialized jar — fresh jar.
      return new CookieJar();
    }
  }

  /** Persist `sessionData` as JSON to `<dir>/<name>.session`. */
  async saveSessionData(): Promise<void> {
    const json = JSON.stringify(this.sessionData);
    // mode 0o600: these files hold live auth tokens — owner-only on creation.
    // With a cipher we write the encrypted Buffer; otherwise the plaintext JSON.
    await fs.writeFile(
      this.sessionPath,
      this.cipher ? this.cipher.encrypt(json) : json,
      { encoding: 'utf-8', mode: 0o600 },
    );
  }

  /** Serialize the cookie jar (including discarded/expired cookies) to disk. */
  async saveCookies(): Promise<void> {
    const serialized = await new Promise<SerializedCookieJar>((resolve, reject) => {
      this.jar.serialize((err, json) => {
        if (err || !json) {
          reject(err ?? new Error('CookieJar.serialize returned no data'));
          return;
        }
        resolve(json);
      });
    });
    const json = JSON.stringify(serialized);
    // mode 0o600: the cookie jar carries the auth cookies — owner-only on creation.
    // With a cipher we write the encrypted Buffer; otherwise the plaintext JSON.
    await fs.writeFile(
      this.cookiePath,
      this.cipher ? this.cipher.encrypt(json) : json,
      { encoding: 'utf-8', mode: 0o600 },
    );
  }

  /**
   * Persist both the session data and the cookie jar.
   *
   * Mirrors the Python per-request persistence (`base.py` writes the session
   * JSON and saves cookies inside `PyiCloudSession.request`). The HTTP layer
   * calls this after harvesting auth response headers so that a trusted
   * session can be resumed on the next run.
   */
  async persistAll(): Promise<void> {
    await Promise.all([this.saveSessionData(), this.saveCookies()]);
  }
}
