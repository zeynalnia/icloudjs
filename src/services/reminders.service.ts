/**
 * RemindersService — port of `pyicloud/services/reminders.py`.
 *
 * GET-only startup (`/rd/startup`) plus a single POST (`/rd/reminders/tasks`).
 * The Python class calls `refresh()` in its constructor (eager network I/O);
 * per the plan (§3.4 / §4.9) that is moved to an async `init()` invoked by the
 * `IcloudAuthService.reminders()` accessor — constructors do NO network I/O.
 *
 * Response key casing is the server's literal PascalCase (`Collections`,
 * `Reminders`); it is NOT auto-transformed (plan §0 "Casing").
 */
import { v4 as uuidv4 } from 'uuid';

import { IcloudHttpService } from '../session/icloud-http.service';

/** A parsed reminder entry (mirrors the Python `{title, desc, due}` dict). */
export interface Reminder {
  title: string;
  /** `description` from the server (may be absent → `undefined`). */
  desc?: string;
  /** Parsed from `dueDate[1..5]` (year, month, day, hour, minute), else null. */
  due: Date | null;
}

/** A reminder collection (list) keyed by title in {@link RemindersService.collections}. */
export interface ReminderCollection {
  guid: string;
  ctag: string;
}

/**
 * The raw `dueDate` wire array: `[packedInt, year, month, day, hour, minute]`.
 * On read only indices 1..5 are used; index 0 (the packed int) is ignored.
 * On write the packed int is built by NAÏVE, UNPADDED string concat (see
 * {@link packDueDate}).
 */
export type DueDateArray = [number, number, number, number, number, number];

/** Server `/rd/startup` payload shape (only the fields this service reads). */
interface RemindersStartupResponse {
  Collections: Array<{ title: string; guid: string; ctag: string }>;
  Reminders: Array<{
    pGuid: string;
    title: string;
    description?: string;
    dueDate?: DueDateArray | null;
  }>;
}

/**
 * Build the `dueDate` wire array EXACTLY as Python does
 * (`reminders.py:84-91`). The leading packed int is a naïve, **unpadded**
 * string concatenation of year+month+day run through `parseInt` — e.g.
 * 2026-06-03 → `parseInt('' + 2026 + 6 + 3, 10)` → `202663` (NOT `20260603`).
 * This quirk is PRESERVED verbatim (plan §4.9, latent-bug decisions).
 */
export function packDueDate(due: Date): DueDateArray {
  const year = due.getFullYear();
  const month = due.getMonth() + 1; // JS months are 0-indexed; wire is 1-indexed.
  const day = due.getDate();
  const hour = due.getHours();
  const minute = due.getMinutes();

  // Naïve concat, NOT zero-padded — matches `int(str(y) + str(m) + str(d))`.
  const packed = parseInt('' + year + month + day, 10);

  return [packed, year, month, day, hour, minute];
}

export class RemindersService {
  /** Parsed reminders per collection title (mirrors Python `self.lists`). */
  lists: Record<string, Reminder[]> = {};

  /** Collection metadata keyed by title (mirrors Python `self.collections`). */
  collections: Record<string, ReminderCollection> = {};

  constructor(
    protected readonly serviceRoot: string,
    protected readonly http: IcloudHttpService,
    protected readonly params: Record<string, string>,
  ) {}

  /**
   * Async init — runs the startup refresh once. Replaces the Python
   * constructor's eager `refresh()` call (no network I/O in constructors).
   */
  async init(): Promise<void> {
    await this.refresh();
  }

  /**
   * IANA timezone name (`tzlocal.get_localzone_name()` →
   * `Intl.DateTimeFormat().resolvedOptions().timeZone`).
   */
  protected get usertz(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /** Shared query params plus the reminders-specific trio. */
  protected buildParams(): Record<string, string> {
    return {
      ...this.params,
      clientVersion: '4.0',
      lang: 'en-us',
      usertz: this.usertz,
    };
  }

  /**
   * Refresh `lists` + `collections` from `/rd/startup`. Parses `Collections[]`
   * (title → {guid, ctag}) and matches each `Reminders[]` entry to its
   * collection by `pGuid === collection.guid`.
   */
  async refresh(): Promise<void> {
    const resp = await this.http.request<RemindersStartupResponse>(
      'GET',
      `${this.serviceRoot}/rd/startup`,
      { params: this.buildParams() },
    );
    const data = resp.data;

    const lists: Record<string, Reminder[]> = {};
    const collections: Record<string, ReminderCollection> = {};

    for (const collection of data.Collections) {
      const temp: Reminder[] = [];
      collections[collection.title] = {
        guid: collection.guid,
        ctag: collection.ctag,
      };

      for (const reminder of data.Reminders) {
        if (reminder.pGuid !== collection.guid) {
          continue;
        }

        let due: Date | null = null;
        if (reminder.dueDate) {
          // Only indices 1..5 are used; index 0 (packed int) is ignored.
          // Wire month is 1-indexed; JS Date month is 0-indexed.
          const d = reminder.dueDate;
          due = new Date(d[1], d[2] - 1, d[3], d[4], d[5]);
        }

        temp.push({
          title: reminder.title,
          desc: reminder.description,
          due,
        });
      }

      lists[collection.title] = temp;
    }

    this.lists = lists;
    this.collections = collections;
  }

  /**
   * Add a new reminder. Resolves `pGuid` (`'tasks'` default, or the named
   * collection's guid when known), builds the full `Reminders` body plus a
   * `ClientState.Collections` snapshot from the cached collections, and POSTs
   * to `/rd/reminders/tasks`. Returns `req.ok` (HTTP status < 400).
   *
   * NOTE: `post()` requires collections to have been loaded (via `init()` /
   * `refresh()`) since `ClientState.Collections` is built from the cache.
   */
  async post(
    title: string,
    description = '',
    collection?: string,
    dueDate?: Date,
  ): Promise<boolean> {
    let pguid = 'tasks';
    if (collection && collection in this.collections) {
      pguid = this.collections[collection].guid;
    }

    const dueDates: DueDateArray | null = dueDate ? packDueDate(dueDate) : null;

    const body = {
      Reminders: {
        title,
        description,
        pGuid: pguid,
        etag: null,
        order: null,
        priority: 0,
        recurrence: null,
        alarms: [],
        startDate: null,
        startDateTz: null,
        startDateIsAllDay: false,
        completedDate: null,
        dueDate: dueDates,
        dueDateIsAllDay: false,
        lastModifiedDate: null,
        createdDate: null,
        isFamily: null,
        createdDateExtended: Date.now(),
        guid: this.newGuid(),
      },
      ClientState: {
        Collections: Object.values(this.collections),
      },
    };

    const resp = await this.http.request(
      'POST',
      `${this.serviceRoot}/rd/reminders/tasks`,
      {
        data: JSON.stringify(body),
        params: this.buildParams(),
      },
    );

    // Python `req.ok` → 2xx/3xx (status < 400).
    return resp.status >= 200 && resp.status < 400;
  }

  /** uuid4 for new reminders (mirrors Python `str(uuid.uuid4())`). */
  protected newGuid(): string {
    return uuidv4();
  }
}
