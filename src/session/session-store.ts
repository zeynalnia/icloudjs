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

export class SessionStore {
  /** Mutable handshake state; mutated in place by the HTTP response interceptor. */
  sessionData: SessionData;

  /** tough-cookie jar; carries the X-APPLE-WEBAUTH-* auth cookies. */
  readonly jar: CookieJar;

  /** Absolute path of the `<name>.session` JSON file. */
  private readonly sessionPath: string;

  /** Absolute path of the `<name>.cookies.json` jar file. */
  private readonly cookiePath: string;

  private constructor(
    sessionData: SessionData,
    jar: CookieJar,
    sessionPath: string,
    cookiePath: string,
  ) {
    this.sessionData = sessionData;
    this.jar = jar;
    this.sessionPath = sessionPath;
    this.cookiePath = cookiePath;
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
   */
  static async load(dir: string, sanitizedName: string): Promise<SessionStore> {
    const sessionPath = path.join(dir, `${sanitizedName}.session`);
    const cookiePath = path.join(dir, `${sanitizedName}.cookies.json`);

    const sessionData = await SessionStore.loadSessionData(sessionPath);
    const jar = await SessionStore.loadJar(cookiePath);

    return new SessionStore(sessionData, jar, sessionPath, cookiePath);
  }

  /** Read + parse the `.session` JSON; tolerate missing/corrupt files. */
  private static async loadSessionData(sessionPath: string): Promise<SessionData> {
    try {
      const raw = await fs.readFile(sessionPath, 'utf-8');
      const parsed = JSON.parse(raw);
      // Guard against a file that parses to a non-object (e.g. `null`, `[]`).
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as SessionData;
      }
      return {};
    } catch {
      // Missing or corrupt — start from an empty handshake bag.
      return {};
    }
  }

  /** Deserialize the tough-cookie jar JSON; tolerate missing/corrupt files. */
  private static async loadJar(cookiePath: string): Promise<CookieJar> {
    let serialized: SerializedCookieJar | undefined;
    try {
      const raw = await fs.readFile(cookiePath, 'utf-8');
      serialized = JSON.parse(raw) as SerializedCookieJar;
    } catch {
      // Missing or unparseable JSON — fresh jar.
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
    await fs.writeFile(
      this.sessionPath,
      JSON.stringify(this.sessionData),
      'utf-8',
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
    await fs.writeFile(this.cookiePath, JSON.stringify(serialized), 'utf-8');
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
