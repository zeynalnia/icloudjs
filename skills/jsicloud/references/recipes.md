# jsicloud — Task-Oriented Recipes

Copy-pasteable TypeScript. Every snippet compiles against the real API. All
imports come from `'jsicloud'`. Assume `auth` is an authenticated
`IcloudAuthService` obtained as in the auth recipe below.

---

## 0. Authenticate (standalone) with full 2FA/2SA + trust

```ts
import {
  IcloudAuthService, SecretsService,
  PyiCloudFailedLoginException,
} from 'jsicloud';
import * as readline from 'readline/promises';

async function prompt(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}

export async function login(accountName: string, password?: string): Promise<IcloudAuthService> {
  let auth: IcloudAuthService;
  try {
    auth = await IcloudAuthService.create(
      { accountName, password, cookieDir: './.icloud-session' }, // stable dir → trust persists
      new SecretsService(),
    );
  } catch (e) {
    if (e instanceof PyiCloudFailedLoginException) {
      throw new Error('Invalid Apple ID / password');
    }
    throw e;
  }

  if (auth.requires2fa) {
    await auth.requestTwoFactorCode();   // REQUIRED: deliver the code (push + SMS) — API sessions aren't auto-sent one
    const code = await prompt('Enter the 6-digit 2FA code: ');
    if (!(await auth.validate2faCode(code))) throw new Error('Wrong 2FA code');
    await auth.trustSession();           // persist trust so future runs skip the prompt
  } else if (auth.requires2sa) {
    const devices = await auth.trustedDevices;   // getter → Promise; await the property
    if (devices.length === 0) throw new Error('No trusted devices for 2SA');
    const device = devices[0];
    await auth.sendVerificationCode(device);
    const code = await prompt('Enter the verification code: ');
    if (!(await auth.validateVerificationCode(device, code))) throw new Error('Wrong 2SA code');
    // validateVerificationCode trusts the session on success.
  }

  return auth;
}
```

To resolve the password from the OS keychain instead of passing it, omit
`password` (keytar must be working) or pre-store it:

```ts
const secrets = new SecretsService();
await secrets.storePasswordInKeyring('me@icloud.com', 'pw');   // once
const auth = await IcloudAuthService.create({ accountName: 'me@icloud.com' }, secrets);
```

---

## 1. iCloud Drive (read + write)

```ts
import { Readable } from 'stream';
import { createWriteStream, createReadStream, statSync } from 'fs';

const drive = auth.drive;                       // sync getter

// List root contents
const root  = await drive.root();
const names = await root.dir();                 // string[] | null

// Walk into a folder and download a file
const folder = await root.get('Documents');     // DriveNode (throws if missing)
const file   = await folder.get('report.pdf');
console.log(file.name, file.type, file.size, file.dateModified);
const inStream = await file.open();              // Readable; 0-byte files → empty stream
await new Promise<void>((res, rej) => {
  const out = createWriteStream('./report.pdf');
  inStream.pipe(out); out.on('finish', res); out.on('error', rej);
});

// Create a subfolder
await folder.mkdir('Reports2026');

// Upload a local file (size in bytes is REQUIRED)
const local = './notes.txt';
const size  = statSync(local).size;
await folder.upload('notes.txt', createReadStream(local), size);

// Rename / delete (delete = move to trash)
const node = await folder.get('notes.txt');
await node.rename('notes-renamed.txt');
await node.delete();

// Recurse the tree
async function walk(n: import('jsicloud').DriveNode, depth = 0): Promise<void> {
  console.log('  '.repeat(depth) + n.name);
  if (n.type === 'folder') {
    for (const child of await n.getChildren()) await walk(child, depth + 1);
  }
}
await walk(root);
```

Service-level write ops (when you already hold ids + etags):

```ts
const data = await drive.getNodeData('FOLDER::com.apple.CloudDocs::root');
await drive.createFolders(data.drivewsid, 'NewFolder');
await drive.renameItems(data.drivewsid, data.etag!, 'Renamed');
await drive.moveItemsToTrash(data.drivewsid, data.etag!);
```

---

## 2. Photos

```ts
const photos = await auth.photos();            // async — runs the indexing probe
                                               // throws PyiCloudServiceNotActivatedException if not indexed

// All Photos
const all = await photos.all();
console.log('count:', await all.length());

// Iterate (PhotoAlbum is AsyncIterable<PhotoAsset>)
for await (const asset of all) {
  console.log(asset.filename, asset.size, asset.created, asset.dimensions);
  const stream = await asset.download('original'); // Readable | null
  if (stream) { /* pipe to disk */ }
  break; // remove to process all
}

// Named / smart albums
const albums = await photos.albums();          // Record<string, PhotoAlbum>
console.log(Object.keys(albums));              // includes 'Favorites','Videos','Screenshots',… + user albums
const favs = albums['Favorites'];
for await (const p of favs) { /* … */ break; }

// Versions
for await (const asset of all) {
  for (const [name, v] of Object.entries(asset.versions)) {
    console.log(name, v.width, v.height, v.size, v.type);
  }
  break;
}

// Soft-delete a photo
for await (const asset of all) { await asset.delete(); break; }
```

Smart-album keys: `'All Photos'`, `'Time-lapse'`, `'Videos'`, `'Slo-mo'`,
`'Bursts'`, `'Favorites'`, `'Panoramas'`, `'Screenshots'`, `'Live'`,
`'Recently Deleted'`, `'Hidden'`.

---

## 3. Find My iPhone

```ts
import { PyiCloudNoDevicesException } from 'jsicloud';

const fmip = await auth.findMyiPhone();         // async — loads the device list

console.log(fmip.keys());                       // device ids, insertion order
for (const d of fmip.all) console.log(d.data.name, d.data.deviceDisplayName);

// Pick a device: by index or by id
let phone;
try {
  phone = fmip.get(0);                          // or fmip.get('iPhone12,1')
} catch (e) {
  if (e instanceof PyiCloudNoDevicesException) throw new Error('No such device');
  throw e;
}

// Live location (triggers a whole-list refresh)
console.log(await phone.location());

// Status subset
console.log(await phone.status(['isLocating', 'lostModeCapable']));

// Remote actions
await phone.playSound();                                   // default subject
await phone.displayMessage({ subject: 'Hi', message: 'Call me', sounds: true });
await phone.lostDevice({ number: '+15551234567', text: 'Lost — please call' });

// Manually refresh the whole list
await fmip.refreshClient();
```

---

## 4. Account (devices / family / storage)

```ts
const account = auth.account;                   // sync getter

// Paired devices
for (const d of await account.devices()) {
  console.log(d.name, d.modelDisplayName, d.osVersion, d.serialNumber);
}

// Family members
for (const m of await account.family()) {
  console.log(m.fullName, m.appleId, m.ageClassification, m.hasShareMyLocationEnabled);
  // const avatar = await m.getPhoto();   // Readable
}

// Storage usage
const storage = await account.storage();
console.log(storage.usage.usedStorageInBytes, '/', storage.usage.totalStorageInBytes);
console.log('percent used:', storage.usage.usedStorageInPercent);
console.log('quota over?', storage.usage.quotaOver, 'almost full?', storage.usage.quotaAlmostFull);
for (const [key, m] of Object.entries(storage.usagesByMedia)) {
  console.log(key, m.label, m.usageInBytes);
}
```

---

## 5. Calendar (GET-only)

```ts
const cal = auth.calendar;                      // sync getter

// Events — defaults to the FULL current month; may be undefined
const events = await cal.events();              // CalendarEvent[] | undefined
for (const e of events ?? []) console.log(e['title'], e['startDate']);

// Explicit range
const from = new Date(2026, 0, 1);
const to   = new Date(2026, 0, 31);
const jan  = await cal.events(from, to);

// Collections (reads the SINGULAR `Collection` key)
const collections = await cal.calendars();      // CalendarCollection[]
for (const c of collections) console.log(c['title'], c['guid']);

// One event's detail (needs pguid = calendar guid, guid = event guid)
const detail = await cal.getEventDetail('CALENDAR-GUID', 'EVENT-GUID');

console.log('timezone:', cal.usertz);
```

---

## 6. Contacts (read-only)

```ts
const contacts = await auth.contacts.all();     // Contact[] | undefined
for (const c of contacts ?? []) {
  console.log(c.firstName, c.lastName, c.normalized);
  for (const phone of c.phones ?? []) console.log('  phone:', phone['field']);
  for (const email of c.emailAddresses ?? []) console.log('  email:', email['field']);
}
```

---

## 7. Reminders (read + create)

```ts
const rem = await auth.reminders();             // async — runs startup refresh

// Existing lists
console.log('lists:', Object.keys(rem.lists));  // e.g. ['Reminders','Groceries']
for (const r of rem.lists['Reminders'] ?? []) {
  console.log(r.title, r.desc, r.due);          // due: Date | null
}
console.log('collections:', rem.collections);   // { title: { guid, ctag } }

// Create a reminder (returns true when HTTP status < 400)
const ok = await rem.post(
  'Buy milk',          // title
  'Two litres',        // description (default '')
  'Reminders',         // collection title (must already exist; defaults to 'tasks' pguid)
  new Date(),          // optional due date
);
if (!ok) throw new Error('reminder post failed');

// Refresh after external changes
await rem.refresh();
```

`post` requires collections to be loaded (they are, after `auth.reminders()`),
because it sends a `ClientState.Collections` snapshot built from the cache.

---

## 8. Legacy Ubiquity file store (read-only)

```ts
const files = auth.files;                        // sync getter (UbiquityService)
const root  = await files.root();                // node id 0
console.log(await root.dir());                   // string[]
const child = await root.get('SomeFolder');      // throws if missing
console.log(child.itemId, child.name, child.type, child.size, child.modified);
const stream = await child.open();               // Readable
```

---

## 9. NestJS service that injects iCloud

```ts
import { Injectable } from '@nestjs/common';
import { IcloudAuthService } from 'jsicloud';

@Injectable()
export class BackupService {
  constructor(private readonly icloud: IcloudAuthService) {} // already authenticated

  async listDriveRoot(): Promise<string[] | null> {
    return (await this.icloud.drive.root()).dir();
  }

  async storagePercent(): Promise<number> {
    return (await this.icloud.account.storage()).usage.usedStorageInPercent;
  }
}
```

Wire it up:

```ts
@Module({
  imports: [IcloudModule.forRoot({ accountName: 'me@icloud.com', password: 'pw' })],
  providers: [BackupService],
})
export class AppModule {}
```

> The module authenticates at init. If a 2FA/2SA challenge is pending you must
> still run the verification flow on the injected `IcloudAuthService` (e.g. in an
> `onApplicationBootstrap` hook) before service calls succeed — and for HSA2 call
> `await auth.requestTwoFactorCode()` first to have Apple deliver the code.

---

## 10. China-mainland accounts

```ts
const auth = await IcloudAuthService.create(
  { accountName: 'me@icloud.com.cn', password: 'pw', chinaMainland: true },
  new SecretsService(),
);
// AUTH/HOME/SETUP now use .com.cn hosts. The OAuth widget stays global — correct.
```

---

## 11. Robust error handling

```ts
import {
  PyiCloudFailedLoginException, PyiCloud2SARequiredException,
  PyiCloudServiceNotActivatedException, PyiCloudNoDevicesException,
  PyiCloudNoStoredPasswordAvailableException, PyiCloudAPIResponseException,
} from 'jsicloud';

try {
  const photos = await auth.photos();
  const all = await photos.all();
  for await (const a of all) { await a.download(); break; }
} catch (e) {
  if (e instanceof PyiCloudServiceNotActivatedException) {
    // Photo library still indexing, or service not provisioned — retry later.
  } else if (e instanceof PyiCloud2SARequiredException) {
    // Re-run the 2SA flow and re-trust the session.
  } else if (e instanceof PyiCloudNoDevicesException) {
    // No devices (Find My iPhone) / bad device id.
  } else if (e instanceof PyiCloudAPIResponseException) {
    console.error('iCloud API error', e.reason, e.code);
  } else {
    throw e;
  }
}
```

Reminders: `PyiCloudFailedLoginException` is a **sibling** of
`PyiCloudAPIResponseException` (catching one never catches the other), and wrong
2FA/2SA verification codes return `false` rather than throwing.

---

## 12. Encryption at rest (session & cookie files)

The persisted `.session` and `.cookies.json` files are **encrypted by default**
(AES-256-GCM). The 32-byte key is resolved in priority order: an explicit base64
key file → the OS keychain → auto-generated-and-stored in the keychain. Legacy
plaintext files are migrated transparently (read once as plaintext, re-written
encrypted on the next persist), so upgrading users never have to re-login.

```ts
import { IcloudAuthService, SecretsService } from 'jsicloud';

// Default: encrypt with a key from the keychain (auto-created on first run).
const auth = await IcloudAuthService.create(
  { accountName: 'me@icloud.com', password: 'pw' },
  new SecretsService(),
);
```

The key file holds a **base64-encoded 32-byte key** on a single line
(surrounding whitespace is trimmed). Generate one with
`head -c 32 /dev/urandom | base64 > icloud.key`, then point at it (it overrides
the keychain):

```ts
const auth = await IcloudAuthService.create(
  { accountName: 'me@icloud.com', password: 'pw', encryptionKeyFile: './icloud.key' },
  new SecretsService(),
);
```

Disable encryption (plaintext at rest — **debugging only**):

```ts
const auth = await IcloudAuthService.create(
  { accountName: 'me@icloud.com', password: 'pw', encrypt: false },
  new SecretsService(),
);
```

Reading a file written with a different key (or a corrupted file) throws
`PyiCloudSessionDecryptionException` — pass the correct key or delete the file.

**CLI flags** — `--no-encrypt` stores plaintext (debugging only) and
`-k, --encryption-key-file <path>` supplies a base64-encoded 32-byte key:

```bash
# Headless/cron: the OS keychain is usually unavailable, so use an explicit key
# file (the same key is reused on every run without touching the keychain).
jsicloud --username me@icloud.com --non-interactive \
  --encryption-key-file /etc/jsicloud/icloud.key --list

# Plaintext at rest (debugging only).
jsicloud --username me@icloud.com --no-encrypt --list
```
