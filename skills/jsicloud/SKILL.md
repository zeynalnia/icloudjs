---
name: jsicloud
description: >-
  Build solutions with jsicloud, the unofficial NestJS/TypeScript client for
  Apple iCloud web services (a port of Python's pyicloud). Use this skill when
  building with jsicloud / the iCloud NestJS client / the pyicloud port — i.e.
  whenever code imports from "jsicloud" or you need to authenticate an Apple ID
  and access iCloud Drive, Photos, Find My iPhone, Account (devices/family/
  storage), Calendar, Contacts, or Reminders from Node. Covers the mandatory
  auth + 2FA/2SA + trust flow, the standalone async-factory vs NestJS-module
  usage modes, per-service recipes, error handling, and gotchas (no network in
  constructors, async accessors, session/cookie persistence, China-mainland).
---

# jsicloud

`jsicloud` is a TypeScript/NestJS port of Python `pyicloud`. It authenticates an
Apple ID and exposes iCloud web services. **Everything is imported from the
package root `'jsicloud'`** (single barrel).

```ts
import {
  IcloudModule, IcloudAuthService, SecretsService,
  PyiCloudFailedLoginException, PyiCloud2SARequiredException,
  PyiCloudServiceNotActivatedException, PyiCloudNoDevicesException,
} from 'jsicloud';
```

## Install

```bash
npm i jsicloud
```

- Node **>= 22** (the package targets `node >=22`).
- Peer/runtime deps it pulls in: `@nestjs/common`, `@nestjs/core`,
  `reflect-metadata`, `rxjs`, `axios`, `tough-cookie`, `keytar`, `uuid`.
- **`keytar` is a NATIVE module** (OS keychain bindings). It needs build tools
  (`python3`, a C++ toolchain) and, on headless Linux, `libsecret`
  (`apt-get install libsecret-1-dev gnome-keyring`). The keychain is read for
  two things: the account `password` (when omitted) and the at-rest
  **session-encryption key** (when `encrypt` is on, the default). If the OS
  keychain is unavailable (typical for **cron/headless**), **pass `password`
  explicitly** AND **set `encryptionKeyFile`** (a base64 key file) — or disable
  encryption with `encrypt: false` — so keytar is never touched.
- If you import the NestJS module, ensure `import 'reflect-metadata';` runs once
  at process start (Nest apps already do this).

## Two usage modes

### Mode A — standalone async factory (no NestJS app needed)

`IcloudAuthService.create(options, secrets)` does ALL the login I/O and returns
an already-authenticated service. You just need a `SecretsService` instance.

```ts
import { IcloudAuthService, SecretsService } from 'jsicloud';

const secrets = new SecretsService();
const auth = await IcloudAuthService.create(
  { accountName: 'me@icloud.com', password: 'app-or-account-pw' },
  secrets,
);
// `auth` is authenticated; check auth.requires2fa / auth.requires2sa next.
```

`SecretsService` is a plain class — `new SecretsService()` is fine outside Nest.

### Mode B — NestJS dynamic module

The module's `IcloudAuthService` provider factory calls `create()` **eagerly at
module init**, so the injected instance is already authenticated.

```ts
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IcloudModule, IcloudAuthService } from 'jsicloud';

@Module({
  imports: [
    IcloudModule.forRoot({ accountName: 'me@icloud.com', password: 'pw' }),
  ],
})
class AppModule {}

const app = await NestFactory.createApplicationContext(AppModule);
const auth = app.get(IcloudAuthService); // already authenticated
```

Async options (e.g. from `ConfigService`):

```ts
IcloudModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (cfg: ConfigService) => ({ accountName: cfg.get('APPLE_ID') }),
});
```

`IcloudModule` exports `IcloudAuthService` and `SecretsService`. DI tokens
`ICLOUD_OPTIONS` and `ICLOUD_MODULE_OPTIONS` are exported symbols.

### `IcloudModuleOptions`

| Field | Type | Required | Meaning / default |
|---|---|---|---|
| `accountName` | `string` | **yes** | Apple ID / email |
| `password` | `string` | no | If omitted, resolved from the keyring by `accountName` (throws if absent and non-interactive) |
| `cookieDir` | `string` | no | Session/cookie dir. Default = per-user state dir (mode `0o700`, token files `0o600`): Linux `$XDG_STATE_HOME/jsicloud` (else `~/.local/state/jsicloud`), macOS `~/Library/Application Support/jsicloud`, Windows `%LOCALAPPDATA%\jsicloud`; `<os.tmpdir()>/jsicloud` fallback in headless envs |
| `chinaMainland` | `boolean` | no | `false`. When `true`, AUTH/HOME/SETUP hosts switch to `.com.cn` (OAuth widget stays global) |
| `verify` | `boolean \| string` | no | `false` disables TLS verification (testing only); a string is a path to a CA-bundle file |
| `clientId` | `string` | no | Persisted client id, else a fresh `auth-<uuidv1>` |
| `withFamily` | `boolean` | no | `true`. Include family-shared devices in Find My iPhone refreshes |
| `userAgent` | `string` | no | Overrides the default browser-like UA. Apple may `503` non-browser User-Agents |
| `encrypt` | `boolean` | no | `true`. Encrypt the persisted session + cookie files at rest (AES-256-GCM). `false` = plaintext (debugging only) |
| `encryptionKeyFile` | `string` | no | Path to a file holding a base64-encoded 32-byte key; overrides the keychain. When neither this nor a stored key is present, a key is auto-created in the OS keychain |

## MANDATORY auth / 2FA / 2SA / trust flow

`create()` (and the Nest factory) authenticate eagerly. **After construction you
MUST check whether a challenge is pending** before calling any service — an
untrusted session will fail downstream calls. The verify methods **return
`false` for a wrong code (they do NOT throw)**.

```ts
import { IcloudAuthService, SecretsService } from 'jsicloud';

const auth = await IcloudAuthService.create(
  { accountName: 'me@icloud.com', password: 'pw' },
  new SecretsService(),
);

if (auth.requires2fa) {
  // HSA2 (two-factor). FIRST ask Apple to DELIVER a code — an API/SRP session
  // is NOT sent one automatically (unlike a browser). This pushes the code to
  // trusted devices and sends an SMS fallback. Skipping it = user gets nothing.
  await auth.requestTwoFactorCode();
  const code = await promptUser('6-digit 2FA code: ');
  const ok = await auth.validate2faCode(code);   // true = accepted
  if (!ok) throw new Error('Wrong 2FA code');
  await auth.trustSession();                      // trust browser → skip prompt next run
} else if (auth.requires2sa) {
  // HSA1 / legacy (two-step): pick a device, send a code, validate it.
  const devices = await auth.trustedDevices;      // NOTE: a getter returning a Promise — await the property
  const device = devices[0];
  await auth.sendVerificationCode(device);
  const code = await promptUser('verification code: ');
  const ok = await auth.validateVerificationCode(device, code);
  if (!ok) throw new Error('Wrong 2SA code');
  // validateVerificationCode already trusts the session on success.
}

// Now safe to use services.
```

Key facts:
- **HSA2 codes are not auto-delivered.** Apple does not push a code for API
  (non-browser) sessions after the SRP sign-in, so you **MUST call
  `await auth.requestTwoFactorCode()`** (trusted-device push + SMS fallback)
  before prompting for the 2FA code. It is a no-op when 2FA isn't required.
- `auth.requires2fa` / `auth.requires2sa` / `auth.isTrustedSession` are **sync
  getters** (no `await`).
- `auth.trustedDevices` is a **getter that RETURNS a Promise** — write
  `await auth.trustedDevices` (no `()`).
- `validate2faCode(code)`, `validateVerificationCode(device, code)`,
  `sendVerificationCode(device)`, `trustSession()` are all `async` and return
  `boolean`. Wrong code → `false`, not an exception (Apple error `-21669`).
- After `validate2faCode`, call `trustSession()` to persist trust so the next
  process start skips the prompt (cookies + trust token are written to
  `cookieDir`). `validateVerificationCode` trusts the session itself.
- An in-flight request that hits the 2SA wall throws
  `PyiCloud2SARequiredException` — see Error handling.

## Service accessors — which are sync, which are async

The auth service is your entry point to every service. **Some accessors are sync
getters; three are async methods that run a one-time network `init()`.** Do not
confuse them.

| Accessor | Call as | Returns |
|---|---|---|
| `auth.drive` | getter | `DriveService` |
| `auth.files` | getter | `UbiquityService` (legacy, read-only) |
| `auth.account` | getter | `AccountService` |
| `auth.calendar` | getter | `CalendarService` |
| `auth.contacts` | getter | `ContactsService` |
| `auth.photos()` | `await` method | `PhotosService` (runs indexing probe) |
| `auth.reminders()` | `await` method | `RemindersService` (runs startup refresh) |
| `auth.findMyiPhone()` | `await` method | `FindMyiPhoneService` (loads device list) |

```ts
const drive  = auth.drive;                // sync getter
const photos = await auth.photos();       // async — init() already done
const fmip   = await auth.findMyiPhone(); // async — devices already loaded
```

All accessors are cached: repeated calls return the same instance.

## Quick recipes (one-liners)

```ts
// Drive: list root, download a file, upload
import { Readable } from 'stream';
const root  = await auth.drive.root();
const names = await root.dir();                       // string[] | null
const file  = await root.get('report.pdf');
const stream = await file.open();                     // Readable
await root.upload('a.txt', Readable.from(['hi']), 2); // (name, stream, byteSize)

// Photos: count + iterate + download
const all = await (await auth.photos()).all();        // "All Photos" album
console.log(await all.length());
for await (const asset of all) {                      // PhotoAlbum is AsyncIterable
  const s = await asset.download('original');         // Readable | null
  break;
}

// Find My iPhone
const fmip  = await auth.findMyiPhone();
const phone = fmip.get(0);                             // index OR fmip.get('iPhone12,1')
await phone.location();                                // single-shot: may be the stale (isOld) fix
await phone.locate();                                  // polls refreshClient until a FRESH fix lands
await phone.playSound();

// Account
const storage = await auth.account.storage();
console.log(storage.usage.usedStorageInPercent);

// Calendar (GET-only), Contacts (read-only), Reminders
const events   = await auth.calendar.events();        // CalendarEvent[] | undefined; defaults to full current month
const contacts = await auth.contacts.all();           // Contact[] | undefined
const rem = await auth.reminders();
await rem.post('Buy milk', 'Two litres', 'Reminders', new Date());
```

Full, copy-pasteable per-service recipes (every method, with exact field
shapes): see [references/recipes.md](references/recipes.md).

## Error handling

Catch these (all extend `PyiCloudException`, exported from the barrel):

| Exception | When | What to do |
|---|---|---|
| `PyiCloudFailedLoginException` | Bad email/password during `create()`/`authenticate()` | Fix credentials. **Sibling** of the API exception — catching one never catches the other. |
| `PyiCloud2SARequiredException` | An in-flight request hit the 2SA wall (missing webauth cookie) | Run the 2SA flow / re-trust the session. |
| `PyiCloudServiceNotActivatedException` | Webservice not provisioned (`getWebserviceUrl` miss) **or** Photos library not finished indexing | The service/library isn't ready; retry later or skip it. (Subclass of `PyiCloudAPIResponseException`.) |
| `PyiCloudNoDevicesException` | Find My iPhone has no devices, or `fmip.get(...)` missed | Account has no devices / bad id. |
| `PyiCloudNoStoredPasswordAvailableException` | No `password` given and keyring has no entry (non-interactive) | Pass `password` or store one in the keyring. |
| `PyiCloudSessionDecryptionException` | A persisted session/cookie file could not be decrypted (wrong key or corrupted) | Provide the correct `encryptionKeyFile`, or delete the `cookieDir` files to start fresh. |
| `PyiCloudAPIResponseException` | Generic iCloud API error | Has `.reason: string` and `.code?: string \| number`. |

```ts
import { PyiCloudFailedLoginException, PyiCloudServiceNotActivatedException } from 'jsicloud';
try {
  const auth = await IcloudAuthService.create(opts, new SecretsService());
} catch (e) {
  if (e instanceof PyiCloudFailedLoginException) { /* wrong credentials */ }
  else throw e;
}
```

**Wrong 2FA/2SA codes do NOT throw — they return `false`.** Check the boolean.

## Gotchas (read before building)

- **No network in constructors.** Never `new IcloudAuthService(...)` (the
  constructor is private). Always use `IcloudAuthService.create()` or the Nest
  module. Service classes also do no I/O in their constructors — the three async
  accessors (`photos()`, `reminders()`, `findMyiPhone()`) run `init()` for you.
- **Async vs sync accessors:** `drive`, `files`, `account`, `calendar`,
  `contacts` are getters; `photos()`, `reminders()`, `findMyiPhone()` are
  `await`ed methods. `auth.trustedDevices` is a getter that returns a Promise.
- **Session persistence:** cookies + session/trust tokens are written to
  `cookieDir` (default = a durable per-user state dir — Linux
  `~/.local/state/jsicloud`, macOS `~/Library/Application Support/jsicloud`,
  Windows `%LOCALAPPDATA%\jsicloud`; `<tmpdir>/jsicloud` fallback when headless).
  This is durable on purpose so trust survives restarts and Apple stops emailing
  codes; the `clientId` is persisted there too. Override `cookieDir` to pin the
  location.
- **Encryption at rest (default ON):** the `.session` and `.cookies.json` files
  are encrypted with AES-256-GCM (`encrypt: true`). The key comes from
  `encryptionKeyFile` (base64 32-byte key), else the OS keychain, else a freshly
  generated key stored in the keychain. Existing plaintext files are migrated
  transparently (no re-login). For cron/headless, use `encryptionKeyFile` since
  the keychain is usually unavailable; `encrypt: false` keeps plaintext for
  debugging. A wrong key throws `PyiCloudSessionDecryptionException`.
- **China mainland:** set `chinaMainland: true` to use `.com.cn` AUTH/HOME/SETUP
  hosts. The OAuth widget/redirect stays global — that is correct, do not change.
- **`verify: false`** disables TLS verification — testing only, never production.
  A string `verify` is a CA-bundle file path.
- **Auth is SRP-based.** Sign-in is Apple's modern SRP handshake (handled
  internally; the password never leaves the process). If sign-in fails with
  `503 Service Temporarily Unavailable`, Apple is throttling/blocking the request
  (often after rapid retries) — back off and retry; a browser-like `User-Agent`
  is already sent (override via `userAgent`). Remember `requestTwoFactorCode()`
  for HSA2 (codes are not auto-delivered).
- **Streams everywhere:** downloads/uploads use Node `Readable` streams, not
  Buffers. `DriveService.sendFile`/`upload` need an explicit byte `size`.
- **Calendar/Contacts/Ubiquity are read-only** (Calendar & Contacts are
  GET-only; Ubiquity has no create/rename/delete). Reminders supports `post`.
  Drive and Photos support writes/deletes.
- **Server response casing is preserved verbatim** (e.g. Calendar uses
  PascalCase `Event`/`Collection`; Reminders `Collections`/`Reminders`). Methods
  may return `undefined` when the server omits a key (`events()`,
  `contacts.all()`).

## Full API cheat-sheet (compact)

`IcloudAuthService`
- `static create(options, secrets, sessionKey?): Promise<IcloudAuthService>` (optional `sessionKey: SessionKeyService` defaults to a real instance)
- `authenticate(opts?): Promise<void>` · `getWebserviceUrl(key): string`
- getters: `requires2fa` · `requires2sa` · `isTrustedSession` · `withFamily` · `user` · `data` · `params`
- `trustedDevices: Promise<...[]>` (getter→Promise)
- `requestTwoFactorCode(): Promise<void>` (HSA2 push + SMS — call before `validate2faCode`)
- `sendVerificationCode(device)` · `validateVerificationCode(device, code)` · `validate2faCode(code)` · `trustSession()` → `Promise<boolean>`
- service accessors: `drive` `files` `account` `calendar` `contacts` (getters); `photos()` `reminders()` `findMyiPhone()` (async)

`DriveService` / `DriveNode` — `root()`, `dir()`, `get(name)`, node `open()`,
`upload(name,stream,size)`, `mkdir(name)`, `rename(name)`, `delete()`,
`getChildren()`; node getters `name`/`type`/`size`/`dateChanged`/`dateModified`/`dateLastOpen`.

`PhotosService` — `await auth.photos()`; `all()`, `albums()`. `PhotoAlbum` is
`AsyncIterable<PhotoAsset>`; `length()`, `title`. `PhotoAsset` — `id`,
`filename`, `size`, `created`/`assetDate`/`addedDate`, `dimensions`, `versions`,
`download(version?)`, `delete()`.

`FindMyiPhoneService` — `await auth.findMyiPhone()`; `get(idOrIndex)`, `keys()`,
`values()`, `all`, `refreshClient()`. `AppleDevice` — `location()` (single-shot,
may be the stale `isOld` fix), `locate({attempts?,intervalMs?})` (polls until a
FRESH fix), `status(additional?)`, `playSound(subject?)`, `displayMessage(opts?)`,
`lostDevice(opts)`, `data`.

`SessionKeyService` (at-rest encryption key mgmt) — `generateKey()` → `Buffer`,
`getKeyFromKeychain(account)`, `storeKeyInKeychain(account, key)`,
`keyExistsInKeychain(account)`, `readKeyFile(path)`, `resolveKey({accountName, encrypt, encryptionKeyFile?})`.
`SessionCipher` — `new SessionCipher(key32)`; `encrypt(str)` → `Buffer`, `decrypt(buf)` → `string`.

`AccountService` — `devices()`, `family()`, `storage()`.
`CalendarService` — `events(from?,to?)`, `getEventDetail(pguid,guid)`, `calendars()`, `usertz`.
`ContactsService` — `all()`, `refreshClient()`.
`RemindersService` — `await auth.reminders()`; `lists`, `collections`, `refresh()`, `post(title, description?, collection?, dueDate?)`.

Exhaustive signatures, return types, option fields, and value-object getters:
see [references/api-reference.md](references/api-reference.md).
