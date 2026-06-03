# jsicloud — Exhaustive API Reference

Every symbol below is exported from the package root `'jsicloud'`. Signatures
match the source exactly. `[I/O]` = makes a network/disk request; `[local]` =
pure/synchronous. "getter→Promise" = a `get` accessor that returns a `Promise`.

---

## Module + DI tokens

### `IcloudModule`
```ts
static forRoot(options: IcloudModuleOptions): DynamicModule
static forRootAsync(opts: IcloudModuleAsyncOptions): DynamicModule
```
Both register `ICLOUD_OPTIONS` (resolved options), `SecretsService`, and an async
factory provider for `IcloudAuthService` (calls `IcloudAuthService.create`).
**Exports:** `IcloudAuthService`, `SecretsService`. All login I/O happens at
module init, so the injected `IcloudAuthService` is already authenticated.

```ts
interface IcloudModuleAsyncOptions {
  useFactory: (...args: unknown[]) => Promise<IcloudModuleOptions> | IcloudModuleOptions;
  inject?: InjectionToken[];          // positional deps for useFactory
  imports?: Array<Type<unknown> | DynamicModule | Promise<DynamicModule>>;
}
```

### DI tokens
```ts
const ICLOUD_OPTIONS: symbol         // Symbol('ICLOUD_OPTIONS')
const ICLOUD_MODULE_OPTIONS: symbol  // Symbol('ICLOUD_MODULE_OPTIONS')
```

### `IcloudModuleOptions`
| Field | Type | Required | Default |
|---|---|---|---|
| `accountName` | `string` | **yes** | — |
| `password` | `string` | no | keyring lookup by `accountName`, else interactive prompt |
| `cookieDir` | `string` | no | `<os.tmpdir()>/jsicloud/<os-username>` (mode `0o700`) |
| `chinaMainland` | `boolean` | no | `false` (true → `.com.cn` AUTH/HOME/SETUP; OAuth stays global) |
| `verify` | `boolean \| string` | no | `undefined` (`false` disables TLS verify — testing only; string = CA-bundle path) |
| `clientId` | `string` | no | persisted `client_id`, else `auth-<uuidv1>` |
| `withFamily` | `boolean` | no | `true` (include family-shared devices in Find My iPhone) |
| `userAgent` | `string` | no | default browser-like UA (Apple may `503` non-browser UAs) |

---

## `IcloudAuthService`

The constructor is **private** — use `create()` or the module.

```ts
static async create(options: IcloudModuleOptions, secrets: SecretsService): Promise<IcloudAuthService>  // [I/O]
```

### Public fields
```ts
data: AccountLoginData                 // dsInfo, webservices, apps, HSA flags
params: Record<string, string>         // shared query-param bag (clientId, dsid, build numbers)
readonly user: { accountName: string; password: string }   // never logged
readonly withFamily: boolean           // device commands default to family
```

### Lifecycle
```ts
async authenticate(opts?: AuthenticateOptions): Promise<void>                       // [I/O]
getAuthHeaders(overrides?: Record<string,string>): Record<string,string>            // [local]
populateParams(): void                                                              // [local]
getWebserviceUrl(key: string): string  // [local] throws PyiCloudServiceNotActivatedException if absent

interface AuthenticateOptions { forceRefresh?: boolean; service?: string; }
```
Flow: (1) if `session_token` present and not `forceRefresh`, try `validate`;
(2) else one-factor service login when supported; (3) else full OAuth
`signin → accountLogin`. Bad credentials → `PyiCloudFailedLoginException`.

### 2FA / 2SA
```ts
get requires2fa(): boolean        // [local] HSA2 required
get requires2sa(): boolean        // [local] HSA1/legacy required
get isTrustedSession(): boolean   // [local]
get trustedDevices(): Promise<Array<Record<string, unknown>>>   // [I/O] getter→Promise: `await auth.trustedDevices`

async requestTwoFactorCode(): Promise<void>   // [I/O] HSA2: deliver code (trusted-device push + SMS). REQUIRED before validate2faCode — API/SRP sessions are NOT auto-sent a code. No-op when !requires2fa.
async sendVerificationCode(device: Record<string,unknown>): Promise<boolean>                 // [I/O] 2SA
async validateVerificationCode(device: Record<string,unknown>, code: string): Promise<boolean> // [I/O] 2SA; wrong code (-21669) → false, trusts on success
async validate2faCode(code: string): Promise<boolean>           // [I/O] 2FA; wrong code (-21669) → false
async trustSession(): Promise<boolean>                          // [I/O] caught API failure → false
```
Wrong codes return `false` (do not throw). On success the session is trusted and
the method returns `!requires2sa`.

### Service accessors
| Accessor | Kind | Returns | init? |
|---|---|---|---|
| `get drive` | sync getter | `DriveService` | no |
| `get files` | sync getter | `UbiquityService` | no |
| `get account` | sync getter | `AccountService` | no |
| `get calendar` | sync getter | `CalendarService` | no |
| `get contacts` | sync getter | `ContactsService` | no |
| `photos()` | async **[I/O]** | `Promise<PhotosService>` | runs `init()` (indexing probe) |
| `reminders()` | async **[I/O]** | `Promise<RemindersService>` | runs `init()` (startup refresh) |
| `findMyiPhone()` | async **[I/O]** | `Promise<FindMyiPhoneService>` | runs `init()` (device list) |

All accessors are cached.

---

## `DriveService` + `DriveNode` (iCloud Drive / CloudDocs — read+write)

```ts
class DriveService {
  async getNodeData(nodeId: string): Promise<DriveItem>                          // [I/O]
  async getFile(fileId: string): Promise<Readable>                              // [I/O] streamed
  async getAppData(): Promise<DriveItem[]>                                      // [I/O]
  async createFolders(parent: string, name: string): Promise<unknown>          // [I/O]
  async renameItems(id: string, etag: string, name: string): Promise<unknown>  // [I/O]
  async moveItemsToTrash(id: string, etag: string): Promise<unknown>           // [I/O] soft delete
  async sendFile(folderId: string, fileName: string, stream: Readable, size: number): Promise<void>  // [I/O]
  async root(): Promise<DriveNode>                                             // [I/O] lazy+cached
  async dir(): Promise<string[] | null>                                       // [I/O] root child names
  async get(name: string): Promise<DriveNode>                                 // [I/O] root child by name
}

class DriveNode {
  constructor(connection: DriveService, data: DriveItem)
  public data: DriveItem
  get name(): string                  // `<name>.<extension>` when extension present
  get type(): string | undefined      // 'folder' | 'file' | 'app_library' (lower-cased)
  get size(): number | undefined      // folders → undefined
  get dateChanged(): Date | null
  get dateModified(): Date | null
  get dateLastOpen(): Date | null
  async getChildren(): Promise<DriveNode[]>            // [I/O] lazy+cached
  async dir(): Promise<string[] | null>               // [I/O] null for a file
  async get(name: string): Promise<DriveNode>         // [I/O] throws if no such child
  async open(): Promise<Readable>                     // [I/O]; size===0 → empty stream, no HTTP call
  async upload(fileName: string, stream: Readable, size: number): Promise<void>  // [I/O]
  async mkdir(folder: string): Promise<unknown>       // [I/O]
  async rename(name: string): Promise<unknown>        // [I/O]
  async delete(): Promise<unknown>                    // [I/O] move to trash
}

interface DriveItem {
  drivewsid: string; docwsid?: string; zone?: string; name: string;
  parentId?: string; etag?: string; type?: string; extension?: string;
  size?: number; dateChanged?: string; dateModified?: string;
  dateCreated?: string; lastOpenTime?: string; status?: string;
  items?: DriveItem[]; [key: string]: unknown;
}
```
`rename`/`delete` on `DriveService` (`renameItems`/`moveItemsToTrash`) need the
node's `etag` (optimistic concurrency).

---

## `UbiquityService` + `UbiquityNode` (legacy file store — READ-ONLY)

Integer node ids, root id `0`.

```ts
class UbiquityService {
  getNodeUrl(nodeId: number, variant?: 'item'|'parent'|'file'): string  // [local], variant default 'item'
  async getNode(nodeId: number): Promise<UbiquityNode>      // [I/O]
  async getChildren(nodeId: number): Promise<UbiquityNode[]>// [I/O]
  async getFile(nodeId: number): Promise<Readable>          // [I/O] streamed
  async root(): Promise<UbiquityNode>                       // [I/O] node 0, lazy+cached
  async dir(): Promise<string[]>                            // [I/O]
  async get(name: string): Promise<UbiquityNode>            // [I/O]
}

class UbiquityNode {
  constructor(connection: UbiquityService, data: UbiquityItem)
  public data: UbiquityItem
  get itemId(): number | undefined
  get name(): string | undefined
  get type(): string | undefined
  get size(): number | null         // unparseable → null
  get modified(): Date | null
  async open(): Promise<Readable>                  // [I/O]
  async getChildren(): Promise<UbiquityNode[]>     // [I/O] lazy+cached
  async dir(): Promise<string[]>                   // [I/O]
  async get(name: string): Promise<UbiquityNode>   // [I/O] throws if no such child
}

interface UbiquityItem {
  item_id?: number; name?: string; type?: string;
  size?: string | number; modified?: string; [key: string]: unknown;
}
```

---

## Photos (CloudKit) — `await auth.photos()`

```ts
class PhotosService {
  constructor(serviceRoot: string, http: IcloudHttpService, params: Record<string,string>)
  readonly serviceEndpoint: string   // `${serviceRoot}/database/1/com.apple.photos.cloud/production/private`
  readonly params: Record<string, string>  // copy + {remapEnums:'true', getCurrentSyncToken:'true'}
  readonly http: IcloudHttpService
  async init(): Promise<void>                                  // [I/O] throws PyiCloudServiceNotActivatedException unless indexing 'FINISHED'
  async albums(): Promise<Record<string, PhotoAlbum>>          // [I/O] lazy+cached (smart folders + user albums)
  async all(): Promise<PhotoAlbum>                             // [I/O] returns albums['All Photos']
  post<T = unknown>(url: string, body: string): Promise<AxiosResponse<T>>  // [I/O] text/plain POST helper
}

class PhotoAlbum implements AsyncIterable<PhotoAsset> {
  // PINNED positional order — do NOT swap listType/objType:
  constructor(
    service: PhotosService, name: string,
    listType: string,        // POSITION 3 — recordType in pagination
    objType: string,         // POSITION 4 — indexCountID value in length()
    direction: 'ASCENDING' | 'DESCENDING',
    queryFilter?: SmartFolderDef['query_filter'],  // default null
    pageSize?: number,       // default 100
  )
  readonly name; readonly listType; readonly objType; readonly direction;
  readonly queryFilter; readonly pageSize;
  get title(): string                       // === name
  async length(): Promise<number>           // [I/O] item count (cached)
  [Symbol.asyncIterator](): AsyncIterator<PhotoAsset>   // [I/O] `for await (const p of album)`
  toString(): string
}

class PhotoAsset {
  constructor(service: PhotosService, masterRecord: CloudKitRecord, assetRecord: CloudKitRecord)
  get id(): string
  get filename(): string          // base64-decoded filenameEnc (UTF-8)
  get size(): number              // original-resolution bytes
  get created(): Date             // alias of assetDate
  get assetDate(): Date           // ms-epoch UTC, epoch 0 if absent
  get addedDate(): Date
  get dimensions(): [number, number]
  get versions(): Record<string, PhotoVersion>           // [local] lazy
  async download(version?: string): Promise<Readable | null>  // [I/O] default 'original'; null if version/url missing
  async delete(): Promise<AxiosResponse>                 // [I/O] soft delete
}

interface PhotoVersion {
  filename: string;
  width: number | null; height: number | null; size: number | null;
  url: string | null; type: string | null;
}
```
Version keys come from `PHOTO_VERSION_LOOKUP` (`original`/`medium`/`thumb`) or
`VIDEO_VERSION_LOOKUP` for videos.

---

## Account — `auth.account` (sync getter)

```ts
class AccountService {
  async devices(): Promise<AccountDevice[]>     // [I/O] lazy+cached
  async family(): Promise<FamilyMember[]>       // [I/O] lazy+cached
  async storage(): Promise<AccountStorage>      // [I/O] lazy+cached (CN-aware URL)
}

class FamilyMember {
  // sync getters (all `| undefined`):
  get lastName; get dsid; get originalInvitationEmail; get fullName;
  get ageClassification; get appleIdForPurchases; get appleId; get familyId;
  get firstName; get hasParentalPrivileges; get hasScreenTimeEnabled;
  get hasAskToBuyEnabled; get hasSharePurchasesEnabled;
  get shareMyLocationEnabledFamilyMembers; get hasShareMyLocationEnabled;
  get dsidForPurchases;
  async getPhoto(): Promise<Readable>   // [I/O] streamed avatar
  toString(): string
}

class AccountStorage {
  readonly usage: AccountStorageUsage
  readonly usagesByMedia: Record<string, AccountStorageUsageForMedia>   // keyed by mediaKey
  toString(): string
}
class AccountStorageUsage {
  get compStorageInBytes; get usedStorageInBytes; get usedStorageInPercent;   // round(used*100/total, 2)
  get availableStorageInBytes; get availableStorageInPercent;
  get totalStorageInBytes; get commerceStorageInBytes;
  get quotaOver; get quotaTierMax; get quotaAlmostFull; get quotaPaid;
}
class AccountStorageUsageForMedia {
  get key; get label; get color; get usageInBytes;
}

interface AccountDevice {
  modelDisplayName: string; name: string; model: string; udid: string;
  serialNumber: string; osVersion: string; imei: string;
  paymentMethods?: string[]; modelLargePhotoURL1x?: string; modelLargePhotoURL2x?: string;
  modelSmallPhotoURL1x?: string; modelSmallPhotoURL2x?: string; [key: string]: unknown;
}
```

---

## Find My iPhone — `await auth.findMyiPhone()`

```ts
class FindMyiPhoneService {
  response?: RefreshClientResponse
  get fmipEndpoint(): string
  async init(): Promise<void>                 // [I/O] runs refreshClient()
  async refreshClient(): Promise<void>        // [I/O] rebuild device map; empty → PyiCloudNoDevicesException
  keys(): string[]                            // [local] insertion-ordered device ids
  values(): AppleDevice[]                     // [local]
  get all(): AppleDevice[]
  get(idOrIndex: string | number): AppleDevice   // [local] number→ordered index, string→id; throws PyiCloudNoDevicesException if missing
}

class AppleDevice {
  content: AppleDeviceContent
  get data(): AppleDeviceContent
  update(data: AppleDeviceContent): void           // [local]
  async location(): Promise<unknown>               // [I/O] whole-list refresh then read content.location
  async status(additional?: string[]): Promise<Record<string, unknown>>  // [I/O] batteryLevel/deviceDisplayName/deviceStatus/name + additional
  async playSound(subject?: string): Promise<void> // [I/O] default 'Find My iPhone Alert'
  async displayMessage(options?: DisplayMessageOptions): Promise<void>    // [I/O]
  async lostDevice(options: LostDeviceOptions): Promise<void>             // [I/O]
}

interface AppleDeviceContent { id: string; location?: unknown; batteryLevel?: unknown; deviceDisplayName?: unknown; deviceStatus?: unknown; name?: unknown; [key: string]: unknown; }
interface DisplayMessageOptions { subject?: string; message?: string; sounds?: boolean; }  // defaults 'Find My iPhone Alert' / 'This is a note' / false
interface LostDeviceOptions { number: string; text?: string; newpasscode?: string; }       // text default 'This iPhone has been lost. Please call me.', newpasscode default ''
```

---

## Calendar — `auth.calendar` (sync getter, GET-only)

```ts
class CalendarService {
  get usertz(): string                        // local IANA timezone
  async events(from?: Date, to?: Date): Promise<CalendarEvent[] | undefined>   // [I/O] default = FULL current month; undefined if server omits `Event`
  async getEventDetail(pguid: string, guid: string): Promise<CalendarEvent>    // [I/O] first Event element
  async calendars(): Promise<CalendarCollection[]>                             // [I/O] reads SINGULAR `Collection` key
}
type CalendarEvent = Record<string, unknown>;
type CalendarCollection = Record<string, unknown>;
```

---

## Contacts — `auth.contacts` (sync getter, read-only)

```ts
class ContactsService {
  response: ContactsListResponse              // overwritten by handshake step 2
  async refreshClient(): Promise<void>        // [I/O] two-step token handshake
  async all(): Promise<Contact[] | undefined> // [I/O] refresh + response.contacts (undefined if absent)
}
interface ContactsStartupResponse { prefToken: string; syncToken: string; [key: string]: unknown; }
interface ContactsListResponse { contacts?: Contact[]; [key: string]: unknown; }
interface Contact {
  contactId?: string; etag?: string; firstName?: string; lastName?: string;
  normalized?: string; phones?: Array<Record<string, unknown>>;
  emailAddresses?: Array<Record<string, unknown>>; [key: string]: unknown;
}
```

---

## Reminders — `await auth.reminders()`

```ts
class RemindersService {
  lists: Record<string, Reminder[]>              // parsed reminders per collection title
  collections: Record<string, ReminderCollection>// metadata keyed by title
  async init(): Promise<void>                    // [I/O] runs refresh()
  async refresh(): Promise<void>                 // [I/O] reload from /rd/startup
  async post(title: string, description?: string, collection?: string, dueDate?: Date): Promise<boolean>
    // [I/O] returns status<400; description default ''; requires loaded collections
}
interface Reminder { title: string; desc?: string; due: Date | null; }
interface ReminderCollection { guid: string; ctag: string; }
type DueDateArray = [number, number, number, number, number, number];
function packDueDate(due: Date): DueDateArray   // [local]
```

---

## Exceptions

```
PyiCloudException (extends Error)
├── PyiCloudAPIResponseException
│   └── PyiCloudServiceNotActivatedException
├── PyiCloudFailedLoginException                 (SIBLING of API exc — NOT a child)
├── PyiCloud2SARequiredException
├── PyiCloudNoStoredPasswordAvailableException
└── PyiCloudNoDevicesException
```
```ts
class PyiCloudException extends Error { constructor(message?: string) }
class PyiCloudAPIResponseException extends PyiCloudException {
  readonly reason: string; readonly code?: string | number;
  constructor(reason: string, code?: string | number, retry?: boolean)  // retry NOT stored
}
class PyiCloudServiceNotActivatedException extends PyiCloudAPIResponseException {
  constructor(reason: string, code?: string | number, retry?: boolean)
}
class PyiCloudFailedLoginException extends PyiCloudException { constructor(message?: string) }
class PyiCloud2SARequiredException extends PyiCloudException { constructor(appleId: string) }
class PyiCloudNoStoredPasswordAvailableException extends PyiCloudException { constructor(message?: string) }
class PyiCloudNoDevicesException extends PyiCloudException { constructor(message?: string) }
```
All set `this.name` + `Object.setPrototypeOf`, so `instanceof` works after
CommonJS transpile. Wrong 2FA/2SA codes do NOT throw (they return `false`).

### Error normalizer
```ts
interface RaiseErrorContext { requires2sa: boolean; appleId: string; }
function extractReasonCode(body: unknown): { reason?: string; code?: string | number }  // [local]
function raiseError(code: string | number | undefined, reason: string, ctx: RaiseErrorContext): never  // [local]
```

---

## Infrastructure (rarely needed directly)

### `SecretsService` (keytar wrapper, `service='pyicloud://icloud-password'`)
```ts
async getPassword(username: string, interactive?: boolean): Promise<string>  // interactive defaults to process.stdout.isTTY at call time
async passwordExistsInKeyring(username: string): Promise<boolean>
async getPasswordFromKeyring(username: string): Promise<string>             // throws PyiCloudNoStoredPasswordAvailableException if absent
async storePasswordInKeyring(username: string, password: string): Promise<void>
async deletePasswordInKeyring(username: string): Promise<void>
```
Also exported: `function underscoreToCamelcase(word: string, initialCapital?: boolean): string`.

### `IcloudHttpService` (authenticated HTTP chokepoint — built inside `create()`)
```ts
constructor(store: SessionStore, endpoints: Endpoints, defaultHeaders: Record<string,string>)
get sessionData(): SessionData
async getCookies(url: string): Promise<Array<{ key: string; value: string }>>
async getAllCookies(): Promise<Cookie[]>
bindAuth(auth: IcloudAuthLike): void
async request<T = unknown>(method: Method, url: string, opts?: IcloudRequestOptions): Promise<AxiosResponse<T>>

interface Endpoints { AUTH: string; HOME: string; SETUP: string; verify?: boolean | string; }
interface IcloudAuthLike {
  readonly user: { accountName: string; password: string };
  readonly requires2sa: boolean;
  getWebserviceUrl(key: string): string;
  authenticate(opts?: { forceRefresh?: boolean; service?: string }): Promise<void>;
}
interface IcloudRequestOptions {
  data?: unknown; params?: Record<string, string>; headers?: Record<string, string>;
  responseType?: 'json' | 'stream' | 'arraybuffer';   // default 'json'
  _retried?: boolean;                                   // internal
}
```

### `SessionStore` (on-disk persistence — built inside `create()`)
```ts
static async load(dir: string, sanitizedName: string): Promise<SessionStore>
sessionData: SessionData
readonly jar: CookieJar
async saveSessionData(): Promise<void>   // → <name>.session
async saveCookies(): Promise<void>       // → <name>.cookies.json
async persistAll(): Promise<void>
```

---

## Interfaces

```ts
interface SessionData {
  client_id?: string; session_token?: string; session_id?: string;
  scnt?: string; account_country?: string; trust_token?: string;
}
interface DsInfo { dsid: string | number; hsaVersion?: number; fullName?: string; firstName?: string; lastName?: string; appleId?: string; primaryEmail?: string; countryCode?: string; [key: string]: unknown; }
interface AppEntry { canLaunchWithOneFactor?: boolean; isQualifiedForBeta?: boolean; isHidden?: boolean; [key: string]: unknown; }
interface AccountLoginData { dsInfo: DsInfo; webservices: Webservices; apps?: Record<string, AppEntry>; hsaChallengeRequired?: boolean; hsaTrustedBrowser?: boolean; pcsEnabled?: boolean; isExtendedLogin?: boolean; version?: number; [key: string]: unknown; }
interface WebserviceEntry { url?: string; uploadUrl?: string; status?: string; pcsRequired?: boolean; [key: string]: unknown; }
type Webservices = Record<string, WebserviceEntry>;
```

---

## Constants

```ts
const ENDPOINTS: { global: {AUTH,HOME,SETUP}; china: {AUTH,HOME,SETUP} }  // china uses .com.cn
const OAUTH: { CLIENT_ID: string; REDIRECT_URI: 'https://www.icloud.com' } // GLOBAL even in CN
const HEADER_DATA: Record<string, keyof SessionData>
const BUILD: { clientBuildNumber; clientMasteringNumber; ckjsBuildVersion }
const PHOTO_VERSION_LOOKUP: Record<string, string>   // {original:'resOriginal', medium:'resJPEGMed', thumb:'resJPEGThumb'}
const VIDEO_VERSION_LOOKUP: Record<string, string>   // {original:'resOriginal', medium:'resVidMed', thumb:'resVidSmall'}
const KEYRING_SERVICE: 'pyicloud://icloud-password'
interface SmartFolderDef { obj_type: string; list_type: string; direction: 'ASCENDING'|'DESCENDING'; query_filter: Array<{fieldName,comparator,fieldValue:{type,value}}> | null; }
const SMART_FOLDERS: Record<string, SmartFolderDef>  // 'All Photos','Time-lapse','Videos','Slo-mo','Bursts','Favorites','Panoramas','Screenshots','Live','Recently Deleted','Hidden'
```
