/**
 * At-rest encryption for the persisted session (`.session`) and cookie jar
 * (`.cookies.json`) files.
 *
 * Wire format of an encrypted blob:
 *
 *   MAGIC(4) ++ IV(12) ++ TAG(16) ++ ciphertext
 *
 * The leading MAGIC lets {@link SessionCipher.looksEncrypted} distinguish an
 * encrypted blob from a legacy plaintext JSON file WITHOUT attempting a decrypt,
 * which is what makes the transparent plaintext→encrypted migration possible.
 *
 * AES-256-GCM is used so that tampering (or a wrong key) is detected by the
 * authentication tag rather than silently producing garbage plaintext.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

import { PyiCloudSessionDecryptionException } from '../exceptions/icloud.exceptions';

/** 4-byte marker prepended to every encrypted blob. */
export const MAGIC = Buffer.from('JIC1', 'ascii');

/** GCM nonce length in bytes (96-bit IV is the recommended size for AES-GCM). */
const IV_BYTES = 12;
/** GCM authentication tag length in bytes. */
const TAG_BYTES = 16;
/** AES-256 key length in bytes. */
const KEY_BYTES = 32;

export class SessionCipher {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `SessionCipher requires a ${KEY_BYTES}-byte key, got ${key.length} bytes.`,
      );
    }
    this.key = key;
  }

  /**
   * Encrypt `plaintext` and return `MAGIC ++ IV ++ TAG ++ ciphertext`.
   *
   * A fresh random IV is generated per call so that re-persisting identical
   * state never reuses a (key, IV) pair — a hard requirement for GCM safety.
   */
  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf-8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([MAGIC, iv, tag, ciphertext]);
  }

  /**
   * Verify and decrypt a blob produced by {@link encrypt}.
   *
   * Any failure (bad MAGIC, truncated blob, wrong key, or tampered ciphertext —
   * the latter two surface as a GCM tag mismatch) is normalized to a single
   * {@link PyiCloudSessionDecryptionException} so callers get one loud, guiding
   * error instead of a grab-bag of low-level crypto exceptions.
   */
  decrypt(blob: Buffer): string {
    try {
      if (!SessionCipher.looksEncrypted(blob)) {
        throw new Error('missing or invalid MAGIC header');
      }
      const minLength = MAGIC.length + IV_BYTES + TAG_BYTES;
      if (blob.length < minLength) {
        throw new Error('blob too short to contain IV and auth tag');
      }
      const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
      const tag = blob.subarray(
        MAGIC.length + IV_BYTES,
        MAGIC.length + IV_BYTES + TAG_BYTES,
      );
      const ciphertext = blob.subarray(MAGIC.length + IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return plaintext.toString('utf-8');
    } catch {
      throw new PyiCloudSessionDecryptionException();
    }
  }

  /** True iff `buf` begins with the {@link MAGIC} marker. */
  static looksEncrypted(buf: Buffer): boolean {
    return buf.length >= MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
  }
}
