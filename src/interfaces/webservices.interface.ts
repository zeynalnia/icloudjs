/**
 * A single entry in the per-account `webservices` URL map returned by
 * `{SETUP}/accountLogin`. Each service client resolves its root URL from
 * `webservices[<key>].url`.
 */
export interface WebserviceEntry {
  /** Base URL for the service (e.g. `https://p31-drivews.icloud.com:443`). */
  url?: string;
  /** Some services (e.g. `photos`) also expose a separate upload URL. */
  uploadUrl?: string;
  /** Typically `'active'`; absent on degenerate entries. */
  status?: string;
  /** Present on services requiring Private Cloud Service. */
  pcsRequired?: boolean;
  /** Allow extra, service-specific keys (e.g. `account.iCloudEnv`). */
  [key: string]: unknown;
}

/**
 * The full webservices map. Keys are service identifiers such as
 * `drivews`, `docws`, `ckdatabasews`, `findme`, `account`, `ubiquity`,
 * `calendar`, `contacts`, `reminders`.
 */
export type Webservices = Record<string, WebserviceEntry>;
