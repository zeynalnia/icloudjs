/**
 * Tests for SessionCipher (at-rest AES-256-GCM encryption of the persisted
 * session / cookie jar). No keychain, no filesystem — pure crypto round-trips.
 *
 * Covers:
 *   - encrypt → decrypt round-trips back to the exact plaintext;
 *   - looksEncrypted: true on an encrypted blob, false on plaintext JSON;
 *   - a tampered blob fails the GCM tag → throws;
 *   - decrypting with the WRONG key throws PyiCloudSessionDecryptionException;
 *   - a non-32-byte key in the constructor throws.
 */
import { randomBytes } from 'crypto';

import { MAGIC, SessionCipher } from '../src/session/session-cipher';
import { PyiCloudSessionDecryptionException } from '../src/exceptions/icloud.exceptions';

const KEY = (): Buffer => randomBytes(32);

describe('SessionCipher', () => {
  describe('round-trip', () => {
    it('decrypts what it encrypted, byte-for-byte', () => {
      const cipher = new SessionCipher(KEY());
      const plaintext = JSON.stringify({
        session_token: 'tok-1',
        scnt: 'scnt-1',
        unicode: 'héllo · 日本語',
      });

      const blob = cipher.encrypt(plaintext);
      expect(Buffer.isBuffer(blob)).toBe(true);
      expect(cipher.decrypt(blob)).toBe(plaintext);
    });

    it('uses a fresh IV per call so identical plaintext yields different blobs', () => {
      const cipher = new SessionCipher(KEY());
      const a = cipher.encrypt('same');
      const b = cipher.encrypt('same');

      // Different ciphertext (fresh random IV) but both decrypt to the original.
      expect(a.equals(b)).toBe(false);
      expect(cipher.decrypt(a)).toBe('same');
      expect(cipher.decrypt(b)).toBe('same');
    });

    it('prefixes the blob with the MAGIC marker', () => {
      const cipher = new SessionCipher(KEY());
      const blob = cipher.encrypt('hello');
      expect(blob.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true);
    });
  });

  describe('looksEncrypted', () => {
    it('is true for an encrypted blob', () => {
      const cipher = new SessionCipher(KEY());
      expect(SessionCipher.looksEncrypted(cipher.encrypt('x'))).toBe(true);
    });

    it('is false for plaintext JSON', () => {
      const plaintext = Buffer.from(JSON.stringify({ a: 1 }), 'utf-8');
      expect(SessionCipher.looksEncrypted(plaintext)).toBe(false);
    });

    it('is false for a buffer shorter than the MAGIC marker', () => {
      expect(SessionCipher.looksEncrypted(Buffer.from('JI', 'ascii'))).toBe(false);
    });
  });

  describe('decrypt failures', () => {
    it('throws PyiCloudSessionDecryptionException on a tampered blob', () => {
      const cipher = new SessionCipher(KEY());
      const blob = cipher.encrypt('secret');
      // Flip a byte in the ciphertext region (after MAGIC+IV+TAG) so the GCM
      // tag no longer verifies.
      blob[blob.length - 1] ^= 0xff;

      expect(() => cipher.decrypt(blob)).toThrow(
        PyiCloudSessionDecryptionException,
      );
    });

    it('throws PyiCloudSessionDecryptionException when decrypting with the wrong key', () => {
      const blob = new SessionCipher(KEY()).encrypt('secret');
      const other = new SessionCipher(KEY());

      expect(() => other.decrypt(blob)).toThrow(
        PyiCloudSessionDecryptionException,
      );
    });

    it('throws on a blob without a valid MAGIC header', () => {
      const cipher = new SessionCipher(KEY());
      expect(() => cipher.decrypt(Buffer.from('not encrypted', 'utf-8'))).toThrow(
        PyiCloudSessionDecryptionException,
      );
    });
  });

  describe('constructor key validation', () => {
    it('throws when the key is not 32 bytes', () => {
      expect(() => new SessionCipher(randomBytes(16))).toThrow();
      expect(() => new SessionCipher(randomBytes(31))).toThrow();
      expect(() => new SessionCipher(randomBytes(33))).toThrow();
    });

    it('accepts an exactly-32-byte key', () => {
      expect(() => new SessionCipher(randomBytes(32))).not.toThrow();
    });
  });
});
