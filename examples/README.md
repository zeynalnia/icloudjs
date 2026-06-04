# jsicloud — Examples

A runnable, well-commented tour of the `jsicloud` public API (the barrel at
[`../src/index.ts`](../src/index.ts)). Every API call in these files is real —
they import from `../src` so they typecheck against the actual library types.

> These examples talk to **live Apple iCloud servers** using a **real Apple ID**.
> There is no mock/offline mode. Run them only against an account you own.

## Index

| File | Covers |
|------|--------|
| [`01-quickstart-standalone.ts`](./01-quickstart-standalone.ts) | `IcloudAuthService.create({ accountName, password })`, the full **2FA (HSA2) and 2SA (legacy)** flow — check `requires2fa` / `requires2sa`, prompt for the code, validate, trust — then a simple Drive call. |
| [`02-nestjs-module.ts`](./02-nestjs-module.ts) | A minimal NestJS app using `IcloudModule.forRootAsync` with a `ConfigService`-style factory, and a consumer service that injects `IcloudAuthService`. |
| [`03-drive.ts`](./03-drive.ts) | iCloud Drive: navigate the tree, `dir()`, download a file (stream), upload a file, `mkdir`, `rename`, `delete`. |
| [`04-photos.ts`](./04-photos.ts) | Photos: list albums, pick **All Photos**, async-iterate assets, read `versions`, download the original. |
| [`05-find-my-iphone.ts`](./05-find-my-iphone.ts) | Find My iPhone: list devices, `location()`, `playSound()`, `displayMessage()`, lost mode (note the async `findMyiPhone()` accessor + `init()`). |
| [`06-account.ts`](./06-account.ts) | Account: paired `devices()`, family `members()` + `getPhoto()`, `storage()` usage. |
| [`07-calendar-contacts-reminders.ts`](./07-calendar-contacts-reminders.ts) | Calendar `events(from, to)`, Contacts `all()`, create a Reminder with `post()`. |

## Prerequisites

- **Node.js ≥ 18** (the package declares `engines.node >= 18`).
- Install dependencies from the **package root** (one directory up):

  ```bash
  cd ..            # into the jsicloud package root
  npm install
  ```

- A **real Apple ID** and its password. The account must have iCloud Drive /
  Photos / Find My / etc. enabled for the corresponding example to return data.

### Environment variables

All examples read configuration from the environment:

| Variable | Used by | Notes |
|----------|---------|-------|
| `APPLE_ID` | all | **Required.** Your Apple ID (email). |
| `APPLE_PASSWORD` | all | Optional. If omitted, the password is resolved from the OS keyring (keytar), or prompted for interactively. |
| `DRIVE_FILE` | `03` | Name of a file at the Drive root to download (e.g. `report.pdf`). |
| `FMIP_PLAY_SOUND` | `05` | Set to `1` to actually play a sound on the device. |
| `FMIP_MESSAGE` | `05` | Set to `1` to actually display a message on the device. |
| `FMIP_LOST_NUMBER` | `05` | A callback phone number — set it to actually enable **lost mode** (locks the device). |
| `CREATE_REMINDER` | `07` | Set to `1` to actually create a reminder. |
| `APPLE_CHINA` | `02` | (Commented out by default) set `true` for mainland-China Apple IDs. |

The destructive / device-affecting actions in examples `05` and `07` are guarded
behind these flags, so running the files with only `APPLE_ID` set is safe.

## Running

Use [`ts-node`](https://typestrong.org/ts-node/) (a dev dependency of the
package) so the TypeScript runs directly — no build step needed:

```bash
# from the package root, after `npm install`
APPLE_ID=you@icloud.com APPLE_PASSWORD=secret \
  npx ts-node examples/01-quickstart-standalone.ts
```

Each example is independent; swap the filename to run a different one. They
import from `../src`, so they always reflect the current source.

## The 2FA / 2SA caveat (read this)

Apple almost always requires a **second authentication factor**:

- **2FA (HSA2)** — the modern flow. The client signs in with SRP; Apple does
  **not** auto-deliver a code to API sessions, so you call
  `auth.requires2fa` → `auth.requestTwoFactorCode()` (push + SMS) →
  `auth.validate2faCode(code)`.
- **2SA (HSA1 / legacy)** — the older trusted-device flow:
  `auth.requires2sa` → pick a device from `await auth.trustedDevices` →
  `auth.sendVerificationCode(device)` → `auth.validateVerificationCode(device, code)`.

Key facts that shape these examples:

1. **`IcloudAuthService.create()` only performs the first leg** (email +
   password). When it returns, the session may still be untrusted — check
   `requires2fa` / `requires2sa` and complete the second leg before making other
   calls. Example `01` shows the complete flow; the rest assume a trusted
   session for brevity.

2. **Wrong codes do NOT throw** — `validate2faCode` and
   `validateVerificationCode` return `false` for an incorrect code (a wrong-code
   API error, code `-21669`, is swallowed). Always check the boolean.

3. **Trusting persists across runs.** After a successful validation,
   `auth.trustSession()` asks Apple to remember this client; the cookie/session
   files are written to a durable per-user state dir (Linux
   `~/.local/state/jsicloud`, macOS `~/Library/Application Support/jsicloud`,
   Windows `%LOCALAPPDATA%\jsicloud`; `<os-tmpdir>/jsicloud` fallback when
   headless — override with the `cookieDir` option). Those files are
   **encrypted at rest** by default (AES-256-GCM); the key is taken from
   `encryptionKeyFile` (a base64 32-byte key), else the OS keychain, else a
   generated key stored in the keychain. On the next run a valid trusted session
   is reused silently — so the **NestJS module in example `02` can authenticate
   at bootstrap without an interactive prompt**. The practical recipe for
   servers: run example `01` once interactively to establish trust, then let the
   module reuse it. For **cron/headless**, set `encryptionKeyFile` (the keychain
   is usually unavailable) or `encrypt: false`.

4. **`trustedDevices` is a getter that returns a `Promise`** — write
   `await auth.trustedDevices`, not `auth.trustedDevices()`.

## Sync getters vs. async accessors

A recurring gotcha. Services that need a one-time network `init()` are exposed
as **async methods** (call with `()` and `await`); the rest are **sync getters**:

| Accessor | Kind |
|----------|------|
| `auth.drive`, `auth.account`, `auth.files`, `auth.calendar`, `auth.contacts` | **sync getter** (no `await`) |
| `auth.photos()`, `auth.reminders()`, `auth.findMyiPhone()` | **async method** (`await` — runs `init()` once) |
