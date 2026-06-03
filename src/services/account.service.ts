/**
 * AccountService — TypeScript port of `pyicloud.services.account`
 * (`account.py`). Exposes the three lazy, cached "Account" sub-resources:
 *
 *   - {@link AccountService.devices}  — paired devices (`getDevices`);
 *   - {@link AccountService.family}   — Family Sharing members (`getFamilyDetails`);
 *   - {@link AccountService.storage}  — storage quota / usage (`storageUsageInfo`).
 *
 * Constructor signature is pinned for the auth-service accessor (plan §4.7):
 * `(serviceRoot, http, params, setupEndpoint)`.
 *
 * FIX #2 (plan §0): in Python the storage URL is HARDCODED to the global
 * `https://setup.icloud.com/setup/ws/1/storageUsageInfo`, so it is NOT switched
 * to the `.com.cn` host when the account is China-mainland. Here we build it
 * from the injected `setupEndpoint` (which is `.com.cn` in China mode), so the
 * storage call respects the China endpoint like every other call. The
 * divergence from Python is intentional.
 *
 * The dynamic `AccountDevice.__getattr__` / `underscore_to_camelcase` indirection
 * from Python is NOT reproduced: `AccountDevice` is a plain typed interface whose
 * keys are already the camelCase server keys.
 */
import { Readable } from 'stream';

import { IcloudHttpService } from '../session/icloud-http.service';

/** Response shape of `GET {acc}/device/getDevices`. */
interface GetDevicesResponse {
  devices: AccountDevice[];
}

/** Response shape of `GET {acc}/family/getFamilyDetails`. */
interface GetFamilyDetailsResponse {
  familyMembers: FamilyMemberInfo[];
}

/** Response shape of `GET {setupEndpoint}/storageUsageInfo`. */
interface StorageUsageInfoResponse {
  storageUsageInfo: AccountStorageUsageInfo;
  quotaStatus: AccountQuotaStatus;
  storageUsageByMedia: AccountStorageUsageForMediaData[];
}

/**
 * A paired iCloud device. Typed interface (plan §4.7) — the camelCase keys are
 * the raw server keys; we do NOT reproduce the Python dynamic getattr.
 */
export interface AccountDevice {
  modelDisplayName: string;
  name: string;
  model: string;
  udid: string;
  serialNumber: string;
  osVersion: string;
  imei: string;
  paymentMethods?: string[];
  modelLargePhotoURL1x?: string;
  modelLargePhotoURL2x?: string;
  modelSmallPhotoURL1x?: string;
  modelSmallPhotoURL2x?: string;
  /** Forward-compatible: tolerate additional server fields. */
  [key: string]: unknown;
}

/** Raw per-member payload from `getFamilyDetails`. */
export interface FamilyMemberInfo {
  lastName?: string;
  dsid?: string;
  originalInvitationEmail?: string;
  fullName?: string;
  ageClassification?: string;
  appleIdForPurchases?: string;
  appleId?: string;
  familyId?: string;
  firstName?: string;
  hasParentalPrivileges?: boolean;
  hasScreenTimeEnabled?: boolean;
  hasAskToBuyEnabled?: boolean;
  hasSharePurchasesEnabled?: boolean;
  shareMyLocationEnabledFamilyMembers?: string[];
  hasShareMyLocationEnabled?: boolean;
  dsidForPurchases?: string;
  [key: string]: unknown;
}

/** The `storageUsageInfo` block. */
export interface AccountStorageUsageInfo {
  compStorageInBytes: number;
  usedStorageInBytes: number;
  totalStorageInBytes: number;
  commerceStorageInBytes: number;
}

/** The `quotaStatus` block. */
export interface AccountQuotaStatus {
  overQuota: boolean;
  haveMaxQuotaTier: boolean;
  'almost-full': boolean;
  paidQuota: boolean;
}

/**
 * A single Family Sharing member. Typed getters mirror the Python `FamilyMember`
 * properties (each is the camelCase server key). `getPhoto()` streams the member
 * avatar image.
 */
export class FamilyMember {
  constructor(
    private readonly attrs: FamilyMemberInfo,
    private readonly http: IcloudHttpService,
    private readonly params: Record<string, string>,
    private readonly photoUrl: string,
  ) {}

  /** Gets the last name. */
  get lastName(): string | undefined {
    return this.attrs.lastName;
  }

  /** Gets the dsid. */
  get dsid(): string | undefined {
    return this.attrs.dsid;
  }

  /** Gets the original invitation email. */
  get originalInvitationEmail(): string | undefined {
    return this.attrs.originalInvitationEmail;
  }

  /** Gets the full name. */
  get fullName(): string | undefined {
    return this.attrs.fullName;
  }

  /** Gets the age classification. */
  get ageClassification(): string | undefined {
    return this.attrs.ageClassification;
  }

  /** Gets the apple id used for purchases. */
  get appleIdForPurchases(): string | undefined {
    return this.attrs.appleIdForPurchases;
  }

  /** Gets the apple id. */
  get appleId(): string | undefined {
    return this.attrs.appleId;
  }

  /** Gets the family id. */
  get familyId(): string | undefined {
    return this.attrs.familyId;
  }

  /** Gets the first name. */
  get firstName(): string | undefined {
    return this.attrs.firstName;
  }

  /** Whether the member has parental privileges. */
  get hasParentalPrivileges(): boolean | undefined {
    return this.attrs.hasParentalPrivileges;
  }

  /** Whether screen time is enabled. */
  get hasScreenTimeEnabled(): boolean | undefined {
    return this.attrs.hasScreenTimeEnabled;
  }

  /** Whether "ask to buy" is enabled. */
  get hasAskToBuyEnabled(): boolean | undefined {
    return this.attrs.hasAskToBuyEnabled;
  }

  /** Whether purchase sharing is enabled. */
  get hasSharePurchasesEnabled(): boolean | undefined {
    return this.attrs.hasSharePurchasesEnabled;
  }

  /** Family members this member shares location with. */
  get shareMyLocationEnabledFamilyMembers(): string[] | undefined {
    return this.attrs.shareMyLocationEnabledFamilyMembers;
  }

  /** Whether location sharing is enabled. */
  get hasShareMyLocationEnabled(): boolean | undefined {
    return this.attrs.hasShareMyLocationEnabled;
  }

  /** Gets the dsid used for purchases. */
  get dsidForPurchases(): string | undefined {
    return this.attrs.dsidForPurchases;
  }

  /**
   * Streams the member's avatar image:
   * `GET {acc}/family/getMemberPhoto?memberId=<dsid>`.
   */
  async getPhoto(): Promise<Readable> {
    const resp = await this.http.request<Readable>('GET', this.photoUrl, {
      params: { ...this.params, memberId: this.dsid ?? '' },
      responseType: 'stream',
    });
    return resp.data;
  }

  toString(): string {
    return `{name: ${this.fullName}, age_classification: ${this.ageClassification}}`;
  }
}

/** Storage used for a single media type (`storageUsageByMedia` entry). */
export class AccountStorageUsageForMedia {
  constructor(private readonly usageData: AccountStorageUsageForMediaData) {}

  /** Media key (e.g. `photos`, `backup`, `docs`, `mail`). */
  get key(): string {
    return this.usageData.mediaKey;
  }

  /** Human display label. */
  get label(): string {
    return this.usageData.displayLabel;
  }

  /** HEX display color. */
  get color(): string {
    return this.usageData.displayColor;
  }

  /** Bytes used by this media type. */
  get usageInBytes(): number {
    return this.usageData.usageInBytes;
  }

  toString(): string {
    return `{key: ${this.key}, usage: ${this.usageInBytes} bytes}`;
  }
}

/** Raw `storageUsageByMedia` entry shape. */
export interface AccountStorageUsageForMediaData {
  mediaKey: string;
  displayLabel: string;
  displayColor: string;
  usageInBytes: number;
}

/**
 * Overall account storage usage + quota. Computed percentages match Python:
 * `round(used * 100 / total, 2)` (2-decimal rounding).
 */
export class AccountStorageUsage {
  constructor(
    private readonly usageData: AccountStorageUsageInfo,
    private readonly quotaData: AccountQuotaStatus,
  ) {}

  /** Compressed storage in bytes. */
  get compStorageInBytes(): number {
    return this.usageData.compStorageInBytes;
  }

  /** Used storage in bytes. */
  get usedStorageInBytes(): number {
    return this.usageData.usedStorageInBytes;
  }

  /** Used storage as a percentage of total (`round(used*100/total, 2)`). */
  get usedStorageInPercent(): number {
    return roundTo2(
      (this.usedStorageInBytes * 100) / this.totalStorageInBytes,
    );
  }

  /** Available (free) storage in bytes. */
  get availableStorageInBytes(): number {
    return this.totalStorageInBytes - this.usedStorageInBytes;
  }

  /** Available storage as a percentage of total. */
  get availableStorageInPercent(): number {
    return roundTo2(
      (this.availableStorageInBytes * 100) / this.totalStorageInBytes,
    );
  }

  /** Total storage in bytes. */
  get totalStorageInBytes(): number {
    return this.usageData.totalStorageInBytes;
  }

  /** Commerce storage in bytes. */
  get commerceStorageInBytes(): number {
    return this.usageData.commerceStorageInBytes;
  }

  /** Whether the account is over quota. */
  get quotaOver(): boolean {
    return this.quotaData.overQuota;
  }

  /** Whether the account is on the max quota tier. */
  get quotaTierMax(): boolean {
    return this.quotaData.haveMaxQuotaTier;
  }

  /** Whether the account is almost full. */
  get quotaAlmostFull(): boolean {
    return this.quotaData['almost-full'];
  }

  /** Whether the account has paid quota. */
  get quotaPaid(): boolean {
    return this.quotaData.paidQuota;
  }

  toString(): string {
    return `${this.usedStorageInPercent}% used of ${this.totalStorageInBytes} bytes`;
  }
}

/**
 * Storage of the account: a {@link AccountStorageUsage} plus an
 * insertion-ordered map of per-media usage keyed by `mediaKey`.
 */
export class AccountStorage {
  readonly usage: AccountStorageUsage;
  /** Per-media usage, keyed by `mediaKey` (insertion order preserved). */
  readonly usagesByMedia: Record<string, AccountStorageUsageForMedia>;

  constructor(storageData: StorageUsageInfoResponse) {
    this.usage = new AccountStorageUsage(
      storageData.storageUsageInfo,
      storageData.quotaStatus,
    );

    this.usagesByMedia = {};
    for (const usageMedia of storageData.storageUsageByMedia ?? []) {
      this.usagesByMedia[usageMedia.mediaKey] = new AccountStorageUsageForMedia(
        usageMedia,
      );
    }
  }

  toString(): string {
    return `{usage: ${this.usage}, usages_by_media: ${Object.keys(
      this.usagesByMedia,
    ).join(', ')}}`;
  }
}

/** Round to 2 decimal places (matches Python `round(x, 2)`). */
function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The "Account" iCloud service: paired devices, Family Sharing, storage quota.
 * All three accessors are lazy and cached.
 */
export class AccountService {
  private _devices?: AccountDevice[];
  private _family?: FamilyMember[];
  private _storage?: AccountStorage;

  /** `{serviceRoot}/setup/web`. */
  private readonly accEndpoint: string;
  private readonly devicesUrl: string;
  private readonly familyDetailsUrl: string;
  private readonly familyMemberPhotoUrl: string;
  /** FIX #2: built from the injected (CN-aware) setupEndpoint, not hardcoded. */
  private readonly storageUrl: string;

  constructor(
    private readonly serviceRoot: string,
    private readonly http: IcloudHttpService,
    private readonly params: Record<string, string>,
    setupEndpoint: string,
  ) {
    this.accEndpoint = `${this.serviceRoot}/setup/web`;
    this.devicesUrl = `${this.accEndpoint}/device/getDevices`;
    this.familyDetailsUrl = `${this.accEndpoint}/family/getFamilyDetails`;
    this.familyMemberPhotoUrl = `${this.accEndpoint}/family/getMemberPhoto`;
    // FIX #2 (plan §0): build the storage URL from the (CN-aware) setupEndpoint
    // instead of the Python hardcoded global host, so it respects China mode.
    this.storageUrl = `${setupEndpoint}/storageUsageInfo`;
  }

  /** Returns the currently paired devices (lazy + cached). */
  async devices(): Promise<AccountDevice[]> {
    if (!this._devices) {
      const resp = await this.http.request<GetDevicesResponse>(
        'GET',
        this.devicesUrl,
        { params: this.params },
      );
      this._devices = resp.data.devices;
    }
    return this._devices;
  }

  /** Returns the Family Sharing members (lazy + cached). */
  async family(): Promise<FamilyMember[]> {
    if (!this._family) {
      const resp = await this.http.request<GetFamilyDetailsResponse>(
        'GET',
        this.familyDetailsUrl,
        { params: this.params },
      );
      this._family = resp.data.familyMembers.map(
        (memberInfo) =>
          new FamilyMember(
            memberInfo,
            this.http,
            this.params,
            this.familyMemberPhotoUrl,
          ),
      );
    }
    return this._family;
  }

  /** Returns the account storage quota / usage (lazy + cached). */
  async storage(): Promise<AccountStorage> {
    if (!this._storage) {
      const resp = await this.http.request<StorageUsageInfoResponse>(
        'GET',
        this.storageUrl,
        { params: this.params },
      );
      this._storage = new AccountStorage(resp.data);
    }
    return this._storage;
  }
}
