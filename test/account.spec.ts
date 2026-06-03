/**
 * account.spec.ts — AccountService (plan §4.7 / §5.2).
 *
 * Asserts against the ported Python fixtures:
 *   - 2 paired devices, with typed (camelCase) fields;
 *   - 3 Family Sharing members;
 *   - storage 43.75% used of 5368709120 bytes (== 2348632876 used);
 *   - FIX #2: the storage URL is CN-aware — built from the China `.com.cn`
 *     setup endpoint, NOT the Python hardcoded global host.
 *
 * Runs the REAL `IcloudAuthService.create()` factory against the wire-level mock
 * router, then exercises the lazy `account` accessor.
 */
import nock from 'nock';

import { IcloudHttpService } from '../src/session/icloud-http.service';
import {
  AccountService,
  AccountStorage,
} from '../src/services/account.service';

import { installMockRouter } from './helpers/mock-router';
import { resetAuthState } from './helpers/auth-state';
import { makeAuthService, MadeService } from './helpers/make-service';

describe('AccountService', () => {
  let made: MadeService;

  beforeEach(() => {
    installMockRouter();
  });

  afterEach(async () => {
    nock.cleanAll();
    resetAuthState();
    if (made) {
      await made.cleanup();
    }
  });

  describe('devices', () => {
    beforeEach(async () => {
      made = await makeAuthService();
    });

    it('returns the two paired devices', async () => {
      const devices = await made.service.account.devices();
      expect(devices).toHaveLength(2);
    });

    it('exposes typed (camelCase) device fields', async () => {
      const devices = await made.service.account.devices();

      const macbook = devices[0];
      expect(macbook.name).toBe('MacBook Pro de Quentin');
      expect(macbook.modelDisplayName).toBe('MacBook Pro 15"');
      expect(macbook.model).toBe('MacBookPro15,1');

      const iphone = devices[1];
      expect(iphone.name).toBe('iPhone de Quentin');
      expect(iphone.modelDisplayName).toBe('iPhone 11');
      expect(iphone.model).toBe('iPhone12,1');
    });

    it('caches the device list (single fetch)', async () => {
      const spy = jest.spyOn(made.service.account['http'], 'request');
      await made.service.account.devices();
      await made.service.account.devices();
      const getDeviceCalls = spy.mock.calls.filter((c) =>
        String(c[1]).includes('device/getDevices'),
      );
      expect(getDeviceCalls).toHaveLength(1);
    });
  });

  describe('family', () => {
    beforeEach(async () => {
      made = await makeAuthService();
    });

    it('returns the three family members', async () => {
      const family = await made.service.account.family();
      expect(family).toHaveLength(3);
    });

    it('exposes typed family-member getters', async () => {
      const family = await made.service.account.family();

      const organizer = family[0];
      expect(organizer.fullName).toBe('Quentin TARANTINO');
      expect(organizer.lastName).toBe('TARANTINO');
      expect(organizer.dsid).toBe('quentintarantino');
      expect(organizer.appleId).toBe('quentintarantino@hotmail.fr');
      expect(organizer.hasParentalPrivileges).toBe(true);
      expect(organizer.hasShareMyLocationEnabled).toBe(true);
      expect(organizer.ageClassification).toBe('ADULT');

      expect(family[1].fullName).toBe('Uma THURMAN');
      expect(family[1].hasParentalPrivileges).toBe(false);
      expect(family[2].fullName).toBe('John TRAVOLTA');
    });

    it('streams a member photo', async () => {
      const family = await made.service.account.family();
      const stream = await family[0].getPhoto();

      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk as Buffer));
      }
      expect(Buffer.concat(chunks).toString()).toBe('photo-bytes');
    });
  });

  describe('storage', () => {
    beforeEach(async () => {
      made = await makeAuthService();
    });

    it('reports 43.75% used of 5368709120 bytes', async () => {
      const storage: AccountStorage = await made.service.account.storage();

      expect(storage.usage.totalStorageInBytes).toBe(5368709120);
      expect(storage.usage.usedStorageInBytes).toBe(2348632876);
      // 2348632876 * 100 / 5368709120 == 43.7461... -> round(., 2) == 43.75
      expect(storage.usage.usedStorageInPercent).toBe(43.75);
    });

    it('computes available storage and percent', async () => {
      const storage = await made.service.account.storage();

      expect(storage.usage.availableStorageInBytes).toBe(
        5368709120 - 2348632876,
      );
      // 56.25 complement of 43.75 (rounded independently).
      expect(storage.usage.availableStorageInPercent).toBe(56.25);
    });

    it('builds the per-media usage map keyed by mediaKey', async () => {
      const storage = await made.service.account.storage();

      expect(Object.keys(storage.usagesByMedia)).toEqual([
        'photos',
        'backup',
        'docs',
        'mail',
      ]);
      const backup = storage.usagesByMedia['backup'];
      expect(backup.key).toBe('backup');
      expect(backup.label).toBe('Sauvegarde');
      expect(backup.color).toBe('5856d6');
      expect(backup.usageInBytes).toBe(799008186);
    });

    it('exposes the quota flags', async () => {
      const storage = await made.service.account.storage();
      expect(storage.usage.quotaOver).toBe(false);
      expect(storage.usage.quotaTierMax).toBe(false);
      expect(storage.usage.quotaAlmostFull).toBe(false);
      expect(storage.usage.quotaPaid).toBe(false);
    });
  });

  describe('FIX #2 — CN-aware storage URL', () => {
    it('GLOBAL: storage URL targets the global setup endpoint', async () => {
      made = await makeAuthService();

      const http: IcloudHttpService = made.service.account['http'];
      const spy = jest.spyOn(http, 'request');

      await made.service.account.storage();

      const storageCall = spy.mock.calls.find((c) =>
        String(c[1]).includes('storageUsageInfo'),
      );
      expect(storageCall).toBeDefined();
      const url = String(storageCall![1]);
      // Built from the GLOBAL setup endpoint.
      expect(url).toBe(
        'https://setup.icloud.com/setup/ws/1/storageUsageInfo',
      );
      expect(url).not.toContain('.com.cn');
    });

    it('CHINA: storage URL targets the .com.cn setup endpoint (NOT hardcoded global)', async () => {
      made = await makeAuthService({ chinaMainland: true });

      const http: IcloudHttpService = made.service.account['http'];
      const spy = jest.spyOn(http, 'request');

      const storage = await made.service.account.storage();

      const storageCall = spy.mock.calls.find((c) =>
        String(c[1]).includes('storageUsageInfo'),
      );
      expect(storageCall).toBeDefined();
      const url = String(storageCall![1]);
      // FIX #2: respects China mode — `.com.cn` host, built from setupEndpoint.
      expect(url).toBe(
        'https://setup.icloud.com.cn/setup/ws/1/storageUsageInfo',
      );

      // And the call still resolves against the (path-routed) mock.
      expect(storage.usage.usedStorageInPercent).toBe(43.75);
    });
  });

  it('AccountService constructor builds the storage URL from setupEndpoint', () => {
    const fakeHttp = {} as IcloudHttpService;
    const svc = new AccountService(
      'https://p31-account.icloud.com.cn:443',
      fakeHttp,
      {},
      'https://setup.icloud.com.cn/setup/ws/1',
    );
    // Access the private field for a direct assertion on the FIX #2 wiring.
    expect(svc['storageUrl']).toBe(
      'https://setup.icloud.com.cn/setup/ws/1/storageUsageInfo',
    );
    expect(svc['accEndpoint']).toBe(
      'https://p31-account.icloud.com.cn:443/setup/web',
    );
  });
});
