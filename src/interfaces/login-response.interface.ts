import { Webservices } from './webservices.interface';

/**
 * The `dsInfo` block of the account-login payload. Only the fields the port
 * actually reads are pinned; all server keys are passed through via the index
 * signature so nothing is lost. `dsid` is read for `params.dsid`, and the HSA
 * fields gate the 2FA/2SA flow.
 */
export interface DsInfo {
  /** Directory Services ID — used to populate `params.dsid` and Ubiquity URLs. */
  dsid: string | number;
  /** 2 => HSA2 (2FA); >=1 => HSA1/legacy 2SA. Absent on degenerate payloads. */
  hsaVersion?: number;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  appleId?: string;
  primaryEmail?: string;
  countryCode?: string;
  [key: string]: unknown;
}

/**
 * Per-app capability flags. The auth flow reads `canLaunchWithOneFactor` to
 * decide whether a one-factor service login is possible.
 */
export interface AppEntry {
  canLaunchWithOneFactor?: boolean;
  isQualifiedForBeta?: boolean;
  isHidden?: boolean;
  [key: string]: unknown;
}

/**
 * Full response payload from `{SETUP}/accountLogin` (and `{SETUP}/validate`),
 * stored as `IcloudAuthService.data`.
 *
 * Server casing is preserved verbatim (PascalCase/camelCase) per the §0
 * casing decision — do NOT auto-transform keys.
 */
export interface AccountLoginData {
  dsInfo: DsInfo;
  webservices: Webservices;
  apps?: Record<string, AppEntry>;
  /** True when a verification challenge is still required. */
  hsaChallengeRequired?: boolean;
  /** True when the current browser/session is already trusted. */
  hsaTrustedBrowser?: boolean;
  pcsEnabled?: boolean;
  isExtendedLogin?: boolean;
  version?: number;
  [key: string]: unknown;
}
