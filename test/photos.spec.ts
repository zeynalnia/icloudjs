/**
 * photos.spec.ts — PhotosService / PhotoAlbum / PhotoAsset (plan §4.6, §5.2).
 *
 * These tests mock the HTTP chokepoint (`IcloudHttpService.request`) directly
 * and inspect the request bodies, so the load-bearing CloudKit invariants are
 * asserted at the wire-body level:
 *
 *   - the CheckIndexingState gate (non-FINISHED → NotActivated);
 *   - base64 decoding of album names (`albumNameEnc`) and file names
 *     (`filenameEnc`);
 *   - user albums constructed with list_type=`CPLContainerRelationLiveByAssetDate`
 *     and obj_type=`CPLContainerRelationNotDeletedByAssetDate:<id>` — roles NOT
 *     swapped;
 *   - `length()` puts **objType** into the `indexCountID` filter value;
 *   - pagination uses **listType** as the `recordType`;
 *   - delete uses the MASTER record's recordChangeTag with the ASSET record's
 *     recordName/recordType;
 *   - every CloudKit POST carries `Content-Type: text/plain`.
 */
import { AxiosResponse } from 'axios';

import {
  PhotoAlbum,
  PhotoAsset,
  PhotosService,
} from '../src/services/photos.service';
import { IcloudHttpService } from '../src/session/icloud-http.service';
import { PyiCloudServiceNotActivatedException } from '../src/exceptions/icloud.exceptions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVICE_ROOT = 'https://p31-ckdatabasews.icloud.com';
const SERVICE_ENDPOINT = `${SERVICE_ROOT}/database/1/com.apple.photos.cloud/production/private`;

/** A captured `request()` call. */
interface Captured {
  method: string;
  url: string;
  data: any;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  responseType?: string;
}

/**
 * A stubbed {@link IcloudHttpService} whose `request` is driven by a
 * caller-supplied responder. Records every call into `calls`.
 */
function makeHttp(
  responder: (method: string, url: string, opts: any) => unknown,
): { http: IcloudHttpService; calls: Captured[] } {
  const calls: Captured[] = [];
  const request = jest.fn(async (method: string, url: string, opts: any = {}) => {
    calls.push({
      method,
      url,
      data: opts.data,
      params: opts.params,
      headers: opts.headers,
      responseType: opts.responseType,
    });
    const data = responder(method, url, opts);
    return { data } as AxiosResponse;
  });
  const http = { request } as unknown as IcloudHttpService;
  return { http, calls };
}

const INDEXING_FINISHED = {
  records: [{ fields: { state: { value: 'FINISHED' } } }],
};

/** Build a PhotosService whose indexing probe has already succeeded. */
async function makeService(
  responder: (method: string, url: string, opts: any) => unknown,
): Promise<{ service: PhotosService; calls: Captured[] }> {
  const { http, calls } = makeHttp(responder);
  const service = new PhotosService(SERVICE_ROOT, http, {
    clientId: 'CLIENT_ID',
    dsid: '12345',
  });
  await service.init();
  return { service, calls };
}

/** base64-encode a UTF-8 string (mirrors what iCloud stores in *Enc fields). */
function b64(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64');
}

// ---------------------------------------------------------------------------
// init() — CheckIndexingState gate
// ---------------------------------------------------------------------------

describe('PhotosService.init (CheckIndexingState gate)', () => {
  it('passes when indexing state is FINISHED', async () => {
    const { service, calls } = await makeService(() => INDEXING_FINISHED);

    expect(service.serviceEndpoint).toBe(SERVICE_ENDPOINT);
    // Probe hit the records/query endpoint with the literal CheckIndexingState body.
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`${SERVICE_ENDPOINT}/records/query`);
    expect(JSON.parse(calls[0].data)).toEqual({
      query: { recordType: 'CheckIndexingState' },
      zoneID: { zoneName: 'PrimarySync' },
    });
    // text/plain on the probe.
    expect(calls[0].headers).toMatchObject({ 'Content-Type': 'text/plain' });
    // params carry the CloudKit flags + the original bag.
    expect(calls[0].params).toMatchObject({
      clientId: 'CLIENT_ID',
      dsid: '12345',
      remapEnums: 'true',
      getCurrentSyncToken: 'true',
    });
  });

  it('throws PyiCloudServiceNotActivatedException when not FINISHED', async () => {
    const { http } = makeHttp(() => ({
      records: [{ fields: { state: { value: 'RUNNING' } } }],
    }));
    const service = new PhotosService(SERVICE_ROOT, http, {});

    await expect(service.init()).rejects.toBeInstanceOf(
      PyiCloudServiceNotActivatedException,
    );
  });

  it('does not mutate the shared params bag', async () => {
    const shared: Record<string, string> = { clientId: 'X' };
    const { http } = makeHttp(() => INDEXING_FINISHED);
    const service = new PhotosService(SERVICE_ROOT, http, shared);
    await service.init();

    // The original bag is untouched; the flags live only on the copy.
    expect(shared).toEqual({ clientId: 'X' });
    expect(service.params).toMatchObject({
      clientId: 'X',
      remapEnums: 'true',
      getCurrentSyncToken: 'true',
    });
  });
});

// ---------------------------------------------------------------------------
// albums() — base64 names + user-album role assignment
// ---------------------------------------------------------------------------

describe('PhotosService.albums', () => {
  /** A folders response with one valid album, one root, one deleted, one nameless. */
  function foldersResponse() {
    return {
      records: [
        {
          recordName: 'ALBUM-ID-1',
          recordType: 'CPLAlbum',
          fields: { albumNameEnc: { value: b64('Holiday 2024') } },
        },
        {
          recordName: '----Root-Folder----',
          recordType: 'CPLAlbum',
          fields: { albumNameEnc: { value: b64('root') } },
        },
        {
          recordName: 'ALBUM-DELETED',
          recordType: 'CPLAlbum',
          fields: {
            albumNameEnc: { value: b64('Trashed') },
            isDeleted: { value: 1 },
          },
        },
        {
          recordName: 'ALBUM-NONAME',
          recordType: 'CPLAlbum',
          fields: {},
        },
      ],
    };
  }

  function responder(method: string, url: string, opts: any) {
    if (url.endsWith('/records/query')) {
      const body = JSON.parse(opts.data);
      if (body.query?.recordType === 'CheckIndexingState') return INDEXING_FINISHED;
      if (body.query?.recordType === 'CPLAlbumByPositionLive') return foldersResponse();
    }
    throw new Error(`unexpected: ${method} ${url} ${opts.data}`);
  }

  it('includes the 11 smart folders plus user albums (skipping root/deleted/nameless)', async () => {
    const { service } = await makeService(responder);
    const albums = await service.albums();

    // 11 smart folders + 1 valid user album.
    expect(Object.keys(albums)).toContain('All Photos');
    expect(Object.keys(albums)).toContain('Hidden');
    expect(albums['Holiday 2024']).toBeInstanceOf(PhotoAlbum);

    // The skipped folders are absent.
    expect(albums['Trashed']).toBeUndefined();
    expect(albums['root']).toBeUndefined();
    expect(Object.keys(albums)).toHaveLength(12);
  });

  it('decodes the album name from base64 albumNameEnc', async () => {
    const { service } = await makeService(responder);
    const albums = await service.albums();
    expect(albums['Holiday 2024']).toBeDefined();
    expect(albums['Holiday 2024'].name).toBe('Holiday 2024');
  });

  it('assigns user-album list_type and obj_type roles WITHOUT swapping them', async () => {
    const { service } = await makeService(responder);
    const album = (await service.albums())['Holiday 2024'];

    // POSITION 3 (listType) — the LIVE relation.
    expect(album.listType).toBe('CPLContainerRelationLiveByAssetDate');
    // POSITION 4 (objType) — the NOT-deleted relation, suffixed with the id.
    expect(album.objType).toBe(
      'CPLContainerRelationNotDeletedByAssetDate:ALBUM-ID-1',
    );

    // Explicitly assert they are NOT the reverse.
    expect(album.objType).not.toBe('CPLContainerRelationLiveByAssetDate');
    expect(album.listType).not.toBe(
      'CPLContainerRelationNotDeletedByAssetDate:ALBUM-ID-1',
    );
  });

  it('All Photos smart folder keeps the pinned list_type/obj_type roles', async () => {
    const { service } = await makeService(responder);
    const all = await service.all();
    // From SMART_FOLDERS['All Photos']: list_type vs obj_type are distinct roles.
    expect(all.listType).toBe('CPLAssetAndMasterByAddedDate'); // POSITION 3
    expect(all.objType).toBe('CPLAssetByAddedDate'); // POSITION 4
  });
});

// ---------------------------------------------------------------------------
// PhotoAlbum.length() — objType drives indexCountID
// ---------------------------------------------------------------------------

describe('PhotoAlbum.length', () => {
  it('puts objType (POSITION 4) into the indexCountID filter value', async () => {
    const { http, calls } = makeHttp((_m, url) => {
      if (url.endsWith('/internal/records/query/batch')) {
        return { batch: [{ records: [{ fields: { itemCount: { value: 42 } } }] }] };
      }
      throw new Error(`unexpected ${url}`);
    });
    const service = new PhotosService(SERVICE_ROOT, http, {});

    const album = new PhotoAlbum(
      service,
      'My Album',
      'LIST_TYPE_VALUE', // listType (POSITION 3)
      'OBJ_TYPE_VALUE', // objType  (POSITION 4)
      'ASCENDING',
    );

    expect(await album.length()).toBe(42);

    const call = calls[0];
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${SERVICE_ENDPOINT}/internal/records/query/batch`);
    expect(call.headers).toMatchObject({ 'Content-Type': 'text/plain' });

    const body = JSON.parse(call.data);
    const filter = body.batch[0].query.filterBy;
    expect(body.batch[0].query.recordType).toBe('HyperionIndexCountLookup');
    expect(filter.fieldName).toBe('indexCountID');
    // The value array carries objType — NOT listType.
    expect(filter.fieldValue.value).toEqual(['OBJ_TYPE_VALUE']);
    expect(filter.fieldValue.value).not.toContain('LIST_TYPE_VALUE');
  });

  it('caches the length (single HTTP call across repeated calls)', async () => {
    const { http, calls } = makeHttp(() => ({
      batch: [{ records: [{ fields: { itemCount: { value: 7 } } }] }],
    }));
    const service = new PhotosService(SERVICE_ROOT, http, {});
    const album = new PhotoAlbum(service, 'A', 'L', 'O', 'ASCENDING');

    expect(await album.length()).toBe(7);
    expect(await album.length()).toBe(7);
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// PhotoAlbum pagination — listType drives recordType; master/asset pairing
// ---------------------------------------------------------------------------

describe('PhotoAlbum pagination', () => {
  /** Build a CPLMaster + CPLAsset pair for one logical photo. */
  function photoPair(id: string, filename: string) {
    return [
      {
        recordName: id,
        recordType: 'CPLMaster',
        recordChangeTag: `master-tag-${id}`,
        fields: {
          filenameEnc: { value: b64(filename) },
          resOriginalRes: { value: { size: 1000, downloadURL: 'orig-url' } },
          resOriginalWidth: { value: 100 },
          resOriginalHeight: { value: 200 },
          resOriginalFileType: { value: 'public.jpeg' },
        },
      },
      {
        recordName: `${id}-asset`,
        recordType: 'CPLAsset',
        recordChangeTag: `asset-tag-${id}`,
        fields: {
          masterRef: { value: { recordName: id } },
          assetDate: { value: 1700000000000 },
          addedDate: { value: 1700000001000 },
        },
      },
    ];
  }

  it('uses listType (POSITION 3) as the records/query recordType', async () => {
    let page = 0;
    const { http, calls } = makeHttp((_m, url) => {
      if (url.endsWith('/records/query')) {
        page += 1;
        // First page: one photo; second page: empty → stop.
        return page === 1
          ? { records: photoPair('M1', 'IMG_0001.JPG') }
          : { records: [] };
      }
      throw new Error(`unexpected ${url}`);
    });
    const service = new PhotosService(SERVICE_ROOT, http, {});
    const album = new PhotoAlbum(
      service,
      'Album',
      'THE_LIST_TYPE', // listType (POSITION 3)
      'THE_OBJ_TYPE', // objType  (POSITION 4)
      'ASCENDING',
    );

    const assets: PhotoAsset[] = [];
    for await (const a of album) assets.push(a);

    expect(assets).toHaveLength(1);

    // Every page-query body uses listType as the recordType (NOT objType).
    const queryCalls = calls.filter((c) => c.url.endsWith('/records/query'));
    expect(queryCalls.length).toBeGreaterThanOrEqual(1);
    for (const c of queryCalls) {
      const body = JSON.parse(c.data);
      expect(body.query.recordType).toBe('THE_LIST_TYPE');
      expect(body.query.recordType).not.toBe('THE_OBJ_TYPE');
      expect(c.headers).toMatchObject({ 'Content-Type': 'text/plain' });
    }
  });

  it('pairs each CPLMaster with its CPLAsset by masterRef.recordName', async () => {
    let page = 0;
    const { http } = makeHttp((_m, url) => {
      if (url.endsWith('/records/query')) {
        page += 1;
        return page === 1
          ? { records: photoPair('M1', 'IMG_0001.JPG') }
          : { records: [] };
      }
      throw new Error(`unexpected ${url}`);
    });
    const service = new PhotosService(SERVICE_ROOT, http, {});
    const album = new PhotoAlbum(service, 'Album', 'L', 'O', 'ASCENDING');

    const assets: PhotoAsset[] = [];
    for await (const a of album) assets.push(a);

    expect(assets).toHaveLength(1);
    // base64-decoded filename pulled from the master record.
    expect(assets[0].filename).toBe('IMG_0001.JPG');
    expect(assets[0].id).toBe('M1');
    expect(assets[0].size).toBe(1000);
    expect(assets[0].dimensions).toEqual([100, 200]);
  });

  it('starts DESCENDING albums at length-1 and walks the offset down', async () => {
    const startRanks: number[] = [];
    let page = 0;
    const { http } = makeHttp((_m, url, opts) => {
      if (url.endsWith('/internal/records/query/batch')) {
        return { batch: [{ records: [{ fields: { itemCount: { value: 3 } } }] }] };
      }
      if (url.endsWith('/records/query')) {
        const body = JSON.parse(opts.data);
        const startRank = body.query.filterBy.find(
          (f: any) => f.fieldName === 'startRank',
        ).fieldValue.value;
        startRanks.push(startRank);
        page += 1;
        return page === 1
          ? { records: photoPair('M1', 'a.jpg') }
          : { records: [] };
      }
      throw new Error(`unexpected ${url}`);
    });
    const service = new PhotosService(SERVICE_ROOT, http, {});
    const album = new PhotoAlbum(service, 'D', 'L', 'O', 'DESCENDING');

    const collected: PhotoAsset[] = [];
    for await (const a of album) collected.push(a);

    // length()===3 → first startRank is 2 (len-1); after 1 master, next is 1.
    expect(startRanks[0]).toBe(2);
    expect(startRanks[1]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PhotoAsset.delete — record-tag mix (asset name/type, master changeTag)
// ---------------------------------------------------------------------------

describe('PhotoAsset', () => {
  function buildAsset() {
    const { http, calls } = makeHttp(() => ({ records: [] }));
    const service = new PhotosService(SERVICE_ROOT, http, {});
    const master = {
      recordName: 'MASTER-NAME',
      recordType: 'CPLMaster',
      recordChangeTag: 'MASTER-CHANGE-TAG',
      fields: {
        filenameEnc: { value: b64('vacation.heic') },
        resOriginalRes: { value: { size: 50, downloadURL: 'u' } },
        resOriginalWidth: { value: 1 },
        resOriginalHeight: { value: 1 },
      },
    };
    const asset = {
      recordName: 'ASSET-NAME',
      recordType: 'CPLAsset',
      recordChangeTag: 'ASSET-CHANGE-TAG',
      fields: { assetDate: { value: 0 }, addedDate: { value: 0 } },
    };
    return { service, calls, photo: new PhotoAsset(service, master, asset) };
  }

  it('decodes the filename from base64 filenameEnc', () => {
    const { photo } = buildAsset();
    expect(photo.filename).toBe('vacation.heic');
  });

  it('delete uses the ASSET recordName/recordType but the MASTER recordChangeTag', async () => {
    const { calls, photo } = buildAsset();
    await photo.delete();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${SERVICE_ENDPOINT}/records/modify`);
    expect(calls[0].headers).toMatchObject({ 'Content-Type': 'text/plain' });

    const body = JSON.parse(calls[0].data);
    const record = body.operations[0].record;
    expect(record.recordName).toBe('ASSET-NAME'); // from asset
    expect(record.recordType).toBe('CPLAsset'); // from asset
    expect(record.recordChangeTag).toBe('MASTER-CHANGE-TAG'); // from MASTER
    // Explicitly NOT the asset's change tag.
    expect(record.recordChangeTag).not.toBe('ASSET-CHANGE-TAG');
    expect(record.fields.isDeleted.value).toBe(1);
    expect(body.atomic).toBe(true);
  });

  it('download returns null for a missing version', async () => {
    const { photo } = buildAsset();
    // No medium/thumb resources present → original-only versions map.
    expect(await photo.download('nonexistent')).toBeNull();
  });
});
