/**
 * cli.spec.ts — Find My iPhone CLI core (`src/cli/fmip-cli.ts`, plan §4.10 / §5.2).
 *
 * Drives {@link runCli} through injected {@link CliDeps} (no real network /
 * keyring / process.exit). Coverage:
 *  - exit `2` on missing username / missing password;
 *  - exit `1` on failed 2FA and on failed 2SA verification;
 *  - exit `0` on success;
 *  - PER-DEVICE LOOP: no `--device` processes ALL devices; `--device <id>`
 *    filters by `content.id` (case-insensitive, trimmed);
 *  - `--list` prints the device fields in order (incl. a "View on Map" link
 *    when a location fix exists);
 *  - bad creds → `throw Error('Bad username or password for <user>')` after the
 *    THIRD failure (and the loop retries twice first);
 *  - 2FA via mocked stdin `'000000'`;
 *  - `--sound`/`--message`/`--silentmessage`/`--lostmode` WITHOUT `--device`
 *    throw a RuntimeError containing `DEVICE_ERROR`;
 *  - keyring save-confirm path; `--delete-from-keyring`; `--outputfile` writes
 *    JSON (not pickle).
 */
import {
  CliApi,
  CliDeps,
  DEVICE_ERROR,
  formatLocation,
  formatValue,
  mapsUrl,
  runCli,
} from '../src/cli/fmip-cli';
import { AppleDevice } from '../src/services/findmyiphone.service';
import { PyiCloudFailedLoginException } from '../src/exceptions/icloud.exceptions';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A fake AppleDevice: a content blob + jest-spied command methods. */
interface FakeDevice {
  content: Record<string, unknown>;
  location: jest.Mock;
  status: jest.Mock;
  playSound: jest.Mock;
  displayMessage: jest.Mock;
  lostDevice: jest.Mock;
}

function makeDevice(content: Record<string, unknown>): FakeDevice {
  return {
    content,
    location: jest.fn().mockResolvedValue(content.location),
    status: jest.fn().mockResolvedValue({}),
    playSound: jest.fn().mockResolvedValue(undefined),
    displayMessage: jest.fn().mockResolvedValue(undefined),
    lostDevice: jest.fn().mockResolvedValue(undefined),
  };
}

const DEVICE_A: Record<string, unknown> = {
  id: 'iPhone12,1',
  name: 'iPhone de Quentin',
  deviceDisplayName: 'iPhone 11',
  location: { latitude: 45.1, longitude: 6.1 },
  batteryLevel: 0.83,
  batteryStatus: 'NotCharging',
  deviceClass: 'iPhone',
  deviceModel: 'iphone11-1-6-0',
};

const DEVICE_B: Record<string, unknown> = {
  id: 'MacBookPro10,1',
  name: 'MacBook de Quentin',
  deviceDisplayName: 'MacBook Pro',
  location: null,
  batteryLevel: 0.5,
  batteryStatus: 'Charging',
  deviceClass: 'MacBook',
  deviceModel: 'macbookpro10-1',
};

/** Build a `CliApi` fake whose `findMyiPhone()` returns the given devices. */
function makeApi(
  devices: FakeDevice[],
  overrides: Partial<CliApi> = {},
): { api: CliApi; devices: FakeDevice[] } {
  const api: CliApi = {
    requires2fa: false,
    requires2sa: false,
    trustedDevices: Promise.resolve([]),
    requestTwoFactorCode: jest.fn().mockResolvedValue(undefined),
    validate2faCode: jest.fn().mockResolvedValue(true),
    sendVerificationCode: jest.fn().mockResolvedValue(true),
    validateVerificationCode: jest.fn().mockResolvedValue(true),
    findMyiPhone: jest
      .fn()
      .mockResolvedValue({ all: devices as unknown as AppleDevice[] }),
    ...overrides,
  };
  return { api, devices };
}

/**
 * A session-encryption-key fake: jest spies on the three members the CLI uses.
 *
 * `keyExistsInKeychain` defaults to TRUE so the existing CLI tests (which do not
 * exercise the key-bootstrap branch) skip the prompt entirely. The encryption
 * specs override it per-test.
 */
function makeSessionKey(opts: { keyExists?: boolean } = {}) {
  return {
    keyExistsInKeychain: jest.fn(async () => opts.keyExists ?? true),
    generateKey: jest.fn(() => Buffer.alloc(32, 7)),
    storeKeyInKeychain: jest.fn(async () => undefined),
  };
}

/** A keyring fake: in-memory store + jest spies on every method. */
function makeSecrets(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  return {
    getPassword: jest.fn(async (u: string) => {
      if (u in store) return store[u];
      throw new PyiCloudFailedLoginException('no stored password');
    }),
    passwordExistsInKeyring: jest.fn(async (u: string) => u in store),
    getPasswordFromKeyring: jest.fn(async (u: string) => store[u]),
    storePasswordInKeyring: jest.fn(async (u: string, p: string) => {
      store[u] = p;
    }),
    deletePasswordInKeyring: jest.fn(async (u: string) => {
      delete store[u];
    }),
  };
}

/** Build a full `CliDeps` bundle; returns the bundle + captured output. */
function makeDeps(
  opts: {
    api?: CliApi;
    createService?: CliDeps['createService'];
    secrets?: ReturnType<typeof makeSecrets>;
    sessionKey?: ReturnType<typeof makeSessionKey>;
    stdinResponses?: string[];
    confirmResult?: boolean;
    interactive?: boolean;
    writeFile?: jest.Mock;
  } = {},
): {
  deps: CliDeps;
  out: string[];
  err: string[];
  exit: jest.Mock;
  secrets: ReturnType<typeof makeSecrets>;
  sessionKey: ReturnType<typeof makeSessionKey>;
  stdin: jest.Mock;
  confirm: jest.Mock;
  writeFile: jest.Mock;
  createService: jest.Mock;
} {
  const out: string[] = [];
  const err: string[] = [];
  const secrets = opts.secrets ?? makeSecrets();
  const sessionKey = opts.sessionKey ?? makeSessionKey();
  const responses = [...(opts.stdinResponses ?? [])];
  const stdin = jest.fn(async () => responses.shift() ?? '');
  const confirm = jest.fn(async () => opts.confirmResult ?? false);
  const writeFile = opts.writeFile ?? jest.fn(async () => undefined);

  // The default exit is non-terminal (returns) so the test can observe the call
  // AND let the function return; we record the code instead of killing Jest.
  const exit = jest.fn((_code: number) => undefined as never);

  // The fake createService now takes the two extra encryption params; defaulting
  // them keeps the body trivial while still being callable with all five args.
  const createService =
    (opts.createService as jest.Mock) ??
    jest.fn(
      async (
        _username: string,
        _password: string,
        _china: boolean,
        _encrypt = true,
        _encryptionKeyFile = '',
      ) => opts.api ?? makeApi([]).api,
    );

  const deps: CliDeps = {
    createService: createService as never,
    secrets: secrets as never,
    sessionKey: sessionKey as never,
    stdin,
    confirm,
    exit: exit as unknown as (code: number) => never,
    log: (l: string) => out.push(l),
    errlog: (l: string) => err.push(l),
    interactive: opts.interactive ?? true,
    writeFile: writeFile as never,
  };

  return {
    deps,
    out,
    err,
    exit,
    secrets,
    sessionKey,
    stdin,
    confirm,
    writeFile,
    createService: createService as jest.Mock,
  };
}

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

describe('runCli — exit codes', () => {
  it('exits 2 when no username is supplied (non-interactive)', async () => {
    const { deps, exit, err } = makeDeps({ interactive: false });
    await runCli([], deps);
    expect(exit).toHaveBeenCalledWith(2);
    expect(err.join('\n')).toContain('No username supplied');
  });

  it('prompts for the username when it is omitted (interactive)', async () => {
    const { api } = makeApi([makeDevice(DEVICE_A)]);
    const createService = jest.fn(async () => api);
    const { deps, exit, stdin } = makeDeps({
      createService,
      stdinResponses: ['typed@user.com'],
    });
    await runCli(['--password', 'pw'], deps);
    expect(stdin).toHaveBeenCalledWith('iCloud username (Apple ID): ');
    // Encryption defaults: encrypt=true, no key-file. The two extra params are
    // forwarded after the original (username, password, china) triple.
    expect(createService).toHaveBeenCalledWith(
      'typed@user.com',
      'pw',
      false,
      true,
      '',
    );
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 2 when no password is available (non-interactive, not in keyring)', async () => {
    const { deps, exit, err } = makeDeps({ interactive: false });
    await runCli(['--username', 'quentin@hotmail.fr'], deps);
    expect(exit).toHaveBeenCalledWith(2);
    expect(err.join('\n')).toContain('No password supplied');
  });

  it('exits 2 on an unknown option (usage error)', async () => {
    const { deps, exit } = makeDeps();
    await runCli(['--not-a-real-flag'], deps);
    expect(exit).toHaveBeenCalledWith(2);
  });

  it('exits 0 on a successful login with no device action', async () => {
    const { api } = makeApi([makeDevice(DEVICE_A)]);
    const { deps, exit } = makeDeps({ api });
    await runCli(['--username', 'u@x.com', '--password', 'pw'], deps);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 1 when 2FA verification fails', async () => {
    const { api } = makeApi([makeDevice(DEVICE_A)], {
      requires2fa: true,
      validate2faCode: jest.fn().mockResolvedValue(false),
    });
    const { deps, exit, out } = makeDeps({
      api,
      stdinResponses: ['000000'],
    });
    await runCli(['--username', 'u@x.com', '--password', 'pw'], deps);
    expect(exit).toHaveBeenCalledWith(1);
    expect(out.join('\n')).toContain('Failed to verify verification code');
  });

  it('exits 1 when 2SA send fails', async () => {
    const { api } = makeApi([makeDevice(DEVICE_A)], {
      requires2sa: true,
      trustedDevices: Promise.resolve([{ deviceName: 'iPhone' }]),
      sendVerificationCode: jest.fn().mockResolvedValue(false),
    });
    const { deps, exit, out } = makeDeps({ api, stdinResponses: ['0'] });
    await runCli(['--username', 'u@x.com', '--password', 'pw'], deps);
    expect(exit).toHaveBeenCalledWith(1);
    expect(out.join('\n')).toContain('Failed to send verification code');
  });

  it('exits 1 when 2SA verification fails', async () => {
    const { api } = makeApi([makeDevice(DEVICE_A)], {
      requires2sa: true,
      trustedDevices: Promise.resolve([{ deviceName: 'iPhone' }]),
      sendVerificationCode: jest.fn().mockResolvedValue(true),
      validateVerificationCode: jest.fn().mockResolvedValue(false),
    });
    const { deps, exit, out } = makeDeps({
      api,
      // first stdin → device index '0', second → the (wrong) code
      stdinResponses: ['0', '0'],
    });
    await runCli(['--username', 'u@x.com', '--password', 'pw'], deps);
    expect(exit).toHaveBeenCalledWith(1);
    expect(out.join('\n')).toContain('Failed to verify verification code');
  });
});

// ---------------------------------------------------------------------------
// 2FA via mocked stdin
// ---------------------------------------------------------------------------

describe('runCli — 2FA handshake', () => {
  it("reads the 2FA code '000000' from stdin and verifies it", async () => {
    const validate2faCode = jest.fn().mockResolvedValue(true);
    const requestTwoFactorCode = jest.fn().mockResolvedValue(undefined);
    const { api } = makeApi([makeDevice(DEVICE_A)], {
      requires2fa: true,
      requestTwoFactorCode,
      validate2faCode,
    });
    const { deps, exit, stdin } = makeDeps({
      api,
      stdinResponses: ['000000'],
    });
    await runCli(['--username', 'u@x.com', '--password', 'pw'], deps);

    // The code must be REQUESTED (push/SMS) before we prompt for it.
    expect(requestTwoFactorCode).toHaveBeenCalled();
    expect(stdin).toHaveBeenCalled();
    expect(validate2faCode).toHaveBeenCalledWith('000000');
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('runs the 2SA flow: lists devices, sends + verifies the code', async () => {
    const sendVerificationCode = jest.fn().mockResolvedValue(true);
    const validateVerificationCode = jest.fn().mockResolvedValue(true);
    const devicesList = [
      { deviceName: 'My iPhone' },
      { phoneNumber: '+33•••••' },
    ];
    const { api } = makeApi([makeDevice(DEVICE_A)], {
      requires2sa: true,
      trustedDevices: Promise.resolve(devicesList),
      sendVerificationCode,
      validateVerificationCode,
    });
    const { deps, exit, out } = makeDeps({
      api,
      stdinResponses: ['1', '0'], // pick device index 1, then code '0'
    });
    await runCli(['--username', 'u@x.com', '--password', 'pw'], deps);

    // Device list rendered with deviceName / "SMS to <phone>" fallback.
    expect(out.join('\n')).toContain('0: My iPhone');
    expect(out.join('\n')).toContain('1: SMS to +33•••••');
    expect(sendVerificationCode).toHaveBeenCalledWith(devicesList[1]);
    expect(validateVerificationCode).toHaveBeenCalledWith(devicesList[1], '0');
    expect(exit).toHaveBeenCalledWith(0);
  });
});

// ---------------------------------------------------------------------------
// Bad-credential 3-strike loop
// ---------------------------------------------------------------------------

describe('runCli — bad-credential 3-strike loop', () => {
  it('throws after the third consecutive failed login', async () => {
    const createService = jest
      .fn()
      .mockRejectedValue(new PyiCloudFailedLoginException('bad'));
    // After each failure the loop clears `password` and re-fetches it via
    // `getPassword` (the interactive re-prompt), so simulate that here.
    const secrets = makeSecrets();
    secrets.getPassword.mockResolvedValue('re-typed-pw');
    const { deps, err } = makeDeps({ createService, secrets });

    await expect(
      runCli(['--username', 'quentin@x.com', '--password', 'pw'], deps),
    ).rejects.toThrow('Bad username or password for quentin@x.com');

    // Three attempts total; the first two errlog the message before retrying.
    expect(createService).toHaveBeenCalledTimes(3);
    expect(
      err.filter((l) => l === 'Bad username or password for quentin@x.com'),
    ).toHaveLength(2);
  });

  it('deletes the stored keyring password when a stored cred fails', async () => {
    const secrets = makeSecrets({ 'quentin@x.com': 'stored-pw' });
    // The re-prompt keeps returning a password so the loop reaches 3 strikes.
    secrets.getPassword.mockResolvedValue('stored-pw');
    const createService = jest
      .fn()
      .mockRejectedValue(new PyiCloudFailedLoginException('bad'));
    const { deps } = makeDeps({ createService, secrets });

    await expect(
      runCli(['--username', 'quentin@x.com'], deps),
    ).rejects.toThrow('Bad username or password for quentin@x.com');

    expect(secrets.deletePasswordInKeyring).toHaveBeenCalledWith('quentin@x.com');
  });
});

// ---------------------------------------------------------------------------
// Keyring save / delete
// ---------------------------------------------------------------------------

describe('runCli — keyring interactions', () => {
  it('offers to save a typed password and stores it on confirm', async () => {
    const secrets = makeSecrets(); // empty keyring → password typed via --password
    const { api } = makeApi([makeDevice(DEVICE_A)]);
    const { deps, confirm } = makeDeps({
      api,
      secrets,
      confirmResult: true,
    });

    await runCli(['--username', 'u@x.com', '--password', 'typed-pw'], deps);

    expect(confirm).toHaveBeenCalledWith('Save password in keyring?');
    expect(secrets.storePasswordInKeyring).toHaveBeenCalledWith(
      'u@x.com',
      'typed-pw',
    );
  });

  it('does NOT store the password when the user declines', async () => {
    const secrets = makeSecrets();
    const { api } = makeApi([makeDevice(DEVICE_A)]);
    const { deps } = makeDeps({ api, secrets, confirmResult: false });

    await runCli(['--username', 'u@x.com', '--password', 'typed-pw'], deps);
    expect(secrets.storePasswordInKeyring).not.toHaveBeenCalled();
  });

  it('--delete-from-keyring removes the stored password up-front, then logs in', async () => {
    const secrets = makeSecrets({ 'u@x.com': 'old-pw' });
    const { api } = makeApi([makeDevice(DEVICE_A)]);
    const { deps, exit } = makeDeps({ api, secrets });

    await runCli(
      ['--username', 'u@x.com', '--password', 'pw', '--delete-from-keyring'],
      deps,
    );

    expect(secrets.deletePasswordInKeyring).toHaveBeenCalledWith('u@x.com');
    // It does NOT return early — login proceeds to success.
    expect(exit).toHaveBeenCalledWith(0);
  });
});

// ---------------------------------------------------------------------------
// Per-device loop + id-match filter
// ---------------------------------------------------------------------------

describe('runCli — per-device loop & id filter', () => {
  it('with NO --device, processes ALL devices (locate runs on each)', async () => {
    const a = makeDevice(DEVICE_A);
    const b = makeDevice(DEVICE_B);
    const { api } = makeApi([a, b]);
    const { deps, exit } = makeDeps({ api });

    await runCli(
      ['--username', 'u@x.com', '--password', 'pw', '--locate'],
      deps,
    );

    expect(a.location).toHaveBeenCalledTimes(1);
    expect(b.location).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('with --device <id>, only the id-matching device acts', async () => {
    const a = makeDevice(DEVICE_A);
    const b = makeDevice(DEVICE_B);
    const { api } = makeApi([a, b]);
    const { deps } = makeDeps({ api });

    await runCli(
      [
        '--username',
        'u@x.com',
        '--password',
        'pw',
        '--device',
        'iPhone12,1',
        '--locate',
      ],
      deps,
    );

    expect(a.location).toHaveBeenCalledTimes(1);
    expect(b.location).not.toHaveBeenCalled();
  });

  it('matches the device id case-insensitively and trimmed', async () => {
    const a = makeDevice(DEVICE_A);
    const { api } = makeApi([a]);
    const { deps } = makeDeps({ api });

    await runCli(
      [
        '--username',
        'u@x.com',
        '--password',
        'pw',
        '--device',
        '  IPHONE12,1  ',
        '--locate',
      ],
      deps,
    );
    expect(a.location).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// --list seven-field set (exact order)
// ---------------------------------------------------------------------------

describe('runCli — --list field set', () => {
  it('prints the device fields (incl. map link) in order', async () => {
    const a = makeDevice(DEVICE_A);
    const { api } = makeApi([a]);
    const { deps, out } = makeDeps({ api });

    await runCli(['--username', 'u@x.com', '--password', 'pw', '--list'], deps);

    // Drop the leading rule line ('-' * 30).
    const lines = out.filter((l) => l !== '-'.repeat(30));
    expect(lines).toEqual([
      `Name - ${DEVICE_A.name}`,
      `Display Name  - ${DEVICE_A.deviceDisplayName}`,
      `Location      - 45.1, 6.1`,
      `View on Map   - https://www.google.com/maps/search/?api=1&query=45.1,6.1`,
      `Battery Level - ${DEVICE_A.batteryLevel}`,
      `Battery Status- ${DEVICE_A.batteryStatus}`,
      `Device Class  - ${DEVICE_A.deviceClass}`,
      `Device Model  - ${DEVICE_A.deviceModel}`,
    ]);
  });

  it('formatLocation renders coordinates, accuracy, timestamp and staleness', () => {
    expect(formatLocation(null)).toBe('unknown');
    expect(formatLocation({})).toBe('unknown');
    expect(formatLocation({ latitude: 45.1, longitude: 6.1 })).toBe('45.1, 6.1');
    expect(
      formatLocation({
        latitude: 1.5,
        longitude: 2.5,
        horizontalAccuracy: 65,
        timeStamp: Date.UTC(2026, 5, 3, 12, 0, 0),
        isOld: true,
      }),
    ).toBe('1.5, 2.5 (±65m) @ 2026-06-03T12:00:00.000Z [stale]');
  });

  it('mapsUrl builds a Google Maps link (or null without a fix)', () => {
    expect(mapsUrl(null)).toBeNull();
    expect(mapsUrl({ latitude: null })).toBeNull();
    expect(mapsUrl({ latitude: 45.1, longitude: 6.1 })).toBe(
      'https://www.google.com/maps/search/?api=1&query=45.1,6.1',
    );
  });

  it('--llist (long list) prints every content key, JSON-encoding objects/arrays', async () => {
    const a = makeDevice({
      id: 'X1',
      name: 'Phone',
      foo: 'bar',
      features: { CLK: true, KEY: false },
      audioChannels: [{ ch: 1 }, { ch: 2 }],
    });
    const { api } = makeApi([a]);
    const { deps, out } = makeDeps({ api });

    await runCli(['--username', 'u@x.com', '--password', 'pw', '--llist'], deps);

    const joined = out.join('\n');
    expect(joined).toContain('Phone');
    expect(joined).toContain('foo'.padStart(20) + ' - bar');
    // Nested object / array are JSON-encoded, not "[object Object]".
    expect(joined).not.toContain('[object Object]');
    expect(joined).toContain(
      'features'.padStart(20) + ' - {"CLK":true,"KEY":false}',
    );
    expect(joined).toContain(
      'audioChannels'.padStart(20) + ' - [{"ch":1},{"ch":2}]',
    );
  });

  it('formatValue JSON-encodes objects/arrays, leaves primitives plain', () => {
    expect(formatValue('bar')).toBe('bar');
    expect(formatValue(6)).toBe('6');
    expect(formatValue(null)).toBe('null');
    expect(formatValue(false)).toBe('false');
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
    expect(formatValue([1, { b: 2 }])).toBe('[1,{"b":2}]');
  });
});

// ---------------------------------------------------------------------------
// Short-flag parsing equivalence
// ---------------------------------------------------------------------------

describe('runCli — short flag parsing', () => {
  it('-l behaves like --list', async () => {
    const a = makeDevice(DEVICE_A);
    const { api } = makeApi([a]);
    const { deps, out } = makeDeps({ api });

    await runCli(['-u', 'u@x.com', '-p', 'pw', '-l'], deps);

    const lines = out.filter((l) => l !== '-'.repeat(30));
    expect(lines).toEqual([
      `Name - ${DEVICE_A.name}`,
      `Display Name  - ${DEVICE_A.deviceDisplayName}`,
      `Location      - 45.1, 6.1`,
      `View on Map   - https://www.google.com/maps/search/?api=1&query=45.1,6.1`,
      `Battery Level - ${DEVICE_A.batteryLevel}`,
      `Battery Status- ${DEVICE_A.batteryStatus}`,
      `Device Class  - ${DEVICE_A.deviceClass}`,
      `Device Model  - ${DEVICE_A.deviceModel}`,
    ]);
  });

  it('-d <id> filters like --device <id>', async () => {
    const a = makeDevice(DEVICE_A);
    const b = makeDevice(DEVICE_B);
    const { api } = makeApi([a, b]);
    const { deps } = makeDeps({ api });

    await runCli(['-u', 'u@x.com', '-p', 'pw', '-d', 'iPhone12,1', '-o'], deps);

    expect(a.location).toHaveBeenCalledTimes(1);
    expect(b.location).not.toHaveBeenCalled();
  });

  it('-o behaves like --locate (runs location on each device)', async () => {
    const a = makeDevice(DEVICE_A);
    const b = makeDevice(DEVICE_B);
    const { api } = makeApi([a, b]);
    const { deps, exit } = makeDeps({ api });

    await runCli(['-u', 'u@x.com', '-p', 'pw', '-o'], deps);

    expect(a.location).toHaveBeenCalledTimes(1);
    expect(b.location).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});

// ---------------------------------------------------------------------------
// --locate text output
// ---------------------------------------------------------------------------

describe('runCli — --locate text output', () => {
  it('prints the Location line and a map link for a located device', async () => {
    const a = makeDevice(DEVICE_A);
    const { api } = makeApi([a]);
    const { deps, out } = makeDeps({ api });

    await runCli(['--username', 'u@x.com', '--password', 'pw', '--locate'], deps);

    const joined = out.join('\n');
    expect(joined).toContain('Location      - 45.1, 6.1');
    expect(joined).toContain(
      'View on Map   - https://www.google.com/maps/search/?api=1&query=45.1,6.1',
    );
  });

  it('prints "unknown" and no map link for a device without a fix', async () => {
    const b = makeDevice(DEVICE_B);
    const { api } = makeApi([b]);
    const { deps, out } = makeDeps({ api });

    await runCli(['--username', 'u@x.com', '--password', 'pw', '--locate'], deps);

    const joined = out.join('\n');
    expect(joined).toContain('Location      - unknown');
    expect(joined).not.toContain('View on Map');
  });
});

// ---------------------------------------------------------------------------
// --json output
// ---------------------------------------------------------------------------

describe('runCli — --json output', () => {
  it('emits a single valid JSON array, one entry per processed device', async () => {
    const a = makeDevice(DEVICE_A);
    const b = makeDevice(DEVICE_B);
    const { api } = makeApi([a, b]);
    const { deps, out } = makeDeps({ api });

    await runCli(['--username', 'u@x.com', '--password', 'pw', '--json'], deps);

    // Exactly one stdout write: the JSON document.
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe('iPhone12,1');
    expect(parsed[1].id).toBe('MacBookPro10,1');
  });

  it('-j with --list yields parseable JSON whose [0].list has the curated fields', async () => {
    const a = makeDevice(DEVICE_A);
    const { api } = makeApi([a]);
    const { deps, out } = makeDeps({ api });

    await runCli(['-u', 'u@x.com', '-p', 'pw', '-l', '-j'], deps);

    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]);
    expect(parsed[0].list).toEqual({
      name: String(DEVICE_A.name),
      displayName: String(DEVICE_A.deviceDisplayName),
      location: '45.1, 6.1',
      mapsUrl: 'https://www.google.com/maps/search/?api=1&query=45.1,6.1',
      batteryLevel: String(DEVICE_A.batteryLevel),
      batteryStatus: String(DEVICE_A.batteryStatus),
      deviceClass: String(DEVICE_A.deviceClass),
      deviceModel: String(DEVICE_A.deviceModel),
    });
  });

  it('-j with --locate yields [0].locate with location, text and mapsUrl', async () => {
    const a = makeDevice(DEVICE_A);
    const { api } = makeApi([a]);
    const { deps, out } = makeDeps({ api });

    await runCli(['-u', 'u@x.com', '-p', 'pw', '-o', '-j'], deps);

    const parsed = JSON.parse(out[0]);
    expect(parsed[0].locate).toEqual({
      location: DEVICE_A.location,
      locationText: '45.1, 6.1',
      mapsUrl: 'https://www.google.com/maps/search/?api=1&query=45.1,6.1',
    });
  });

  it('-j --locate gives a null mapsUrl for a device without a fix', async () => {
    const b = makeDevice(DEVICE_B);
    const { api } = makeApi([b]);
    const { deps, out } = makeDeps({ api });

    await runCli(['-u', 'u@x.com', '-p', 'pw', '-o', '-j'], deps);

    const parsed = JSON.parse(out[0]);
    expect(parsed[0].locate.mapsUrl).toBeNull();
    expect(parsed[0].locate.locationText).toBe('unknown');
  });

  it('-j with --llist embeds the full content blob', async () => {
    const a = makeDevice({ id: 'X1', name: 'Phone', features: { CLK: true } });
    const { api } = makeApi([a]);
    const { deps, out } = makeDeps({ api });

    await runCli(['-u', 'u@x.com', '-p', 'pw', '-L', '-j'], deps);

    const parsed = JSON.parse(out[0]);
    expect(parsed[0].llist).toEqual({
      id: 'X1',
      name: 'Phone',
      features: { CLK: true },
    });
  });

  it('-j with --device filtering yields only the matching entry', async () => {
    const a = makeDevice(DEVICE_A);
    const b = makeDevice(DEVICE_B);
    const { api } = makeApi([a, b]);
    const { deps, out } = makeDeps({ api });

    await runCli(['-u', 'u@x.com', '-p', 'pw', '-d', 'MacBookPro10,1', '-j'], deps);

    const parsed = JSON.parse(out[0]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('MacBookPro10,1');
  });

  it('-j with no matching device emits an empty array', async () => {
    const a = makeDevice(DEVICE_A);
    const { api } = makeApi([a]);
    const { deps, out } = makeDeps({ api });

    await runCli(['-u', 'u@x.com', '-p', 'pw', '-d', 'no-such-id', '-j'], deps);

    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Singular-device actions require --device
// ---------------------------------------------------------------------------

describe('runCli — singular-device actions require --device', () => {
  const cases: Array<[string, string[], string]> = [
    ['--sound', ['--sound'], 'Sounds can only be played on a singular device.'],
    [
      '--message',
      ['--message', 'hi'],
      'Messages can only be played on a singular device.',
    ],
    [
      '--silentmessage',
      ['--silentmessage', 'shh'],
      'Silent Messages can only be played on a singular device.',
    ],
    [
      '--lostmode',
      ['--lostmode'],
      'Lost Mode can only be activated on a singular device.',
    ],
  ];

  it.each(cases)(
    '%s without --device throws a RuntimeError containing DEVICE_ERROR',
    async (_name, flag, prefix) => {
      const { api } = makeApi([makeDevice(DEVICE_A)]);
      const { deps } = makeDeps({ api });

      await expect(
        runCli(['--username', 'u@x.com', '--password', 'pw', ...flag], deps),
      ).rejects.toThrow(`${prefix} ${DEVICE_ERROR}`);
    },
  );

  it('--sound WITH --device calls playSound on the matching device', async () => {
    const a = makeDevice(DEVICE_A);
    const { api } = makeApi([a]);
    const { deps, exit } = makeDeps({ api });

    await runCli(
      [
        '--username',
        'u@x.com',
        '--password',
        'pw',
        '--device',
        'iPhone12,1',
        '--sound',
      ],
      deps,
    );
    expect(a.playSound).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('--message WITH --device sends "A Message" with sounds=true', async () => {
    const a = makeDevice(DEVICE_A);
    const { api } = makeApi([a]);
    const { deps } = makeDeps({ api });

    await runCli(
      [
        '--username',
        'u@x.com',
        '--password',
        'pw',
        '--device',
        'iPhone12,1',
        '--message',
        'hello',
      ],
      deps,
    );
    expect(a.displayMessage).toHaveBeenCalledWith({
      subject: 'A Message',
      message: 'hello',
      sounds: true,
    });
  });

  it('--silentmessage WITH --device sends "A Silent Message" with sounds=false', async () => {
    const a = makeDevice(DEVICE_A);
    const { api } = makeApi([a]);
    const { deps } = makeDeps({ api });

    await runCli(
      [
        '--username',
        'u@x.com',
        '--password',
        'pw',
        '--device',
        'iPhone12,1',
        '--silentmessage',
        'quiet',
      ],
      deps,
    );
    expect(a.displayMessage).toHaveBeenCalledWith({
      subject: 'A Silent Message',
      message: 'quiet',
      sounds: false,
    });
  });

  it('--lostmode WITH --device activates lost mode with trimmed values', async () => {
    const a = makeDevice(DEVICE_A);
    const { api } = makeApi([a]);
    const { deps } = makeDeps({ api });

    await runCli(
      [
        '--username',
        'u@x.com',
        '--password',
        'pw',
        '--device',
        'iPhone12,1',
        '--lostmode',
        '--lostphone',
        ' +33123 ',
        '--lostmessage',
        ' call me ',
        '--lostpassword',
        ' 1234 ',
      ],
      deps,
    );
    expect(a.lostDevice).toHaveBeenCalledWith({
      number: '+33123',
      text: 'call me',
      newpasscode: '1234',
    });
  });
});

// ---------------------------------------------------------------------------
// --outputfile writes JSON
// ---------------------------------------------------------------------------

describe('runCli — --outputfile', () => {
  it('writes JSON.stringify(content) to <name>.fmip_snapshot.json (not pickle)', async () => {
    const a = makeDevice(DEVICE_A);
    const { api } = makeApi([a]);
    const writeFile = jest.fn(
      async (_path: string, _contents: string) => undefined,
    );
    const { deps } = makeDeps({ api, writeFile });

    await runCli(
      ['--username', 'u@x.com', '--password', 'pw', '--outputfile'],
      deps,
    );

    expect(writeFile).toHaveBeenCalledTimes(1);
    const [filename, contents] = writeFile.mock.calls[0];
    // <name>.trim().toLowerCase(), then sanitized (non-[a-z0-9._-] chars → '_'
    // for path-traversal hardening), + .fmip_snapshot.json
    expect(filename).toBe('iphone_de_quentin.fmip_snapshot.json');
    expect(JSON.parse(contents as string)).toEqual(DEVICE_A);
  });
});

// ---------------------------------------------------------------------------
// At-rest session encryption — key bootstrap & flag forwarding
// ---------------------------------------------------------------------------

describe('runCli — session-encryption key bootstrap', () => {
  it('--no-encrypt skips the key prompt and forwards encrypt=false', async () => {
    const a = makeDevice(DEVICE_A);
    const { api } = makeApi([a]);
    // A fresh keychain (no key) — but with --no-encrypt the bootstrap must be
    // skipped entirely, so keyExistsInKeychain is never consulted.
    const sessionKey = makeSessionKey({ keyExists: false });
    const { deps, exit, confirm, createService } = makeDeps({
      api,
      sessionKey,
    });

    await runCli(
      ['--username', 'u@x.com', '--password', 'pw', '--no-encrypt'],
      deps,
    );

    expect(sessionKey.keyExistsInKeychain).not.toHaveBeenCalled();
    expect(sessionKey.storeKeyInKeychain).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalledWith(
      expect.stringContaining('session-encryption key'),
    );
    expect(createService).toHaveBeenCalledWith(
      'u@x.com',
      'pw',
      false,
      false,
      '',
    );
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('missing key + interactive + confirm-yes stores a freshly generated key', async () => {
    const a = makeDevice(DEVICE_A);
    const { api } = makeApi([a]);
    const sessionKey = makeSessionKey({ keyExists: false });
    const { deps, exit, confirm } = makeDeps({
      api,
      sessionKey,
      confirmResult: true,
    });

    await runCli(['--username', 'u@x.com', '--password', 'pw'], deps);

    expect(sessionKey.keyExistsInKeychain).toHaveBeenCalledWith('u@x.com');
    expect(confirm).toHaveBeenCalledWith(
      'No session-encryption key found for u@x.com. Create one and store it in your keychain?',
    );
    expect(sessionKey.generateKey).toHaveBeenCalledTimes(1);
    expect(sessionKey.storeKeyInKeychain).toHaveBeenCalledWith(
      'u@x.com',
      sessionKey.generateKey.mock.results[0].value,
    );
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('missing key + interactive + confirm-no exits 2 without storing a key', async () => {
    const a = makeDevice(DEVICE_A);
    const { api } = makeApi([a]);
    const sessionKey = makeSessionKey({ keyExists: false });
    const { deps, exit, err, createService } = makeDeps({
      api,
      sessionKey,
      confirmResult: false,
    });

    await runCli(['--username', 'u@x.com', '--password', 'pw'], deps);

    expect(sessionKey.storeKeyInKeychain).not.toHaveBeenCalled();
    expect(createService).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('No encryption key');
    expect(exit).toHaveBeenCalledWith(2);
  });

  it('does NOT prompt when a key already exists in the keychain', async () => {
    const a = makeDevice(DEVICE_A);
    const { api } = makeApi([a]);
    const sessionKey = makeSessionKey({ keyExists: true });
    const { deps, exit, confirm } = makeDeps({ api, sessionKey });

    await runCli(['--username', 'u@x.com', '--password', 'pw'], deps);

    expect(sessionKey.keyExistsInKeychain).toHaveBeenCalledWith('u@x.com');
    expect(confirm).not.toHaveBeenCalledWith(
      expect.stringContaining('session-encryption key'),
    );
    expect(sessionKey.storeKeyInKeychain).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('non-interactive missing key does NOT prompt (create() auto-creates later)', async () => {
    const a = makeDevice(DEVICE_A);
    const { api } = makeApi([a]);
    const sessionKey = makeSessionKey({ keyExists: false });
    const { deps, exit, confirm, createService } = makeDeps({
      api,
      sessionKey,
      interactive: false,
    });

    await runCli(['--username', 'u@x.com', '--password', 'pw'], deps);

    expect(confirm).not.toHaveBeenCalled();
    expect(sessionKey.storeKeyInKeychain).not.toHaveBeenCalled();
    // Login still proceeds — the key is auto-created downstream by resolveKey.
    expect(createService).toHaveBeenCalledWith('u@x.com', 'pw', false, true, '');
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('--encryption-key-file skips the keychain bootstrap and is forwarded to createService', async () => {
    const a = makeDevice(DEVICE_A);
    const { api } = makeApi([a]);
    const sessionKey = makeSessionKey({ keyExists: false });
    const { deps, exit, createService } = makeDeps({ api, sessionKey });

    await runCli(
      [
        '--username',
        'u@x.com',
        '--password',
        'pw',
        '--encryption-key-file',
        '/tmp/key.b64',
      ],
      deps,
    );

    // With an explicit key file, the keychain bootstrap branch is skipped...
    expect(sessionKey.keyExistsInKeychain).not.toHaveBeenCalled();
    expect(sessionKey.storeKeyInKeychain).not.toHaveBeenCalled();
    // ...and the path is forwarded to createService for resolveKey to read.
    expect(createService).toHaveBeenCalledWith(
      'u@x.com',
      'pw',
      false,
      true,
      '/tmp/key.b64',
    );
    expect(exit).toHaveBeenCalledWith(0);
  });
});
