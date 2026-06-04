/**
 * findmyiphone.service.ts — TypeScript port of
 * `pyicloud/services/findmyiphone.py` (`FindMyiPhoneServiceManager` +
 * `AppleDevice`), per plan §4.8.
 *
 * The "Find My iPhone" iCloud service connects to iCloud and returns phone data
 * including the near-realtime latitude and longitude.
 *
 * Key porting decisions (plan §0 / §4.8):
 *  - NO network in the constructor. The Python `__init__` called
 *    `refresh_client()` eagerly; here that I/O moves to an async `init()` (the
 *    auth-service accessor awaits it). This is the "no network in constructors"
 *    global decision.
 *  - The device map is keyed by `content.id` (the device identifier returned by
 *    the refresh endpoint), mirroring `self._devices[device_info["id"]]`.
 *  - `get(int)` indexes into the insertion-ordered key list; `get(string)`
 *    looks the device up by id (Python `__getitem__`).
 *  - `location()` / `status()` both trigger a WHOLE-LIST `refreshClient()` and
 *    then read from the (freshly replaced) device content — there is no
 *    per-device location endpoint.
 *  - `playSound` hardcodes `clientContext.fmly = true` (latent bug #6:
 *    PRESERVED, because it matches Apple's actual behaviour — see comment).
 *  - Empty device list → `PyiCloudNoDevicesException` (matches Python).
 *
 * Request bodies are serialised with `JSON.stringify` and sent as the raw `data`
 * payload (the Python source passes `json.dumps(...)` as `data=`), with the
 * shared `params` bag (clientId/dsid/build numbers) as the query string.
 */
import { PyiCloudNoDevicesException } from '../exceptions/icloud.exceptions';
import { IcloudHttpService } from '../session/icloud-http.service';

/** Resolve after `ms` milliseconds (used to space out locate polling). */
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Default polling budget for {@link AppleDevice.locate}. */
const DEFAULT_LOCATE_ATTEMPTS = 6;
const DEFAULT_LOCATE_INTERVAL_MS = 5000;

/** The shape returned by the refresh endpoint (`refreshClient`). */
interface RefreshClientResponse {
  /** One entry per device; each becomes an {@link AppleDevice}. */
  content: AppleDeviceContent[];
  [key: string]: unknown;
}

/**
 * A single device's content blob, as returned by the refresh endpoint. Only the
 * fields actually read by this module are typed; everything else is preserved
 * verbatim (the CLI long-list and `--outputfile` dump the whole object).
 */
export interface AppleDeviceContent {
  /** Device identifier — the device-map key (e.g. `iPhone12,1`). */
  id: string;
  /** Near-realtime device location (may be `null` when unavailable). */
  location?: unknown;
  /** Battery level (0..1). */
  batteryLevel?: unknown;
  /** Human-readable model name (e.g. `iPhone 11`). */
  deviceDisplayName?: unknown;
  /** Numeric device status code. */
  deviceStatus?: unknown;
  /** User-given device name (e.g. `iPhone de Quentin`). */
  name?: unknown;
  [key: string]: unknown;
}

/** Options for {@link AppleDevice.displayMessage}. */
export interface DisplayMessageOptions {
  /** Notification subject line. */
  subject?: string;
  /** The message body shown on the device. */
  message?: string;
  /** Whether to play a sound alongside the message. */
  sounds?: boolean;
}

/** Options for {@link AppleDevice.lostDevice}. */
export interface LostDeviceOptions {
  /** Callback number the finder can dial without unlocking the device. */
  number: string;
  /** Message shown on the locked device. */
  text?: string;
  /** New passcode to set on the device (empty string leaves it unchanged). */
  newpasscode?: string;
}

/**
 * Manager for the "Find My iPhone" service: refreshes the device list and
 * exposes per-device lookups.
 */
export class FindMyiPhoneService {
  /** `…/fmipservice/client/web/refreshClient` — rebuilds the device list. */
  private readonly fmipRefreshUrl: string;
  /** `…/fmipservice/client/web/playSound`. */
  private readonly fmipSoundUrl: string;
  /** `…/fmipservice/client/web/sendMessage`. */
  private readonly fmipMessageUrl: string;
  /** `…/fmipservice/client/web/lostDevice`. */
  private readonly fmipLostUrl: string;

  /** Device map keyed by `content.id` (insertion-ordered, like a Python dict). */
  private readonly devices = new Map<string, AppleDevice>();

  /** The most recent raw refresh response (mirrors Python `self.response`). */
  response?: RefreshClientResponse;

  constructor(
    serviceRoot: string,
    private readonly http: IcloudHttpService,
    private readonly params: Record<string, string>,
    private readonly withFamily: boolean,
  ) {
    const fmipEndpoint = `${serviceRoot}/fmipservice/client/web`;
    this.fmipRefreshUrl = `${fmipEndpoint}/refreshClient`;
    this.fmipSoundUrl = `${fmipEndpoint}/playSound`;
    this.fmipMessageUrl = `${fmipEndpoint}/sendMessage`;
    this.fmipLostUrl = `${fmipEndpoint}/lostDevice`;
  }

  /** `serviceRoot + '/fmipservice/client/web'` (the FMIP endpoint base). */
  get fmipEndpoint(): string {
    // Derive from the refresh URL so there is a single source of truth.
    return this.fmipRefreshUrl.slice(0, -'/refreshClient'.length);
  }

  /**
   * Run the initial device-list refresh. Replaces the Python constructor I/O
   * (the "no network in constructors" rule); the auth-service accessor awaits
   * this once before returning the service.
   */
  async init(): Promise<void> {
    await this.refreshClient();
  }

  /**
   * Refresh the FindMyiPhone endpoint so the location data is up to date.
   *
   * POSTs to `refreshClient` with the `clientContext` envelope, then rebuilds
   * the device map keyed by `content.id`: new ids create a fresh
   * {@link AppleDevice}; existing ids are updated in place (so the same device
   * objects survive across refreshes). Throws {@link PyiCloudNoDevicesException}
   * when the account has no devices.
   */
  async refreshClient(): Promise<void> {
    const body = JSON.stringify({
      clientContext: {
        fmly: this.withFamily,
        shouldLocate: true,
        selectedDevice: 'all',
        deviceListVersion: 1,
      },
    });

    const resp = await this.http.request<RefreshClientResponse>(
      'POST',
      this.fmipRefreshUrl,
      { data: body, params: this.params },
    );
    this.response = resp.data;

    for (const deviceInfo of this.response.content) {
      const deviceId = deviceInfo.id;
      const existing = this.devices.get(deviceId);
      if (existing) {
        existing.update(deviceInfo);
      } else {
        this.devices.set(
          deviceId,
          new AppleDevice(deviceInfo, this.http, this.params, this, {
            soundUrl: this.fmipSoundUrl,
            lostUrl: this.fmipLostUrl,
            messageUrl: this.fmipMessageUrl,
          }),
        );
      }
    }

    if (this.devices.size === 0) {
      throw new PyiCloudNoDevicesException();
    }
  }

  /** Insertion-ordered device ids (mirrors Python `dict.keys()`). */
  keys(): string[] {
    return [...this.devices.keys()];
  }

  /** Insertion-ordered devices (mirrors Python `dict.values()`). */
  values(): AppleDevice[] {
    return [...this.devices.values()];
  }

  /** All devices, in insertion order (convenience for the CLI per-device loop). */
  get all(): AppleDevice[] {
    return this.values();
  }

  /**
   * Look up a device. Mirrors Python `__getitem__`:
   *  - a `number` indexes into the ordered key list (`keys()[index]`);
   *  - a `string` is used directly as the device-map key.
   */
  get(idOrIndex: string | number): AppleDevice {
    const key = typeof idOrIndex === 'number' ? this.keys()[idOrIndex] : idOrIndex;
    const device = key === undefined ? undefined : this.devices.get(key);
    if (!device) {
      throw new PyiCloudNoDevicesException();
    }
    return device;
  }
}

/** A single Apple device, exposing location/status and remote commands. */
export class AppleDevice {
  /** The raw device content blob (mirrors Python `self.content` / `data`). */
  content: AppleDeviceContent;

  private readonly soundUrl?: string;
  private readonly lostUrl?: string;
  private readonly messageUrl?: string;

  constructor(
    content: AppleDeviceContent,
    private readonly http: IcloudHttpService,
    private readonly params: Record<string, string>,
    private readonly manager: FindMyiPhoneService,
    urls: { soundUrl?: string; lostUrl?: string; messageUrl?: string } = {},
  ) {
    this.content = content;
    this.soundUrl = urls.soundUrl;
    this.lostUrl = urls.lostUrl;
    this.messageUrl = urls.messageUrl;
  }

  /** The device data (mirrors the Python `data` property). */
  get data(): AppleDeviceContent {
    return this.content;
  }

  /** Replace this device's content (called by the manager on refresh). */
  update(data: AppleDeviceContent): void {
    this.content = data;
  }

  /**
   * Update and return the device location. Triggers a WHOLE-LIST refresh (there
   * is no per-device location endpoint) then reads the refreshed `location`.
   *
   * Single-shot (faithful to the pyicloud port): it returns whatever Apple has
   * cached right now, which after a period of inactivity is the previous,
   * `isOld: true` fix — a fresh `refreshClient` only ASKS Apple to locate the
   * device; the new position arrives seconds later. Use {@link locate} when you
   * need to wait for that fresh fix.
   */
  async location(): Promise<unknown> {
    await this.manager.refreshClient();
    return this.content.location;
  }

  /**
   * Actively locate the device and wait for a FRESH fix.
   *
   * A `refreshClient` with `shouldLocate` only kicks off a locate request; the
   * device reports its position a few seconds later. Reading immediately (as
   * {@link location} does) therefore returns the stale, `isOld: true` fix — and
   * the fresh one only shows up on a *later* call. This polls `refreshClient`
   * up to `attempts` times, `intervalMs` apart, returning as soon as the locate
   * settles (a fix that is present and not flagged `isOld`). If the device never
   * reports a fresh fix within the budget (e.g. it is offline), the best-known
   * location is returned — never throws for staleness.
   *
   * @param opts.attempts   Max `refreshClient` polls (default 6).
   * @param opts.intervalMs Delay between polls in ms (default 5000).
   */
  async locate(
    opts: { attempts?: number; intervalMs?: number } = {},
  ): Promise<unknown> {
    const attempts = Math.max(1, opts.attempts ?? DEFAULT_LOCATE_ATTEMPTS);
    const intervalMs = opts.intervalMs ?? DEFAULT_LOCATE_INTERVAL_MS;

    // The initial list refresh (run by init()) may already carry a fresh fix —
    // avoid an extra round-trip in that case.
    if (AppleDevice.isLocateSettled(this.content.location)) {
      return this.content.location;
    }

    for (let attempt = 1; attempt <= attempts; attempt++) {
      await this.manager.refreshClient();
      if (AppleDevice.isLocateSettled(this.content.location)) {
        return this.content.location;
      }
      if (attempt < attempts) {
        await delay(intervalMs);
      }
    }
    return this.content.location;
  }

  /**
   * Whether a locate has produced a usable, current fix: a `location` object
   * with coordinates that is NOT flagged `isOld`. Apple returns the previous
   * fix with `isOld: true` (or `location: null`) while a locate is still in
   * flight, so those keep the poll going.
   */
  private static isLocateSettled(location: unknown): boolean {
    if (!location || typeof location !== 'object') {
      return false;
    }
    const loc = location as Record<string, unknown>;
    const hasFix = loc.latitude != null && loc.longitude != null;
    return hasFix && loc.isOld !== true;
  }

  /**
   * Return a subset of status properties for the device. Triggers a whole-list
   * refresh first, then reads the default fields plus any `additional` ones.
   */
  async status(additional: string[] = []): Promise<Record<string, unknown>> {
    await this.manager.refreshClient();
    const fields = ['batteryLevel', 'deviceDisplayName', 'deviceStatus', 'name', ...additional];
    const properties: Record<string, unknown> = {};
    for (const field of fields) {
      // Mirror Python `self.content.get(field)` → undefined when absent.
      properties[field] = this.content[field];
    }
    return properties;
  }

  /**
   * Ask the device to play a sound.
   *
   * NOTE (latent bug #6, PRESERVED): `clientContext.fmly` is hardcoded to `true`
   * here, even though the manager's `withFamily` flag may be false. This is
   * intentionally kept — it matches Apple's actual behaviour for the playSound
   * endpoint (and the upstream pyicloud source).
   */
  async playSound(subject = 'Find My iPhone Alert'): Promise<void> {
    const data = JSON.stringify({
      device: this.content.id,
      subject,
      clientContext: { fmly: true },
    });
    await this.http.request('POST', this.soundUrl as string, {
      data,
      params: this.params,
    });
  }

  /**
   * Send a message (with an optional sound) to the device.
   *
   * Accepts a single options object so the CLI can call it as
   * `displayMessage({ subject, message, sounds })`.
   */
  async displayMessage(options: DisplayMessageOptions = {}): Promise<void> {
    const subject = options.subject ?? 'Find My iPhone Alert';
    const message = options.message ?? 'This is a note';
    const sounds = options.sounds ?? false;
    const data = JSON.stringify({
      device: this.content.id,
      subject,
      sound: sounds,
      userText: true,
      text: message,
    });
    await this.http.request('POST', this.messageUrl as string, {
      data,
      params: this.params,
    });
  }

  /**
   * Trigger "lost mode" on the device. The device shows `text`; if a `number`
   * is supplied the finder can call it without entering the passcode.
   *
   * Accepts a single options object so the CLI can call it as
   * `lostDevice({ number, text, newpasscode })`.
   */
  async lostDevice(options: LostDeviceOptions): Promise<void> {
    const text = options.text ?? 'This iPhone has been lost. Please call me.';
    const newpasscode = options.newpasscode ?? '';
    const data = JSON.stringify({
      text,
      userText: true,
      ownerNbr: options.number,
      lostModeEnabled: true,
      trackingEnabled: true,
      device: this.content.id,
      passcode: newpasscode,
    });
    await this.http.request('POST', this.lostUrl as string, {
      data,
      params: this.params,
    });
  }
}
