/**
 * findmyiphone.spec.ts — FindMyiPhoneService + AppleDevice
 * (`src/services/findmyiphone.service.ts`, plan §4.8 / §5.2).
 *
 * Coverage (plan §5.2 row):
 *  - the 13-device refresh fixture is parsed into a map keyed by `content.id`;
 *  - `get(int)` indexes the ordered key list, `get(string)` looks up by id;
 *  - `location()` and `status()` BOTH trigger a whole-list `refreshClient()`
 *    (asserted by counting refresh hits);
 *  - `playSound` hardcodes `clientContext.fmly = true` (latent-bug #6 preserved)
 *    EVEN when the manager was built with `withFamily = false`;
 *  - `refreshClient` sends the `clientContext` envelope with the manager's
 *    `withFamily` flag, `shouldLocate:true`, `selectedDevice:'all'`,
 *    `deviceListVersion:1`, plus the shared `params` on the query string;
 *  - `displayMessage` / `lostDevice` build the exact Python body shapes;
 *  - an empty `content` array raises `PyiCloudNoDevicesException`.
 *
 * Strategy: build a standalone {@link IcloudHttpService} pointed at the real
 * FMIP host (`p31-fmipweb.icloud.com`) so per-route nock interceptors can both
 * assert the outgoing body/params AND control the response. No auth handshake is
 * needed — every FMIP response here is a 200, so the re-auth/retry branch (the
 * only thing that needs `bindAuth`) never fires.
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import nock from 'nock';

import { SessionStore } from '../src/session/session-store';
import { Endpoints, IcloudHttpService } from '../src/session/icloud-http.service';
import {
  AppleDevice,
  FindMyiPhoneService,
} from '../src/services/findmyiphone.service';
import { PyiCloudNoDevicesException } from '../src/exceptions/icloud.exceptions';

// ---------------------------------------------------------------------------
// Constants / fixtures
// ---------------------------------------------------------------------------

/** The `findme` webservice root (matches the account-login fixture). */
const FMIP_ROOT = 'https://p31-fmipweb.icloud.com:443';
/** nock host scope for that root (host includes the explicit :443 port). */
const FMIP_HOST = 'https://p31-fmipweb.icloud.com:443';
/** FMIP endpoint path prefix (`refreshClient`, `playSound`, … hang off this). */
const FMIP_PATH = '/fmipservice/client/web';

const PARAMS: Record<string, string> = {
  clientId: 'auth-test-client',
  dsid: '1234567890',
  clientBuildNumber: '2521Project35',
  clientMasteringNumber: '2521B2',
  ckjsBuildVersion: '2521ProjectDev39',
};

let fmiFixture: Record<string, unknown>;

beforeAll(async () => {
  fmiFixture = JSON.parse(
    await fs.readFile(path.join(__dirname, 'fixtures', 'fmi-refresh.json'), 'utf8'),
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A deep clone of the 13-device refresh fixture (no shared mutation). */
function refreshFixture(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fmiFixture));
}

/** The same fixture but with an empty device list (drives NoDevices). */
function emptyFixture(): Record<string, unknown> {
  return { ...refreshFixture(), content: [] };
}

const cleanups: Array<() => Promise<void>> = [];

/** Build a standalone, fully-constructed HTTP service (no auth handshake). */
async function makeHttp(): Promise<IcloudHttpService> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsicloud-fmip-'));
  cleanups.push(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const store = await SessionStore.load(dir, 'fmip');
  store.sessionData.client_id = PARAMS.clientId;

  const endpoints: Endpoints = {
    AUTH: 'https://idmsa.apple.com/appleauth/auth',
    HOME: 'https://www.icloud.com',
    SETUP: 'https://setup.icloud.com/setup/ws/1',
  };
  return new IcloudHttpService(store, endpoints, {
    Origin: endpoints.HOME,
    Referer: `${endpoints.HOME}/`,
  });
}

/**
 * Build an initialised manager (the 13-device refresh has already run once).
 * Captures every `refreshClient` request (body + query) into `refreshHits`.
 */
async function makeManager(
  withFamily = false,
): Promise<{
  service: FindMyiPhoneService;
  refreshHits: Array<{ body: unknown; query: Record<string, string> }>;
}> {
  const http = await makeHttp();
  const refreshHits: Array<{ body: unknown; query: Record<string, string> }> = [];

  nock(FMIP_HOST)
    .persist()
    .post(`${FMIP_PATH}/refreshClient`)
    .query(true)
    .reply(function (uri, body) {
      const search = uri.includes('?') ? uri.slice(uri.indexOf('?') + 1) : '';
      const query: Record<string, string> = {};
      for (const pair of search.split('&')) {
        if (!pair) continue;
        const i = pair.indexOf('=');
        query[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
      }
      refreshHits.push({
        body: typeof body === 'string' ? JSON.parse(body) : body,
        query,
      });
      return [200, refreshFixture(), { 'Content-Type': 'application/json' }];
    });

  const service = new FindMyiPhoneService(FMIP_ROOT, http, PARAMS, withFamily);
  await service.init();
  return { service, refreshHits };
}

beforeEach(() => {
  nock.disableNetConnect();
});

afterEach(async () => {
  nock.cleanAll();
  for (const c of cleanups.splice(0)) {
    await c();
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FindMyiPhoneService.refreshClient / init', () => {
  it('parses the 13-device fixture into a map keyed by content.id', async () => {
    const { service } = await makeManager();

    expect(service.keys()).toHaveLength(13);
    expect(service.values()).toHaveLength(13);
    // First and last ids match the fixture order (insertion-ordered map).
    expect(service.keys()[0]).toBe('iPhone12,1');
    expect(service.keys()[12]).toBe('iPhone6,2johntravolta');
    // Every key is the device's own content.id.
    for (const dev of service.values()) {
      expect(service.get(dev.content.id)).toBe(dev);
    }
  });

  it('sends the clientContext envelope + shared params on refresh', async () => {
    const { refreshHits } = await makeManager(false);

    expect(refreshHits).toHaveLength(1); // init() ran exactly one refresh
    const { body, query } = refreshHits[0];
    expect(body).toEqual({
      clientContext: {
        fmly: false,
        shouldLocate: true,
        selectedDevice: 'all',
        deviceListVersion: 1,
      },
    });
    // Shared params (clientId/dsid/build numbers) are on the query string.
    expect(query.clientId).toBe(PARAMS.clientId);
    expect(query.dsid).toBe(PARAMS.dsid);
  });

  it('honours withFamily=true in the clientContext.fmly flag', async () => {
    const { refreshHits } = await makeManager(true);
    expect((refreshHits[0].body as { clientContext: { fmly: boolean } }).clientContext.fmly).toBe(
      true,
    );
  });

  it('updates existing device objects in place across refreshes', async () => {
    const { service } = await makeManager();
    const before = service.get(0);
    await service.refreshClient();
    const after = service.get(0);
    // Same object identity preserved (Python `.update()` path, not re-created).
    expect(after).toBe(before);
    expect(service.keys()).toHaveLength(13);
  });

  it('raises PyiCloudNoDevicesException on an empty device list', async () => {
    const http = await makeHttp();
    nock(FMIP_HOST)
      .post(`${FMIP_PATH}/refreshClient`)
      .query(true)
      .reply(200, emptyFixture(), { 'Content-Type': 'application/json' });

    const service = new FindMyiPhoneService(FMIP_ROOT, http, PARAMS, false);
    await expect(service.init()).rejects.toBeInstanceOf(PyiCloudNoDevicesException);
  });
});

describe('FindMyiPhoneService.get', () => {
  it('get(int) indexes the ordered key list; get(id) looks up by id', async () => {
    const { service } = await makeManager();

    const byIndex = service.get(3);
    const byId = service.get('MacBookPro10,1');
    expect(byIndex).toBe(byId);
    expect(byIndex.content.id).toBe('MacBookPro10,1');

    // get(0) is the first device; get(id) for the same device is identical.
    expect(service.get(0)).toBe(service.get('iPhone12,1'));
  });

  it('throws when an id or index is out of range', async () => {
    const { service } = await makeManager();
    expect(() => service.get('does-not-exist')).toThrow(PyiCloudNoDevicesException);
    expect(() => service.get(999)).toThrow(PyiCloudNoDevicesException);
  });
});

describe('AppleDevice.location / status (whole-list refresh)', () => {
  it('location() triggers a fresh refreshClient and returns content.location', async () => {
    const { service, refreshHits } = await makeManager();
    expect(refreshHits).toHaveLength(1); // from init()

    const dev = service.get(0);
    const loc = await dev.location();

    expect(refreshHits).toHaveLength(2); // location() forced another whole-list refresh
    expect(loc).toEqual(dev.content.location);
    expect((loc as { latitude: number }).latitude).toBeCloseTo(45.123456789012344);
  });

  it('status() triggers a refresh and returns the default fields (+additional)', async () => {
    const { service, refreshHits } = await makeManager();
    const dev = service.get(0);

    const status = await dev.status();
    expect(refreshHits).toHaveLength(2); // status() also forced a refresh

    expect(Object.keys(status)).toEqual([
      'batteryLevel',
      'deviceDisplayName',
      'deviceStatus',
      'name',
    ]);
    expect(status.deviceDisplayName).toBe('iPhone 11');
    expect(status.name).toBe('iPhone de Quentin');

    // `additional` fields are appended.
    const withExtra = await dev.status(['deviceClass']);
    expect(withExtra.deviceClass).toBe('iPhone');
  });
});

describe('AppleDevice remote commands', () => {
  it('playSound hardcodes clientContext.fmly=true even when withFamily=false', async () => {
    const { service } = await makeManager(false); // manager built withFamily=false

    let captured: Record<string, unknown> | undefined;
    nock(FMIP_HOST)
      .post(`${FMIP_PATH}/playSound`)
      .query(true)
      .reply(function (_uri, body) {
        captured = typeof body === 'string' ? JSON.parse(body) : (body as never);
        return [200, {}, { 'Content-Type': 'application/json' }];
      });

    await service.get(0).playSound();

    expect(captured).toEqual({
      device: 'iPhone12,1',
      subject: 'Find My iPhone Alert',
      // PRESERVED latent bug #6: fmly is true regardless of withFamily.
      clientContext: { fmly: true },
    });
  });

  it('playSound accepts a custom subject', async () => {
    const { service } = await makeManager();
    let captured: Record<string, unknown> | undefined;
    nock(FMIP_HOST)
      .post(`${FMIP_PATH}/playSound`)
      .query(true)
      .reply(function (_uri, body) {
        captured = typeof body === 'string' ? JSON.parse(body) : (body as never);
        return [200, {}, { 'Content-Type': 'application/json' }];
      });

    await service.get(0).playSound('Custom Subject');
    expect(captured?.subject).toBe('Custom Subject');
  });

  it('displayMessage builds the sendMessage body', async () => {
    const { service } = await makeManager();
    let captured: Record<string, unknown> | undefined;
    nock(FMIP_HOST)
      .post(`${FMIP_PATH}/sendMessage`)
      .query(true)
      .reply(function (_uri, body) {
        captured = typeof body === 'string' ? JSON.parse(body) : (body as never);
        return [200, {}, { 'Content-Type': 'application/json' }];
      });

    await service.get(0).displayMessage({ subject: 'A Message', message: 'hi', sounds: true });

    expect(captured).toEqual({
      device: 'iPhone12,1',
      subject: 'A Message',
      sound: true,
      userText: true,
      text: 'hi',
    });
  });

  it('lostDevice builds the lostDevice body', async () => {
    const { service } = await makeManager();
    let captured: Record<string, unknown> | undefined;
    nock(FMIP_HOST)
      .post(`${FMIP_PATH}/lostDevice`)
      .query(true)
      .reply(function (_uri, body) {
        captured = typeof body === 'string' ? JSON.parse(body) : (body as never);
        return [200, {}, { 'Content-Type': 'application/json' }];
      });

    await service
      .get(0)
      .lostDevice({ number: '+33123456789', text: 'lost!', newpasscode: '1234' });

    expect(captured).toEqual({
      text: 'lost!',
      userText: true,
      ownerNbr: '+33123456789',
      lostModeEnabled: true,
      trackingEnabled: true,
      device: 'iPhone12,1',
      passcode: '1234',
    });
  });
});

describe('AppleDevice accessors', () => {
  it('exposes content via the data getter and is the right class', async () => {
    const { service } = await makeManager();
    const dev = service.get(0);
    expect(dev).toBeInstanceOf(AppleDevice);
    expect(dev.data).toBe(dev.content);
    expect(dev.data.id).toBe('iPhone12,1');
  });
});
