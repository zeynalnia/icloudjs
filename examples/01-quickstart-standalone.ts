/**
 * 01 — Quickstart (standalone, no NestJS module)
 * ==============================================
 *
 * The shortest path to an authenticated iCloud session: call the
 * `IcloudAuthService.create()` factory directly. This bypasses the NestJS
 * dependency-injection module entirely (see 02-nestjs-module.ts for the DI
 * variant) — useful for scripts, CLIs, or non-Nest apps.
 *
 * WHY a factory instead of `new IcloudAuthService(...)`?
 *   The constructor is PRIVATE. All network I/O (password resolution, session
 *   load, the OAuth sign-in handshake, params population) happens inside the
 *   async `create()` factory — constructors never do I/O in this library. So
 *   the only way to obtain an instance is `await IcloudAuthService.create(...)`.
 *
 * WHY do we still have to handle 2FA/2SA AFTER create() returns?
 *   `create()` performs the *first* authentication leg (email + password). If
 *   Apple requires a second factor, the returned service is authenticated but
 *   NOT yet trusted — `auth.requires2fa` / `auth.requires2sa` will be true and
 *   most service calls will fail until you validate a code and trust the
 *   session. That second leg needs a human-entered code, so it cannot live
 *   inside `create()`.
 *
 * Run:  APPLE_ID=you@icloud.com APPLE_PASSWORD=secret \
 *         npx ts-node examples/01-quickstart-standalone.ts
 */
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

// Relative import into the package barrel so this file typechecks against the
// REAL exported types (not a published d.ts). In your own project you would
// instead write `from 'jsicloud'`.
import {
  IcloudAuthService,
  SecretsService,
  PyiCloudFailedLoginException,
} from '../src';

/** Tiny stdin prompt helper — reads a single line from the terminal. */
async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const accountName = process.env.APPLE_ID;
  if (!accountName) {
    throw new Error('Set APPLE_ID (and optionally APPLE_PASSWORD) in the env.');
  }

  // `SecretsService` is the keytar wrapper. `create()` needs one so it can
  // resolve the password from the OS keyring when `password` is omitted. Here
  // we construct it directly (it is a plain @Injectable with a no-arg ctor).
  const secrets = new SecretsService();

  // The first authentication leg. If APPLE_PASSWORD is unset, `create()` will
  // ask `secrets` for the password (keyring lookup, else interactive prompt).
  let auth: IcloudAuthService;
  try {
    auth = await IcloudAuthService.create(
      {
        accountName,
        password: process.env.APPLE_PASSWORD, // optional — undefined → keyring
      },
      secrets,
    );
  } catch (err) {
    // A bad email/password throws this SPECIFIC exception. Note it is a SIBLING
    // of the API-response exception, not a subclass — catching one never
    // catches the other.
    if (err instanceof PyiCloudFailedLoginException) {
      console.error('Login failed: bad email/password combination.');
      process.exit(1);
    }
    throw err;
  }

  // -------------------------------------------------------------------------
  // Second factor. Check 2FA (HSA2, the modern 6-digit flow) FIRST, then 2SA
  // (HSA1/legacy trusted-device flow). An account uses one or the other.
  // -------------------------------------------------------------------------
  if (auth.requires2fa) {
    // HSA2: ask Apple to DELIVER the code first. Unlike a browser login, an
    // API/SRP session does not get a code automatically — this triggers the
    // trusted-device push and an SMS fallback.
    await auth.requestTwoFactorCode();

    console.log('Two-factor authentication (2FA) required.');
    const code = await prompt('Enter the 6-digit code: ');

    // Returns `true` when accepted, `false` when the code is WRONG.
    // It does NOT throw on a wrong code — so check the boolean.
    const ok = await auth.validate2faCode(code);
    if (!ok) {
      console.error('Incorrect 2FA code.');
      process.exit(1);
    }

    // `validate2faCode` already trusted the session on success, but calling
    // `trustSession()` explicitly is harmless and makes intent clear: it asks
    // Apple to remember this client so future logins skip the prompt. Returns
    // `false` (never throws) on a caught API failure.
    if (!auth.isTrustedSession) {
      const trusted = await auth.trustSession();
      console.log(trusted ? 'Session trusted.' : 'Could not trust session.');
    }
  } else if (auth.requires2sa) {
    // HSA1 / legacy two-step: choose a trusted device, have Apple send it a
    // code, then validate that code against the SAME device object.
    console.log('Two-step authentication (2SA) required.');

    // NOTE: `trustedDevices` is a GETTER that returns a Promise — `await` the
    // property, do NOT call it like `trustedDevices()`.
    const devices = await auth.trustedDevices;
    if (devices.length === 0) {
      throw new Error('No trusted devices available for 2SA.');
    }

    devices.forEach((d, i) => {
      // The device shape is open-ended; `deviceName`/`phoneNumber` are common.
      console.log(`  [${i}] ${d.deviceName ?? d.phoneNumber ?? JSON.stringify(d)}`);
    });

    const idx = Number(await prompt('Pick a device index: ')) || 0;
    const device = devices[idx];

    // Ask Apple to send the verification code to the chosen device.
    const sent = await auth.sendVerificationCode(device);
    if (!sent) {
      throw new Error('Failed to send verification code.');
    }

    const code = await prompt('Enter the code you received: ');
    // Pass the SAME device object back so its identifiers are echoed. Returns
    // `false` on a wrong code (-21669) rather than throwing.
    const ok = await auth.validateVerificationCode(device, code);
    if (!ok) {
      console.error('Incorrect verification code.');
      process.exit(1);
    }
    console.log('2SA verification succeeded; session trusted.');
  } else {
    // Either no second factor is configured, or a previously trusted session
    // was restored from the on-disk cookie/session files — no prompt needed.
    console.log('Already authenticated (no second factor required).');
  }

  // -------------------------------------------------------------------------
  // A simple, real call to prove the session works. `auth.drive` is a SYNC
  // getter (no init needed); `dir()` lists the root folder's child names.
  // -------------------------------------------------------------------------
  console.log(`\nSigned in as: ${auth.data.dsInfo?.fullName ?? accountName}`);

  const rootNames = await auth.drive.dir();
  console.log('iCloud Drive root contains:', rootNames ?? '(empty)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
