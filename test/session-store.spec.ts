/**
 * Tests for SessionStore (port of pyicloud's on-disk session persistence).
 *
 * Covers:
 *   - load/persist round-trip for session_data JSON,
 *   - cookie jar serialize → deserialize round-trip,
 *   - corrupt / missing files tolerated → empty state,
 *   - sessionData mutability + persistAll writing both files,
 *   - at-rest encryption (with a SessionCipher): encrypted round-trip, the
 *     on-disk MAGIC marker, transparent legacy-plaintext migration, and a
 *     wrong-key reload that throws loudly.
 *
 * Uses a real temp directory (no network); each test gets an isolated dir.
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';

import { Cookie } from 'tough-cookie';

import { SessionStore } from '../src/session/session-store';
import { MAGIC, SessionCipher } from '../src/session/session-cipher';
import { PyiCloudSessionDecryptionException } from '../src/exceptions/icloud.exceptions';

const NAME = 'quentintarantinohotmailfr';

describe('SessionStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsicloud-session-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const sessionFile = () => path.join(dir, `${NAME}.session`);
  const cookieFile = () => path.join(dir, `${NAME}.cookies.json`);

  describe('load', () => {
    it('starts with empty sessionData and a usable jar when no files exist', async () => {
      const store = await SessionStore.load(dir, NAME);

      expect(store.sessionData).toEqual({});
      // The jar is real and usable.
      await store.jar.setCookie(
        'foo=bar; Domain=icloud.com; Path=/',
        'https://www.icloud.com',
      );
      const cookieStr = await store.jar.getCookieString('https://www.icloud.com');
      expect(cookieStr).toContain('foo=bar');
    });

    it('loads previously persisted sessionData', async () => {
      await fs.writeFile(
        sessionFile(),
        JSON.stringify({
          client_id: 'auth-abc',
          session_token: 'valid_token',
          scnt: 'scnt-1',
        }),
        'utf-8',
      );

      const store = await SessionStore.load(dir, NAME);

      expect(store.sessionData).toEqual({
        client_id: 'auth-abc',
        session_token: 'valid_token',
        scnt: 'scnt-1',
      });
    });

    it('tolerates a corrupt session file and starts empty', async () => {
      await fs.writeFile(sessionFile(), '{ this is not json', 'utf-8');

      const store = await SessionStore.load(dir, NAME);

      expect(store.sessionData).toEqual({});
    });

    it('tolerates a session file that parses to a non-object', async () => {
      await fs.writeFile(sessionFile(), 'null', 'utf-8');
      const storeNull = await SessionStore.load(dir, NAME);
      expect(storeNull.sessionData).toEqual({});

      await fs.writeFile(sessionFile(), '[1,2,3]', 'utf-8');
      const storeArr = await SessionStore.load(dir, NAME);
      expect(storeArr.sessionData).toEqual({});
    });

    it('tolerates a corrupt cookie file and starts with a fresh jar', async () => {
      await fs.writeFile(cookieFile(), 'not-json-at-all', 'utf-8');

      const store = await SessionStore.load(dir, NAME);

      // Fresh jar: no cookies, but still usable.
      const before = await store.jar.getCookieString('https://www.icloud.com');
      expect(before).toBe('');
      await store.jar.setCookie(
        'a=b; Domain=icloud.com; Path=/',
        'https://www.icloud.com',
      );
      const after = await store.jar.getCookieString('https://www.icloud.com');
      expect(after).toContain('a=b');
    });

    it('tolerates structurally-valid JSON that is not a serialized jar', async () => {
      await fs.writeFile(
        cookieFile(),
        JSON.stringify({ totally: 'unrelated', shape: [1, 2] }),
        'utf-8',
      );

      const store = await SessionStore.load(dir, NAME);

      // Should not throw, and the jar should be empty/usable.
      const cookieStr = await store.jar.getCookieString('https://www.icloud.com');
      expect(cookieStr).toBe('');
    });
  });

  describe('persistence', () => {
    it('saveSessionData round-trips mutable sessionData', async () => {
      const store = await SessionStore.load(dir, NAME);

      // sessionData is mutable — mutate in place.
      store.sessionData.session_token = 'tok-1';
      store.sessionData.trust_token = 'trust-1';
      await store.saveSessionData();

      const reloaded = await SessionStore.load(dir, NAME);
      expect(reloaded.sessionData).toEqual({
        session_token: 'tok-1',
        trust_token: 'trust-1',
      });
    });

    it('saveCookies round-trips the cookie jar', async () => {
      const store = await SessionStore.load(dir, NAME);
      await store.jar.setCookie(
        'X-APPLE-WEBAUTH-TOKEN=valid_cookie; Domain=icloud.com; Path=/',
        'https://www.icloud.com',
      );
      await store.saveCookies();

      const reloaded = await SessionStore.load(dir, NAME);
      const cookieStr = await reloaded.jar.getCookieString(
        'https://www.icloud.com',
      );
      expect(cookieStr).toContain('X-APPLE-WEBAUTH-TOKEN=valid_cookie');
    });

    it('persistAll writes BOTH the session JSON and the cookie jar', async () => {
      const store = await SessionStore.load(dir, NAME);
      store.sessionData.client_id = 'auth-xyz';
      await store.jar.setCookie(
        'sess=1; Domain=icloud.com; Path=/',
        'https://www.icloud.com',
      );

      await store.persistAll();

      // Both files exist on disk.
      const sessionRaw = await fs.readFile(sessionFile(), 'utf-8');
      expect(JSON.parse(sessionRaw)).toEqual({ client_id: 'auth-xyz' });
      const cookieRaw = await fs.readFile(cookieFile(), 'utf-8');
      expect(JSON.parse(cookieRaw).cookies).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: 'sess' })]),
      );

      // And a fresh load sees both.
      const reloaded = await SessionStore.load(dir, NAME);
      expect(reloaded.sessionData.client_id).toBe('auth-xyz');
      const cookieStr = await reloaded.jar.getCookieString(
        'https://www.icloud.com',
      );
      expect(cookieStr).toContain('sess=1');
    });

    it('persists discarded/expired cookies (ignore_discard/ignore_expires parity)', async () => {
      const store = await SessionStore.load(dir, NAME);
      // A session cookie (no Expires/Max-Age) is "discardable"; it must still
      // survive serialization so trusted sessions resume.
      const cookie = Cookie.parse('discardable=1; Domain=icloud.com; Path=/')!;
      await store.jar.setCookie(cookie, 'https://www.icloud.com');
      await store.saveCookies();

      const reloaded = await SessionStore.load(dir, NAME);
      const cookieStr = await reloaded.jar.getCookieString(
        'https://www.icloud.com',
      );
      expect(cookieStr).toContain('discardable=1');
    });
  });

  describe('at-rest encryption (with a SessionCipher)', () => {
    const KEY = (): Buffer => randomBytes(32);

    it('persists then reloads through the cipher (round-trip)', async () => {
      const cipher = new SessionCipher(KEY());

      const store = await SessionStore.load(dir, NAME, cipher);
      store.sessionData.session_token = 'enc-tok';
      store.sessionData.scnt = 'enc-scnt';
      await store.jar.setCookie(
        'X-APPLE-WEBAUTH-TOKEN=enc_cookie; Domain=icloud.com; Path=/',
        'https://www.icloud.com',
      );
      await store.persistAll();

      const reloaded = await SessionStore.load(dir, NAME, cipher);
      expect(reloaded.sessionData).toEqual({
        session_token: 'enc-tok',
        scnt: 'enc-scnt',
      });
      const cookieStr = await reloaded.jar.getCookieString(
        'https://www.icloud.com',
      );
      expect(cookieStr).toContain('X-APPLE-WEBAUTH-TOKEN=enc_cookie');
    });

    it('writes on-disk bytes that start with MAGIC and are NOT readable JSON', async () => {
      const cipher = new SessionCipher(KEY());

      const store = await SessionStore.load(dir, NAME, cipher);
      store.sessionData.client_id = 'auth-enc';
      await store.jar.setCookie(
        'sess=1; Domain=icloud.com; Path=/',
        'https://www.icloud.com',
      );
      await store.persistAll();

      for (const file of [sessionFile(), cookieFile()]) {
        const raw = await fs.readFile(file);
        // The encrypted blob is prefixed with the MAGIC marker...
        expect(raw.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true);
        // ...and the ciphertext body is not parseable as JSON.
        expect(() => JSON.parse(raw.toString('utf-8'))).toThrow();
      }
    });

    it('migrates a legacy PLAINTEXT file: loads it, then re-writes it encrypted', async () => {
      // A file written by an older (pre-encryption) version is plaintext JSON.
      await fs.writeFile(
        sessionFile(),
        JSON.stringify({ session_token: 'legacy-tok' }),
        'utf-8',
      );

      const cipher = new SessionCipher(KEY());

      // Reading WITH a cipher transparently loads the legacy plaintext body.
      const store = await SessionStore.load(dir, NAME, cipher);
      expect(store.sessionData).toEqual({ session_token: 'legacy-tok' });

      // The file is still plaintext until the next persist.
      const beforePersist = await fs.readFile(sessionFile());
      expect(SessionCipher.looksEncrypted(beforePersist)).toBe(false);

      // Persisting re-writes it ENCRYPTED (the migration completes).
      await store.saveSessionData();
      const afterPersist = await fs.readFile(sessionFile());
      expect(SessionCipher.looksEncrypted(afterPersist)).toBe(true);

      // And it still round-trips with the same key.
      const reloaded = await SessionStore.load(dir, NAME, cipher);
      expect(reloaded.sessionData).toEqual({ session_token: 'legacy-tok' });
    });

    it('throws PyiCloudSessionDecryptionException when reloaded with a DIFFERENT key', async () => {
      const store = await SessionStore.load(dir, NAME, new SessionCipher(KEY()));
      store.sessionData.session_token = 'tok';
      await store.saveSessionData();

      // A wrong key must be loud — the decrypt failure PROPAGATES, not swallowed.
      const wrongKeyCipher = new SessionCipher(KEY());
      await expect(
        SessionStore.load(dir, NAME, wrongKeyCipher),
      ).rejects.toBeInstanceOf(PyiCloudSessionDecryptionException);
    });
  });
});
