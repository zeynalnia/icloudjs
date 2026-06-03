All four blocking issues are confirmed. Now I have the exact values. I'll produce the revised plan with: (1) the real 11-entry SMART_FOLDERS table, (2) pinned PhotoAlbum signature with positional order, (3) Drive array response shapes documented, (4) the CLI per-device loop + printed fields. Plus the worthwhile suggestions (auth-state constants, build-number test assertions, no-Python-reference callouts, 2FA vs 2SA code values, two Drive POST shapes).

# jsicloud — Concrete NestJS/TypeScript Reimplementation Plan for pyicloud

This is a complete, file-by-file build plan for reimplementing `pyicloud` as a NestJS module at `/home/daria/projects/icloud/jsicloud`. It is self-contained: an engineer can implement each file from this document without re-reading the Python source. All paths are absolute.

---

## 0. Conventions & Global Decisions

- **Language target:** TypeScript 5.x, `module`/`target` = `CommonJS`/`ES2021`, `experimentalDecorators` + `emitDecoratorMetadata` ON (NestJS DI).
- **HTTP client:** raw `axios` instance wrapped in `IcloudHttpService` (NOT `@nestjs/axios`, to keep full control of interceptors and cookie jar). Cookie support via `tough-cookie` + a small custom adapter (`axios-cookiejar-support` is allowed as a convenience dep — see package.json; if avoided, implement two interceptors that read/write the jar manually).
- **No network in constructors.** Every class that authenticated/refreshed in Python `__init__` is converted to an async `init()` / factory. The `IcloudAuthService.create()` static async factory is the single entry point.
- **Latent-bug resolutions (final decisions, applied throughout):**

| # | Python bug | Resolution in jsicloud |
|---|---|---|
| 1 | `params` left `{}` | **FIX.** Populate `params` after login: `dsid` (`data.dsInfo.dsid`), `clientId` (persisted `client_id`), plus constants `clientBuildNumber='2521Project35'`, `clientMasteringNumber='2521B2'`, `ckjsBuildVersion='2521ProjectDev39'` (named constants in `constants.ts`; values are placeholders matching the historical pattern `17DHotfix5`/`17DProjectDev77` — keep configurable). **Because the Python source never populates `params` at all, no fixture depends on the exact build-number strings: drive/ubiquity tests MUST assert only that `clientId` and `dsid` are present in `params`, never the build-number values.** |
| 2 | Hardcoded non-CN storage URL | **FIX.** Build storage URL from `SETUP_ENDPOINT` so it respects China mode: `${setupEndpoint}/storageUsageInfo`. Document the divergence from Python in a code comment. |
| 3 | Calendar `monthrange` weekday-as-day | **FIX.** `events()` with no explicit range uses month start = day 1, end = last day of month (`new Date(year, month, 0).getDate()`). |
| 4 | `DriveNode.upload(**kw)` → `send_file` (no kwargs) | **FIX.** `upload(fileName, stream)` drops extra kwargs; `sendFile` signature is explicit. |
| 5 | `requires_2fa` KeyError asymmetry | **FIX/HARDEN.** Use optional chaining: `data?.dsInfo?.hsaVersion === 2`. |
| 6 | `play_sound` hardcodes `fmly:true` | **PRESERVE** (matches Apple behavior); add a code comment noting inconsistency. |
| 7 | Test mock unmatched route → `None` | **FIX.** Test router throws `Unexpected request: METHOD URL`. |
| — | China OAuth widget/redirect stay global | **PRESERVE.** Hosts switch to `.com.cn`; OAuth widget-key/client-id/redirect-URI remain `https://www.icloud.com`. |
| — | Pickle in CLI `--outputfile` | **REPLACE** with `JSON.stringify` to `<name>.fmip_snapshot.json`. |
| — | Photos delete change-tag mix | **PRESERVE** (recordName/Type from asset, recordChangeTag from master). |

- **Casing:** server responses are PascalCase (`Event`, `Collection`, `Collections`, `Reminders`) or camelCase (contacts). Do **not** auto-transform; access keys literally via typed interfaces.
- **Secrets:** `keytar`, `service = 'pyicloud://icloud-password'` (exact, for cross-compat with the Python keyring).
- **Never log** password or harvested tokens.

---

## 1. Project Scaffolding

### 1.1 `/home/daria/projects/icloud/jsicloud/package.json`

```json
{
  "name": "jsicloud",
  "version": "1.0.0",
  "description": "Unofficial NestJS client for Apple iCloud web services (port of pyicloud).",
  "license": "MIT",
  "bin": { "jsicloud": "dist/cli/main.js" },
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "start:cli": "ts-node src/cli/main.ts",
    "test": "jest --runInBand",
    "test:cov": "jest --coverage --runInBand",
    "test:watch": "jest --watch",
    "lint": "eslint \"{src,test}/**/*.ts\" --max-warnings 0",
    "lint:fix": "eslint \"{src,test}/**/*.ts\" --fix",
    "format": "prettier --write \"{src,test}/**/*.ts\""
  },
  "dependencies": {
    "@nestjs/common": "^10.4.0",
    "@nestjs/core": "^10.4.0",
    "axios": "^1.7.0",
    "axios-cookiejar-support": "^5.0.0",
    "commander": "^12.1.0",
    "keytar": "^7.9.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1",
    "tough-cookie": "^4.1.4",
    "uuid": "^9.0.1"
  },
  "devDependencies": {
    "@nestjs/testing": "^10.4.0",
    "@types/jest": "^29.5.12",
    "@types/node": "^20.14.0",
    "@types/uuid": "^9.0.8",
    "@typescript-eslint/eslint-plugin": "^7.16.0",
    "@typescript-eslint/parser": "^7.16.0",
    "eslint": "^8.57.0",
    "eslint-config-prettier": "^9.1.0",
    "jest": "^29.7.0",
    "nock": "^13.5.4",
    "prettier": "^3.3.0",
    "ts-jest": "^29.2.0",
    "ts-node": "^10.9.2",
    "typescript": "^5.5.0"
  },
  "engines": { "node": ">=18" }
}
```

> `@inquirer/prompts` intentionally omitted; CLI uses Node's built-in `readline/promises` for password/confirm prompts (zero extra dep, easily mockable). `axios-cookiejar-support` chosen over hand-rolled jar interceptors for reliability; if the team prefers zero non-essential deps, replace with two interceptors (noted in §4.2).

### 1.2 `/home/daria/projects/icloud/jsicloud/tsconfig.json`

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2021",
    "lib": ["ES2021"],
    "declaration": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "strict": true,
    "strictNullChecks": true,
    "noImplicitAny": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "moduleResolution": "node"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
```

### 1.3 `/home/daria/projects/icloud/jsicloud/tsconfig.build.json`

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "dist", "test", "**/*.spec.ts"]
}
```

### 1.4 `/home/daria/projects/icloud/jsicloud/jest.config.js`

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.module.ts', '!src/index.ts', '!src/cli/main.ts'],
  coverageThreshold: {
    global: { branches: 70, functions: 80, lines: 80, statements: 80 },
  },
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  clearMocks: true,
  restoreMocks: true,
};
```

### 1.5 `/home/daria/projects/icloud/jsicloud/.eslintrc.js` (optional but in DoD)

```js
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: { project: 'tsconfig.json', sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['plugin:@typescript-eslint/recommended', 'prettier'],
  root: true,
  env: { node: true, jest: true },
  ignorePatterns: ['dist', 'node_modules', '.eslintrc.js', 'jest.config.js'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
};
```

### 1.6 `/home/daria/projects/icloud/jsicloud/.prettierrc`

```json
{ "singleQuote": true, "trailingComma": "all", "printWidth": 100 }
```

---

## 2. Directory & File Tree

```
/home/daria/projects/icloud/jsicloud/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── jest.config.js
├── .eslintrc.js
├── .prettierrc
├── ARCHITECTURE_MAP.md                 (already present — reference only)
├── src/
│   ├── index.ts                        Public barrel: re-export IcloudModule, IcloudAuthService,
│   │                                   all service classes, all interfaces, all exceptions.
│   ├── icloud.module.ts                IcloudModule (dynamic module: forRoot/forRootAsync).
│   ├── icloud.constants.ts             Injection tokens + DI symbols (ICLOUD_OPTIONS, etc.).
│   ├── constants.ts                    Endpoint bases, OAuth header constants, HEADER_DATA map,
│   │                                   build-number constants, SMART_FOLDERS, version-lookup maps.
│   ├── interfaces/
│   │   ├── options.interface.ts        IcloudModuleOptions (accountName, password?, cookieDir?,
│   │   │                               chinaMainland?, verify?, clientId?).
│   │   ├── session-data.interface.ts   SessionData shape (client_id, session_token, scnt, ...).
│   │   ├── login-response.interface.ts AccountLoginData (dsInfo, webservices, apps, flags).
│   │   └── webservices.interface.ts    Webservices URL map type.
│   ├── exceptions/
│   │   └── icloud.exceptions.ts        Full exception hierarchy (one file, all classes).
│   ├── secrets/
│   │   └── secrets.service.ts          SecretsService (keytar wrapper).
│   ├── session/
│   │   ├── session-store.ts            SessionStore (cookie jar + session_data persistence).
│   │   ├── icloud-http.service.ts      IcloudHttpService (axios + jar + interceptors + retry).
│   │   └── error-normalizer.ts         normalizeAndRaise(response) + raiseError(code, reason).
│   ├── auth/
│   │   └── icloud-auth.service.ts      IcloudAuthService (auth lifecycle, factory, params, ws map).
│   ├── util/
│   │   ├── camelcase.ts                underscoreToCamelcase().
│   │   ├── date.ts                     dateToUtc(), parseUbiquityDate().
│   │   └── redact.ts                   redactSecret() for logging.
│   ├── services/
│   │   ├── drive.service.ts            DriveService + DriveNode.
│   │   ├── ubiquity.service.ts         UbiquityService + UbiquityNode.
│   │   ├── photos.service.ts           PhotosService + PhotoAlbum + PhotoAsset.
│   │   ├── account.service.ts          AccountService + AccountDevice + FamilyMember + storage types.
│   │   ├── findmyiphone.service.ts     FindMyiPhoneService + AppleDevice.
│   │   ├── calendar.service.ts         CalendarService.
│   │   ├── contacts.service.ts         ContactsService.
│   │   └── reminders.service.ts        RemindersService.
│   └── cli/
│       ├── main.ts                     #!/usr/bin/env node entry; commander program + run().
│       └── fmip-cli.ts                 runCli(argv, deps) — testable core (login loop + dispatch).
└── test/
    ├── setup.ts                        nock disableNetConnect; global afterEach cleanAll.
    ├── fixtures/                       Ported JSON fixtures (from const_*.py).
    │   ├── account-login.json
    │   ├── account-login-2fa.json
    │   ├── validate.json
    │   ├── trusted-devices.json
    │   ├── account-devices.json
    │   ├── family-details.json
    │   ├── storage.json
    │   ├── drive-root.json
    │   ├── drive-folder-test.json
    │   ├── fmi-refresh.json            (13 devices)
    │   ├── photos-indexing.json
    │   ├── photos-albums.json
    │   ├── calendar-events.json
    │   ├── contacts-startup.json
    │   ├── contacts-list.json
    │   └── reminders-startup.json
    ├── helpers/
    │   ├── mock-router.ts              nock-based router mirroring substring+method table; stateful
    │   │                               handshake; header-based auth; throws on unmatched routes.
    │   ├── auth-state.ts               Closure state machine for signin→accountLogin transitions.
    │   └── make-service.ts             Builds an authenticated IcloudAuthService against the router.
    ├── exceptions.spec.ts
    ├── secrets.spec.ts
    ├── session-store.spec.ts
    ├── http-interceptors.spec.ts       header harvesting + echo + retry/re-auth.
    ├── auth.spec.ts                    full sign-in, 2FA, 2SA, trust, China, validate-token reuse.
    ├── drive.spec.ts
    ├── ubiquity.spec.ts
    ├── photos.spec.ts
    ├── account.spec.ts
    ├── findmyiphone.spec.ts
    ├── calendar.spec.ts
    ├── contacts.spec.ts
    ├── reminders.spec.ts
    └── cli.spec.ts                     exit codes, 2FA prompt, bad-cred loop, keyring save/delete.
```

---

## 3. Dependency Injection Design

### 3.1 Providers (all `@Injectable()`)

| Class | Scope | Notes |
|---|---|---|
| `SecretsService` | singleton | Stateless keytar wrapper. |
| `SessionStore` | singleton | Constructed per account via factory; holds jar + session_data. |
| `IcloudHttpService` | singleton | Holds axios instance, jar, mutable `sessionData`, ref to auth for retry re-auth. |
| `IcloudAuthService` | singleton | Orchestrator; exposes service accessors. |
| Each service class (`DriveService`, …) | **not** providers | Constructed lazily by `IcloudAuthService` accessors with `(serviceRoot, http, params)`. They are plain classes, NOT DI-managed, because they need runtime-resolved `serviceRoot`. |

Rationale: webservice roots only exist after login, so per-service classes are created by factory methods, not by Nest's container. Only the **infrastructure** (`SecretsService`, `IcloudHttpService`, `IcloudAuthService`) is DI-managed.

### 3.2 `IcloudModule` (`src/icloud.module.ts`)

```ts
@Module({})
export class IcloudModule {
  static forRootAsync(opts: {
    useFactory: (...a: any[]) => Promise<IcloudModuleOptions> | IcloudModuleOptions;
    inject?: any[];
    imports?: any[];
  }): DynamicModule;

  static forRoot(options: IcloudModuleOptions): DynamicModule;
}
```

Both register:
- `{ provide: ICLOUD_OPTIONS, useValue|useFactory }`
- `SecretsService`
- `{ provide: IcloudAuthService, useFactory: async (opts, secrets) => IcloudAuthService.create(opts, secrets), inject: [ICLOUD_OPTIONS, SecretsService] }` ← **the async factory; network I/O happens here, at module init, not in a constructor.**
- exports: `IcloudAuthService`, `SecretsService`.

`IcloudHttpService` and `SessionStore` are created **inside** `IcloudAuthService.create()` (they need account-derived paths) rather than as separate Nest providers — keeps the async-init wiring in one place. (Alternative: expose them as providers too; not required.)

### 3.3 Async factory contract (`IcloudAuthService.create`)

```ts
static async create(options: IcloudModuleOptions, secrets: SecretsService): Promise<IcloudAuthService> {
  // 1. resolve china vs global endpoints
  // 2. resolve password: options.password ?? await secrets.getPasswordFromKeyring(accountName)
  // 3. sanitize accountName -> /[A-Za-z0-9_]/ for filenames
  // 4. cookieDir = options.cookieDir ?? <tmpdir>/jsicloud/<os.userInfo().username>  (mkdir 0o700)
  // 5. store = await SessionStore.load(cookieDir, sanitized)  -> session_data + tough-cookie jar
  // 6. client_id = session_data.client_id ?? `auth-${uuidv1().toLowerCase()}`; persist back
  // 7. http = new IcloudHttpService(store, endpoints, sessionData, defaultHeaders)
  //    defaultHeaders: Origin = HOME_ENDPOINT, Referer = HOME_ENDPOINT + '/'
  // 8. const svc = new IcloudAuthService(...); http.bindAuth(svc) // for retry re-auth callback
  // 9. await svc.authenticate();  // network
  // 10. svc.populateParams();     // FIX #1: dsid, clientId, build numbers
  // 11. return svc;
}
```

### 3.4 How services receive `(service_root, session, params)`

`IcloudAuthService` getters (lazy + cached on `this._<name>`):

```ts
get drive(): DriveService {
  return (this._drive ??= new DriveService(
    this.getWebserviceUrl('drivews'),
    this.getWebserviceUrl('docws'),
    this.http,
    this.params,                 // shared mutable bag
  ));
}
async findMyiPhone(): Promise<FindMyiPhoneService> {
  if (!this._fmip) {
    this._fmip = new FindMyiPhoneService(this.getWebserviceUrl('findme'), this.http, this.params, this.withFamily);
    await this._fmip.init();     // replaces constructor refresh
  }
  return this._fmip;
}
```

- `getWebserviceUrl(key)` → `this.webservices[key].url` or throw `PyiCloudServiceNotActivatedException`.
- `params` is one shared mutable object (`Record<string,string>`); services that mutate it (none do, they read `clientId`/`dsid`) and reads stay consistent.
- Services needing async init (`findMyiPhone`, `photos`, `reminders`, `contacts`, `calendar`-on-first-call) expose `init()` and are returned via `async` getters/methods.

---

## 4. Per-Module Porting Spec

### 4.0 `src/constants.ts`

```ts
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
};
export const OAUTH = {
  CLIENT_ID: 'd39ba9916b7251055b22c7f910e2ea796ee65e98b2ddecea8f5dde8d9d1a815d', // widget key + client id
  REDIRECT_URI: 'https://www.icloud.com', // GLOBAL even in CN (preserve)
};
export const HEADER_DATA: Record<string, keyof SessionData> = {
  'X-Apple-ID-Account-Country': 'account_country',
  'X-Apple-ID-Session-Id': 'session_id',
  'X-Apple-Session-Token': 'session_token',
  'X-Apple-TwoSV-Trust-Token': 'trust_token',
  scnt: 'scnt',
};
export const BUILD = {                       // FIX #1 — placeholders, keep configurable
  clientBuildNumber: '2521Project35',
  clientMasteringNumber: '2521B2',
  ckjsBuildVersion: '2521ProjectDev39',
};
export const PHOTO_VERSION_LOOKUP = { original: 'resOriginal', medium: 'resJPEGMed', thumb: 'resJPEGThumb' };
export const VIDEO_VERSION_LOOKUP = { original: 'resOriginal', medium: 'resVidMed', thumb: 'resVidSmall' };
export const KEYRING_SERVICE = 'pyicloud://icloud-password';
```

#### `SMART_FOLDERS` — exact 11-entry table (ported verbatim from `pyicloud/services/photos.py:13-122`)

Type:

```ts
export interface SmartFolderDef {
  obj_type: string;
  list_type: string;
  direction: 'ASCENDING' | 'DESCENDING';
  query_filter: Array<{
    fieldName: string;
    comparator: string;
    fieldValue: { type: string; value: string };
  }> | null;
}
export const SMART_FOLDERS: Record<string, SmartFolderDef>;
```

Every entry's `direction` is `'ASCENDING'`. `query_filter` is `null` for the four non-smart-album folders ("All Photos", "Bursts", "Recently Deleted", "Hidden") and a single-element array `[{ fieldName:'smartAlbum', comparator:'EQUALS', fieldValue:{ type:'STRING', value:'<VALUE>' } }]` for the rest. **Copy these literals exactly — they are load-bearing for every photo query:**

| Key | `obj_type` | `list_type` | `query_filter` smartAlbum value |
|---|---|---|---|
| `All Photos` | `CPLAssetByAddedDate` | `CPLAssetAndMasterByAddedDate` | `null` |
| `Time-lapse` | `CPLAssetInSmartAlbumByAssetDate:Timelapse` | `CPLAssetAndMasterInSmartAlbumByAssetDate` | `TIMELAPSE` |
| `Videos` | `CPLAssetInSmartAlbumByAssetDate:Video` | `CPLAssetAndMasterInSmartAlbumByAssetDate` | `VIDEO` |
| `Slo-mo` | `CPLAssetInSmartAlbumByAssetDate:Slomo` | `CPLAssetAndMasterInSmartAlbumByAssetDate` | `SLOMO` |
| `Bursts` | `CPLAssetBurstStackAssetByAssetDate` | `CPLBurstStackAssetAndMasterByAssetDate` | `null` |
| `Favorites` | `CPLAssetInSmartAlbumByAssetDate:Favorite` | `CPLAssetAndMasterInSmartAlbumByAssetDate` | `FAVORITE` |
| `Panoramas` | `CPLAssetInSmartAlbumByAssetDate:Panorama` | `CPLAssetAndMasterInSmartAlbumByAssetDate` | `PANORAMA` |
| `Screenshots` | `CPLAssetInSmartAlbumByAssetDate:Screenshot` | `CPLAssetAndMasterInSmartAlbumByAssetDate` | `SCREENSHOT` |
| `Live` | `CPLAssetInSmartAlbumByAssetDate:Live` | `CPLAssetAndMasterInSmartAlbumByAssetDate` | `LIVE` |
| `Recently Deleted` | `CPLAssetDeletedByExpungedDate` | `CPLAssetAndMasterDeletedByExpungedDate` | `null` |
| `Hidden` | `CPLAssetHiddenByAssetDate` | `CPLAssetAndMasterHiddenByAssetDate` | `null` |

> NOTE: prior plan revisions fabricated these (`CPLAssetByAssetDateWithoutHiddenOrDeleted`, etc.). Those values are WRONG and must not be used. The literals above are the source of truth.

---

### 4.1 Exceptions (`src/exceptions/icloud.exceptions.ts`)

```ts
export class PyiCloudException extends Error {
  constructor(message?: string) { super(message); this.name = 'PyiCloudException';
    Object.setPrototypeOf(this, PyiCloudException.prototype); }
}
export class PyiCloudAPIResponseException extends PyiCloudException {
  readonly reason: string; readonly code?: string | number;
  constructor(reason: string, code?: string | number, retry = false) {
    let msg = reason || '';
    if (code) msg += ` (${code})`;
    if (retry) msg += '. Retrying ...';
    super(msg);
    this.name = 'PyiCloudAPIResponseException';
    this.reason = reason; this.code = code;  // retry NOT stored
    Object.setPrototypeOf(this, PyiCloudAPIResponseException.prototype);
  }
}
export class PyiCloudServiceNotActivatedException extends PyiCloudAPIResponseException { /* setPrototypeOf */ }
export class PyiCloudFailedLoginException extends PyiCloudException { /* SIBLING of API exc, not child */ }
export class PyiCloud2SARequiredException extends PyiCloudException {
  constructor(appleId: string) { super(`Two-step authentication required for account: ${appleId}`); /* … */ }
}
export class PyiCloudNoStoredPasswordAvailableException extends PyiCloudException { /* … */ }
export class PyiCloudNoDevicesException extends PyiCloudException { /* … */ }
```

Every subclass sets `this.name` and `Object.setPrototypeOf(this, X.prototype)`. Keep `PyiCloudFailedLoginException` as a **direct** child of `PyiCloudException` (sibling of the API exception) — catch-specificity contract.

---

### 4.2 Session / HTTP layer

#### `src/session/session-store.ts`

```ts
export class SessionStore {
  sessionData: SessionData;            // mutable
  readonly jar: CookieJar;             // tough-cookie
  static async load(dir: string, sanitizedName: string): Promise<SessionStore>;
  saveSessionData(): Promise<void>;    // write <dir>/<name>.session JSON
  saveCookies(): Promise<void>;        // serialize jar -> <dir>/<name>.cookies.json
  async persistAll(): Promise<void>;   // both
}
```

- JSON cookie store (tough-cookie `toJSON`/`fromJSON`) — LWP format dropped (greenfield).
- Tolerate corrupt files: catch parse errors, start empty (rebuild on next auth).
- `SessionData` interface fields: `client_id?, session_token?, session_id?, scnt?, account_country?, trust_token?`.

#### `src/session/error-normalizer.ts`

```ts
export function extractReasonCode(body: any): { reason?: string; code?: string|number };
//   reason = errorMessage ?? reason ?? errorReason ?? (typeof error==='string'?error:undefined)
//            ?? (error ? 'Unknown reason' : undefined)
//   code   = errorCode ?? serverErrorCode
export function raiseError(code: string|number|undefined, reason: string, ctx: {
  requires2sa: boolean; appleId: string;
}): never;
```

`raiseError` special-case map (in order):
1. `requires2sa && reason === 'Missing X-APPLE-WEBAUTH-TOKEN cookie'` → throw `PyiCloud2SARequiredException(appleId)`.
2. `code in ('ZONE_NOT_FOUND','AUTHENTICATION_FAILED')` → `PyiCloudServiceNotActivatedException(reason, code)`.
3. `code === 'ACCESS_DENIED'` → reason += throttle note → `PyiCloudAPIResponseException`.
4. `code in (421,450,500)` → `PyiCloudAPIResponseException('Authentication required for Account.', code)`.
5. else → `PyiCloudAPIResponseException(reason, code)`.

#### `src/session/icloud-http.service.ts` (`@Injectable()`)

Core port of `PyiCloudSession.request`. Public API:

```ts
@Injectable()
export class IcloudHttpService {
  constructor(store: SessionStore, endpoints: Endpoints, defaultHeaders: Record<string,string>);
  bindAuth(auth: IcloudAuthService): void;   // for retry re-auth + requires2sa/appleId in raiseError

  request<T = any>(method: Method, url: string, opts?: {
    data?: any;                 // raw body (string or object); pyicloud passes json.dumps as data=
    params?: Record<string,string>;
    headers?: Record<string,string>;
    responseType?: 'json' | 'stream' | 'arraybuffer';
    _retried?: boolean;         // internal single-retry guard
  }): Promise<AxiosResponse<T>>;

  get sessionData(): SessionData;
}
```

Behavior to preserve exactly:

1. **Request interceptor:** if `sessionData.scnt` → header `scnt`; if `sessionData.session_id` → header `X-Apple-ID-Session-Id`. Merge default headers (Origin/Referer).
2. **Cookie jar:** attach jar to axios (via `axios-cookiejar-support` `wrapper(axios.create({ jar }))`). *If avoiding that dep:* request interceptor sets `Cookie` from `jar.getCookieString(url)`; response interceptor calls `jar.setCookie(...)` for each `set-cookie`. The `X-APPLE-WEBAUTH-*` family is thus auto-sent.
3. **Response interceptor (header harvest — CRITICAL):** for each header in `HEADER_DATA`, if present copy value into `sessionData[key]`. Then `await store.persistAll()` (session_data JSON + cookies) — mirror the per-request persist (functionally needed for trusted-session resume).
4. **Error normalization:** axios `validateStatus: () => true` (never throw on status); after response, parse body: if reason extracted via `extractReasonCode`, call `raiseError`.
5. **Single retry / re-auth (FIX guard):** when response not-ok AND (content-type not in `['application/json','text/json']` OR status in `{421,450,500}`) AND `!_retried`:
   - **Branch A — URL contains the findme root:** call `auth.authenticate({ forceRefresh: true, service: status === 450 ? undefined : 'find' })`; then `return this.request(method, url, { ...opts, _retried: true })`. Swallow exceptions from the re-auth attempt (try/catch), then still retry.
   - **Branch B — other:** retry once with `_retried: true`.
   - If `_retried` already true → `raiseError(status, reason)`.
6. **JSON vs raw:** `responseType:'json'` parses; `'stream'`/`'arraybuffer'` for downloads (don't parse body for error reason on streams).

> **No-Python-reference callout:** the Python test suite has NO China test and NO header-harvest test (its mock cheats by mutating `session_data` directly). The header-handshake, China host-vs-OAuth-global, and explicit-retry tests added here (`http-interceptors.spec.ts`, `auth.spec.ts`) are NET-NEW and have no Python reference. They must be derived from the source REQUEST code (the behavior items 1–6 above and §4.3), not ported from any Python test.

---

### 4.3 Auth service (`src/auth/icloud-auth.service.ts`, `@Injectable()`)

Public API:

```ts
@Injectable()
export class IcloudAuthService {
  static async create(options, secrets): Promise<IcloudAuthService>;   // factory (§3.3)

  // state
  data: AccountLoginData;             // dsInfo, webservices, apps, hsa flags
  params: Record<string,string>;      // shared bag (populated)
  readonly user: { accountName: string; password: string };

  // lifecycle
  authenticate(opts?: { forceRefresh?: boolean; service?: string }): Promise<void>;
  populateParams(): void;             // FIX #1

  // 2FA / 2SA
  get requires2fa(): boolean;         // data?.dsInfo?.hsaVersion === 2 && (hsaChallengeRequired || !isTrustedSession)
  get requires2sa(): boolean;         // (data?.dsInfo?.hsaVersion ?? 0) >= 1 && (hsaChallengeRequired || !isTrustedSession)
  get isTrustedSession(): boolean;    // data?.hsaTrustedBrowser ?? false
  get trustedDevices(): Promise<any[]>;
  sendVerificationCode(device): Promise<boolean>;
  validateVerificationCode(device, code: string): Promise<boolean>;   // -21669 -> false; success -> trustSession()
  validate2faCode(code: string): Promise<boolean>;                    // -21669 -> false; success -> trustSession()
  trustSession(): Promise<boolean>;

  // service accessors (lazy, cached) — §3.4
  get drive, get account, get photos(): Promise<...>, get files (Ubiquity),
  get calendar(): Promise<...>, get contacts(): Promise<...>, get reminders(): Promise<...>,
  findMyiPhone(): Promise<FindMyiPhoneService>;

  getWebserviceUrl(key: string): string;
}
```

`authenticate()` flow (exact, §2.3):
- If `sessionData.session_token && !forceRefresh`: try `_validateToken()`; on failure fall through to sign-in.
- elif `service && data.apps?.[service]?.canLaunchWithOneFactor`: try `_authenticateWithCredentialsService(service)`; on failure fall through.
- else full OAuth sign-in:
  - `POST {AUTH}/signin?isRememberMeEnabled=true`, body `{ accountName, password, rememberMe:true, trustTokens: sessionData.trust_token ? [sessionData.trust_token] : [] }`, headers = `getAuthHeaders()` + dynamic scnt/session_id. Failure → `PyiCloudFailedLoginException('Invalid email/password combination.')`.
  - `_authenticateWithToken()`.
- After any path: `this._webservices = this.data.webservices`.

Sub-methods:
- `_authenticateWithToken()` → `POST {SETUP}/accountLogin` body `{ accountCountryCode: sessionData.account_country, dsWebAuthToken: sessionData.session_token, extended_login: true, trustToken: sessionData.trust_token ?? '' }` → `this.data = resp`.
- `_authenticateWithCredentialsService(service)` → `POST {SETUP}/accountLogin` body `{ appName: service, apple_id: accountName, password }`; then `this.data = await _validateToken()`.
- `_validateToken()` → `POST {SETUP}/validate` with raw body literal `'null'` (string, Content-Type application/json) → returns payload.

`getAuthHeaders(overrides?)` (§2.4): builds the 8 `X-Apple-OAuth-*`/widget headers (REDIRECT_URI and widget/client-id always GLOBAL), `Accept:'*/*'`, `Content-Type:'application/json'`, `X-Apple-OAuth-State: client_id`, `X-Apple-Widget-Key/Client-Id: OAUTH.CLIENT_ID`; merge overrides (2FA sets `Accept:'application/json'`).

2FA/2SA:
- `validate2faCode(code)` → `POST {AUTH}/verify/trusteddevice/securitycode` body `{securityCode:{code}}`, headers = authHeaders({Accept:'application/json'}) + scnt + session_id. On error code `-21669` → return `false`. Success → `await trustSession()`; return `!requires2sa`.
- `trustedDevices` → `GET {SETUP}/listDevices` → `resp.devices`.
- `sendVerificationCode(device)` → `POST {SETUP}/sendVerificationCode` body=device → `resp.success`.
- `validateVerificationCode(device, code)` → `POST {SETUP}/validateVerificationCode` body `{...device, verificationCode:code, trustBrowser:true}`. `-21669` → false. Success → `trustSession()` (Python calls `trust_session()`); return `!requires2sa`.
- `trustSession()` → `GET {AUTH}/2sv/trust` (authHeaders + scnt + session_id); the `X-Apple-TwoSV-Trust-Token` response header is harvested by the interceptor; then `await _authenticateWithToken()`. Return boolean (false on caught failure).

> **2FA vs 2SA code values (test correctness):** the two verification paths compare DIFFERENT codes. In the Python fixtures `VALID_2FA_CODE='000000'` is used by the **2FA** `securitycode` path (`validate2faCode`). The **2SA** `validateVerificationCode` path compares against the device dict mutated by the source helper, where `verificationCode` is the string `'0'` (the source mutates the module-level `TRUSTED_DEVICE_1` fixture and the router compares the mutated dict including `verificationCode:'0'`). `auth.spec.ts` and `cli.spec.ts` MUST use `'000000'` for the 2FA path and `'0'` for the 2SA device-compare path — do not cross them.

`populateParams()`:
```ts
this.params = {
  clientBuildNumber: BUILD.clientBuildNumber,
  clientMasteringNumber: BUILD.clientMasteringNumber,
  ckjsBuildVersion: BUILD.ckjsBuildVersion,
  clientId: this.store.sessionData.client_id!,
  dsid: String(this.data.dsInfo.dsid),
};
```

---

### 4.4 Secrets (`src/secrets/secrets.service.ts`, `@Injectable()`)

```ts
@Injectable()
export class SecretsService {
  async getPassword(username: string, interactive = process.stdout.isTTY): Promise<string>;
  async passwordExistsInKeyring(username: string): Promise<boolean>;
  async getPasswordFromKeyring(username: string): Promise<string>; // null -> throw NoStoredPasswordAvailable
  async storePasswordInKeyring(username: string, password: string): Promise<void>;
  async deletePasswordInKeyring(username: string): Promise<void>;
}
export function underscoreToCamelcase(word: string, initialCapital = false): string;
```

- All keytar calls use `service = KEYRING_SERVICE` (`'pyicloud://icloud-password'`), account = username.
- `getPassword`: try `getPasswordFromKeyring`; on `PyiCloudNoStoredPasswordAvailableException` re-throw if `!interactive`, else prompt via `readline/promises` (hidden if feasible) — return entered value.
- **FIX #5 (interactive default):** evaluate `process.stdout.isTTY` at call time (default param), not at import.
- `underscoreToCamelcase('foo_bar')` → `'fooBar'`; capitalize each piece, lowercase first char unless `initialCapital`.

---

### 4.5 Drive (`src/services/drive.service.ts`)

```ts
export class DriveService {
  constructor(serviceRoot: string /*drivews*/, documentRoot: string /*docws*/, http: IcloudHttpService, params: Record<string,string>);
  async root(): Promise<DriveNode>;                 // lazy, cached
  async getNodeData(nodeId: string): Promise<DriveItem>;
  async getFile(fileId: string): Promise<NodeJS.ReadableStream>;
  async getAppData(): Promise<DriveItem[]>;
  async sendFile(folderId: string, fileName: string, stream: Readable, size: number): Promise<void>;
  async createFolders(parent: string, name: string): Promise<any>;
  async renameItems(id: string, etag: string, name: string): Promise<any>;
  async moveItemsToTrash(id: string, etag: string): Promise<any>;
  // delegation: DriveService proxies to root node for dir()/get()/[]
}
export class DriveNode {
  data: DriveItem;
  get name(): string;            // `${name}.${extension}` if extension else name
  get type(): string;            // data.type.toLowerCase()
  get size(): number | undefined;
  get dateChanged(): Date; get dateModified(): Date; get dateLastOpen(): Date;
  async getChildren(): Promise<DriveNode[]>;     // fetch via getNodeData(docwsid), MERGE into data; throw if status missing
  async dir(): Promise<string[]>;
  async get(name: string): Promise<DriveNode>;
  async open(): Promise<NodeJS.ReadableStream>;  // size===0 -> empty stream, NO HTTP CALL
  async mkdir(name), rename(name), delete(), upload(fileName, stream, size);  // FIX #4: explicit signature
}
```

HTTP behavior to preserve:
- `getNodeData`: `POST {drivews}/retrieveItemDetailsInFolders`, body = **JSON array** `[{ drivewsid: `FOLDER::com.apple.CloudDocs::${nodeId}`, partialData:false }]` → return `resp[0]`. (Router must match on `body[0].drivewsid`.)
- `getFile`: `GET {docws}/ws/com.apple.CloudDocs/download/by_id?document_id=<id>` → JSON tokens; then `GET data_token.url ?? package_token.url` with `responseType:'stream'`.
- `getAppData`: `GET {drivews}/retrieveAppLibraries` → `resp.items`.
- **`text/plain` Content-Type mandatory** on: `upload/web`, `update/documents`, `createFolders`. JSON body still sent as the request body string but with `Content-Type: text/plain`.

#### `sendFile` saga — TWO Drive POSTs with DIFFERENT response shapes (port `drive.py:80-156`)

This is load-bearing: the reserve POST returns an ARRAY and the commit POST returns an OBJECT. Router fixtures and the implementation must agree.

1. **Reserve (`_get_upload_contentws_url`):** `POST {docws}/ws/com.apple.CloudDocs/upload/web` (Content-Type `text/plain`), body `{ filename: fileName, type:'FILE', content_type: <guessed>, size }`.
   - **Response body is a JSON ARRAY; read index `[0]`.** Implementation reads `resp[0].document_id` and `resp[0].url` (i.e. Python `request.json()[0]['document_id']` and `request.json()[0]['url']`). Return `[document_id, url]`.
   - Router fixture for this route MUST be an array: `[{ "document_id": "...", "url": "<reserved-upload-url>" }]`.
2. **Upload to reserved url:** multipart/form-data POST to `url` (no explicit Content-Type; let the boundary be set automatically), streaming the file bytes.
   - **Response body is an OBJECT; read `resp.singleFile`** (Python `request.json()['singleFile']`). This `singleFile` info is passed to the commit step as `sf_info`.
   - Router fixture for this route MUST be an object: `{ "singleFile": { ... } }`.
3. **Commit (`_update_contentws`):** `POST {docws}/ws/com.apple.CloudDocs/update/documents` (Content-Type `text/plain`), body containing `document_id`, `command:'add_file'`, `path:{ starting_document_id: folderId, path: fileName }`, `data:{ signature, wrapping_key, reference_signature, size }` from `sf_info`, plus `receipt` from `sf_info` — **OMIT `receipt` when size === 0** (0-byte files have no receipt).

Other Drive HTTP:
- `createFolders`: body `{destinationDrivewsId:parent, folders:[{clientId: params.clientId, name}]}`.
- `moveItemsToTrash`: body `{items:[{drivewsid:id, etag, clientId: params.clientId}]}`.
- `renameItems`: body `{items:[{drivewsid:id, etag, name}]}`.
- `_getTokenFromCookie()`: read jar for `X-APPLE-WEBAUTH-VALIDATE`, regex `/\bt=([^:]+)/` on value → `{token}`. Required for upload.
- `_raiseIfError(resp)`: throw `PyiCloudAPIResponseException(reason, status)` if `!resp.ok`.
- **`open()` 0-byte short-circuit:** if `size===0`, return an empty `Readable` (`Readable.from([])`) with NO HTTP (iCloud 400s on 0-byte `by_id`).
- Node ids: folders `FOLDER::com.apple.CloudDocs::<guid|root>`, files `FILE::...::<guid>`; `docwsid` = bare guid for children/download; `etag` (e.g. `32::2x`) required for rename/delete.
- Dates via `dateToUtc()` (§4.11).

#### Ubiquity (`src/services/ubiquity.service.ts`) — kept entirely separate

```ts
export class UbiquityService {
  constructor(serviceRoot: string, http, params);   // dsid from params
  async getNode(nodeId: number): Promise<UbiquityNode>;     // {ubiquity}/ws/{dsid}/item/{nodeId}
  async getChildren(nodeId: number): Promise<UbiquityNode[]>; // -> {item_list:[...]}
  async getFile(nodeId: number): Promise<Readable>;          // .../file/{nodeId}
  async root(): Promise<UbiquityNode>;                       // nodeId 0
}
export class UbiquityNode { item_id: number; modified: Date /* %Y-%m-%dT%H:%M:%SZ */; type; name; ... }
```
Read-only; integer ids; root id = `0`. URL template `{ubiquity}/ws/{dsid}/{item|parent|file}/{nodeId}`.

---

### 4.6 Photos (`src/services/photos.service.ts`)

```ts
export class PhotosService {
  constructor(serviceRoot /*ckdatabasews*/, http, params);
  async init(): Promise<void>;                 // CheckIndexingState probe -> throw NotActivated if state!='FINISHED'
  async albums(): Promise<Record<string, PhotoAlbum>>;  // lazy; SMART_FOLDERS + _fetchFolders()
  async all(): Promise<PhotoAlbum>;            // albums['All Photos']
  serviceEndpoint: string;                     // serviceRoot + '/database/1/com.apple.photos.cloud/production/private'
}
```

#### `PhotoAlbum` — PINNED constructor signature & positional argument order

The Python signature (`photos.py:233-249`) is, **in this exact order**:

```
__init__(self, service, name, list_type, obj_type, direction, query_filter=None, page_size=100)
```

`list_type` comes **BEFORE** `obj_type`. The TypeScript class must mirror this exactly:

```ts
export class PhotoAlbum implements AsyncIterable<PhotoAsset> {
  constructor(
    service: PhotosService,
    name: string,
    listType: string,     // POSITION 3 — used as recordType in pagination query
    objType: string,      // POSITION 4 — used as the indexCountID value in length()
    direction: 'ASCENDING' | 'DESCENDING',
    queryFilter: SmartFolderDef['query_filter'] = null,
    pageSize = 100,
  );
  readonly name: string;
  get title(): string;                         // === name
  length(): Promise<number>;                   // caches _len
  [Symbol.asyncIterator](): AsyncIterator<PhotoAsset>;
}
```

**Smart folders** are constructed by spreading the `SMART_FOLDERS` def (`new PhotoAlbum(this, name, def.list_type, def.obj_type, def.direction, def.query_filter)`).

**User albums** (from `_fetchFolders()`) are constructed POSITIONALLY, exactly as Python `photos.py:198-205`:

```ts
new PhotoAlbum(
  this,
  folderName,                                  // decoded from base64 albumNameEnc
  'CPLContainerRelationLiveByAssetDate',       // list_type  (POSITION 3)
  `CPLContainerRelationNotDeletedByAssetDate:${folderId}`, // obj_type (POSITION 4)
  'ASCENDING',
  queryFilter,                                 // [{ fieldName:'parentId', comparator:'EQUALS', fieldValue:{type:'STRING', value: folderId} }]
);
```

> ROLE WARNING (do not swap): `length()` filters `indexCountID` by **`objType`**; pagination uses **`listType`** as the `recordType`. The user-album `list_type` is `CPLContainerRelationLiveByAssetDate` and `obj_type` is `CPLContainerRelationNotDeletedByAssetDate:<folderId>` — NOT the reverse. Swapping them breaks both counting and pagination.

#### `PhotoAlbum.length()` (`photos.py:261-299`)

`POST {serviceEndpoint}/internal/records/query/batch` (Content-Type `text/plain`), query string `urlencode(params)`, body:

```json
{ "batch": [ { "resultsLimit": 1,
  "query": { "filterBy": { "fieldName": "indexCountID",
    "fieldValue": { "type": "STRING_LIST", "value": ["<objType>"] },
    "comparator": "IN" },
    "recordType": "HyperionIndexCountLookup" },
  "zoneWide": true, "zoneID": { "zoneName": "PrimarySync" } } ] }
```

Read count from `resp.batch[0].records[0].fields.itemCount.value`. The `value` placed in `indexCountID` is `objType` (POSITION 4) — assert this in `photos.spec.ts`.

#### Pagination (`[Symbol.asyncIterator]`, `photos.py:301-346`)

- Start offset: `direction === 'DESCENDING' ? (await length()) - 1 : 0`.
- Loop: `POST {serviceEndpoint}/records/query?{params}` (Content-Type `text/plain`), body from `_listQueryGen(offset, listType, direction, queryFilter)` — uses **`listType`** as `recordType` (POSITION 3), `startRank` INT64 = offset, `direction` STRING, `resultsLimit = pageSize*2`, ~90 `desiredKeys`, `zoneID PrimarySync`, then extend `filterBy` with `queryFilter` if present.
- Partition `resp.records`: `CPLAsset` keyed by `fields.masterRef.value.recordName`; `CPLMaster` collected in order.
- Advance offset by master count (`-= masterCount` if DESCENDING else `+= masterCount`); for each master, `yield new PhotoAsset(service, master, assetRecords[master.recordName])`.
- Stop when a page yields no masters.

```ts
export class PhotoAsset {
  id; get filename(): string /*base64 filenameEnc*/; size; assetDate: Date; created: Date; addedDate: Date; dimensions;
  get versions(): Record<string, PhotoVersion>;  // VIDEO_ if resVidSmallRes present else PHOTO_
  async download(version = 'original'): Promise<Readable | null>;
  async delete(): Promise<void>;
}
```

- `versions`: per lookup map, each = `{filename, width, height, size, url: <prefix>Res.value.downloadURL, type}`.
- `download(version)`: `GET versions[version].url` stream; `null` if missing.
- `delete()`: `POST {serviceEndpoint}/records/modify` update op `fields.isDeleted.value=1`, `atomic:true`. **PRESERVE:** recordName/recordType from asset, recordChangeTag from **master**.

---

### 4.7 Account (`src/services/account.service.ts`)

```ts
export class AccountService {
  constructor(serviceRoot, http, params, setupEndpoint: string /* for storage URL — FIX #2 */);
  get accEndpoint(): string;                    // serviceRoot + '/setup/web'
  async devices(): Promise<AccountDevice[]>;    // GET {acc}/device/getDevices -> devices[]
  async family(): Promise<FamilyMember[]>;      // GET {acc}/family/getFamilyDetails -> familyMembers[]
  async storage(): Promise<AccountStorage>;     // GET {setupEndpoint}/storageUsageInfo  (FIX #2: CN-aware)
}
export interface AccountDevice { modelDisplayName: string; name: string; /* typed, NOT __getattr__ */ ... }
export class FamilyMember {
  lastName; dsid; fullName; appleId; hasParentalPrivileges; hasShareMyLocationEnabled; ...
  async getPhoto(): Promise<Readable>;          // GET {acc}/family/getMemberPhoto?memberId=<dsid>
}
export class AccountStorage {
  usage: AccountStorageUsage;
  usagesByMedia: Record<string, AccountStorageUsageForMedia>;
}
export interface AccountStorageUsage { used; total; usedStorageInPercent /*round(used*100/total,2)*/; availableInBytes; overQuota; ... }
export interface AccountStorageUsageForMedia { mediaKey; displayLabel; displayColor; usageInBytes; }
```
- All accessors lazy + cached.
- **FIX #2:** storage URL = `${setupEndpoint}/storageUsageInfo` (respects `.com.cn`), not hardcoded global.
- **AccountDevice:** typed interface — do not reproduce dynamic `__getattr__`/camelcase.

---

### 4.8 Find My iPhone (`src/services/findmyiphone.service.ts`)

```ts
export class FindMyiPhoneService {
  constructor(serviceRoot /*findme*/, http, params, withFamily: boolean);
  async init(): Promise<void>;                  // refreshClient() — replaces constructor I/O
  async refreshClient(): Promise<void>;         // POST /refreshClient -> rebuild device map; NoDevices if empty
  keys(): string[]; values(): AppleDevice[]; get(idOrIndex: string|number): AppleDevice;
  get fmipEndpoint(): string;                   // serviceRoot + '/fmipservice/client/web'
}
export class AppleDevice {
  content: any;
  async location(): Promise<any>;               // refreshClient() then content.location
  async status(additional?: string[]): Promise<any>;
  async playSound(subject = 'Find My iPhone Alert'): Promise<void>;   // fmly:true HARDCODED (preserve)
  async displayMessage(subject, message = 'This is a note', sounds = false): Promise<void>;
  async lostDevice(number, text = ..., newpasscode = ''): Promise<void>;
}
```
- `refreshClient()`: `POST /refreshClient` body `{clientContext:{fmly:withFamily, shouldLocate:true, selectedDevice:'all', deviceListVersion:1}}`; rebuild `Map` keyed by `content.id`; throw `PyiCloudNoDevicesException` if empty.
- `get(int)` → index into `keys()`; `get(string)` → map lookup.
- `location()`/`status()` both call whole-list `refreshClient()` then read from refreshed content (no per-device endpoint).
- Bodies per §3.4 table; `playSound` `clientContext.fmly:true` hardcoded (PRESERVE, comment).

---

### 4.9 Calendar / Contacts / Reminders

#### `src/services/calendar.service.ts`
```ts
export class CalendarService {
  constructor(serviceRoot, http, params);
  get usertz(): string;   // Intl.DateTimeFormat().resolvedOptions().timeZone
  async events(from?: Date, to?: Date): Promise<CalendarEvent[]>; // GET /ca/events; FIX #3 month range
  async getEventDetail(pguid, guid): Promise<CalendarEvent>;      // GET /ca/eventdetail/{pguid}/{guid} -> Event[0]
  async calendars(): Promise<any[]>;                              // GET /ca/startup -> response.Collection (singular)
}
```
- `events`: `GET {root}/ca/events?lang=en-us&usertz=<tz>&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` → `resp.Event`. **FIX #3:** when range omitted, `startDate` = 1st of month, `endDate` = `new Date(year, month, 0).getDate()`.
- Date format `YYYY-MM-DD`.

#### `src/services/contacts.service.ts`
```ts
export class ContactsService {
  constructor(serviceRoot, http, params);
  async refreshClient(): Promise<void>;  // TWO-STEP, sequential (do NOT parallelize)
  async all(): Promise<Contact[]>;       // response.contacts
}
```
- **Step 1:** `GET {root}/co/startup?clientVersion=2.1&locale=en_US&order=last,first` → `prefToken`, `syncToken`.
- **Step 2:** `GET {root}/co/contacts?...&prefToken=<>&syncToken=<>&limit=0&offset=0` (`limit=0` = all) → overwrite `response`. Sequential await.

#### `src/services/reminders.service.ts`
```ts
export class RemindersService {
  constructor(serviceRoot, http, params);
  async init(): Promise<void>;     // refresh() — replaces constructor I/O
  async refresh(): Promise<void>;  // GET /rd/startup -> lists/collections
  lists: Record<string, Reminder[]>;
  collections: Record<string, { guid: string; ctag: string }>;
  async post(title: string, description = '', collection?: string, dueDate?: Date): Promise<boolean>;
}
```
- `refresh`: `GET {root}/rd/startup?clientVersion=4.0&lang=en-us&usertz=<tz>` → parse `Collections[]` (`title→{guid,ctag}`) and `Reminders[]` (matched by `pGuid==collection.guid`).
- `post`: resolve `pGuid` (`'tasks'` default or `collections[collection].guid`); `POST {root}/rd/reminders/tasks?...` body per §3.5; return `resp.ok` (boolean).
- **`dueDate` packed-int (PRESERVE exactly):** array `[packedInt, year, month, day, hour, minute]` where `packedInt = parseInt('' + year + month + day, 10)` — **naive string concat, NOT zero-padded** (2026,6,3 → `parseInt('202663')`). On read only indices 1..5 used.
- `createdDateExtended` = epoch ms; `guid` = uuidv4.
- `post()` requires collections loaded (builds `ClientState.Collections` from cache).

---

### 4.10 CLI (`src/cli/`)

`src/cli/fmip-cli.ts` exports a **testable** core:
```ts
export interface CliDeps {
  createService: (u: string, p: string, china: boolean) => Promise<IcloudAuthService>;
  secrets: SecretsService;
  stdin: () => Promise<string>;     // prompt reader (injectable for tests)
  confirm: (q: string) => Promise<boolean>;
  exit: (code: number) => never;    // injectable (default process.exit)
  log: (s: string) => void; errlog: (s: string) => void;
}
export async function runCli(argv: string[], deps: CliDeps): Promise<void>;
```
`src/cli/main.ts`: `#!/usr/bin/env node`, builds `commander` program, wires real deps, calls `runCli`.

Behavior to preserve (port `cmdline.py:174-366` exactly):

1. Parse args (`--username`, `--password`, `--china-mainland`, `-n/--non-interactive`, `--delete-from-keyring`, `--locate`, `--outputfile`, `--llist`/`--list`, `--device`, `--sound`, `--message`, `--silentmessage`, `--lostmode`, `--lostphone`, `--lostmessage`, `--lostpassword`).
2. If `username` AND `--delete-from-keyring` → `secrets.deletePasswordInKeyring(username)` (does NOT return; falls into login loop).
3. **Login loop (`while true`):** if no `username` → usage error (`parser.error`) → exit `2`. If no `password` → `secrets.getPassword(username, interactive)`; if still none → usage error → exit `2`.
4. Construct service via `createService(username.trim(), password.trim(), china)`. If password NOT in keyring AND interactive AND `confirm("Save password in keyring?")` → `storePasswordInKeyring`.
5. If `requires2fa`: print prompt, read code from stdin → `validate2faCode(code)`; on false → print "Failed to verify verification code", `exit(1)`. Elif `requires2sa`: fetch `trustedDevices`, list each as `device.deviceName ?? "SMS to " + device.phoneNumber`, prompt for an integer index, `sendVerificationCode(device)` (false → "Failed to send verification code", `exit(1)`), then read code, `validateVerificationCode(device, code)` (false → "Failed to verify verification code", `exit(1)`). Then `break`.
6. `catch PyiCloudFailedLoginException`: if password in keyring → delete it; set message `'Bad username or password for <username>'`; `password=undefined`; `failureCount++`; if `>=3` → `throw new Error(message)`; else errlog the message and continue the loop.

7. **Dispatch — per-device LOOP with id-match filter (`for dev of api.devices`):** iterate over EVERY device in `api.devices`. For each `dev`, apply the device filter FIRST: process this device only when `!deviceId` OR `deviceId.trim().toLowerCase() === dev.content.id.trim().toLowerCase()`. (There is no single-device lookup; all actions run inside this loop.) Inside, in this order:
   - `--locate` → `await dev.location()`.
   - `--outputfile` → write `JSON.stringify(dev.content)` to `<dev.content.name.trim().toLowerCase()>.fmip_snapshot.json` (REPLACES Python pickle `<name>.fmip_snapshot`).
   - `--llist` (longlist) → print a `'-'.repeat(30)` rule, then `dev.content.name`, then every key/value of `dev.content` as `"%20s - %s"`.
   - else if `--list` → print a `'-'.repeat(30)` rule, then EXACTLY these seven fields from `dev.content` (this exact set and order):
     - `Name - <name>`
     - `Display Name  - <deviceDisplayName>`
     - `Location      - <location>`
     - `Battery Level - <batteryLevel>`
     - `Battery Status- <batteryStatus>`
     - `Device Class  - <deviceClass>`
     - `Device Model  - <deviceModel>`
   - `--sound` → require `--device` (i.e. `deviceId` truthy) else `throw RuntimeError("Sounds can only be played on a singular device. " + DEVICE_ERROR)`; on device → `dev.playSound()`.
   - `--message <text>` → require `--device` else throw (`"Messages can only be played on a singular device. " + DEVICE_ERROR`); on device → `dev.displayMessage({ subject:'A Message', message, sounds:true })`.
   - `--silentmessage <text>` → require `--device` else throw (`"Silent Messages can only be played on a singular device. " + DEVICE_ERROR`); on device → `dev.displayMessage({ subject:'A Silent Message', message, sounds:false })`.
   - `--lostmode` → require `--device` else throw (`"Lost Mode can only be activated on a singular device. " + DEVICE_ERROR`); on device → `dev.lostDevice({ number: lostPhone.trim(), text: lostMessage.trim(), newpasscode: lostPassword.trim() })`.
8. After the loop, `exit(0)`.

`DEVICE_ERROR = "Please use the --device switch to indicate which device to use."`.

**Exit-code contract:** `2` = usage error (missing username/password); `1` = failed 2FA/2SA verification; `0` = success; bad creds → thrown `Error('Bad username or password for <user>')` after 3 failures. Keep `.trim()` on username/password/device-id/lost-* values.

> `cli.spec.ts` must drive the dispatch through the per-device loop: assert that with no `--device` ALL devices are processed, with `--device <id>` only the id-matching device acts, that `--list` prints exactly the seven fields above (in order), and that `--sound`/`--message`/`--silentmessage`/`--lostmode` without `--device` throw the corresponding RuntimeError containing `DEVICE_ERROR`.

---

### 4.11 Utils

- `src/util/camelcase.ts`: `underscoreToCamelcase`.
- `src/util/date.ts`: `dateToUtc(s)` — accepts `…Z` (UTC) or California offset `…-07:00`/`-08:00`; regex-detect offset, subtract, return UTC `Date`. `parseUbiquityDate(s)` — `%Y-%m-%dT%H:%M:%SZ`.
- `src/util/redact.ts`: `redactSecret(text, secret)` → replaces with `********`. Used by a NestJS `Logger` wrapper; never log password/tokens.

---

## 5. Test Strategy

### 5.1 Wire-level mocking (nock)

- `test/setup.ts`: `nock.disableNetConnect()`; `afterEach(() => { nock.cleanAll(); resetAuthState(); })`.
- `test/helpers/mock-router.ts`: register nock interceptors mirroring the **substring + method** table. **Match ordering preserved** (e.g. `validateVerificationCode` before `validate`). Drive routes on `body[0].drivewsid` (array body). Drive `upload/web` replies an ARRAY (`[{document_id,url}]`); the reserved-upload url replies an OBJECT (`{singleFile:{…}}`) — see §4.5. **Unmatched route → throw `Unexpected request: METHOD URL`** (FIX #7).
- **Header-based auth (improvement over Python — NET-NEW, no Python reference):** mock responses return real headers (`X-Apple-ID-Session-Id`, `X-Apple-Session-Token`, `X-Apple-TwoSV-Trust-Token`, `X-Apple-ID-Account-Country`, `scnt`) so the **response interceptor's header harvesting is actually exercised**. The Python mock cheats by mutating `session_data` directly, so this handshake test is derived from the source REQUEST code, not ported.
- `test/helpers/auth-state.ts` holds a closure state machine. **Auth-state constants must come from `tests/const.py` exactly:**
  - `AUTHENTICATED_USER = PRIMARY_EMAIL` (NOT a hard-coded `'quentintarantino@hotmail.fr'` literal — bind it to whatever `PRIMARY_EMAIL` resolves to).
  - `VALID_PASSWORD` (from const).
  - `VALID_USERS` includes `AUTHENTICATED_USER` plus the `APPLE_ID_EMAIL` and `ICLOUD_ID_EMAIL` aliases.
  - `REQUIRES_2FA_USER = 'requires_2fa_user'`, `REQUIRES_2FA_TOKEN = 'requires_2fa_token'`.
  - `VALID_TOKENS` (accepted `dsWebAuthToken` set), `VALID_COOKIE`.
  - `VALID_2FA_CODE = '000000'` (2FA path). 2SA device-compare uses `verificationCode:'0'` (see §4.3).
  - Router gating, encoded precisely in `auth-state.ts`:
    - `signin` succeeds only when `accountName ∈ VALID_USERS` AND `password === VALID_PASSWORD`; it sets `session_token` to a VALID token or to `REQUIRES_2FA_TOKEN` based on the user.
    - `accountLogin` succeeds only when `dsWebAuthToken ∈ VALID_TOKENS`; returns the working-login or 2FA-login fixture accordingly.
    - `2FA securitycode` → 204; `2sv/trust` → 204 (+ trust-token header).
    - `{SETUP}/validate` requires header `X-APPLE-WEBAUTH-TOKEN === VALID_COOKIE`, else error `'Session expired'`.
- **Stateful fixtures reset every test** — deep-cloned per test (no shared mutable singletons). This fixes the Python `TRUSTED_DEVICE_1.update(...)` isolation hazard where the source mutates the module-level fixture in place.
- **China:** path-based substring matching (`signin`, `accountLogin`) works for `.com.cn` hosts. NET-NEW China test (no Python reference): assert signin host is `.com.cn` but OAuth `X-Apple-OAuth-Redirect-URI === https://www.icloud.com`.

### 5.2 Per-module tests

| Spec | Asserts |
|---|---|
| `exceptions.spec.ts` | `instanceof` chain via setPrototypeOf; message formatting (`reason (code). Retrying ...`); `PyiCloudFailedLoginException` is NOT instanceof API exception. |
| `secrets.spec.ts` | keytar mocked; service name `'pyicloud://icloud-password'`; null → throws NoStoredPassword; non-interactive re-throw; `underscoreToCamelcase('foo_bar')==='fooBar'`. |
| `session-store.spec.ts` | load/persist round-trip; corrupt file tolerated → empty; cookie jar serialize/deserialize. |
| `http-interceptors.spec.ts` | **header harvest** into sessionData; scnt/session_id echo on next request; **single-retry** with `_retried` guard (no infinite loop); 421/450/500 paths; findme branch re-auth (450→full, else→`'find'`); error normalization key-priority. (NET-NEW, derived from source request code.) |
| `auth.spec.ts` | full signin→accountLogin→webservices map; `validate`-token reuse path; `requires2fa`/`requires2sa`/`isTrustedSession`; `validate2faCode('000000')` (-21669→false, success→trust); 2SA `sendVerificationCode`/`validateVerificationCode` with device `verificationCode:'0'`; `trustSession` harvests trust-token; `populateParams` sets dsid/clientId (assert these present) but does NOT pin build-number strings; China endpoints + global OAuth redirect (NET-NEW). |
| `drive.spec.ts` | root `dir()` === `['Keynote','Numbers','Pages','Preview','pyiCloud']`; subfolder `Test` === `['Document scanné 2.pdf','Scanned document 1.pdf']`; array-body routing; `text/plain` on upload/commit/createFolders; sendFile reserve reads `[0].document_id`/`[0].url`, upload reads `.singleFile`, commit omits `receipt` when size 0; 0-byte `open()` makes NO HTTP; cookie-token regex; download 2-hop. |
| `ubiquity.spec.ts` | int ids; root id 0; `{item_list}` parsing; `dsid` in path. |
| `photos.spec.ts` | CheckIndexingState gate (not FINISHED → NotActivated); albums merge/skip rules; base64 name decode; **user-album constructed with list_type=`CPLContainerRelationLiveByAssetDate`, obj_type=`CPLContainerRelationNotDeletedByAssetDate:<id>` (assert roles NOT swapped)**; `length()` puts `objType` into `indexCountID`; pagination uses `listType` as recordType, pairs master/asset; delete uses master changeTag; `text/plain`. |
| `account.spec.ts` | 2 devices; 3 family members; storage 43.75% of 5368709120; **storage URL is CN-aware** (FIX #2 asserted); typed device fields. |
| `findmyiphone.spec.ts` | 13 devices; `get(int)`/`get(id)`; location/status trigger refresh; playSound fmly:true; lostDevice body; NoDevices on empty. |
| `calendar.spec.ts` | `events()` returns `Event`; `calendars()` reads `Collection` (singular); **FIX #3** month range (start=1st, end=last day); date format. |
| `contacts.spec.ts` | two-step sequential handshake; `prefToken`/`syncToken` threaded into step 2; `limit=0`; `all()` reads `contacts`. |
| `reminders.spec.ts` | startup parse (Collections/Reminders); `post()` builds body + ClientState; **packed-int concat** unpadded (assert `parseInt('202663')`); returns `ok`. |
| `cli.spec.ts` | exit `2` on missing username/password; exit `1` on failed 2FA/2SA; exit `0` success; **per-device loop**: no `--device` processes all devices, `--device <id>` filters by `content.id` match; `--list` prints exactly the 7 fields in order; bad creds → `throw Error('Bad username or password for <user>')` after 3 failures; 2FA via mocked stdin `'000000'`; `--sound`/`--message`/`--silentmessage`/`--lostmode` without `--device` throw RuntimeError containing `DEVICE_ERROR`; keyring save-confirm; `--delete-from-keyring`; `--outputfile` writes JSON. |

### 5.3 Retry tests (explicit — improvement, NET-NEW)
Directly drive a service request returning 421/450/500 then 200, assert exactly one retry and (for findme URLs) a re-auth call between them. Assert no second retry on persistent failure (`_retried` guard). No Python reference — derived from §4.2 request code.

### 5.4 Ported fixtures
Port `const_*.py` dicts to `test/fixtures/*.json`. Keep derivation: `PERSON_ID = (first+last).toLowerCase()`, emails `@{hotmail.fr,me.com,icloud.com}`. Auth-state constants live in `test/helpers/auth-state.ts` per §5.1 (bound to `PRIMARY_EMAIL`/`VALID_USERS`/`VALID_TOKENS`, not hard-coded literals): `AUTHENTICATED_USER`, `VALID_PASSWORD`, `VALID_COOKIE`, `VALID_TOKENS`, `VALID_2FA_CODE='000000'`, `REQUIRES_2FA_USER='requires_2fa_user'`, `REQUIRES_2FA_TOKEN='requires_2fa_token'`, `AUTH_OK={authType:'hsa2'}`.

---

## 6. Implementation Order (Dependency-Respecting Phases)

Files within a phase are independent and can be built by **parallel agents**.

**Phase 0 — Scaffolding (1 agent, blocks all):**
`package.json`, `tsconfig*.json`, `jest.config.js`, `.eslintrc.js`, `.prettierrc`, `test/setup.ts`, empty `src/index.ts`. Run `npm install`.

**Phase 1 — Leaves (parallel, no internal deps):**
- A: `src/exceptions/icloud.exceptions.ts` + `test/exceptions.spec.ts`
- B: `src/constants.ts`, `src/icloud.constants.ts`, `src/interfaces/*.ts`
- C: `src/util/camelcase.ts`, `src/util/date.ts`, `src/util/redact.ts`
- D: `src/secrets/secrets.service.ts` + `test/secrets.spec.ts` (depends on A only)

**Phase 2 — Session core (depends on 1):**
- A: `src/session/session-store.ts` + `test/session-store.spec.ts`
- B: `src/session/error-normalizer.ts`
- C: `src/session/icloud-http.service.ts` + `test/http-interceptors.spec.ts` (depends on 2A, 2B)
- D: `test/helpers/auth-state.ts`, `test/helpers/mock-router.ts`, `test/fixtures/*` (parallel, no src dep)

**Phase 3 — Auth (depends on 2):**
- `src/auth/icloud-auth.service.ts` + `test/helpers/make-service.ts` + `test/auth.spec.ts`

**Phase 4 — Services (all parallel; each depends only on 1–3):**
- `drive.service.ts` + `ubiquity.service.ts` + `drive.spec.ts` + `ubiquity.spec.ts`
- `photos.service.ts` + `photos.spec.ts`
- `account.service.ts` + `account.spec.ts`
- `findmyiphone.service.ts` + `findmyiphone.spec.ts`
- `calendar.service.ts` + `calendar.spec.ts`
- `contacts.service.ts` + `contacts.spec.ts`
- `reminders.service.ts` + `reminders.spec.ts`

**Phase 5 — Wiring (depends on 3 + relevant of 4):**
- `src/icloud.module.ts` (wire async factory + accessors into `IcloudAuthService`)
- `src/index.ts` (barrel)

**Phase 6 — CLI (depends on 3 + findmyiphone from 4):**
- `src/cli/fmip-cli.ts`, `src/cli/main.ts` + `test/cli.spec.ts`

**Phase 7 — Finalize:**
- Wire service accessors into `IcloudAuthService` (if deferred), run full `npm run build && npm test && npm run lint`, tune coverage.

---

## 7. Definition of Done

1. **Build:** `npm run build` (`tsc -p tsconfig.build.json`) completes with **zero errors**; emits `dist/` with `.d.ts` declarations; `dist/cli/main.js` is the executable bin.
2. **Tests:** `npm test` green; coverage meets thresholds (branches ≥70, functions/lines/statements ≥80). Every module in §5.2 has its spec passing. Header-handshake, single-retry, China-OAuth, CLI exit-code (0/1/2), CLI per-device-loop/field-set, photos obj_type-vs-list_type role, Drive array-vs-object response shapes, and unmatched-route-throws tests all pass.
3. **Lint:** `npm run lint` clean (`--max-warnings 0`).
4. **No network in constructors:** all eager-I/O paths (`PyiCloudService.__init__`, `FindMyiPhone`/`Reminders` constructors, Photos probe) moved to async `create()`/`init()`; verified by a test constructing classes with no nock mocks registered (no unexpected HTTP).
5. **Secrets/redaction:** password and the five harvested tokens never appear in logs (assert via spied logger in `http-interceptors.spec.ts`); keytar service string is exactly `'pyicloud://icloud-password'`.
6. **Source-fidelity for load-bearing literals:** the 11-entry `SMART_FOLDERS` table matches §4.0 exactly; `PhotoAlbum` constructor positional order is `(service, name, listType, objType, direction, queryFilter, pageSize)`; user albums use `list_type=CPLContainerRelationLiveByAssetDate`, `obj_type=CPLContainerRelationNotDeletedByAssetDate:<id>`; Drive reserve reads `[0]`, upload reads `.singleFile`; CLI dispatch is a per-device loop with the id-match filter and the exact `--list` seven-field set — each confirmed by an assertion.
7. **Latent-bug resolutions** from §0 are implemented and each has a confirming assertion (params populated with clientId/dsid — build numbers NOT pinned; CN-aware storage URL; calendar month range; explicit `upload` signature; hardened `requires2fa`; unmatched-route throws). Preserved quirks (CN OAuth-global, `fmly:true`, photos change-tag mix) are covered by a comment + a test asserting the preserved behavior.
---

## 8. Reviewer Addendum — Final Clarifications (apply during implementation)

These three clarifications were raised in final review (non-blocking) and MUST be honored:

### 8.1 Retry gate wording (precise semantics — §4.2 item 5)
The outer condition `not-ok AND (content-type not JSON OR status in {421,450,500})` is ONLY the gate that decides *error-handling vs returning the raw response*. The **actual single retry** (both the findme/Branch-A re-auth path and Branch-B) fires **only when `status ∈ {421,450,500}` AND `!_retried`**. A non-JSON response that is NOT 421/450/500 must fall straight through to `raiseError` with **NO retry** (do not retry a non-JSON 404). Additionally: **successful (status 200) stream/arraybuffer downloads have a non-JSON content-type and must NOT enter the retry/raise path** — the source only enters error handling when `!response.ok`. State this explicitly so the streaming download tests don't accidentally trigger retry/parse logic.

### 8.2 Calendar FIX #3 — pin the month-range values (§4.9 calendar)
Be explicit that `month` is the **1-indexed human month**. `endDate` day = `new Date(year, month, 0).getDate()` yields the last day of the 1-indexed `month` (JS `Date` with day 0 = last day of previous 0-indexed month = last day of the 1-indexed month). Pin with a frozen-clock test (`jest.useFakeTimers().setSystemTime(new Date('2026-02-15'))`): `events()` with no args ⇒ `startDate='2026-02-01'`, `endDate='2026-02-28'`. The same default month-range applies to BOTH `startDate` and `endDate`, and `calendars()` recomputes the same range independently — **apply FIX #3 and the assertion to `calendars()` too**, not just `events()`.

### 8.3 Drive commit body — explicit `sf_info` key mapping (§4.5 sendFile step 3)
The commit (`update/documents`) `data` block maps from the upload `singleFile` response (`sf_info`) with these EXACT source keys:
- `signature` ⇐ `sf_info.fileChecksum`
- `wrapping_key` ⇐ `sf_info.wrappingKey`
- `reference_signature` ⇐ `sf_info.referenceChecksum`
- `size` ⇐ `sf_info.size`
- `receipt` ⇐ `sf_info.receipt` (OMIT the key entirely when falsy / size 0)

And the full commit body also includes (do not omit): `command:'add_file'`, `create_short_guid:true`, `document_id:<from reserve>`, `path:{ starting_document_id:<folder docwsid>, path:<fileName> }`, `allow_conflict:true`, `file_flags:{ is_writable:true, is_executable:false, is_hidden:false }`, `mtime:<epoch ms>`, `btime:<epoch ms>`.
