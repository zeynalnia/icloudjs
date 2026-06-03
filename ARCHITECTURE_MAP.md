# pyicloud Architecture Map — Porting Guide for a NestJS/TypeScript Reimplementation

> **Purpose.** This document is a faithful, porting-oriented reconstruction of the `pyicloud` Python library's architecture, distilled from a per-subsystem reading of the source. It targets a developer reimplementing the library as a NestJS/TypeScript module. It enumerates every class, responsibility, key method, HTTP endpoint, request/response shape, cross-cutting concern (auth, cookies, retries, secrets), and the testing/mocking strategy — plus the latent bugs and quirks you must decide to preserve or fix.

---

## Table of Contents

1. [High-Level Overview & Module Dependency Graph](#1-high-level-overview--module-dependency-graph)
2. [Authentication / Session Lifecycle](#2-authentication--session-lifecycle)
3. [Per-Service Breakdown](#3-per-service-breakdown)
4. [Cross-Cutting Concerns](#4-cross-cutting-concerns)
5. [Catalog of External iCloud Endpoints](#5-catalog-of-external-icloud-endpoints)
6. [Testing / Mocking Strategy & Jest Mirror](#6-testing--mocking-strategy--jest-mirror)
7. [Consolidated Porting Checklist](#7-consolidated-porting-checklist)

---

## 1. High-Level Overview & Module Dependency Graph

`pyicloud` is an unofficial client for Apple's iCloud web services. It authenticates against Apple's `idmsa` OAuth endpoint and the `setup.icloud.com` web service, then exposes a family of thin REST clients for Drive, Photos, Find My iPhone, Account, Calendar, Contacts, and Reminders. **Authentication is centralized and cookie-based**; every service is constructed lazily from a per-account *webservices* URL map returned by the login response and shares a single authenticated HTTP session.

### 1.1 Subsystems

| Module | Role |
|---|---|
| `base.py` | Auth + HTTP session core. `PyiCloudService` (facade/orchestrator), `PyiCloudSession` (requests.Session subclass), `PyiCloudPasswordFilter` (log redaction). |
| `exceptions.py` | Typed exception hierarchy used by every subsystem. |
| `utils.py` | Keyring password CRUD, interactive prompt, `underscore_to_camelcase` helper. |
| `cmdline.py` | Standalone "Find My iPhone" CLI entrypoint. |
| `services/drive.py` | iCloud Drive (CloudDocs) + legacy Ubiquity. |
| `services/photos.py` | iCloud Photos (CloudKit DB web API). |
| `services/account.py` | Paired devices, Family Sharing, storage quota. |
| `services/findmyiphone.py` | Find My iPhone: locate / sound / message / lost-mode. |
| `services/calendar.py` | Calendar events/collections. |
| `services/contacts.py` | Contacts (two-step token handshake). |
| `services/reminders.py` | Reminder collections + tasks. |
| `tests/` | Pure unit tests; subclass the session and route on URL substrings against static fixtures. |

### 1.2 Dependency Graph

```
                         ┌──────────────────────┐
                         │     exceptions.py    │  (leaf: no internal deps)
                         └──────────▲───────────┘
                                    │ used by everyone
        ┌───────────────┐          │          ┌────────────────────┐
        │   utils.py    │──────────┤          │   PyiCloudPassword │
        │ (keyring/str) │          │          │   Filter (logging) │
        └───────▲───────┘          │          └─────────┬──────────┘
                │ get_password*     │                    │ used by
                │                   │                    │
        ┌───────┴───────────────────┴────────────────────┴──────────┐
        │                         base.py                            │
        │   PyiCloudService (facade)  ───owns──►  PyiCloudSession    │
        │   - authenticate() / 2FA / 2SA / trust                     │
        │   - cookie + session-data persistence                     │
        │   - resolves webservices[...] URL map                     │
        │   - lazy service accessors (props)                        │
        └───┬────┬────┬────┬────┬────┬────┬────┬──────────────────────┘
            │    │    │    │    │    │    │    │  (constructs each with
            ▼    ▼    ▼    ▼    ▼    ▼    ▼    ▼   service_root, session, params)
        ┌──────┐┌──────┐┌──────┐┌─────────┐┌──────┐┌────────┐┌──────────┐
        │drive ││photos││account││findmy   ││calendar││contacts││reminders │
        │+ubiq ││      ││+family││iphone   ││        ││        ││          │
        └──────┘└──────┘└──────┘└─────────┘└──────┘└────────┘└──────────┘

        cmdline.py ──► base.PyiCloudService + utils (keyring) + exceptions
                       (drives FindMyiPhone device commands)
```

**Key structural facts:**
- `exceptions.py` is the only true leaf; everything depends on it.
- All services receive `(service_root, session, params)` (FindMyiPhone also `with_family`; Drive also a second `document_root`). They never authenticate themselves.
- `service_root` is **resolved at runtime** from `data['webservices'][key]['url']` — never hardcoded (the one exception is the hardcoded storage URL in `account.py`).
- `params` is a **shared mutable query-param bag** threaded into every downstream call.

### 1.3 Recommended NestJS Module Shape

```
IcloudModule
├── IcloudAuthService       (port of PyiCloudService auth lifecycle; async init)
├── IcloudHttpService       (port of PyiCloudSession; axios + cookie jar + interceptors)
├── SessionStore            (cookie jar + session_data persistence to disk)
├── SecretsService          (keytar wrapper; port of utils keyring funcs)
├── exceptions/*            (Error subclasses; mirror hierarchy exactly)
└── services/
    ├── DriveService / UbiquityService
    ├── PhotosService
    ├── AccountService
    ├── FindMyiPhoneService
    ├── CalendarService / ContactsService / RemindersService
```

Use a **factory** (`IcloudAuthService.create(...)`) instead of doing network I/O in constructors (the Python code authenticates eagerly in `__init__`, and several services call `refresh()` in their constructors).

---

## 2. Authentication / Session Lifecycle

This is the most intricate and load-bearing subsystem. Get it right first; every service depends on a correctly populated cookie jar and webservices map.

### 2.1 Endpoint Bases

| Constant | Global | China mainland (`china_mainland=True`) |
|---|---|---|
| `AUTH_ENDPOINT` | `https://idmsa.apple.com/appleauth/auth` | `https://idmsa.apple.com.cn/appleauth/auth` |
| `HOME_ENDPOINT` | `https://www.icloud.com` | `https://www.icloud.com.cn` |
| `SETUP_ENDPOINT` | `https://setup.icloud.com/setup/ws/1` | `https://setup.icloud.com.cn/setup/ws/1` |

> **China quirk (preserve):** the three host bases switch to `.com.cn`, **but** the OAuth widget-key, client-id, and `X-Apple-OAuth-Redirect-URI` inside `_get_auth_headers` stay at the **global** `https://www.icloud.com` values regardless. This appears intentional (matches Apple's auth widget) — do not "fix" it.

### 2.2 Constructor Behavior (`PyiCloudService.__init__`)

1. Select CN vs global endpoints when `china_mainland`.
2. If `password is None`, pull from keyring (`get_password_from_keyring`).
3. Set `self.user = {accountName, password}`.
4. `client_id` defaults to `'auth-' + str(uuid1()).lower()`, **but is overridden** by a persisted `session_data['client_id']` if present (so it survives restarts — important for trusted-session continuity). It is also used as `X-Apple-OAuth-State`.
5. Resolve cookie directory: explicit param, else `<tmpdir>/pyicloud/<os-username>` (created mode `0o700`).
6. Load `<sanitizedAccountName>.session` JSON into `session_data`.
7. Construct `PyiCloudSession(verify=...)`; set default headers `Origin = HOME_ENDPOINT`, `Referer = HOME_ENDPOINT + '/'`.
8. Load `LWPCookieJar` from `cookiejar_path`.
9. **Call `authenticate()` eagerly** (network I/O in constructor → in NestJS use an async factory).

`accountName` is sanitized to word chars `[A-Za-z0-9_]` for the filenames: cookie jar = `<dir>/<sanitized>`, session = `<dir>/<sanitized>.session`.

### 2.3 The `authenticate(force_refresh=False, service=None)` Flow

```
authenticate(force_refresh, service):
  if session_data.session_token and not force_refresh:
      try _validate_token()           # POST {SETUP}/validate, body literal 'null'
      except -> fall through to full sign-in
  elif service and data['apps'][service]['canLaunchWithOneFactor']:
      try _authenticate_with_credentials_service(service)
      except -> fall through
  else:
      # FULL OAUTH SIGN-IN
      POST {AUTH}/signin?isRememberMeEnabled=true
        body = {accountName, password, rememberMe:true,
                trustTokens:[trust_token] or []}
        headers = _get_auth_headers() + (scnt, X-Apple-ID-Session-Id if present)
        on failure -> PyiCloudFailedLoginException('Invalid email/password combination.')
      _authenticate_with_token()      # exchange session_token for full payload
  self._webservices = self.data['webservices']
```

Sub-steps:
- **`_authenticate_with_token()`** → `POST {SETUP}/accountLogin` with `{accountCountryCode, dsWebAuthToken=session_token, extended_login:true, trustToken}`. Response JSON stored in `self.data` (contains `dsInfo`, `webservices`, `apps`, `hsaChallengeRequired`, `hsaTrustedBrowser`).
- **`_authenticate_with_credentials_service(service)`** → `POST {SETUP}/accountLogin` with `{appName, apple_id, password}`, then `self.data = _validate_token()`.
- **`_validate_token()`** → `POST {SETUP}/validate` with body literal string `'null'`; returns the dsInfo/webservices payload.

### 2.4 OAuth Auth Headers (`_get_auth_headers`)

Sent on `signin`, 2FA verify, and trust calls (merged with `overrides`):

```
Accept: */*                              (2FA overrides this to application/json)
Content-Type: application/json
X-Apple-OAuth-Client-Id:    d39ba9916b7251055b22c7f910e2ea796ee65e98b2ddecea8f5dde8d9d1a815d
X-Apple-OAuth-Client-Type:  firstPartyAuth
X-Apple-OAuth-Redirect-URI: https://www.icloud.com      (global even in CN mode)
X-Apple-OAuth-Require-Grant-Code: true
X-Apple-OAuth-Response-Mode: web_message
X-Apple-OAuth-Response-Type: code
X-Apple-OAuth-State:        <client_id>
X-Apple-Widget-Key:         d39ba9916b7251055b22c7f910e2ea796ee65e98b2ddecea8f5dde8d9d1a815d
```

Dynamic headers pulled from `session_data` and added when present: `scnt` (`scnt`), `session_id` (`X-Apple-ID-Session-Id`).

### 2.5 Token Threading via Response Headers (CRITICAL)

The multi-step login state lives in `session_data`, populated **from response headers on EVERY response** by `PyiCloudSession.request`. This is the easiest thing to miss in a port because `requests` does it transparently.

`HEADER_DATA` mapping (response header → `session_data` key):

| Response header | `session_data` key |
|---|---|
| `X-Apple-ID-Account-Country` | `account_country` |
| `X-Apple-ID-Session-Id` | `session_id` |
| `X-Apple-Session-Token` | `session_token` |
| `X-Apple-TwoSV-Trust-Token` | `trust_token` |
| `scnt` | `scnt` |

These thread the handshake together: harvested from each response, then echoed back as `scnt` + `X-Apple-ID-Session-Id` request headers on the next `signin`/`2fa`/`trust` call. **In TS:** an axios *response* interceptor copies these five headers into a mutable session-data object; a *request* interceptor echoes the relevant ones back.

### 2.6 Two-Factor (HSA2 / 2FA)

- `requires_2fa` (prop): `data['dsInfo']['hsaVersion'] == 2 and (hsaChallengeRequired or not is_trusted_session)`.
  > Note: uses `data['dsInfo']` directly → KeyErrors if `dsInfo` absent (asymmetric with `requires_2sa` which uses `.get('dsInfo', {})`). Harden in the port if desired.
- `validate_2fa_code(code)` → `POST {AUTH}/verify/trusteddevice/securitycode` with `{securityCode:{code}}` + OAuth headers (`Accept: application/json`) + `scnt` + `X-Apple-ID-Session-Id`.
  - Error code `-21669` → return `False` (wrong code, do not raise).
  - On success → `trust_session()`; returns `not requires_2sa`.

### 2.7 Two-Step (HSA1 / legacy 2SA)

- `requires_2sa` (prop): `data.get('dsInfo',{}).get('hsaVersion',0) >= 1 and (hsaChallengeRequired or not is_trusted_session)`.
- `is_trusted_session` (prop): `data.get('hsaTrustedBrowser', False)`.
- `trusted_devices` → `GET {SETUP}/listDevices` → `response['devices']`.
- `send_verification_code(device)` → `POST {SETUP}/sendVerificationCode` (body = device) → `{success:bool}`.
- `validate_verification_code(device, code)` → `POST {SETUP}/validateVerificationCode` with `device + {verificationCode, trustBrowser:true}`.
  - Error code `-21669` → return `False`.
  - On success → `trust_session()`; returns `not requires_2sa`.

### 2.8 Trust

- `trust_session()` → `GET {AUTH}/2sv/trust` with OAuth headers + `scnt` + `X-Apple-ID-Session-Id`. The response delivers the `X-Apple-TwoSV-Trust-Token` header (harvested into `session_data`), then calls `_authenticate_with_token()`. Returns bool.

### 2.9 Cookie / Session Persistence

- **`session_data`** persisted as JSON to `<cookieDir>/<sanitized>.session` on **every request** (inside `request()`).
- **Cookies** persisted via `LWPCookieJar` to `<cookieDir>/<sanitized>` (LWP/Netscape format) with `ignore_discard=True, ignore_expires=True`.
- `client_id` lives in `session_data` and is reused across runs.
- The real auth credential for service calls is the **`X-APPLE-WEBAUTH-*` cookie family** (notably `X-APPLE-WEBAUTH-TOKEN`, `X-APPLE-WEBAUTH-VALIDATE`, `X-APPLE-WEBAUTH-HSA-TRUST`), set by Apple during login and sent automatically on every subsequent call.

**TS persistence:** use `tough-cookie` `CookieJar` + a file store (a JSON store is fine for a greenfield port — LWP format isn't standard in JS). Load on startup; tolerate corrupt/old jars by rebuilding on next auth. Persist after auth-affecting requests at minimum (per-request disk writes are wasteful but functionally important for resuming trusted sessions). **Never log the password or harvested tokens.**

### 2.10 Webservice URL Resolution

`_get_webservice_url(ws_key)` → `self._webservices[ws_key]['url']` or raises `PyiCloudServiceNotActivatedException`. Lazy service properties map to these keys:

| Property | webservices key |
|---|---|
| `devices` / FindMyiPhone | `findme` |
| `account` | `account` |
| `files` (Ubiquity) | `ubiquity` |
| `photos` | `ckdatabasews` |
| `calendar` | `calendar` |
| `contacts` | `contacts` |
| `reminders` | `reminders` |
| `drive` | `drivews` + `docws` |

---

## 3. Per-Service Breakdown

> All services share the authenticated cookie session. Bodies are typically `json.dumps(...)` passed as raw `data=` (not `json=`); Content-Type is set explicitly only where noted. Hosts shown (e.g. `p31-…`) are illustrative — **resolve from the webservices map**.

### 3.1 Drive (`services/drive.py`)

Two storage systems: modern **CloudDocs** (`DriveService`/`DriveNode`) and legacy read-only **Ubiquity** (`UbiquityService`/`UbiquityNode`).

#### `DriveService`
Facade over two base URLs: `_service_root` (drivews, metadata/folder ops) and `_document_root` (docws, download/upload). Stores a **copy** of `params`; lazily builds and caches the root `DriveNode`. Delegates attribute/index access to the root node.

| Method | Endpoint / Behavior |
|---|---|
| `get_node_data(node_id)` | `POST {drivews}/retrieveItemDetailsInFolders`, body = JSON **array** `[{drivewsid:'FOLDER::com.apple.CloudDocs::<node_id>', partialData:false}]` → returns `json()[0]`. |
| `get_file(file_id, **kw)` | `GET {docws}/ws/com.apple.CloudDocs/download/by_id?document_id=<file_id>` → JSON with tokens; then `GET data_token.url` (fallback `package_token.url`) — streamed. |
| `get_app_data()` | `GET {drivews}/retrieveAppLibraries` → `json()['items']`. |
| `_get_upload_contentws_url(fobj)` | `POST {docws}/ws/com.apple.CloudDocs/upload/web`, header `Content-Type: text/plain`, body `{filename,type:'FILE',content_type,size}` → `(document_id, url)`. |
| `send_file(folder_id, fobj)` | Saga: reserve URL → multipart POST file → read `json()['singleFile']` → `_update_contentws`. |
| `_update_contentws(...)` | `POST {docws}/ws/com.apple.CloudDocs/update/documents` (commit). Header `text/plain`. |
| `create_folders(parent, name)` | `POST {drivews}/createFolders` body `{destinationDrivewsId, folders:[{clientId:params['clientId'], name}]}`. Header `text/plain`. |
| `rename_items(id, etag, name)` | `POST {drivews}/renameItems` body `{items:[{drivewsid,etag,name}]}`. |
| `move_items_to_trash(id, etag)` | `POST {drivews}/moveItemsToTrash` body `{items:[{drivewsid,etag,clientId:params['clientId']}]}`. |
| `_get_token_from_cookie()` | Scans cookies for `X-APPLE-WEBAUTH-VALIDATE`, regex `\bt=([^:]+)` from value → `{token:<t>}`. **Required for upload.** |
| `_raise_if_error(resp)` | Raise `PyiCloudAPIResponseException(reason, status)` if `not resp.ok`. |

**Node id conventions:** folders `FOLDER::com.apple.CloudDocs::<guid|root>` (drivewsid); files `FILE::com.apple.CloudDocs::<guid>`. `docwsid` = bare guid (`root`/`documents`) used for download/upload/children-fetch. `etag` (e.g. `32::2x`) required for rename/delete (optimistic concurrency).

**Upload commit body (`update/documents`):**
```json
{ "data": { "signature": "<fileChecksum>", "wrapping_key": "<wrappingKey>",
            "reference_signature": "<referenceChecksum>", "size": <size>,
            "receipt": "<receipt — OMIT for 0-byte files>" },
  "command": "add_file", "create_short_guid": true, "document_id": "<from reserve>",
  "path": { "starting_document_id": "<folder docwsid>", "path": "<filename>" },
  "allow_conflict": true,
  "file_flags": { "is_writable": true, "is_executable": false, "is_hidden": false },
  "mtime": <epoch ms>, "btime": <epoch ms> }
```

#### `DriveNode`
Wraps a metadata dict; lazily fetches/caches `_children`; proxies ops back to `DriveService`.

- `name`: `<name>.<extension>` if `extension` present else `name`.
- `type`: `data['type'].lower()` (`folder`/`file`/`app_library`).
- `get_children()`: if `items` missing, fetch via `get_node_data(data['docwsid'])` and **merge into `data`**; `KeyError(data['status'])` if still none.
- `size`/`date_changed`/`date_modified`/`date_last_open`: parsed fields (`_date_to_utc`).
- `open(**kw)`: **if `size==0`, returns an empty in-memory Response with NO HTTP call** (iCloud 400s on 0-byte `by_id`); else `get_file(docwsid)`.
- `mkdir`/`rename`/`delete`/`dir`/`get`/`__getitem__`.
- `upload(fobj, **kw)`: calls `send_file` — **but `send_file` has no `**kwargs`**, so extra kwargs raise `TypeError`. Drop or fix in TS.

#### `UbiquityService` / `UbiquityNode` (legacy, read-only)
URL template `{ubiquity}/ws/{dsid}/{variant}/{node_id}`, variant `item|parent|file`. Root node id is integer **0**. `get_children` → `{item_list:[...]}`. Nodes have integer `item_id`; `modified` parsed `%Y-%m-%dT%H:%M:%SZ`. Keep entirely separate from Drive's guid scheme.

#### Drive-specific HTTP details
- **Content-Type `text/plain` is mandatory** for `upload/web`, `update/documents`, `createFolders` (iCloud rejects `application/json`). Other POSTs send JSON with default content-type. Multipart upload sets no content-type (boundary auto-set).
- **Download is 2 hops**; CDN url is self-authenticating and **time-limited** (`e=<epoch>` expiry) — fetch promptly.
- **Date normalization (`_date_to_utc`):** dates arrive as `…Z` (UTC) or California offset `…-07:00`/`-08:00`; regex-detect offset, subtract it, output naive UTC. `dateModified` usually `Z`; `dateChanged`/`dateCreated` carry offsets.

> **`params` regression (fix, don't copy):** `base.py` initializes `self.params = {}` and never repopulates it, yet Drive needs `params['clientId']` (in `createFolders`/`moveItemsToTrash` bodies) and Ubiquity needs `params['dsid']` (URL path). Populate after login: `dsid` from `data.dsInfo.dsid`, `clientId` from the persisted `client_id`, plus `clientBuildNumber`/`clientMasteringNumber`/`ckjsBuildVersion` constants (historically `17DHotfix5` / `17DProjectDev77`).

### 3.2 Photos (`services/photos.py`)

Wraps the **CloudKit Database web API**. All POSTs carry a JSON body with header `Content-Type: text/plain`; query string is `urlencode(self.params)` augmented with `remapEnums=True, getCurrentSyncToken=True`.

`service_endpoint = service_root + '/database/1/com.apple.photos.cloud/production/private'` where `service_root = webservices['ckdatabasews'].url`.

#### `PhotosService`
- `__init__`: copies params, adds the two flags, **POSTs a `CheckIndexingState` probe**; raises `PyiCloudServiceNotActivatedException` if `records[0].fields.state.value != 'FINISHED'`.
- `albums` (lazy dict): starts from 11 hard-coded `SMART_FOLDERS`, merges `_fetch_folders()` (recordType `CPLAlbumByPositionLive`); skips folders lacking `albumNameEnc`, the `----Root-Folder----` record, and `isDeleted` folders; decodes name from base64 `albumNameEnc`; builds a `parentId EQUALS` filter per user album.
- `all`: `albums['All Photos']`.

#### `PhotoAlbum` (iterable, length-aware)
- `__len__`: `POST internal/records/query/batch` with `HyperionIndexCountLookup` filtered by `indexCountID IN [obj_type]`, `zoneWide:true` → `batch[0].records[0].fields.itemCount.value` (cached in `_len`).
- `photos` (generator): rank-based pagination. Start offset = `len-1` for DESCENDING else `0`. Loop `POST records/query` (`_list_query_gen` body); partition records into `CPLAsset` (keyed by `masterRef.recordName`) and `CPLMaster`; advance offset by number of master records (down for DESCENDING, up otherwise); yield `PhotoAsset(master, asset)`; stop when a page returns no masters.
- `_list_query_gen`: body with `filterBy` `startRank` (INT64) + `direction` (STRING), `recordType=list_type`, `resultsLimit = page_size*2` (each logical photo = two records), ~90-field `desiredKeys`, `zoneID PrimarySync`; extends with `query_filter` if present.

#### `PhotoAsset`
- `id`, `filename` (base64 `filenameEnc`), `size`, `asset_date`/`created` (ms-epoch UTC, fallback epoch 0), `added_date`, `dimensions`.
- `versions`: `VIDEO_VERSION_LOOKUP` if `resVidSmallRes` present else `PHOTO_VERSION_LOOKUP`; each version = `{filename,width,height,size,url=<prefix>Res.value.downloadURL,type}`.
  - `PHOTO_VERSION_LOOKUP = {original:resOriginal, medium:resJPEGMed, thumb:resJPEGThumb}`
  - `VIDEO_VERSION_LOOKUP = {original:resOriginal, medium:resVidMed, thumb:resVidSmall}`
- `download(version='original', **kw)`: `GET versions[version].url` with `stream=True`; returns `None` if version missing.
- `delete()`: `POST records/modify` update op setting `fields.isDeleted.value=1`, `atomic:true`.
  > **Subtlety (preserve):** sets `recordName`/`recordType` from the **asset** record but uses `recordChangeTag` from the **master** record. Wrong mix → change-tag mismatch failure. (Source also has dead `CheckIndexingState` assignment overwritten immediately — ignore.)

**Literal request bodies** (all `zoneID:{zoneName:'PrimarySync'}`):
- Indexing: `{"query":{"recordType":"CheckIndexingState"},"zoneID":{...}}`
- Folders: `{"query":{"recordType":"CPLAlbumByPositionLive"},"zoneID":{...}}`
- Count: `{"batch":[{"resultsLimit":1,"query":{"filterBy":{"fieldName":"indexCountID","fieldValue":{"type":"STRING_LIST","value":[obj_type]},"comparator":"IN"},"recordType":"HyperionIndexCountLookup"},"zoneWide":true,"zoneID":{...}}]}`
- Smart-album filter example: `[{"fieldName":"smartAlbum","comparator":"EQUALS","fieldValue":{"type":"STRING","value":"FAVORITE"}}]`

**Records** have `recordName`, `recordType`, `recordChangeTag`, `fields` (map of `fieldName → {value,type}`). User album `obj_type = 'CPLContainerRelationNotDeletedByAssetDate:<folderId>'`, `list_type = 'CPLContainerRelationLiveByAssetDate'`. Subfolders are explicitly **not** handled (flattened by name; collisions overwrite).

### 3.3 Account (`services/account.py`)

#### `AccountService` (all lazy + cached)
- `_acc_endpoint = service_root + '/setup/web'`.
- `devices` → `GET {acc}/device/getDevices` → `response['devices']` mapped to `AccountDevice`.
- `family` → `GET {acc}/family/getFamilyDetails` → `response['familyMembers']` mapped to `FamilyMember`.
- `storage` → `GET {hardcoded}/storageUsageInfo` → `AccountStorage`.
  > **Quirk/latent bug:** storage URL is **hardcoded** to `https://setup.icloud.com/setup/ws/1/storageUsageInfo` — NOT switched to `.com.cn` for China. Decide whether to fix.

#### `AccountDevice`
Dict subclass; `__getattr__(key)` → `self[underscore_to_camelcase(key)]` (e.g. `model_display_name` → `modelDisplayName`). **In TS, define typed interfaces instead of reproducing the dynamic getattr.**

#### `FamilyMember`
Typed getters (`last_name`, `dsid`, `full_name`, `apple_id`, `has_parental_privileges`, `has_share_my_location_enabled`, …). `get_photo()` → `GET {acc}/family/getMemberPhoto?memberId=<dsid>` streamed image bytes (raw Buffer/stream in TS).

#### `AccountStorage` / `AccountStorageUsage` / `AccountStorageUsageForMedia`
- `AccountStorage`: builds `usage` from `storageUsageInfo + quotaStatus`; `usages_by_media` OrderedDict keyed by `mediaKey` from `storageUsageByMedia`.
- `AccountStorageUsage`: `comp/used/total/commerce…InBytes`; computed `used_storage_in_percent = round(used*100/total,2)`, `available_*`; quota flags `overQuota`, `haveMaxQuotaTier`, `almost-full`, `paidQuota`.
- `AccountStorageUsageForMedia`: `mediaKey`, `displayLabel`, `displayColor` (hex), `usageInBytes`.

### 3.4 Find My iPhone (`services/findmyiphone.py`)

#### `FindMyiPhoneServiceManager`
`fmip_endpoint = service_root + '/fmipservice/client/web'`. **Calls `refresh_client()` in its constructor** (eager network I/O → async init in NestJS). Dict-like container of `AppleDevice` keyed by `content['id']`.

- `refresh_client()` → `POST /refreshClient` body `{clientContext:{fmly:with_family, shouldLocate:true, selectedDevice:'all', deviceListVersion:1}}`; stores `self.response`; (re)builds device map from `response['content']`; raises `PyiCloudNoDevicesException` if empty.
- `__getitem__`: int key indexes `keys()` list; else dict lookup by id.
- `__getattr__`: delegates to `_devices` dict (`.keys()`, `.values()`, `.items()`, `len()`).

Endpoint URLs: `/refreshClient`, `/playSound`, `/sendMessage`, `/lostDevice`.

#### `AppleDevice`
Holds raw `content` dict + back-ref to manager. **No per-device location endpoint** — `location()` and `status()` both call `manager.refresh_client()` (whole-list refresh) then read from refreshed content.

| Method | Body |
|---|---|
| `location()` | refresh → `content['location']` |
| `status(additional=[])` | refresh → `{batteryLevel, deviceDisplayName, deviceStatus, name} + additional` |
| `play_sound(subject='Find My iPhone Alert')` | `POST /playSound` `{device:id, subject, clientContext:{fmly:true}}` — **fmly hardcoded true** (inconsistent with manager's `with_family`) |
| `display_message(subject, message='This is a note', sounds=False)` | `POST /sendMessage` `{device, subject, sound:sounds, userText:true, text:message}` |
| `lost_device(number, text=..., newpasscode='')` | `POST /lostDevice` `{text, userText:true, ownerNbr:number, lostModeEnabled:true, trackingEnabled:true, device, passcode:newpasscode}` |

`content` keys: `id`, `location` (`latitude/longitude/timeStamp/horizontalAccuracy/positionType/isOld/locationFinished`), `batteryLevel`, `deviceDisplayName`, `deviceStatus`, `name`, `modelDisplayName`, `deviceClass`, `batteryStatus`. Location is near-realtime and may be stale (`isOld`, `timeStamp` epoch ms).

### 3.5 Calendar / Contacts / Reminders

These three are GET-only except `reminders.post` (POST). Calendar/Reminders are timezone-aware (`usertz` = IANA tz name).

#### `CalendarService`
- `events(from,to)` → `refresh_client` → `GET {root}/ca/events?lang=en-us&usertz=<tz>&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` → `response['Event']`.
- `get_event_detail(pguid, guid)` → `GET {root}/ca/eventdetail/{pguid}/{guid}?lang=en-us&usertz=<tz>` → `response['Event'][0]`.
- `calendars()` → `GET {root}/ca/startup?...` → `response['Collection']` (singular key!).

#### `ContactsService` (two-step token handshake — do NOT parallelize)
- `refresh_client()`: **Step 1** `GET {root}/co/startup?clientVersion=2.1&locale=en_US&order=last,first` → `prefToken`, `syncToken`. **Step 2** `GET {root}/co/contacts?...&prefToken&syncToken&limit=0&offset=0` (`limit=0` = all) → overwrites `self.response`.
- `all()` → `response['contacts']`.
- `_contacts_changeset_url` (`/co/changeset`) declared but unused.

#### `RemindersService`
**Calls `refresh()` in constructor.**
- `refresh()` → `GET {root}/rd/startup?clientVersion=4.0&lang=en-us&usertz=<tz>` → parses `Collections[]` (`title→{guid,ctag}`) and `Reminders[]` (matched by `pGuid==collection.guid`) into `lists`/`collections`.
- `post(title, description='', collection=None, due_date=None)` → resolves `pGuid` (`'tasks'` default or `collections[collection].guid`); `POST {root}/rd/reminders/tasks?...` → returns `req.ok` (boolean).

**Reminders POST body** (JSON string):
```json
{ "Reminders": { "title": ..., "description": ..., "pGuid": "tasks-or-guid",
    "etag": null, "order": null, "priority": 0, "recurrence": null, "alarms": [],
    "startDate": null, "startDateTz": null, "startDateIsAllDay": false,
    "completedDate": null, "dueDate": <dueArrayOrNull>, "dueDateIsAllDay": false,
    "lastModifiedDate": null, "createdDate": null, "isFamily": null,
    "createdDateExtended": <epoch ms>, "guid": "<uuid4>" },
  "ClientState": { "Collections": [ <{guid,ctag} from cached collections> ] } }
```

**`dueDate` array encoding (read & write):** 6 elements `[packedInt, year, month, day, hour, minute]`. On **write**, `packedInt = int("" + year + month + day)` — **naive string concat, NOT zero-padded** (e.g. 2026,6,3 → `int('202663')`). Replicate exactly. On **read**, only indices 1..5 are used; index 0 ignored.

#### Cal/Contacts/Reminders gotchas
- **`monthrange` latent bug:** Calendar computes `first_day, last_day = monthrange(...)` then `datetime(year, month, first_day)`. But `monthrange` returns `(weekday_of_first, days_in_month)` — so `first_day` is a **weekday index (0–6)**, not day 1. `startDate` is therefore usually wrong. **Decide intentionally** (most correct: start = 1st, end = last day) and flag to the team.
- **Response key casing:** PascalCase from server — `Event`, `Collection` (calendar, singular), `Collections`/`Reminders` (reminders, plural); camelCase contacts — `contacts`, `prefToken`, `syncToken`.
- `usertz` from `tzlocal.get_localzone_name()` → TS `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- `post()` requires collections to be loaded first (it builds `ClientState.Collections` from the cache).

---

## 4. Cross-Cutting Concerns

### 4.1 Secrets / Config Storage (`utils.py`)

- Keyring service name constant: **`KEYRING_SYSTEM = 'pyicloud://icloud-password'`**, entries keyed by username (Apple ID). Preserve this exact string if the TS port must read credentials saved by the Python version (keytar `service` must equal it).
- `get_password(username, interactive=sys.stdout.isatty())`: keyring first; on `PyiCloudNoStoredPasswordAvailableException`, re-raise if non-interactive, else prompt via `getpass`.
  > **Gotcha:** `interactive` default is evaluated **once at import** (`sys.stdout.isatty()`), not per call. In TS, evaluate `process.stdout.isTTY` at call time (or capture once intentionally).
- `password_exists_in_keyring(username)`, `get_password_from_keyring` (None → raise), `store_password_in_keyring`, `delete_password_in_keyring`.
- `underscore_to_camelcase(word, initial_capital=False)`: split `_`, capitalize each piece, lowercase first char unless `initial_capital`. `'foo_bar' → 'fooBar'`.

**TS mapping:** `keytar` (`getPassword`/`setPassword`/`deletePassword`) with `service = 'pyicloud://icloud-password'`. `getPassword` resolves `null` when absent → throw `NoStoredPasswordAvailable`.

### 4.2 Exception Hierarchy (`exceptions.py`)

```
PyiCloudException (extends Error)
├── PyiCloudAPIResponseException(reason, code=None, retry=false)
│       .reason, .code stored; message = reason||''; + ' (code)' if code; + '. Retrying ...' if retry
│       (retry is NOT stored as an attribute — only affects message)
│   └── PyiCloudServiceNotActivatedException
├── PyiCloudFailedLoginException        (SIBLING of API exception, not a child — matters for catch specificity)
├── PyiCloud2SARequiredException(apple_id)   message: 'Two-step authentication required for account: <apple_id>'
├── PyiCloudNoStoredPasswordAvailableException
└── PyiCloudNoDevicesException
```

**TS:** for each `Error` subclass, set `this.name` and call `Object.setPrototypeOf(this, X.prototype)` so `instanceof` works. Keep `reason`/`code` as public fields.

### 4.3 Error Handling & Normalization (`PyiCloudSession.request` / `_raise_error`)

JSON bodies use inconsistent key names across endpoints; sometimes 2xx-but-error:
- **reason** = `errorMessage` ‖ `reason` ‖ `errorReason` ‖ (`error` if str) ‖ (`'Unknown reason'` if `error` truthy).
- **code** = `errorCode` ‖ `serverErrorCode`.
- If a reason is present, call `_raise_error(code, reason)`.

`_raise_error(code, reason)` special cases:
| Condition | Result |
|---|---|
| `requires_2sa` and reason `'Missing X-APPLE-WEBAUTH-TOKEN cookie'` | `PyiCloud2SARequiredException` |
| code in `('ZONE_NOT_FOUND','AUTHENTICATION_FAILED')` | `PyiCloudServiceNotActivatedException` |
| code `'ACCESS_DENIED'` | append throttle note |
| code in `[421,450,500]` | `'Authentication required for Account.'` |
| else | `PyiCloudAPIResponseException(reason, code)` |
| verification/2FA code `-21669` | returned as `False` upstream (wrong code), not raised |

### 4.4 Retry / Re-Auth Semantics (single retry, recursion)

`request()` recursively calls itself with `kwargs['retried']=True`; the guard `has_retried is None` means **exactly one retry**. Triggered when a response is not-ok and (content-type non-JSON) or status in `{421, 450, 500}`:

- **Branch A (findme URL in URL):** re-authenticate (`force_refresh=True`; `service=None` if 450 else `'find'`) then retry once. The surrounding try/except **swallows all exceptions**, including webservice-URL-resolution failures.
- **Branch B (other):** retry once after constructing (but not raising) an exception.
- Otherwise: `_raise_error(status, reason)`.

Content-Type checked against `['application/json','text/json']` for JSON vs raw handling.

**TS:** implement as a single transparent retry in an axios interceptor; guard with a `retried` flag to avoid infinite loops; mirror the findme-specific 450→full / else→`'find'` re-auth.

### 4.5 `params` (shared mutable query-param bag)

Passed to every downstream service and to 2SA endpoints. In `base.py` it stays `{}` (latent regression). The port must populate it after login with at least `dsid` (`data.dsInfo.dsid`) and `clientId` (persisted `client_id`), plus build-number constants, so Drive/Ubiquity/Photos work. Keep it a shared mutable object available to service constructors.

### 4.6 Logging / Redaction

`PyiCloudPasswordFilter` (a `logging.Filter`) replaces the plaintext password with `********` in any record. The `inspect.stack()`-based per-module logger is cosmetic. **TS:** use a NestJS `Logger` + a redaction step; never log password or harvested tokens.

### 4.7 CLI (`cmdline.py`) — Find My iPhone Tool

Stateful login-retry loop and device-command dispatch:

1. Parse argparse. If `--username` + `--delete-from-keyring`, delete entry immediately.
2. Loop: require username (else `parser.error` → exit 2); fetch password via `get_password` (else error).
3. Construct `PyiCloudService(username.strip(), password.strip(), china_mainland=flag)`. If password not in keyring AND interactive AND user confirms "Save password in keyring?" → store.
4. If `requires_2fa`: read code from stdin → `validate_2fa_code`; failure → `sys.exit(1)`. Elif `requires_2sa`: list `trusted_devices` (show `deviceName` or `SMS to <phoneNumber>`), prompt index → `send_verification_code` → `validate_verification_code`; failure → exit 1. Then break.
5. `except PyiCloudFailedLoginException`: if password in keyring, **delete it** (stale-cred cleanup); message `'Bad username or password for <username>'`; set `password=None`; `failure_count++`; if `>=3` raise `RuntimeError` chained; else print to stderr and loop.

Device dispatch (non-exclusive, combinable): `--locate` → `location()`; `--outputfile` → pickle `device.content` to `<name>.fmip_snapshot`; `--llist`/`--list`; `--sound`/`--message`/`--silentmessage`/`--lostmode` each **require `--device`** (else `RuntimeError`, constant `DEVICE_ERROR`). `display_message` uses subject `'A Message'` (sounds=True) or `'A Silent Message'` (sounds=False). `lost_device(number=lost_phone, text=lost_message, newpasscode=lost_password)`.

**Exit codes are part of the contract:** `2` = argparse/usage error; `0` = success; bad creds → `RuntimeError('Bad username or password for <user>')`.

**TS:** `commander`/`nestjs-commander`; `@inquirer/prompts` for password/confirm; replace `pickle` with `JSON.stringify` to `.json` (pickle is non-portable and an arbitrary-code-execution risk). Keep `.strip()` trimming on username/password/device-id/lost-* values.

---

## 5. Catalog of External iCloud Endpoints

> Bases: `AUTH = idmsa…/appleauth/auth`, `SETUP = setup.icloud.com/setup/ws/1`, `HOME = www.icloud.com` (or `.com.cn`). Per-service roots resolved from `webservices[...]`.

### 5.1 Authentication / Setup

| Method | URL | Body | Notes |
|---|---|---|---|
| POST | `{AUTH}/signin?isRememberMeEnabled=true` | `{accountName,password,rememberMe:true,trustTokens:[…]}` | OAuth password login; fail → `PyiCloudFailedLoginException` |
| POST | `{SETUP}/accountLogin` | `{accountCountryCode,dsWebAuthToken,extended_login:true,trustToken}` | Token login → `self.data` |
| POST | `{SETUP}/accountLogin` | `{appName,apple_id,password}` | One-factor service variant |
| POST | `{SETUP}/validate` | literal `'null'` | Validate existing session |
| GET | `{SETUP}/listDevices` | — | 2SA trusted devices → `{devices:[…]}` |
| POST | `{SETUP}/sendVerificationCode` | device | → `{success:bool}` |
| POST | `{SETUP}/validateVerificationCode` | device + `{verificationCode,trustBrowser:true}` | `-21669` = wrong code |
| POST | `{AUTH}/verify/trusteddevice/securitycode` | `{securityCode:{code}}` | HSA2; `-21669` = wrong code |
| GET | `{AUTH}/2sv/trust` | — | Trust token via response header |
| GET | `{SETUP}/storageUsageInfo` *(hardcoded host)* | — | Storage; not CN-switched |

### 5.2 Drive / Ubiquity

| Method | URL | Notes |
|---|---|---|
| POST | `{drivews}/retrieveItemDetailsInFolders` | array body; node metadata + children |
| GET | `{docws}/ws/com.apple.CloudDocs/download/by_id?document_id=<id>` | → signed CDN tokens |
| GET | `<data_token.url \| package_token.url>` | actual bytes (`cvws.icloud-content.com`), streamed, `e=` expiry |
| GET | `{drivews}/retrieveAppLibraries` | app libraries |
| POST | `{docws}/ws/com.apple.CloudDocs/upload/web` | reserve upload (`text/plain`) |
| POST | `<reserve url>` | multipart file PUT → `{singleFile:{…}}` |
| POST | `{docws}/ws/com.apple.CloudDocs/update/documents` | commit (`text/plain`) |
| POST | `{drivews}/createFolders` | (`text/plain`) |
| POST | `{drivews}/renameItems` | |
| POST | `{drivews}/moveItemsToTrash` | soft delete |
| GET | `{ubiquity}/ws/{dsid}/item\|parent\|file/{node_id}` | legacy read-only |

### 5.3 Photos (CloudKit) — `{ckdatabasews}/database/1/com.apple.photos.cloud/production/private`

| Method | URL | Notes |
|---|---|---|
| POST | `…/records/query` | indexing probe, folders, photo listing (`text/plain`) |
| POST | `…/internal/records/query/batch` | album count |
| POST | `…/records/modify` | soft delete |
| GET | `<version.downloadURL>` | binary, signed CDN, streamed |

### 5.4 Account / Find My iPhone

| Method | URL | Notes |
|---|---|---|
| GET | `{account}/setup/web/device/getDevices` | `{devices:[…]}` |
| GET | `{account}/setup/web/family/getFamilyDetails` | `{familyMembers:[…]}` |
| GET | `{account}/setup/web/family/getMemberPhoto?memberId=<dsid>` | streamed image |
| POST | `{findme}/fmipservice/client/web/refreshClient` | device list + locations |
| POST | `{findme}/fmipservice/client/web/playSound` | |
| POST | `{findme}/fmipservice/client/web/sendMessage` | |
| POST | `{findme}/fmipservice/client/web/lostDevice` | |

### 5.5 Calendar / Contacts / Reminders

| Method | URL | Notes |
|---|---|---|
| GET | `{calendar}/ca/events?lang&usertz&startDate&endDate` | `response.Event` |
| GET | `{calendar}/ca/eventdetail/{pguid}/{guid}` | `response.Event[0]` |
| GET | `{calendar}/ca/startup?...` | `response.Collection` |
| GET | `{contacts}/co/startup?clientVersion=2.1&locale=en_US&order=last,first` | `prefToken,syncToken` |
| GET | `{contacts}/co/contacts?...&prefToken&syncToken&limit=0&offset=0` | `contacts[]` |
| GET | `{reminders}/rd/startup?clientVersion=4.0&lang&usertz` | `Collections[]`, `Reminders[]` |
| POST | `{reminders}/rd/reminders/tasks?...` | create reminder; returns `ok` |

---

## 6. Testing / Mocking Strategy & Jest Mirror

### 6.1 How the Python Suite Works

The suite is **pure unit tests — no real network**. It subclasses the real `PyiCloudSession` and overrides `request(method, url, **kwargs)` with a hand-written router that:
1. Matches on **substring-in-URL + exact method string**.
2. Inspects JSON body (`kwargs['data']`, parsed with `json.loads(data or '{}')`), `params`, and `headers`.
3. Returns canned `ResponseMock` objects built from static fixture dicts in `const_*.py`.
4. **Mutates `self.service` state** to simulate stateful 2FA/2SA transitions.

Because only the *session* is mocked, **the real `authenticate()` business logic still runs** against the mock — this is the canonical reference for the HTTP contract.

| Test class | Mocks the session helper |
|---|---|
| `ResponseMock` | Stands in for `requests.Response`; `.text` = `json.dumps(result)`; holds `status_code`, `raw` (binary stream), `headers`. |
| `PyiCloudSessionMock` | The router; reads `SETUP/AUTH_ENDPOINT` from `self.service`, mutates `session_data['session_token']` and `user['apple_id']`. |
| `PyiCloudServiceMock` | Monkeypatches `base.PyiCloudSession = PyiCloudSessionMock` then runs the real `__init__`. |
| `AccountServiceTest`/`DriveServiceTest`/`FindMyiPhoneServiceTest`/`TestCmdline` | Assert parsed attrs, `__repr__`, dir listings, exit codes, error strings, 2FA flow. |

### 6.2 Router Contract (must reproduce exactly)

- **Order matters:** `validateVerificationCode` must be checked **before** `validate` (substring overlap).
- **Array bodies:** Drive `retrieveItemDetailsInFolders` sends a JSON array; route on `body[0].drivewsid`.
- **Auth state machine:** `signin` sets `session_data['session_token']` (VALID or `REQUIRES_2FA_TOKEN` based on user), which gates the subsequent `accountLogin` branch. `accountLogin` returns `LOGIN_WORKING` or `LOGIN_2FA` (`hsaChallengeRequired=true`, `hsaTrustedBrowser=false` → `requires_2fa`). 2FA `securitycode` returns **204** on success; `2sv/trust` returns **204**.
- **Cookie check:** `{SETUP}/validate` requires header `X-APPLE-WEBAUTH-TOKEN == VALID_COOKIE` else raises `'Session expired'`.
- **Stateful mutation:** `validateVerificationCode` does `TRUSTED_DEVICE_1.update({verificationCode:'0', trustBrowser:true})` then compares — **mutates a module-level fixture** (test-isolation hazard).
- **Binary:** `download/by_id` requires `params.document_id == '516C896C-…'`; the CDN GET returns `ResponseMock({}, raw=open('.gitignore','rb'))` so `.raw` is truthy.

**Key constants:** `AUTHENTICATED_USER='quentintarantino@hotmail.fr'`; `REQUIRES_2FA_USER`/`REQUIRES_2FA_TOKEN`; `VALID_PASSWORD='valid_password'`; `VALID_COOKIE='valid_cookie'`; `VALID_TOKEN='valid_token'`; `VALID_2FA_CODE='000000'`; `AUTH_OK={authType:'hsa2'}`. Fixture expectations include: 2 account devices, 3 family members, storage 43.75% of 5368709120 bytes, Drive root `dir()==['Keynote','Numbers','Pages','Preview','pyiCloud']`, subfolder `Test==['Document scanné 2.pdf','Scanned document 1.pdf']`, FMI 13 devices.

### 6.3 Mirroring in Jest (recommended improvements)

1. **Intercept HTTP at the wire, don't mock the service.** Use **nock** (axios) or **msw** with a routing table mirroring the substring+method branches, so the real ported `authenticate()`/parsing code is exercised.
2. **Return real response headers** (`X-Apple-ID-Session-Id`, `X-Apple-Session-Token`, `X-Apple-TwoSV-Trust-Token`, `X-Apple-ID-Account-Country`, `scnt`) — the Python mock cheats by mutating `session_data` directly, which **under-tests header parsing**. Prefer header-based mocks so your response interceptor is covered.
3. **Stateful two-request handshake:** keep a stateful closure variable (or sequenced stubs) so `signin` → `accountLogin` carry session state; reset between tests.
4. **Reset mutable fixtures between tests** (the `TRUSTED_DEVICE_1.update` pattern); never share a mutable singleton.
5. **Preserve match ordering** (`validateVerificationCode` before `validate`) or use stricter path matching.
6. **Array bodies** for Drive routing.
7. **Binary/stream:** return a `Readable`/arraybuffer for the CDN download and assert the stream/body exists.
8. **CLI exit codes** (`expect(...).toThrow`, mocked `process.exit`): `2` arg error, `0` success, `RuntimeError('Bad username or password for <user>')`; feed `VALID_2FA_CODE` via mocked stdin/`input`.
9. **Fail loudly on unmatched routes** — the Python mock returns `None` (latent bug); in TS throw `unexpected request: METHOD URL`.
10. **China:** substring matching works for `.com.cn` too because it matches paths (`signin`, `accountLogin`), not full hosts — keep substring matching.
11. **Port fixtures as JSON files**; keep the email/name derivation (`PERSON_ID = (first+last).lower()`, emails `@{hotmail.fr,me.com,icloud.com}`) so cross-references stay consistent.
12. **Add explicit retry tests** — the current suite only indirectly exercises 421/450/500 single-retry-with-reauth (via the `fmi` branch); test it directly in the port.

---

## 7. Consolidated Porting Checklist

**Do first (foundation):**
- [ ] Port `exceptions` (exact hierarchy; `instanceof` via `setPrototypeOf`).
- [ ] Port the session layer: axios + `tough-cookie` jar (file-backed), **response interceptor** harvesting the five `HEADER_DATA` headers into mutable `session_data`, **request interceptor** echoing `scnt` + `X-Apple-ID-Session-Id`.
- [ ] Single-retry interceptor (421/450/500; findme 450→full / else→`'find'`); guard with `retried`.
- [ ] Error normalization (multi-key reason/code extraction; special-case map).
- [ ] Persist `session_data` JSON + cookie jar; reuse `client_id` across runs.

**Auth lifecycle:**
- [ ] Async `create()`/`init()` (no network in constructor).
- [ ] `signin` → `accountLogin` → `validate` flow; 2FA + 2SA + trust.
- [ ] Resolve `webservices[...]` URL map; populate `params` with `dsid` + `clientId` (+ build numbers) — fixing the empty-`{}` regression.
- [ ] China endpoint switch (hosts to `.com.cn`; OAuth widget/redirect stay global).

**Services (each takes resolved `service_root`, shared session, `params`):**
- [ ] Drive (two roots: drivews + docws; `text/plain` on upload/commit/createFolders; 3-step upload saga; 0-byte short-circuit; cookie-token extraction; `_date_to_utc`).
- [ ] Ubiquity (read-only; int ids; `dsid` in path) — kept separate.
- [ ] Photos (CheckIndexingState gate; rank pagination `resultsLimit=page_size*2`; CPLAsset/CPLMaster pairing; delete uses master `recordChangeTag`; base64 names; `text/plain`).
- [ ] Account (lazy/cached; typed interfaces instead of `__getattr__`; decide on hardcoded/CN-unaware storage URL).
- [ ] FindMyiPhone (async init instead of constructor refresh; manager owns device map; whole-list refresh for location/status).
- [ ] Calendar/Contacts/Reminders (timezone params; contacts two-step handshake; reminders constructor refresh→async; `dueDate` packed-int concat; **decide on `monthrange` bug fix**).

**Cross-cutting:**
- [ ] Secrets via `keytar` (`service = 'pyicloud://icloud-password'`).
- [ ] Logger + password/token redaction (never log secrets).
- [ ] CLI (commander; JSON instead of pickle; preserve exit codes + error strings + `.strip()`).

**Tests:**
- [ ] nock/msw wire-level mocks with **header-based** responses; stateful handshake; mutable-fixture reset; loud failures on unmatched routes; explicit retry tests; ported JSON fixtures.

> **Latent bugs to decide on (flag to team, do not blindly copy):** (1) empty `params` regression; (2) hardcoded non-CN storage URL; (3) Calendar `monthrange` weekday-as-day-of-month; (4) `DriveNode.upload` passing kwargs to a no-kwargs `send_file`; (5) `requires_2fa` KeyError asymmetry; (6) `play_sound` hardcoding `fmly:true`; (7) unmatched-route → `None` in the test mock.