/**
 * PhotosService + PhotoAlbum + PhotoAsset — TypeScript port of
 * `pyicloud/services/photos.py` (CloudKit Database web API).
 *
 * Plan §4.6. The load-bearing invariants (DO NOT regress):
 *
 *   - PhotoAlbum constructor positional order is PINNED to the Python signature
 *     `(service, name, list_type, obj_type, direction, query_filter=None,
 *     page_size=100)` — `listType` is POSITION 3, `objType` is POSITION 4.
 *   - `length()` puts **objType** into the `indexCountID` filter value.
 *   - Pagination uses **listType** as the `recordType` of the records/query body.
 *   - User albums are built with `list_type='CPLContainerRelationLiveByAssetDate'`
 *     and `obj_type='CPLContainerRelationNotDeletedByAssetDate:<folderId>'`
 *     (NOT the reverse — swapping breaks both counting and pagination).
 *   - `init()` runs the `CheckIndexingState` probe and throws
 *     `PyiCloudServiceNotActivatedException` unless state === 'FINISHED'.
 *   - Album and file names are base64-decoded (`albumNameEnc` / `filenameEnc`).
 *   - `delete()` mixes records: recordName/recordType from the ASSET record,
 *     recordChangeTag from the MASTER record (preserve — wrong mix → change-tag
 *     mismatch failure).
 *   - All CloudKit POSTs carry `Content-Type: text/plain` (iCloud rejects
 *     application/json on these endpoints).
 *
 * The query string mirrors Python: `self.params` (which already carries
 * clientId/dsid/build numbers) augmented with `remapEnums=true` and
 * `getCurrentSyncToken=true`.
 */
import { Readable } from 'stream';
import { AxiosResponse } from 'axios';

import {
  PHOTO_VERSION_LOOKUP,
  SMART_FOLDERS,
  SmartFolderDef,
  VIDEO_VERSION_LOOKUP,
} from '../constants';
import { PyiCloudServiceNotActivatedException } from '../exceptions/icloud.exceptions';
import { IcloudHttpService } from '../session/icloud-http.service';

/** The extra CloudKit query flags appended to `params` for every photos call. */
const PHOTO_QUERY_FLAGS = {
  remapEnums: 'true',
  getCurrentSyncToken: 'true',
} as const;

/** `text/plain` header object reused on every CloudKit POST. */
const TEXT_PLAIN = { 'Content-Type': 'text/plain' } as const;

/**
 * A single CloudKit field value (`{value, type}`). CloudKit field values are
 * heterogeneous (numbers, strings, `{size, downloadURL}` resource objects,
 * `{recordName}` references), so `value` is intentionally untyped and narrowed
 * at each read site.
 */
interface CloudKitFieldValue {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any;
  type?: string;
}

/** A CloudKit record (`recordName`, `recordType`, `recordChangeTag`, `fields`). */
interface CloudKitRecord {
  recordName: string;
  recordType: string;
  recordChangeTag?: string;
  fields: Record<string, CloudKitFieldValue>;
}

/** A single resolved photo/video version descriptor. */
export interface PhotoVersion {
  filename: string;
  width: number | null;
  height: number | null;
  size: number | null;
  url: string | null;
  type: string | null;
}

// ---------------------------------------------------------------------------
// PhotosService
// ---------------------------------------------------------------------------

export class PhotosService {
  /** `serviceRoot + '/database/1/com.apple.photos.cloud/production/private'`. */
  readonly serviceEndpoint: string;

  /** A COPY of the shared params bag, augmented with the CloudKit flags. */
  readonly params: Record<string, string>;

  /** Lazily-built album map (smart folders + user albums). */
  private _albums?: Record<string, PhotoAlbum>;

  constructor(
    private readonly serviceRoot: string,
    readonly http: IcloudHttpService,
    params: Record<string, string>,
  ) {
    // Copy params (Python `dict(params)`), then add the two CloudKit flags so
    // the original shared bag is not mutated.
    this.params = { ...params, ...PHOTO_QUERY_FLAGS };
    this.serviceEndpoint = `${serviceRoot}/database/1/com.apple.photos.cloud/production/private`;
  }

  /**
   * Runs the `CheckIndexingState` probe. Throws
   * `PyiCloudServiceNotActivatedException` unless the indexing state is
   * `'FINISHED'` (mirrors `PhotosService.__init__`).
   */
  async init(): Promise<void> {
    const body =
      '{"query":{"recordType":"CheckIndexingState"},' +
      '"zoneID":{"zoneName":"PrimarySync"}}';

    const response = await this.post<{
      records: Array<{ fields: { state: { value: string } } }>;
    }>(`${this.serviceEndpoint}/records/query`, body);

    const indexingState = response.data.records[0].fields.state.value;
    if (indexingState !== 'FINISHED') {
      throw new PyiCloudServiceNotActivatedException(
        'iCloud Photo Library not finished indexing. ' +
          'Please try again in a few minutes.',
      );
    }
  }

  /**
   * The album map. Starts from the 11 hard-coded SMART_FOLDERS, then merges the
   * user albums from `_fetchFolders()` (recordType `CPLAlbumByPositionLive`),
   * skipping folders lacking `albumNameEnc`, the `----Root-Folder----` record,
   * and `isDeleted` folders. Names are base64-decoded.
   */
  async albums(): Promise<Record<string, PhotoAlbum>> {
    if (!this._albums) {
      const albums: Record<string, PhotoAlbum> = {};

      // Smart folders — spread the SMART_FOLDERS def, honoring the PINNED
      // positional order: (service, name, list_type, obj_type, direction,
      // query_filter).
      for (const [name, def] of Object.entries(SMART_FOLDERS)) {
        albums[name] = new PhotoAlbum(
          this,
          name,
          def.list_type,
          def.obj_type,
          def.direction,
          def.query_filter,
        );
      }

      // User albums.
      for (const folder of await this._fetchFolders()) {
        const fields = folder.fields ?? {};

        // Skip albums having a null name (can happen sometimes).
        if (!('albumNameEnc' in fields)) {
          continue;
        }

        // Skip the root folder and deleted folders. (Subfolders are flattened
        // by name; collisions overwrite — matches Python, which does not handle
        // subfolders.)
        const isDeleted = fields.isDeleted && fields.isDeleted.value;
        if (folder.recordName === '----Root-Folder----' || isDeleted) {
          continue;
        }

        const folderId = folder.recordName;
        // POSITION 4 (obj_type): the per-folder relation, suffixed with the id.
        const folderObjType = `CPLContainerRelationNotDeletedByAssetDate:${folderId}`;
        // Base64-decode the album name (UTF-8).
        const folderName = Buffer.from(
          fields.albumNameEnc.value,
          'base64',
        ).toString('utf-8');

        const queryFilter: SmartFolderDef['query_filter'] = [
          {
            fieldName: 'parentId',
            comparator: 'EQUALS',
            fieldValue: { type: 'STRING', value: folderId },
          },
        ];

        // PINNED positional order (Python photos.py:198-205):
        //   (this, name, list_type, obj_type, direction, query_filter)
        // list_type = 'CPLContainerRelationLiveByAssetDate'  (POSITION 3)
        // obj_type  = 'CPLContainerRelationNotDeletedByAssetDate:<id>' (POSITION 4)
        albums[folderName] = new PhotoAlbum(
          this,
          folderName,
          'CPLContainerRelationLiveByAssetDate',
          folderObjType,
          'ASCENDING',
          queryFilter,
        );
      }

      this._albums = albums;
    }

    return this._albums;
  }

  /** Fetch the user-album folder records (`CPLAlbumByPositionLive`). */
  private async _fetchFolders(): Promise<CloudKitRecord[]> {
    const body =
      '{"query":{"recordType":"CPLAlbumByPositionLive"},' +
      '"zoneID":{"zoneName":"PrimarySync"}}';

    const response = await this.post<{ records: CloudKitRecord[] }>(
      `${this.serviceEndpoint}/records/query`,
      body,
    );
    return response.data.records;
  }

  /** The "All Photos" album. */
  async all(): Promise<PhotoAlbum> {
    return (await this.albums())['All Photos'];
  }

  /**
   * Shared CloudKit POST helper: sends a `text/plain` body and passes the
   * augmented `params` as the query string (mirrors `urlencode(self.params)`).
   */
  post<T = unknown>(url: string, body: string): Promise<AxiosResponse<T>> {
    return this.http.request<T>('POST', url, {
      data: body,
      params: this.params,
      headers: { ...TEXT_PLAIN },
    });
  }
}

// ---------------------------------------------------------------------------
// PhotoAlbum
// ---------------------------------------------------------------------------

/**
 * A photo album. Length-aware and async-iterable over its {@link PhotoAsset}s.
 *
 * PINNED constructor signature (mirrors Python exactly):
 *   `(service, name, listType, objType, direction, queryFilter=null, pageSize=100)`
 * — `listType` is POSITION 3, `objType` is POSITION 4. DO NOT swap them.
 */
export class PhotoAlbum implements AsyncIterable<PhotoAsset> {
  /** Cached item count (filled by {@link length}). */
  private _len?: number;

  constructor(
    private readonly service: PhotosService,
    readonly name: string,
    /** POSITION 3 — used as the `recordType` in pagination queries. */
    readonly listType: string,
    /** POSITION 4 — used as the `indexCountID` value in {@link length}. */
    readonly objType: string,
    readonly direction: 'ASCENDING' | 'DESCENDING',
    readonly queryFilter: SmartFolderDef['query_filter'] = null,
    readonly pageSize = 100,
  ) {}

  /** The album name (Python `title` property === `name`). */
  get title(): string {
    return this.name;
  }

  /**
   * The album's photo count. `POST .../internal/records/query/batch` with a
   * `HyperionIndexCountLookup` filtered by `indexCountID IN [objType]`.
   *
   * CRITICAL: the value placed in `indexCountID` is **objType** (POSITION 4).
   */
  async length(): Promise<number> {
    if (this._len === undefined) {
      const body = JSON.stringify({
        batch: [
          {
            resultsLimit: 1,
            query: {
              filterBy: {
                fieldName: 'indexCountID',
                fieldValue: {
                  type: 'STRING_LIST',
                  // objType — NOT listType.
                  value: [this.objType],
                },
                comparator: 'IN',
              },
              recordType: 'HyperionIndexCountLookup',
            },
            zoneWide: true,
            zoneID: { zoneName: 'PrimarySync' },
          },
        ],
      });

      const response = await this.service.post<{
        batch: Array<{
          records: Array<{ fields: { itemCount: { value: number } } }>;
        }>;
      }>(`${this.service.serviceEndpoint}/internal/records/query/batch`, body);

      this._len = response.data.batch[0].records[0].fields.itemCount.value;
    }

    return this._len;
  }

  /**
   * Iterate the album's photos via rank-based pagination.
   *
   * Start offset = `length()-1` for DESCENDING, else 0. Each page POSTs
   * `records/query` with `_listQueryGen` (recordType === **listType**),
   * partitions records into CPLAsset (keyed by `masterRef.recordName`) and
   * CPLMaster, advances the offset by the master count (down for DESCENDING, up
   * otherwise), yields one PhotoAsset per master, and stops on an empty page.
   */
  async *[Symbol.asyncIterator](): AsyncIterator<PhotoAsset> {
    let offset = this.direction === 'DESCENDING' ? (await this.length()) - 1 : 0;

    for (;;) {
      const body = JSON.stringify(
        this._listQueryGen(offset, this.listType, this.direction, this.queryFilter),
      );

      const response = await this.service.post<{ records: CloudKitRecord[] }>(
        `${this.service.serviceEndpoint}/records/query`,
        body,
      );

      const assetRecords: Record<string, CloudKitRecord> = {};
      const masterRecords: CloudKitRecord[] = [];
      for (const rec of response.data.records) {
        if (rec.recordType === 'CPLAsset') {
          const masterId = rec.fields.masterRef.value.recordName as string;
          assetRecords[masterId] = rec;
        } else if (rec.recordType === 'CPLMaster') {
          masterRecords.push(rec);
        }
      }

      const masterCount = masterRecords.length;
      if (masterCount) {
        offset =
          this.direction === 'DESCENDING' ? offset - masterCount : offset + masterCount;

        for (const master of masterRecords) {
          yield new PhotoAsset(
            this.service,
            master,
            assetRecords[master.recordName],
          );
        }
      } else {
        break;
      }
    }
  }

  /**
   * Build the `records/query` body for a page. `recordType` === **listType**
   * (POSITION 3); `resultsLimit` === `pageSize * 2` (each logical photo is two
   * records: a CPLAsset and a CPLMaster). Extends `filterBy` with `queryFilter`
   * when present.
   */
  private _listQueryGen(
    offset: number,
    listType: string,
    direction: string,
    queryFilter: SmartFolderDef['query_filter'],
  ): Record<string, unknown> {
    const filterBy: Array<Record<string, unknown>> = [
      {
        fieldName: 'startRank',
        fieldValue: { type: 'INT64', value: offset },
        comparator: 'EQUALS',
      },
      {
        fieldName: 'direction',
        fieldValue: { type: 'STRING', value: direction },
        comparator: 'EQUALS',
      },
    ];

    if (queryFilter) {
      filterBy.push(...queryFilter);
    }

    return {
      query: {
        filterBy,
        // recordType is listType (POSITION 3) — NOT objType.
        recordType: listType,
      },
      resultsLimit: this.pageSize * 2,
      desiredKeys: PHOTO_DESIRED_KEYS,
      zoneID: { zoneName: 'PrimarySync' },
    };
  }

  toString(): string {
    return this.title;
  }
}

// ---------------------------------------------------------------------------
// PhotoAsset
// ---------------------------------------------------------------------------

/** A single photo (or video) asset, pairing a CPLMaster + CPLAsset record. */
export class PhotoAsset {
  private _versions?: Record<string, PhotoVersion>;

  constructor(
    private readonly service: PhotosService,
    private readonly masterRecord: CloudKitRecord,
    private readonly assetRecord: CloudKitRecord,
  ) {}

  /** The photo id (master record name). */
  get id(): string {
    return this.masterRecord.recordName;
  }

  /** The decoded file name (base64 `filenameEnc`, UTF-8). */
  get filename(): string {
    return Buffer.from(
      this.masterRecord.fields.filenameEnc.value,
      'base64',
    ).toString('utf-8');
  }

  /** Original-resolution byte size. */
  get size(): number {
    return this.masterRecord.fields.resOriginalRes.value.size;
  }

  /** Alias of {@link assetDate} (Python `created`). */
  get created(): Date {
    return this.assetDate;
  }

  /** The asset date (ms-epoch UTC), falling back to epoch 0 if absent. */
  get assetDate(): Date {
    const entry = this.assetRecord.fields.assetDate;
    if (!entry) {
      return new Date(0);
    }
    return new Date(entry.value);
  }

  /** The added date (ms-epoch UTC). */
  get addedDate(): Date {
    return new Date(this.assetRecord.fields.addedDate.value);
  }

  /** Original-resolution `[width, height]`. */
  get dimensions(): [number, number] {
    const fields = this.masterRecord.fields;
    return [fields.resOriginalWidth.value, fields.resOriginalHeight.value];
  }

  /**
   * The resolved versions map. Uses VIDEO_VERSION_LOOKUP when `resVidSmallRes`
   * is present, else PHOTO_VERSION_LOOKUP. Each version reads
   * `<prefix>{Width,Height,Res,FileType}` (with `Res.value.{size,downloadURL}`).
   */
  get versions(): Record<string, PhotoVersion> {
    if (!this._versions) {
      const fields = this.masterRecord.fields;
      const lookup =
        'resVidSmallRes' in fields ? VIDEO_VERSION_LOOKUP : PHOTO_VERSION_LOOKUP;

      const versions: Record<string, PhotoVersion> = {};
      for (const [key, prefix] of Object.entries(lookup)) {
        if (`${prefix}Res` in fields) {
          const widthEntry = fields[`${prefix}Width`];
          const heightEntry = fields[`${prefix}Height`];
          const sizeEntry = fields[`${prefix}Res`];
          const typeEntry = fields[`${prefix}FileType`];

          versions[key] = {
            filename: this.filename,
            width: widthEntry ? widthEntry.value : null,
            height: heightEntry ? heightEntry.value : null,
            size: sizeEntry ? sizeEntry.value.size : null,
            url: sizeEntry ? sizeEntry.value.downloadURL : null,
            type: typeEntry ? typeEntry.value : null,
          };
        }
      }

      this._versions = versions;
    }

    return this._versions;
  }

  /** Download a version (streamed). Returns `null` when the version is missing. */
  async download(version = 'original'): Promise<Readable | null> {
    const v = this.versions[version];
    if (!v || !v.url) {
      return null;
    }
    const response = await this.service.http.request<Readable>('GET', v.url, {
      responseType: 'stream',
    });
    return response.data;
  }

  /**
   * Soft-delete the photo (`records/modify`, sets `isDeleted=1`, `atomic:true`).
   *
   * PRESERVE the record-tag mix: recordName/recordType come from the ASSET
   * record, but recordChangeTag comes from the MASTER record. Using the wrong
   * change tag → change-tag mismatch failure.
   */
  async delete(): Promise<AxiosResponse> {
    const body =
      '{"operations":[{' +
      '"operationType":"update",' +
      '"record":{' +
      `"recordName":"${this.assetRecord.recordName}",` +
      `"recordType":"${this.assetRecord.recordType}",` +
      `"recordChangeTag":"${this.masterRecord.recordChangeTag}",` +
      '"fields":{"isDeleted":{"value":1}' +
      '}}}],' +
      '"zoneID":{' +
      '"zoneName":"PrimarySync"' +
      '},"atomic":true}';

    return this.service.post(`${this.service.serviceEndpoint}/records/modify`, body);
  }
}

// ---------------------------------------------------------------------------
// desiredKeys — the ~90-field projection requested on every page query.
// Ported verbatim from `photos.py:_list_query_gen`.
// ---------------------------------------------------------------------------

const PHOTO_DESIRED_KEYS: readonly string[] = [
  'resJPEGFullWidth',
  'resJPEGFullHeight',
  'resJPEGFullFileType',
  'resJPEGFullFingerprint',
  'resJPEGFullRes',
  'resJPEGLargeWidth',
  'resJPEGLargeHeight',
  'resJPEGLargeFileType',
  'resJPEGLargeFingerprint',
  'resJPEGLargeRes',
  'resJPEGMedWidth',
  'resJPEGMedHeight',
  'resJPEGMedFileType',
  'resJPEGMedFingerprint',
  'resJPEGMedRes',
  'resJPEGThumbWidth',
  'resJPEGThumbHeight',
  'resJPEGThumbFileType',
  'resJPEGThumbFingerprint',
  'resJPEGThumbRes',
  'resVidFullWidth',
  'resVidFullHeight',
  'resVidFullFileType',
  'resVidFullFingerprint',
  'resVidFullRes',
  'resVidMedWidth',
  'resVidMedHeight',
  'resVidMedFileType',
  'resVidMedFingerprint',
  'resVidMedRes',
  'resVidSmallWidth',
  'resVidSmallHeight',
  'resVidSmallFileType',
  'resVidSmallFingerprint',
  'resVidSmallRes',
  'resSidecarWidth',
  'resSidecarHeight',
  'resSidecarFileType',
  'resSidecarFingerprint',
  'resSidecarRes',
  'itemType',
  'dataClassType',
  'filenameEnc',
  'originalOrientation',
  'resOriginalWidth',
  'resOriginalHeight',
  'resOriginalFileType',
  'resOriginalFingerprint',
  'resOriginalRes',
  'resOriginalAltWidth',
  'resOriginalAltHeight',
  'resOriginalAltFileType',
  'resOriginalAltFingerprint',
  'resOriginalAltRes',
  'resOriginalVidComplWidth',
  'resOriginalVidComplHeight',
  'resOriginalVidComplFileType',
  'resOriginalVidComplFingerprint',
  'resOriginalVidComplRes',
  'isDeleted',
  'isExpunged',
  'dateExpunged',
  'remappedRef',
  'recordName',
  'recordType',
  'recordChangeTag',
  'masterRef',
  'adjustmentRenderType',
  'assetDate',
  'addedDate',
  'isFavorite',
  'isHidden',
  'orientation',
  'duration',
  'assetSubtype',
  'assetSubtypeV2',
  'assetHDRType',
  'burstFlags',
  'burstFlagsExt',
  'burstId',
  'captionEnc',
  'locationEnc',
  'locationV2Enc',
  'locationLatitude',
  'locationLongitude',
  'adjustmentType',
  'timeZoneOffset',
  'vidComplDurValue',
  'vidComplDurScale',
  'vidComplDispValue',
  'vidComplDispScale',
  'vidComplVisibilityState',
  'customRenderedValue',
  'containerId',
  'itemId',
  'position',
  'isKeyAsset',
];
