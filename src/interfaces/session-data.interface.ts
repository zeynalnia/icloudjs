/**
 * Persisted, mutable handshake state harvested from Apple auth response headers
 * (see HEADER_DATA in constants.ts) plus the locally-generated client_id.
 *
 * Field names use snake_case to stay byte-compatible with the on-disk
 * `<account>.session` JSON written by the Python pyicloud library, so a session
 * file produced by either implementation can be read by the other.
 */
export interface SessionData {
  /** Locally generated `auth-<uuidv1>`; reused across runs and sent as X-Apple-OAuth-State. */
  client_id?: string;
  /** From `X-Apple-Session-Token` response header; exchanged at accountLogin. */
  session_token?: string;
  /** From `X-Apple-ID-Session-Id` response header; echoed back on subsequent auth calls. */
  session_id?: string;
  /** From the `scnt` response header; echoed back on subsequent auth calls. */
  scnt?: string;
  /** From `X-Apple-ID-Account-Country` response header. */
  account_country?: string;
  /** From `X-Apple-TwoSV-Trust-Token` response header; persists a trusted session. */
  trust_token?: string;
}
