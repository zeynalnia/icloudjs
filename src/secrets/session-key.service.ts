/**
 * Session-encryption key management for at-rest encryption of the persisted
 * session (`.session`) and cookie jar (`.cookies.json`).
 *
 * Mirrors {@link SecretsService}'s thin, stateless keytar usage: all keychain
 * calls use `service = SESSION_KEY_KEYRING_SERVICE` and `account = username`.
 * Keys are stored base64-encoded (keytar stores strings) and are always exactly
 * {@link KEY_BYTES} bytes (AES-256) once decoded.
 *
 * Never logs key material.
 */
import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as keytar from 'keytar';

import { SESSION_KEY_KEYRING_SERVICE } from '../constants';

/** AES-256 key size in bytes. */
export const KEY_BYTES = 32;

@Injectable()
export class SessionKeyService {
  /** Generate a fresh random 32-byte (AES-256) key. */
  generateKey(): Buffer {
    return crypto.randomBytes(KEY_BYTES);
  }

  /**
   * Read the stored key for `account` from the OS keychain.
   *
   * @returns The decoded 32-byte key, or `null` when no entry exists.
   * @throws Error when a stored value decodes to a non-32-byte buffer (the
   *         keychain entry is corrupt and would silently break encryption).
   */
  async getKeyFromKeychain(account: string): Promise<Buffer | null> {
    const value = await keytar.getPassword(SESSION_KEY_KEYRING_SERVICE, account);
    if (value === null || value === undefined) {
      return null;
    }
    const key = Buffer.from(value, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `Session-encryption key in the keychain for ${account} is ` +
          `${key.length} bytes, expected ${KEY_BYTES}. The keychain entry is ` +
          'corrupt; delete it to regenerate a fresh key.',
      );
    }
    return key;
  }

  /** Store (or overwrite) the base64-encoded key for `account` in the keychain. */
  async storeKeyInKeychain(account: string, key: Buffer): Promise<void> {
    await keytar.setPassword(
      SESSION_KEY_KEYRING_SERVICE,
      account,
      key.toString('base64'),
    );
  }

  /** Return true when a stored key exists in the keychain for `account`. */
  async keyExistsInKeychain(account: string): Promise<boolean> {
    return (await this.getKeyFromKeychain(account)) !== null;
  }

  /**
   * Read a base64-encoded 32-byte key from `filePath`.
   *
   * The file is read as UTF-8 and trimmed so a trailing newline (common when
   * the file is written with an editor or `echo`) does not corrupt the decode.
   *
   * @throws Error when the decoded key is not exactly 32 bytes.
   */
  async readKeyFile(filePath: string): Promise<Buffer> {
    const contents = await fs.readFile(filePath, 'utf-8');
    const key = Buffer.from(contents.trim(), 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `Session-encryption key file ${filePath} decoded to ${key.length} ` +
          `bytes, expected ${KEY_BYTES}. Provide a base64-encoded 32-byte key.`,
      );
    }
    return key;
  }

  /**
   * Resolve the encryption key per the documented priority order:
   *   1. encryption disabled -> `null` (plaintext at rest).
   *   2. an explicit key file -> read and validate it.
   *   3. the OS keychain -> reuse the stored key if present.
   *   4. otherwise auto-generate a key and store it in the keychain.
   *
   * Auto-creation (step 4) is silent: this is the library default, so callers
   * that have not opted out of encryption transparently get a key without any
   * prompt. The CLI handles the interactive confirmation separately before
   * reaching this point.
   */
  async resolveKey(opts: {
    accountName: string;
    encrypt: boolean;
    encryptionKeyFile?: string;
  }): Promise<Buffer | null> {
    if (!opts.encrypt) {
      return null;
    }
    if (opts.encryptionKeyFile) {
      return this.readKeyFile(opts.encryptionKeyFile);
    }
    const existing = await this.getKeyFromKeychain(opts.accountName);
    if (existing) {
      return existing;
    }
    const key = this.generateKey();
    await this.storeKeyInKeychain(opts.accountName, key);
    return key;
  }
}
