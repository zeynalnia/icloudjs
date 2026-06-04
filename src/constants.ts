/**
 * Library constants ported from `pyicloud` (`base.py`, `services/photos.py`,
 * `utils.py`). Endpoint bases, OAuth header constants, the response-header
 * harvest map, build-number constants, the photos SMART_FOLDERS table, the
 * photo/video version-lookup maps, and the keyring service name.
 */
import { SessionData } from './interfaces/session-data.interface';

/**
 * Endpoint bases. China-mainland mode switches the three host bases to
 * `.com.cn`; the OAuth widget-key / client-id / redirect-URI (see {@link OAUTH})
 * stay GLOBAL even in China mode (matches Apple's auth widget — do not "fix").
 */
export const ENDPOINTS = {
  global: {
    AUTH: 'https://idmsa.apple.com/appleauth/auth',
    HOME: 'https://www.icloud.com',
    SETUP: 'https://setup.icloud.com/setup/ws/1',
  },
  china: {
    AUTH: 'https://idmsa.apple.com.cn/appleauth/auth',
    HOME: 'https://www.icloud.com.cn',
    SETUP: 'https://setup.icloud.com.cn/setup/ws/1',
  },
} as const;

/**
 * Default `User-Agent` sent on every request. Apple's `idmsa`/iCloud endpoints
 * increasingly answer non-browser clients with `503 Service Temporarily
 * Unavailable` as an anti-automation measure; presenting the User-Agent of the
 * iCloud web client (Safari on macOS) avoids that. Overridable via
 * `IcloudModuleOptions.userAgent`.
 */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15';

/** OAuth widget key + client id + redirect URI — GLOBAL even in China mode. */
export const OAUTH = {
  /** Widget key AND client id (same value in pyicloud). */
  CLIENT_ID: 'd39ba9916b7251055b22c7f910e2ea796ee65e98b2ddecea8f5dde8d9d1a815d',
  /** GLOBAL even in CN (preserve — matches Apple's auth widget). */
  REDIRECT_URI: 'https://www.icloud.com',
} as const;

/**
 * Response-header → SessionData-key harvest map (CRITICAL). The HTTP response
 * interceptor copies each of these headers, when present, into the mutable
 * session-data object; `scnt` and `X-Apple-ID-Session-Id` are then echoed back
 * on the next auth call.
 */
export const HEADER_DATA: Record<string, keyof SessionData> = {
  'X-Apple-ID-Account-Country': 'account_country',
  'X-Apple-ID-Session-Id': 'session_id',
  'X-Apple-Session-Token': 'session_token',
  'X-Apple-TwoSV-Trust-Token': 'trust_token',
  scnt: 'scnt',
};

/**
 * Build-number query params (FIX #1 — placeholders, kept configurable).
 *
 * The Python source never populates `params` at all, so NO fixture depends on
 * the exact build-number strings: drive/ubiquity tests assert only that
 * `clientId` and `dsid` are present in `params`, never these values.
 */
export const BUILD = {
  clientBuildNumber: '2521Project35',
  clientMasteringNumber: '2521B2',
  ckjsBuildVersion: '2521ProjectDev39',
} as const;

/** Photo version lookup: logical name → CloudKit resource-field prefix. */
export const PHOTO_VERSION_LOOKUP: Record<string, string> = {
  original: 'resOriginal',
  medium: 'resJPEGMed',
  thumb: 'resJPEGThumb',
};

/** Video version lookup: logical name → CloudKit resource-field prefix. */
export const VIDEO_VERSION_LOOKUP: Record<string, string> = {
  original: 'resOriginal',
  medium: 'resVidMed',
  thumb: 'resVidSmall',
};

/**
 * Keyring service name. EXACT string for cross-compatibility with the password
 * stored by the Python pyicloud keyring (`utils.KEYRING_SYSTEM`). keytar's
 * `service` argument must equal this.
 */
export const KEYRING_SERVICE = 'pyicloud://icloud-password';

/**
 * Keyring service name for the session-encryption key. Distinct from
 * {@link KEYRING_SERVICE} so the at-rest encryption key lives in its own
 * keychain entry and never collides with the stored iCloud password.
 */
export const SESSION_KEY_KEYRING_SERVICE = 'jsicloud://session-encryption-key';

/** A single smart-folder definition (ported from `photos.py:13-122`). */
export interface SmartFolderDef {
  obj_type: string;
  list_type: string;
  direction: 'ASCENDING' | 'DESCENDING';
  query_filter:
    | Array<{
        fieldName: string;
        comparator: string;
        fieldValue: { type: string; value: string };
      }>
    | null;
}

/** Build the single-element smartAlbum filter array used by smart folders. */
function smartAlbumFilter(value: string): SmartFolderDef['query_filter'] {
  return [
    {
      fieldName: 'smartAlbum',
      comparator: 'EQUALS',
      fieldValue: { type: 'STRING', value },
    },
  ];
}

/**
 * The exact 11-entry SMART_FOLDERS table (ported verbatim from
 * `pyicloud/services/photos.py:13-122`). Every entry's `direction` is
 * `'ASCENDING'`; `query_filter` is `null` for the four non-smart-album folders
 * and a single-element smartAlbum filter otherwise. These literals are
 * load-bearing for every photo query.
 */
export const SMART_FOLDERS: Record<string, SmartFolderDef> = {
  'All Photos': {
    obj_type: 'CPLAssetByAddedDate',
    list_type: 'CPLAssetAndMasterByAddedDate',
    direction: 'ASCENDING',
    query_filter: null,
  },
  'Time-lapse': {
    obj_type: 'CPLAssetInSmartAlbumByAssetDate:Timelapse',
    list_type: 'CPLAssetAndMasterInSmartAlbumByAssetDate',
    direction: 'ASCENDING',
    query_filter: smartAlbumFilter('TIMELAPSE'),
  },
  Videos: {
    obj_type: 'CPLAssetInSmartAlbumByAssetDate:Video',
    list_type: 'CPLAssetAndMasterInSmartAlbumByAssetDate',
    direction: 'ASCENDING',
    query_filter: smartAlbumFilter('VIDEO'),
  },
  'Slo-mo': {
    obj_type: 'CPLAssetInSmartAlbumByAssetDate:Slomo',
    list_type: 'CPLAssetAndMasterInSmartAlbumByAssetDate',
    direction: 'ASCENDING',
    query_filter: smartAlbumFilter('SLOMO'),
  },
  Bursts: {
    obj_type: 'CPLAssetBurstStackAssetByAssetDate',
    list_type: 'CPLBurstStackAssetAndMasterByAssetDate',
    direction: 'ASCENDING',
    query_filter: null,
  },
  Favorites: {
    obj_type: 'CPLAssetInSmartAlbumByAssetDate:Favorite',
    list_type: 'CPLAssetAndMasterInSmartAlbumByAssetDate',
    direction: 'ASCENDING',
    query_filter: smartAlbumFilter('FAVORITE'),
  },
  Panoramas: {
    obj_type: 'CPLAssetInSmartAlbumByAssetDate:Panorama',
    list_type: 'CPLAssetAndMasterInSmartAlbumByAssetDate',
    direction: 'ASCENDING',
    query_filter: smartAlbumFilter('PANORAMA'),
  },
  Screenshots: {
    obj_type: 'CPLAssetInSmartAlbumByAssetDate:Screenshot',
    list_type: 'CPLAssetAndMasterInSmartAlbumByAssetDate',
    direction: 'ASCENDING',
    query_filter: smartAlbumFilter('SCREENSHOT'),
  },
  Live: {
    obj_type: 'CPLAssetInSmartAlbumByAssetDate:Live',
    list_type: 'CPLAssetAndMasterInSmartAlbumByAssetDate',
    direction: 'ASCENDING',
    query_filter: smartAlbumFilter('LIVE'),
  },
  'Recently Deleted': {
    obj_type: 'CPLAssetDeletedByExpungedDate',
    list_type: 'CPLAssetAndMasterDeletedByExpungedDate',
    direction: 'ASCENDING',
    query_filter: null,
  },
  Hidden: {
    obj_type: 'CPLAssetHiddenByAssetDate',
    list_type: 'CPLAssetAndMasterHiddenByAssetDate',
    direction: 'ASCENDING',
    query_filter: null,
  },
};
