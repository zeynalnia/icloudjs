/**
 * fmip-cli.ts — testable core of the "Find My iPhone" command-line tool
 * (TypeScript port of `pyicloud/cmdline.py:174-366`, plan §4.10).
 *
 * The heavy lifting (argument parsing, the stateful 3-strike login loop, the
 * per-device dispatch loop with the id-match filter) lives here in
 * {@link runCli} so it can be unit-tested with injected dependencies
 * ({@link CliDeps}) — no real network, no real keyring, no real `process.exit`.
 *
 * `src/cli/main.ts` is the thin `#!/usr/bin/env node` wrapper that wires the
 * real dependencies (a {@link IcloudAuthService} factory, a {@link SecretsService},
 * `readline/promises` prompts, `process.exit`, `console.log`) and calls
 * {@link runCli}.
 *
 * Exit-code contract (part of the spec — DO NOT change):
 *  - `2` — usage error (missing username or password);
 *  - `1` — failed 2FA / 2SA verification;
 *  - `0` — success;
 *  - bad credentials → a thrown `Error('Bad username or password for <user>')`
 *    after the THIRD consecutive failure (the loop retries twice before that).
 *
 * Divergences from the Python source (per plan §0):
 *  - `--outputfile` writes `JSON.stringify(dev.content)` to
 *    `<name>.fmip_snapshot.json` instead of pickling to `<name>.fmip_snapshot`
 *    (pickle is non-portable and an arbitrary-code-execution risk).
 *
 * Preserved exactly: the `.trim()` calls on username / password / device-id /
 * lost-* values, the seven `--list` fields and their order, and the
 * `DEVICE_ERROR` requirement on `--sound`/`--message`/`--silentmessage`/
 * `--lostmode`.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { Command } from 'commander';

import { PyiCloudFailedLoginException } from '../exceptions/icloud.exceptions';
import { SecretsService } from '../secrets/secrets.service';
import { SessionKeyService } from '../secrets/session-key.service';
import { AppleDevice } from '../services/findmyiphone.service';

/**
 * The standard "use --device" hint appended to every singular-device action
 * error. Mirrors `cmdline.DEVICE_ERROR` verbatim.
 */
export const DEVICE_ERROR =
  'Please use the --device switch to indicate which device to use.';

/**
 * Render a Find My iPhone `location` object as a readable one-liner (the raw
 * value is an object, so naive string interpolation prints `[object Object]`).
 * Returns `unknown` when no fix is available.
 */
export function formatLocation(location: unknown): string {
  if (!location || typeof location !== 'object') {
    return 'unknown';
  }
  const loc = location as Record<string, unknown>;
  if (loc.latitude == null || loc.longitude == null) {
    return 'unknown';
  }
  let out = `${loc.latitude}, ${loc.longitude}`;
  if (loc.horizontalAccuracy != null) {
    out += ` (±${loc.horizontalAccuracy}m)`;
  }
  if (loc.timeStamp != null) {
    const when = new Date(Number(loc.timeStamp));
    if (!Number.isNaN(when.getTime())) {
      out += ` @ ${when.toISOString()}`;
    }
  }
  if (loc.isOld) {
    out += ' [stale]';
  }
  return out;
}

/**
 * Build a Google Maps URL for a Find My iPhone `location` object, or `null`
 * when there is no usable fix.
 */
export function mapsUrl(location: unknown): string | null {
  if (!location || typeof location !== 'object') {
    return null;
  }
  const loc = location as Record<string, unknown>;
  if (loc.latitude == null || loc.longitude == null) {
    return null;
  }
  return `https://www.google.com/maps/search/?api=1&query=${loc.latitude},${loc.longitude}`;
}

/**
 * Render an arbitrary device-content value for the long listing. Objects and
 * arrays are JSON-encoded (so they don't collapse to `[object Object]`);
 * primitives (and null/undefined) keep their plain string form.
 */
export function formatValue(value: unknown): string {
  if (value !== null && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * The slice of an authenticated iCloud session that the CLI actually drives.
 *
 * Structurally compatible with {@link IcloudAuthService}: `main.ts` passes the
 * real service, while `cli.spec.ts` passes a lightweight fake. Only the members
 * used by {@link runCli} are listed.
 */
export interface CliApi {
  /** True when HSA2 two-factor verification is still required. */
  readonly requires2fa: boolean;
  /** Ask Apple to deliver an HSA2 code (trusted-device push + SMS fallback). */
  requestTwoFactorCode(): Promise<void>;
  /** True when legacy two-step (HSA1) verification is still required. */
  readonly requires2sa: boolean;
  /** Devices trusted for two-step authentication (`{SETUP}/listDevices`). */
  readonly trustedDevices: Promise<Array<Record<string, unknown>>>;
  /** Verify a 2FA security code; `false` ⇒ wrong code. */
  validate2faCode(code: string): Promise<boolean>;
  /** Send a 2SA verification code to `device`; `false` ⇒ send failed. */
  sendVerificationCode(device: Record<string, unknown>): Promise<boolean>;
  /** Verify a 2SA verification code for `device`; `false` ⇒ wrong code. */
  validateVerificationCode(
    device: Record<string, unknown>,
    code: string,
  ): Promise<boolean>;
  /** Resolve the Find My iPhone manager (runs the device-list refresh once). */
  findMyiPhone(): Promise<{ all: AppleDevice[] }>;
}

/**
 * Injectable dependencies for {@link runCli}. `main.ts` supplies the real
 * implementations; tests supply fakes/spies.
 */
export interface CliDeps {
  /** Build an authenticated session (the {@link IcloudAuthService} factory). */
  createService: (
    username: string,
    password: string,
    china: boolean,
    encrypt: boolean,
    encryptionKeyFile: string,
  ) => Promise<CliApi>;
  /** Keyring wrapper (port of `utils` keyring helpers). */
  secrets: SecretsService;
  /** Session-encryption key manager (keychain bootstrap for at-rest encryption). */
  sessionKey: SessionKeyService;
  /** Read a line from the user (password / 2FA code / device index prompt). */
  stdin: (question: string) => Promise<string>;
  /** Yes/no confirmation prompt (e.g. "Save password in keyring?"). */
  confirm: (question: string) => Promise<boolean>;
  /** Terminate the process with `code` (default `process.exit`; injectable). */
  exit: (code: number) => never;
  /** stdout writer. */
  log: (line: string) => void;
  /** stderr writer. */
  errlog: (line: string) => void;
  /**
   * Whether interactive prompts are allowed. Defaults to `process.stdout.isTTY`.
   * `-n`/`--non-interactive` forces this off for the whole run.
   */
  interactive?: boolean;
  /** File writer for `--outputfile` (injectable; default `fs.writeFile`). */
  writeFile?: (path: string, contents: string) => Promise<void>;
}

/** Parsed/normalised command-line options. */
interface CliOptions {
  username: string;
  password: string;
  chinaMainland: boolean;
  interactive: boolean;
  deleteFromKeyring: boolean;
  list: boolean;
  longlist: boolean;
  locate: boolean;
  deviceId: string;
  sound: boolean;
  message: string;
  silentmessage: string;
  lostmode: boolean;
  lostPhone: string;
  lostPassword: string;
  lostMessage: string;
  outputToFile: boolean;
  json: boolean;
  encrypt: boolean;
  encryptionKeyFile: string;
}

/**
 * Build the commander program. Defined here (not in `main.ts`) so the parsing
 * is exercised by `cli.spec.ts`. `exitOverride` turns commander's own
 * `process.exit` into a thrown {@link UsageExit} the loop converts to exit code
 * `2`, matching argparse's `parser.error(...)` semantics.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name('jsicloud')
    .description('Find My iPhone CommandLine Tool')
    .helpOption(false)
    .allowExcessArguments(true)
    .option('-u, --username <username>', 'Apple ID to Use', '')
    .option(
      '-p, --password <password>',
      'Apple ID Password to Use; if unspecified, password will be fetched from the system keyring.',
      '',
    )
    .option(
      '-c, --china-mainland',
      'If the country/region setting of the Apple ID is China mainland',
      false,
    )
    .option('-n, --non-interactive', 'Disable interactive prompts.', false)
    .option(
      '-D, --delete-from-keyring',
      'Delete stored password in system keyring for this username.',
      false,
    )
    .option(
      '-l, --list',
      'Short Listings for Device(s) associated with account',
      false,
    )
    .option(
      '-L, --llist',
      'Detailed Listings for Device(s) associated with account',
      false,
    )
    .option(
      '-o, --locate',
      'Retrieve Location for the iDevice (non-exclusive).',
      false,
    )
    .option('-d, --device <device_id>', 'Only effect this device', '')
    .option('-s, --sound', 'Play a sound on the device', false)
    .option(
      '-m, --message <message>',
      'Optional Text Message to display with a sound',
      '',
    )
    .option(
      '-S, --silentmessage <message>',
      'Optional Text Message to display with no sounds',
      '',
    )
    .option('-M, --lostmode', 'Enable Lost mode for the device', false)
    .option(
      '-P, --lostphone <number>',
      'Phone Number allowed to call when lost mode is enabled',
      '',
    )
    .option(
      '-W, --lostpassword <passcode>',
      'Forcibly active this passcode on the idevice',
      '',
    )
    .option(
      '-G, --lostmessage <message>',
      'Forcibly display this message when activating lost mode.',
      '',
    )
    .option(
      '-O, --outputfile',
      'Save device data to a file in the current directory.',
      false,
    )
    .option(
      '-j, --json',
      'Output machine-readable JSON instead of plain text.',
      false,
    )
    .option(
      '--no-encrypt',
      'Store session & cookies as plaintext (debugging only).',
    )
    .option(
      '-k, --encryption-key-file <path>',
      'Path to a base64-encoded 32-byte session-encryption key.',
      '',
    );
  return program;
}

/**
 * Thrown when commander rejects the arguments (unknown option, missing value,
 * etc.). {@link runCli} converts it to exit code `2`, mirroring argparse's
 * `parser.error(...) → SystemExit(2)`.
 */
class UsageExit extends Error {}

/** Normalise commander's parsed options into a typed {@link CliOptions}. */
function parseArgs(argv: string[]): CliOptions {
  const program = buildProgram();
  program.exitOverride((err) => {
    throw new UsageExit(err.message);
  });
  program.parse(argv, { from: 'user' });
  const opts = program.opts();
  return {
    username: opts.username ?? '',
    password: opts.password ?? '',
    chinaMainland: !!opts.chinaMainland,
    // commander stores `--non-interactive` as `nonInteractive`.
    interactive: !opts.nonInteractive,
    deleteFromKeyring: !!opts.deleteFromKeyring,
    list: !!opts.list,
    longlist: !!opts.llist,
    locate: !!opts.locate,
    deviceId: opts.device ?? '',
    sound: !!opts.sound,
    message: opts.message ?? '',
    silentmessage: opts.silentmessage ?? '',
    lostmode: !!opts.lostmode,
    lostPhone: opts.lostphone ?? '',
    lostPassword: opts.lostpassword ?? '',
    lostMessage: opts.lostmessage ?? '',
    outputToFile: !!opts.outputfile,
    json: !!opts.json,
    encrypt: opts.encrypt !== false,
    encryptionKeyFile: opts.encryptionKeyFile ?? '',
  };
}

/**
 * Run the Find My iPhone CLI.
 *
 * @param argv The user arguments (i.e. `process.argv.slice(2)`).
 * @param deps Injected dependencies (network/keyring/prompts/exit/log).
 * @returns Resolves after {@link CliDeps.exit} has been invoked (the caller's
 *          `exit` is expected to be terminal; the default `process.exit` never
 *          returns).
 */
export async function runCli(argv: string[], deps: CliDeps): Promise<void> {
  const writeFile = deps.writeFile ?? ((p, c) => fs.writeFile(p, c));

  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageExit) {
      deps.errlog(err.message);
      return void deps.exit(2);
    }
    throw err;
  }

  // The whole run is interactive unless `-n`/`--non-interactive` (or the deps
  // override) says otherwise. Defaults to the current TTY state.
  const interactive =
    options.interactive && (deps.interactive ?? !!process.stdout.isTTY);

  let username = options.username;
  let password = options.password;
  const china = options.chinaMainland;

  // `--username … --delete-from-keyring` removes the stored password up-front
  // and then FALLS THROUGH into the login loop (it does not return).
  if (username && options.deleteFromKeyring) {
    await deps.secrets.deletePasswordInKeyring(username);
  }

  let api: CliApi | undefined;
  let failureCount = 0;

  // ----------------------------------------------------------------------
  // Stateful login loop (port of cmdline.py:184-273).
  // ----------------------------------------------------------------------
  for (;;) {
    // Username is required (it determines which keyring password to use).
    // When it is missing we prompt for it interactively; only a non-interactive
    // run (or an empty answer) falls through to the usage error.
    if (!username) {
      if (interactive) {
        username = (await deps.stdin('iCloud username (Apple ID): ')).trim();
      }
      if (!username) {
        deps.errlog('No username supplied');
        return void deps.exit(2);
      }
    }

    if (!password) {
      try {
        password = await deps.secrets.getPassword(username, interactive);
      } catch {
        // Non-interactive + no stored password → fall through to the usage
        // error below (argparse `parser.error("No password supplied")`).
        password = '';
      }
    }

    if (!password) {
      deps.errlog('No password supplied');
      return void deps.exit(2);
    }

    // Bootstrap the session-encryption key BEFORE building the session. When
    // encryption is on and no explicit key file is given, the key lives in the
    // OS keychain; in an interactive run we ask before silently creating one so
    // the user knows a keychain entry is about to appear. A non-interactive run
    // falls through to create()/resolveKey, which auto-creates the key silently
    // (the library default). Keyed by the SAME trimmed username passed below.
    const trimmedUsername = username.trim();
    if (options.encrypt && !options.encryptionKeyFile) {
      const hasKey =
        await deps.sessionKey.keyExistsInKeychain(trimmedUsername);
      if (!hasKey && interactive) {
        if (
          await deps.confirm(
            'No session-encryption key found for ' +
              trimmedUsername +
              '. Create one and store it in your keychain?',
          )
        ) {
          await deps.sessionKey.storeKeyInKeychain(
            trimmedUsername,
            deps.sessionKey.generateKey(),
          );
        } else {
          deps.errlog(
            'No encryption key; re-run with --no-encrypt for plaintext or --encryption-key-file <path>.',
          );
          return void deps.exit(2);
        }
      }
    }

    try {
      api = await deps.createService(
        trimmedUsername,
        password.trim(),
        china,
        options.encrypt,
        options.encryptionKeyFile,
      );

      // Offer to persist a freshly-typed password.
      if (
        !(await deps.secrets.passwordExistsInKeyring(username)) &&
        interactive &&
        (await deps.confirm('Save password in keyring?'))
      ) {
        await deps.secrets.storePasswordInKeyring(username, password);
      }

      if (api.requires2fa) {
        // Apple does NOT auto-deliver a code for API (non-browser) SRP sessions;
        // explicitly trigger the trusted-device push + SMS before prompting.
        await api.requestTwoFactorCode();
        deps.log('\nTwo-step authentication required. \nPlease enter validation code');
        const code = await deps.stdin('(string) --> ');
        if (!(await api.validate2faCode(code))) {
          deps.log('Failed to verify verification code');
          return void deps.exit(1);
        }
        deps.log('');
      } else if (api.requires2sa) {
        deps.log('\nTwo-step authentication required. \nYour trusted devices are:');

        const devices = await api.trustedDevices;
        devices.forEach((device, i) => {
          const label =
            (device.deviceName as string | undefined) ??
            `SMS to ${device.phoneNumber as string | undefined}`;
          deps.log(`    ${i}: ${label}`);
        });

        deps.log('\nWhich device would you like to use?');
        const index = parseInt(await deps.stdin('(number) --> '), 10);
        const device = devices[index];
        if (!(await api.sendVerificationCode(device))) {
          deps.log('Failed to send verification code');
          return void deps.exit(1);
        }

        deps.log('\nPlease enter validation code');
        const code = await deps.stdin('(string) --> ');
        if (!(await api.validateVerificationCode(device, code))) {
          deps.log('Failed to verify verification code');
          return void deps.exit(1);
        }
        deps.log('');
      }
      break;
    } catch (err) {
      if (!(err instanceof PyiCloudFailedLoginException)) {
        throw err;
      }

      // We just used a stored password and it did not work — delete it so the
      // next attempt prompts afresh.
      if (await deps.secrets.passwordExistsInKeyring(username)) {
        await deps.secrets.deletePasswordInKeyring(username);
      }

      const message = `Bad username or password for ${username}`;
      // The exception message carries Apple's actual reason/code when the
      // failure wrapped an API error. Surface it so a non-credential rejection
      // (throttling, account state, 2FA quirks) is diagnosable rather than
      // looking like a simple wrong password.
      const detail = err.message && err.message !== message ? err.message : '';
      password = '';
      failureCount += 1;
      if (failureCount >= 3) {
        throw new Error(detail ? `${message} (${detail})` : message);
      }
      deps.errlog(message);
      if (detail) {
        deps.errlog(`  ↳ ${detail}`);
      }
    }
  }

  // ----------------------------------------------------------------------
  // Dispatch — per-device loop with the id-match filter
  // (port of cmdline.py:274-366). EVERY device is iterated; an action runs
  // only when there is no `--device` filter OR the (trimmed, lower-cased) id
  // matches. There is no single-device lookup.
  // ----------------------------------------------------------------------
  const manager = await api!.findMyiPhone();
  // In `--json` mode every processed device contributes one entry here; the
  // whole array is emitted with a single `JSON.stringify` AFTER the loop so the
  // output is one valid JSON document. In text mode this stays empty/unused.
  const results: unknown[] = [];
  for (const dev of manager.all) {
    const id = String(dev.content.id);
    if (
      options.deviceId &&
      options.deviceId.trim().toLowerCase() !== id.trim().toLowerCase()
    ) {
      continue;
    }

    // The located object (the fake resolves this to `content.location`). Capture
    // it once. Use `locate()` (not `location()`) so we POLL for a fresh fix: a
    // single refresh only asks Apple to locate the device and returns the stale
    // `isOld` position, so `location()` alone would print the old fix until the
    // next run. Fall back to `content.location` if it resolves void.
    let located: unknown;
    if (options.locate) {
      located = (await dev.locate()) ?? dev.content.location;
    }

    if (options.outputToFile) {
      // WHY: the device name is attacker-influenced data; using it verbatim in a
      // file path lets a name containing '/' or '..' write outside the cwd
      // (path traversal, CWE-22). Reduce to a basename and strip everything but
      // safe filename characters, with a non-empty fallback.
      const rawName = String(dev.content.name).trim().toLowerCase();
      const safeName =
        path.basename(rawName).replace(/[^a-z0-9._-]/gi, '_') || 'device';
      await writeFile(
        `${safeName}.fmip_snapshot.json`,
        JSON.stringify(dev.content),
      );
    }

    const contents = dev.content;

    if (options.json) {
      // Build this device's structured entry; identity is always present, the
      // listing/locate keys mirror the active flags (non-exclusive).
      const entry: Record<string, unknown> = { id: String(contents.id) };
      if (options.list) {
        entry.list = {
          name: String(contents.name),
          displayName: String(contents.deviceDisplayName),
          location: formatLocation(contents.location),
          mapsUrl: mapsUrl(contents.location),
          batteryLevel: String(contents.batteryLevel),
          batteryStatus: String(contents.batteryStatus),
          deviceClass: String(contents.deviceClass),
          deviceModel: String(contents.deviceModel),
        };
      }
      if (options.longlist) {
        entry.llist = contents;
      }
      if (options.locate) {
        entry.locate = {
          location: located,
          locationText: formatLocation(located),
          mapsUrl: mapsUrl(located),
        };
      }
      results.push(entry);
    } else {
      if (options.longlist) {
        deps.log('-'.repeat(30));
        deps.log(String(contents.name));
        for (const key of Object.keys(contents)) {
          deps.log(`${key.padStart(20)} - ${formatValue(contents[key])}`);
        }
      } else if (options.list) {
        deps.log('-'.repeat(30));
        deps.log(`Name - ${String(contents.name)}`);
        deps.log(`Display Name  - ${String(contents.deviceDisplayName)}`);
        deps.log(`Location      - ${formatLocation(contents.location)}`);
        const url = mapsUrl(contents.location);
        if (url) {
          deps.log(`View on Map   - ${url}`);
        }
        deps.log(`Battery Level - ${String(contents.batteryLevel)}`);
        deps.log(`Battery Status- ${String(contents.batteryStatus)}`);
        deps.log(`Device Class  - ${String(contents.deviceClass)}`);
        deps.log(`Device Model  - ${String(contents.deviceModel)}`);
      }

      // Surface the located fix at the end of this device's text output (the
      // map link only when there is a usable fix, matching the --list block).
      if (options.locate) {
        deps.log(`Location      - ${formatLocation(located)}`);
        const url = mapsUrl(located);
        if (url) {
          deps.log(`View on Map   - ${url}`);
        }
      }
    }

    if (options.sound) {
      if (options.deviceId) {
        await dev.playSound();
      } else {
        throw new Error(
          `Sounds can only be played on a singular device. ${DEVICE_ERROR}`,
        );
      }
    }

    if (options.message) {
      if (options.deviceId) {
        await dev.displayMessage({
          subject: 'A Message',
          message: options.message,
          sounds: true,
        });
      } else {
        throw new Error(
          `Messages can only be played on a singular device. ${DEVICE_ERROR}`,
        );
      }
    }

    if (options.silentmessage) {
      if (options.deviceId) {
        await dev.displayMessage({
          subject: 'A Silent Message',
          message: options.silentmessage,
          sounds: false,
        });
      } else {
        throw new Error(
          `Silent Messages can only be played on a singular device. ${DEVICE_ERROR}`,
        );
      }
    }

    if (options.lostmode) {
      if (options.deviceId) {
        await dev.lostDevice({
          number: options.lostPhone.trim(),
          text: options.lostMessage.trim(),
          newpasscode: options.lostPassword.trim(),
        });
      } else {
        throw new Error(
          `Lost Mode can only be activated on a singular device. ${DEVICE_ERROR}`,
        );
      }
    }
  }

  if (options.json) {
    // `--device <id>` filters to at most one device (ids are unique), so emit a
    // single object (or `null` when nothing matched) instead of a one-element
    // array. Without `--device`, callers expect the full array of devices.
    const output = options.deviceId ? results[0] ?? null : results;
    deps.log(JSON.stringify(output, null, 2));
  }

  return void deps.exit(0);
}
