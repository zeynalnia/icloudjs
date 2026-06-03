# jsicloud

> An unofficial, dependency-light **NestJS / TypeScript client for Apple iCloud web services** — a faithful port of Python's [`pyicloud`](https://github.com/picklepete/pyicloud).

![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![tests](https://img.shields.io/badge/tests-231%20passing-success)
![license](https://img.shields.io/badge/license-MIT-blue)

`jsicloud` lets you authenticate against an Apple ID (including HSA2 two-factor and
legacy two-step verification), persist a trusted session to disk, and drive the
same private iCloud web endpoints that `icloud.com` uses — Drive, Photos, Find My
iPhone, Account, Calendar, Contacts, Reminders, and the legacy Ubiquity file
store. It ships both as an injectable **NestJS module** and as a standalone
factory, plus a `jsicloud` **command-line tool**.

---

## Table of contents

- [Disclaimer](#disclaimer)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
  - [Standalone](#standalone-icloudauthservicecreate)
  - [NestJS](#nestjs-icloudmoduleforrootasync)
  - [Handling 2FA / 2SA](#handling-2fa--2sa)
- [Service usage](#service-usage)
  - [Drive](#drive)
  - [Photos](#photos)
  - [Find My iPhone](#find-my-iphone)
  - [Account](#account)
  - [Calendar](#calendar)
  - [Contacts](#contacts)
  - [Reminders](#reminders)
  - [Ubiquity (legacy files)](#ubiquity-legacy-files)
- [Command-line tool](#command-line-tool)
- [Configuration](#configuration)
- [Session & secret storage](#session--secret-storage)
- [Error handling](#error-handling)
- [Examples & AI skill](#examples--ai-skill)
- [Development](#development)
- [Porting notes — divergence from pyicloud](#porting-notes--divergence-from-pyicloud)
- [License](#license)

---

## Disclaimer

**This is an unofficial library.** It is not endorsed by, affiliated with, or
supported by Apple Inc. It works by talking to Apple's *private, undocumented*
iCloud web endpoints, which can change or break at any time.

- **Terms of Service:** automating access to iCloud may violate the Apple iCloud
  Terms of Service and/or the Apple Media Services Terms. You are solely
  responsible for ensuring your use complies with all applicable terms and laws.
  Only use it with **your own account** and credentials you are authorised to use.
- **Security:** this library handles your Apple ID password and trusted-session
  tokens. Credentials are read from the OS keyring (via `keytar`) and session
  state is persisted to disk. Protect the cookie/session directory and your
  keyring. Passwords and tokens are scrubbed from debug logs, but **never** log,
  commit, or share session files. The `verify` option can disable TLS
  verification — for local testing only, **never** in production.

Use at your own risk.

---

## Features

All eight iCloud services are ported, reachable from a single authenticated
`IcloudAuthService`:

- **iCloud Drive** (`DriveService` / `DriveNode`) — modern CloudDocs: browse,
  download (streamed), upload, create folders, rename, move-to-trash.
- **Photos** (`PhotosService` / `PhotoAlbum` / `PhotoAsset`) — CloudKit web API:
  smart folders + user albums, async-iterable assets, download versions, delete.
- **Find My iPhone** (`FindMyiPhoneService` / `AppleDevice`) — list devices,
  locate, play sound, display message, enable lost mode.
- **Account** (`AccountService`) — devices, family members (+ avatars), storage
  usage breakdown.
- **Calendar** (`CalendarService`) — read events and calendar collections
  (GET-only).
- **Contacts** (`ContactsService`) — list contacts via the token handshake.
- **Reminders** (`RemindersService`) — read lists/collections and post new
  reminders.
- **Ubiquity** (`UbiquityService` / `UbiquityNode`) — the legacy, read-only
  document store.
- **CLI** (`jsicloud`) — a Find My iPhone command-line tool with keyring
  integration and interactive 2FA/2SA.

---

## Requirements

- **Node.js >= 18** (declared in `engines`).
- **[`keytar`](https://github.com/atom/node-keytar) `^7.9.0`** — a native module
  used for OS keyring access. It compiles against your platform's secret store
  (libsecret/GNOME Keyring on Linux, Keychain on macOS, Credential Vault on
  Windows). On Linux CI/headless boxes you may need `libsecret-1-dev` and a
  D-Bus session, or you can always pass `password` explicitly to avoid the
  keyring entirely.
- Peer-style runtime deps: `@nestjs/common` / `@nestjs/core` `^10.4.0`.

---

## Installation

```bash
npm install jsicloud
# or
yarn add jsicloud
# or
pnpm add jsicloud
```

`reflect-metadata` is a dependency and is imported by NestJS; if you use the
NestJS module directly, ensure it is imported once at your app's entry point.

---

## Quick start

### Standalone (`IcloudAuthService.create`)

The factory is the **only** way to construct an authenticated client (the
constructor is private). It resolves the password, loads any persisted session,
authenticates eagerly, and populates the shared query-param bag.

```ts
import { IcloudAuthService, SecretsService } from 'jsicloud';

const secrets = new SecretsService();

const auth = await IcloudAuthService.create(
  { accountName: 'me@icloud.com', password: 'app-or-account-password' },
  secrets,
);

// `create` returns once authentication has completed.
if (auth.requires2fa) {
  const ok = await auth.validate2faCode('123456');
  if (!ok) throw new Error('Wrong 2FA code');
}

const root = await auth.drive.root();
console.log(await root.dir());
```

If `password` is omitted, it is resolved from the OS keyring by `accountName`,
falling back to an interactive prompt when running on a TTY.

### NestJS (`IcloudModule.forRootAsync`)

Register the module once. **All authentication I/O happens at module
initialisation** — the injected `IcloudAuthService` is already authenticated by
the time your providers resolve.

```ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { IcloudModule } from 'jsicloud';

@Module({
  imports: [
    IcloudModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        accountName: cfg.getOrThrow('APPLE_ID'),
        password: cfg.get('APPLE_PASSWORD'), // optional — keyring fallback
        cookieDir: cfg.get('ICLOUD_COOKIE_DIR'),
      }),
    }),
  ],
})
export class AppModule {}
```

Static registration is also supported:

```ts
IcloudModule.forRoot({ accountName: 'me@icloud.com', password: 'pw' });
```

The module **exports** `IcloudAuthService` and `SecretsService`. Inject the auth
service anywhere:

```ts
import { Injectable } from '@nestjs/common';
import { IcloudAuthService } from 'jsicloud';

@Injectable()
export class PhotosSync {
  constructor(private readonly auth: IcloudAuthService) {}

  async run() {
    const photos = await this.auth.photos();
    const all = await photos.all();
    console.log(await all.length());
  }
}
```

### Handling 2FA / 2SA

After `create()` (or after the module finishes initialising) the session may
still need a verification code. Inspect the lifecycle getters and respond.
**Wrong codes do not throw — they return `false`.**

```ts
if (auth.requires2fa) {
  // HSA2 two-factor: a 6-digit code on a trusted device.
  const ok = await auth.validate2faCode('123456');
  if (!ok) throw new Error('Wrong 2FA code');
} else if (auth.requires2sa) {
  // Legacy two-step: pick a trusted device, then send + verify a code.
  // NOTE: `trustedDevices` is a *getter returning a Promise* — await it.
  const devices = await auth.trustedDevices;
  const device = devices[0];
  await auth.sendVerificationCode(device);
  const ok = await auth.validateVerificationCode(device, '1234');
  if (!ok) throw new Error('Wrong 2SA code');
}

// Optionally mark this browser/session as trusted so future runs skip the prompt.
// `isTrustedSession` is a synchronous getter.
if (!auth.isTrustedSession) {
  await auth.trustSession();
}
```

You can also force a full re-authentication:

```ts
await auth.authenticate({ forceRefresh: true });
```

---

## Service usage

Every service is reached through the authenticated `auth` instance. Services that
need a one-time network `init()` are exposed as **async methods** (`photos()`,
`reminders()`, `findMyiPhone()`); the rest are **sync getters** (`drive`,
`account`, `files`, `calendar`, `contacts`). All accessors are cached — repeated
calls return the same instance.

### Drive

```ts
const drive = auth.drive;             // sync getter (DriveService)

const root = await drive.root();      // DriveNode for the Drive root
const names = await root.dir();       // string[] | null — child names
const file = await root.get('report.pdf');

console.log(file.name, file.type, file.size, file.dateModified);

// Stream a download.
const stream = await file.open();     // Readable

// Upload a file into the root folder (size in bytes is required).
import { Readable } from 'stream';
await root.upload('hello.txt', Readable.from(['hi']), 2);

// Folder operations.
await root.mkdir('Reports');
await file.rename('report-final.pdf');
await file.delete();                  // move to trash
```

### Photos

```ts
const photos = await auth.photos();   // async — init() (indexing probe) already ran

const all = await photos.all();       // PhotoAlbum for "All Photos"
console.log(await all.length());      // item count

const albums = await photos.albums(); // Record<string, PhotoAlbum>
const favorites = albums['Favorites'];

for await (const asset of all) {      // PhotoAlbum is AsyncIterable<PhotoAsset>
  console.log(asset.filename, asset.size, asset.created, asset.dimensions);
  const original = await asset.download('original'); // Readable | null
  break;
}
```

### Find My iPhone

```ts
const fmip = await auth.findMyiPhone(); // async — device list already refreshed

const device = fmip.get(0);             // by ordered index (number) ...
// const device = fmip.get('iPhone12,1'); // ... or by device id (string)

const loc = await device.location();
const status = await device.status();   // batteryLevel / deviceDisplayName / ...

await device.playSound();               // default subject "Find My iPhone Alert"
await device.displayMessage({ subject: 'Hi', message: 'Call me', sounds: true });
await device.lostDevice({ number: '+15551234567', text: 'Lost — please call.' });
```

### Account

```ts
const devices = await auth.account.devices(); // AccountDevice[]
const family = await auth.account.family();    // FamilyMember[]
const storage = await auth.account.storage();  // AccountStorage

console.log(storage.usage.usedStorageInPercent);
for (const [media, usage] of Object.entries(storage.usagesByMedia)) {
  console.log(usage.label, usage.usageInBytes);
}

const avatar = await family[0].getPhoto();     // Readable
```

### Calendar

GET-only. With no date range, `events()` defaults to the **full current month**.

```ts
const cal = auth.calendar;                     // sync getter

const events = await cal.events();             // CalendarEvent[] | undefined (current month)
const ranged = await cal.events(new Date('2026-06-01'), new Date('2026-06-30'));
const collections = await cal.calendars();     // CalendarCollection[]

console.log(cal.usertz);                        // local IANA timezone
```

`events()` returns `undefined` when the server omits the `Event` key.

### Contacts

```ts
const contacts = await auth.contacts.all();    // Contact[] | undefined
contacts?.forEach((c) => console.log(c.firstName, c.lastName, c.phones));
```

### Reminders

```ts
const rem = await auth.reminders();            // async — refresh() already ran

console.log(Object.keys(rem.lists));           // collection titles
console.log(rem.collections);                  // { [title]: { guid, ctag } }

// post(title, description?, collection?, dueDate?) → boolean (status < 400)
await rem.post('Buy milk', 'Two litres', 'Reminders', new Date());
```

### Ubiquity (legacy files)

Read-only legacy store with integer node ids (root id `0`).

```ts
const files = auth.files;                       // sync getter (UbiquityService)
const root = await files.root();
const names = await root.dir();                 // string[]
const node = await root.get('Document.pages');
const stream = await node.open();               // Readable
```

---

## Command-line tool

After installing, the package exposes the `jsicloud` binary (`dist/cli/main.js`).
During development, run it with `npm run start:cli -- <args>`.

It is a Find My iPhone tool. **Username is always required.** When `--password`
is omitted it is fetched from the system keyring; on first interactive use it can
offer to save a freshly-typed password to the keyring.

```bash
jsicloud --username me@icloud.com --list
```

### Flags

| Flag | Description |
|---|---|
| `--username <username>` | Apple ID to use (**required**). |
| `--password <password>` | Apple ID password; if omitted, fetched from the keyring. |
| `--china-mainland` | Use the China-mainland (`.com.cn`) endpoints. |
| `-n, --non-interactive` | Disable interactive prompts for the whole run. |
| `--delete-from-keyring` | Delete the stored password for this username, then continue to login. |
| `--list` | Short listing for each device. |
| `--llist` | Detailed (full) listing for each device. |
| `--locate` | Refresh location for each device (non-exclusive). |
| `--device <device_id>` | Restrict singular-device actions to this device id. |
| `--sound` | Play a sound (requires `--device`). |
| `--message <message>` | Display a message **with** sound (requires `--device`). |
| `--silentmessage <message>` | Display a message with **no** sound (requires `--device`). |
| `--lostmode` | Enable Lost Mode (requires `--device`). |
| `--lostphone <number>` | Phone number allowed to call in Lost Mode. |
| `--lostpassword <passcode>` | Passcode to force on the device in Lost Mode. |
| `--lostmessage <message>` | Message to show when activating Lost Mode. |
| `--outputfile` | Save each device's data to `<name>.fmip_snapshot.json` in the current directory. |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Failed 2FA / 2SA verification (bad/failed code, or failed code send). |
| `2` | Usage error — missing username, missing password, or invalid arguments. |

> Bad credentials are retried twice; after the **third** consecutive failed login
> the CLI throws `Error('Bad username or password for <user>')` rather than
> exiting with a code.

### Examples

```bash
# Short list of all devices.
jsicloud --username me@icloud.com --list

# Detailed list and locate every device.
jsicloud --username me@icloud.com --llist --locate

# Play a sound on a single device.
jsicloud --username me@icloud.com --device iPhone12,1 --sound

# Display a message (with sound) on a single device.
jsicloud --username me@icloud.com --device iPhone12,1 --message "Call me"

# Enable Lost Mode with a callback number.
jsicloud --username me@icloud.com --device iPhone12,1 \
  --lostmode --lostphone "+15551234567" --lostmessage "Please return this phone"

# Dump every device's raw data to JSON files in the cwd.
jsicloud --username me@icloud.com --outputfile

# China-mainland account, non-interactive (keyring password required).
jsicloud --username me@icloud.com --china-mainland --non-interactive --list

# Forget a stored keyring password (then continue to a fresh login).
jsicloud --username me@icloud.com --delete-from-keyring
```

---

## Configuration

`IcloudModuleOptions` (shared by `forRoot`, `forRootAsync`, and
`IcloudAuthService.create`):

| Field | Type | Required | Default |
|---|---|---|---|
| `accountName` | `string` | **yes** | — (Apple ID / email). |
| `password` | `string` | no | Resolved from the keyring by `accountName`; else interactive prompt. |
| `cookieDir` | `string` | no | `<os.tmpdir()>/jsicloud/<os-username>` (created with mode `0o700`). |
| `chinaMainland` | `boolean` | no | `false`. When `true`, the AUTH/HOME/SETUP endpoints use `.com.cn`; the OAuth widget stays on the global host. |
| `verify` | `boolean \| string` | no | `undefined`. `false` disables TLS verification — **testing only**. |
| `clientId` | `string` | no | The persisted `session_data.client_id`, else a fresh `auth-<uuidv1>`. |

> The auth service also exposes a read-only `withFamily` flag (Find My iPhone
> commands default to operating across family devices). It is derived internally
> and reflected on `auth.withFamily`.

`IcloudModuleAsyncOptions`:

```ts
interface IcloudModuleAsyncOptions {
  useFactory: (...args: unknown[]) =>
    | Promise<IcloudModuleOptions>
    | IcloudModuleOptions;
  inject?: InjectionToken[];  // positional deps for useFactory
  imports?: Array<Type<unknown> | DynamicModule | Promise<DynamicModule>>;
}
```

DI tokens (exported): `ICLOUD_OPTIONS` (the resolved options) and
`ICLOUD_MODULE_OPTIONS`.

---

## Session & secret storage

**Password (keyring).** `SecretsService` wraps `keytar` with the service name
`pyicloud://icloud-password` — the **same** service Python's `pyicloud` uses, so
a password stored by either tool is readable by the other. Key methods:

```ts
await secrets.passwordExistsInKeyring(username);    // boolean
await secrets.getPasswordFromKeyring(username);     // throws if absent
await secrets.storePasswordInKeyring(username, pw);
await secrets.deletePasswordInKeyring(username);
await secrets.getPassword(username, interactive?);  // keyring → prompt fallback
```

`getPassword`'s `interactive` flag defaults to `process.stdout.isTTY` **at call
time**, so the same code prompts on a terminal and stays silent in a service.

**Session & cookies (disk).** A `SessionStore` persists state under `cookieDir`:

- `<name>.session` — JSON `SessionData` (`client_id`, `session_token`,
  `session_id`, `scnt`, `account_country`, `trust_token`). The on-disk layout is
  **byte-compatible** with Python `pyicloud`'s `.session` file.
- `<name>.cookies.json` — the cookie jar.

On the next run, a persisted `session_token` lets `authenticate()` take the
fast-path `validate` route and skip a full OAuth sign-in. A previously
**trusted** session (`auth.isTrustedSession`) avoids re-prompting for a
verification code; call `auth.trustSession()` to establish trust after a
successful 2FA/2SA challenge. Persisting is automatic during the auth flow; the
store also exposes `saveSessionData()`, `saveCookies()`, and `persistAll()`.

---

## Error handling

All errors derive from `PyiCloudException`:

```
PyiCloudException (extends Error)
├── PyiCloudAPIResponseException        (.reason, .code?)
│   └── PyiCloudServiceNotActivatedException
├── PyiCloudFailedLoginException        ← SIBLING of the API exception, not a child
├── PyiCloud2SARequiredException
├── PyiCloudNoStoredPasswordAvailableException
└── PyiCloudNoDevicesException
```

Each subclass sets `this.name` and fixes its prototype, so `instanceof` works
reliably after CommonJS transpilation.

**Catch contract:**

- `PyiCloudFailedLoginException` is a *sibling* of `PyiCloudAPIResponseException`
  — catching one never catches the other.
- A **wrong** 2FA/2SA verification code does **not** throw; the verify methods
  return `false`.
- An in-flight request that hits the two-step wall throws
  `PyiCloud2SARequiredException`.
- A service the account hasn't enabled throws
  `PyiCloudServiceNotActivatedException` (also raised by `getWebserviceUrl()` for
  an absent key, and by `photos().init()` when indexing isn't `FINISHED`).
- Find My iPhone with no devices throws `PyiCloudNoDevicesException`.

```ts
import {
  IcloudAuthService,
  SecretsService,
  PyiCloudFailedLoginException,
  PyiCloud2SARequiredException,
  PyiCloudServiceNotActivatedException,
  PyiCloudNoDevicesException,
} from 'jsicloud';

try {
  const auth = await IcloudAuthService.create(
    { accountName: 'me@icloud.com', password: 'pw' },
    new SecretsService(),
  );

  if (auth.requires2fa && !(await auth.validate2faCode('123456'))) {
    throw new Error('Wrong 2FA code'); // returns false, doesn't throw on its own
  }

  const fmip = await auth.findMyiPhone();
  await fmip.get(0).playSound();
} catch (err) {
  if (err instanceof PyiCloudFailedLoginException) {
    // bad Apple ID / password
  } else if (err instanceof PyiCloud2SARequiredException) {
    // two-step verification needed before this call can proceed
  } else if (err instanceof PyiCloudServiceNotActivatedException) {
    // service not enabled / not indexed for this account
  } else if (err instanceof PyiCloudNoDevicesException) {
    // no Find My iPhone devices
  } else {
    throw err;
  }
}
```

The low-level error normalizer (`extractReasonCode`, `raiseError`) is exported if
you need to map raw iCloud error bodies to these exceptions yourself.

---

## Examples & AI skill

- Runnable examples live in [`/examples`](./examples).
- An AI assistant skill describing this library lives in
  [`/skills/jsicloud`](./skills/jsicloud).

---

## Development

```bash
npm install        # install deps (builds the keytar native module)
npm run build      # tsc → dist/ (uses tsconfig.build.json)
npm test           # Jest suite — 231 tests across 15 suites (runs in-band)
npm run test:cov   # tests with coverage report (./coverage)
npm run test:watch # watch mode
npm run lint       # eslint, zero warnings allowed
npm run lint:fix   # eslint --fix
npm run format     # prettier
npm run start:cli  # run the CLI via ts-node (e.g. `npm run start:cli -- --list`)
```

Deep design references: [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) and
[`ARCHITECTURE_MAP.md`](./ARCHITECTURE_MAP.md).

---

## Porting notes — divergence from pyicloud

This is a faithful port, but several **deliberate fixes** correct latent bugs in
the original Python source. Each is covered by a confirming test:

- **Populated `params` bag (FIX #1).** Python never populated the shared
  query-param bag. After login, `params` is filled with `clientId`, `dsid`, and
  the build numbers (`clientBuildNumber`, `clientMasteringNumber`,
  `ckjsBuildVersion`) from `constants.ts`, so Drive/Ubiquity requests carry the
  identifiers iCloud expects.
- **CN-aware Account storage URL (FIX #2).** The storage URL is built from the
  resolved setup endpoint (`${setupEndpoint}/storageUsageInfo`) instead of a
  hardcoded global host, so `chinaMainland: true` correctly targets `.com.cn`.
- **Calendar default month range (FIX #3).** When `events()` (and `calendars()`)
  is called without a date range, the range is the full current month —
  `startDate` is the 1st and `endDate` is the last day of the **1-indexed**
  month, fixing the original off-by-range behaviour.
- **Explicit Drive `upload` signature (FIX #4).** `upload(fileName, stream, size)`
  takes an explicit byte `size` rather than relying on implicit length detection.
- **Interactive default evaluated at call time (FIX #5).** Keyring prompting keys
  off `process.stdout.isTTY` when the call is made, not at import time.
- **Hardened 2FA detection.** `requires2fa` / `requires2sa` are computed
  defensively from the login payload's HSA flags.

Preserved quirks (intentionally matched to Python for compatibility) include the
OAuth widget staying on the **global** host even in China mode, the Find My
iPhone `fmly: true` family default, the `packDueDate` leading-integer date
encoding, and the Photos change-tag handling.

---

## License

[MIT](./LICENSE)
