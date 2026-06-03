/**
 * Options for constructing an authenticated iCloud session.
 *
 * Mirrors the `PyiCloudService.__init__` parameters: `apple_id`/`password`,
 * `cookie_directory`, `china_mainland`, `verify`, and `client_id`.
 */
export interface IcloudModuleOptions {
  /** Apple ID / account name (email). Required. */
  accountName: string;
  /**
   * Account password. If omitted, it is resolved from the OS keyring
   * (keytar) by account name, or — when interactive — prompted for.
   */
  password?: string;
  /**
   * Directory for the cookie jar and `<account>.session` file.
   * Defaults to `<tmpdir>/jsicloud/<os-username>` (created mode 0o700).
   */
  cookieDir?: string;
  /**
   * When true, use the `.com.cn` host bases for AUTH/HOME/SETUP.
   * NOTE: the OAuth widget key / client id / redirect URI stay GLOBAL
   * (`https://www.icloud.com`) even in China mode — see OAUTH in constants.ts.
   */
  chinaMainland?: boolean;
  /**
   * TLS verification control passed through to the HTTP layer.
   * - `false` disables TLS certificate verification (testing only — never use
   *   against the real Apple endpoints).
   * - a string is treated as a path to a CA-bundle file used to verify the
   *   server certificate.
   * Omitted/`true` keeps Node's default certificate verification.
   */
  verify?: boolean | string;
  /**
   * Explicit client id. If omitted, a persisted `session_data.client_id` is
   * reused, else a fresh `auth-<uuidv1>` is generated.
   */
  clientId?: string;
  /**
   * Whether device commands default to including family-shared devices
   * (mirrors Python `with_family`). Defaults to `true`; set `false` to limit
   * `FindMyiPhoneService.refreshClient` to this account's own devices.
   */
  withFamily?: boolean;
  /**
   * Override the `User-Agent` sent on every request. Defaults to the iCloud web
   * client's Safari UA ({@link DEFAULT_USER_AGENT}); Apple may answer
   * non-browser User-Agents with `503 Service Temporarily Unavailable`.
   */
  userAgent?: string;
}
