/**
 * Tests for SessionKeyService (session-encryption key management).
 *
 * keytar is mocked via `jest.mock('keytar')` so no OS keychain is touched; the
 * key-file paths use a real temp directory (no network).
 *
 * Covers:
 *   - generateKey returns a fresh 32-byte key;
 *   - resolveKey reuses an existing keychain key (no store call);
 *   - resolveKey auto-creates + stores a key when none exists (setPassword called);
 *   - readKeyFile reads + validates a base64 32-byte key (trims trailing newline);
 *   - a bad-length key file throws;
 *   - encrypt:false short-circuits to null (no keychain access).
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';

import * as keytar from 'keytar';

import { SessionKeyService } from '../src/secrets/session-key.service';
import { SESSION_KEY_KEYRING_SERVICE } from '../src/constants';

jest.mock('keytar');

const mockedKeytar = keytar as jest.Mocked<typeof keytar>;

const ACCOUNT = 'quentintarantino@hotmail.fr';

describe('SessionKeyService', () => {
  let service: SessionKeyService;
  let dir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    service = new SessionKeyService();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsicloud-key-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('SESSION_KEY_KEYRING_SERVICE', () => {
    it('uses its own keyring service name (distinct from the password keyring)', () => {
      expect(SESSION_KEY_KEYRING_SERVICE).toBe(
        'jsicloud://session-encryption-key',
      );
    });
  });

  describe('generateKey', () => {
    it('returns a fresh 32-byte buffer', () => {
      const a = service.generateKey();
      const b = service.generateKey();
      expect(a).toHaveLength(32);
      expect(b).toHaveLength(32);
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('getKeyFromKeychain', () => {
    it('returns the decoded key for the correct service/account', async () => {
      const key = randomBytes(32);
      mockedKeytar.getPassword.mockResolvedValue(key.toString('base64'));

      const result = await service.getKeyFromKeychain(ACCOUNT);
      expect(result).not.toBeNull();
      expect((result as Buffer).equals(key)).toBe(true);
      expect(mockedKeytar.getPassword).toHaveBeenCalledWith(
        SESSION_KEY_KEYRING_SERVICE,
        ACCOUNT,
      );
    });

    it('returns null when no entry exists', async () => {
      mockedKeytar.getPassword.mockResolvedValue(null);
      await expect(service.getKeyFromKeychain(ACCOUNT)).resolves.toBeNull();
    });

    it('throws when the stored key decodes to a non-32-byte buffer', async () => {
      mockedKeytar.getPassword.mockResolvedValue(
        randomBytes(16).toString('base64'),
      );
      await expect(service.getKeyFromKeychain(ACCOUNT)).rejects.toThrow();
    });
  });

  describe('keyExistsInKeychain', () => {
    it('is true when a key is stored, false otherwise', async () => {
      mockedKeytar.getPassword.mockResolvedValueOnce(
        randomBytes(32).toString('base64'),
      );
      await expect(service.keyExistsInKeychain(ACCOUNT)).resolves.toBe(true);

      mockedKeytar.getPassword.mockResolvedValueOnce(null);
      await expect(service.keyExistsInKeychain(ACCOUNT)).resolves.toBe(false);
    });
  });

  describe('storeKeyInKeychain', () => {
    it('stores the base64-encoded key under the correct service/account', async () => {
      mockedKeytar.setPassword.mockResolvedValue();
      const key = randomBytes(32);

      await service.storeKeyInKeychain(ACCOUNT, key);

      expect(mockedKeytar.setPassword).toHaveBeenCalledWith(
        SESSION_KEY_KEYRING_SERVICE,
        ACCOUNT,
        key.toString('base64'),
      );
    });
  });

  describe('resolveKey', () => {
    it('returns null and never touches the keychain when encrypt is false', async () => {
      const result = await service.resolveKey({
        accountName: ACCOUNT,
        encrypt: false,
      });
      expect(result).toBeNull();
      expect(mockedKeytar.getPassword).not.toHaveBeenCalled();
      expect(mockedKeytar.setPassword).not.toHaveBeenCalled();
    });

    it('reuses an existing keychain key without storing a new one', async () => {
      const existing = randomBytes(32);
      mockedKeytar.getPassword.mockResolvedValue(existing.toString('base64'));

      const result = await service.resolveKey({
        accountName: ACCOUNT,
        encrypt: true,
      });

      expect((result as Buffer).equals(existing)).toBe(true);
      expect(mockedKeytar.setPassword).not.toHaveBeenCalled();
    });

    it('auto-creates and stores a key when none exists in the keychain', async () => {
      mockedKeytar.getPassword.mockResolvedValue(null);
      mockedKeytar.setPassword.mockResolvedValue();

      const result = await service.resolveKey({
        accountName: ACCOUNT,
        encrypt: true,
      });

      expect(result).toHaveLength(32);
      expect(mockedKeytar.setPassword).toHaveBeenCalledTimes(1);
      // The stored value is the base64 of the returned key.
      const [, account, stored] = mockedKeytar.setPassword.mock.calls[0];
      expect(account).toBe(ACCOUNT);
      expect((result as Buffer).equals(Buffer.from(stored, 'base64'))).toBe(true);
    });

    it('reads + validates a key FILE and never touches the keychain', async () => {
      const key = randomBytes(32);
      const keyFile = path.join(dir, 'key.b64');
      // A trailing newline must be tolerated (trimmed before decode).
      await fs.writeFile(keyFile, `${key.toString('base64')}\n`, 'utf-8');

      const result = await service.resolveKey({
        accountName: ACCOUNT,
        encrypt: true,
        encryptionKeyFile: keyFile,
      });

      expect((result as Buffer).equals(key)).toBe(true);
      expect(mockedKeytar.getPassword).not.toHaveBeenCalled();
      expect(mockedKeytar.setPassword).not.toHaveBeenCalled();
    });

    it('throws when the key file decodes to the wrong length', async () => {
      const keyFile = path.join(dir, 'bad.b64');
      await fs.writeFile(keyFile, randomBytes(16).toString('base64'), 'utf-8');

      await expect(
        service.resolveKey({
          accountName: ACCOUNT,
          encrypt: true,
          encryptionKeyFile: keyFile,
        }),
      ).rejects.toThrow();
    });
  });

  describe('readKeyFile', () => {
    it('reads a base64 32-byte key, trimming surrounding whitespace', async () => {
      const key = randomBytes(32);
      const keyFile = path.join(dir, 'whitespace.b64');
      await fs.writeFile(keyFile, `  ${key.toString('base64')}  \n`, 'utf-8');

      const result = await service.readKeyFile(keyFile);
      expect(result.equals(key)).toBe(true);
    });

    it('throws on a wrong-length key file', async () => {
      const keyFile = path.join(dir, 'short.b64');
      await fs.writeFile(keyFile, randomBytes(8).toString('base64'), 'utf-8');
      await expect(service.readKeyFile(keyFile)).rejects.toThrow();
    });
  });
});
