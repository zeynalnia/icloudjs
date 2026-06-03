/**
 * Log redaction helper ported from `pyicloud/base.py:PyiCloudPasswordFilter`.
 *
 * The Python filter replaces any occurrence of the plaintext password in a log
 * record with eight asterisks. Here we generalize it to any secret string so
 * the NestJS `Logger` wrapper can scrub the password AND the harvested auth
 * tokens before anything is written. Never log the original secret.
 */

/** The fixed replacement token (`"*" * 8` in the Python source). */
export const REDACTION = '********';

/**
 * Replace every occurrence of `secret` in `text` with `********`.
 *
 * Matching is a plain substring replace (mirrors Python's `str.replace`); the
 * secret is treated literally, not as a regular expression. Empty or falsy
 * secrets are ignored (returns `text` unchanged) to avoid pathological
 * "replace the empty string everywhere" behavior.
 *
 * @param text   The message that may contain the secret.
 * @param secret The sensitive value to scrub (password or token).
 * @returns The text with all occurrences of `secret` replaced by `********`.
 */
export function redactSecret(text: string, secret: string | null | undefined): string {
  if (!secret) {
    return text;
  }
  return text.split(secret).join(REDACTION);
}
