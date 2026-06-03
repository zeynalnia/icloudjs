/**
 * CalendarService — TypeScript port of `pyicloud.services.calendar.CalendarService`
 * (`services/calendar.py`).
 *
 * GET-only, timezone-aware. Mirrors the three Python entry points:
 *   - `events(from?, to?)`  → GET `{root}/ca/events`           → `response.Event`
 *   - `getEventDetail(p,g)` → GET `{root}/ca/eventdetail/{p}/{g}` → `response.Event[0]`
 *   - `calendars()`         → GET `{root}/ca/startup`          → `response.Collection`
 *                                                                (PascalCase, SINGULAR key)
 *
 * Constructor signature is pinned by the auth-service accessor (plan §4.9):
 * `(serviceRoot, http, params)`.
 *
 * --- FIX #3 (plan §0, §4.9, §8.2): month-range default --------------------
 * The Python source uses `calendar.monthrange(year, month)` and then
 * `datetime(year, month, first_day)`, but `monthrange` returns
 * `(weekday_of_first, days_in_month)` — so `first_day` is a WEEKDAY index
 * (0-6), not day 1, making `startDate` usually wrong. We fix it: when no
 * explicit range is supplied the default window is the FULL current month —
 * `startDate` = the 1st and `endDate` = the last day of the month.
 *
 * The last day is computed as `new Date(year, month, 0).getDate()` where
 * `month` is the 1-indexed (human) month: a JS `Date` with day `0` rolls back
 * to the last day of the previous 0-indexed month, i.e. the last day of the
 * 1-indexed `month`. This default is applied IDENTICALLY to BOTH `events()`
 * and `calendars()` (each recomputes the range independently).
 */
import { IcloudHttpService } from '../session/icloud-http.service';

/**
 * A calendar event record as returned under the PascalCase `Event` key. The
 * server shape is open-ended; callers index it directly.
 */
export type CalendarEvent = Record<string, unknown>;

/**
 * A calendar collection record as returned under the PascalCase (SINGULAR)
 * `Collection` key by `/ca/startup`.
 */
export type CalendarCollection = Record<string, unknown>;

/** Response envelope from `/ca/events` and `/ca/eventdetail/...`. */
interface EventsResponse {
  Event?: CalendarEvent[];
}

/** Response envelope from `/ca/startup`. */
interface StartupResponse {
  Collection: CalendarCollection[];
}

/** Inclusive month window expressed as `YYYY-MM-DD` strings. */
interface MonthRange {
  startDate: string;
  endDate: string;
}

export class CalendarService {
  private readonly calendarEndpoint: string;
  private readonly calendarRefreshUrl: string;
  private readonly calendarEventDetailUrl: string;
  private readonly calendarsUrl: string;

  /** Last raw response payload (mirrors Python `self.response`). */
  private response: Record<string, unknown> = {};

  constructor(
    protected readonly serviceRoot: string,
    protected readonly http: IcloudHttpService,
    protected readonly params: Record<string, string>,
  ) {
    this.calendarEndpoint = `${this.serviceRoot}/ca`;
    this.calendarRefreshUrl = `${this.calendarEndpoint}/events`;
    this.calendarEventDetailUrl = `${this.calendarEndpoint}/eventdetail`;
    this.calendarsUrl = `${this.calendarEndpoint}/startup`;
  }

  /**
   * The IANA timezone name reported to the server as `usertz`. Mirrors Python's
   * `tzlocal.get_localzone_name()` via the Intl API.
   */
  get usertz(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /**
   * Retrieve events for a date range; defaults to the FULL current month
   * (FIX #3). Returns the `Event` array from the response (may be `undefined`
   * when the server omits the key — matches Python `response.get("Event")`).
   */
  async events(from?: Date, to?: Date): Promise<CalendarEvent[] | undefined> {
    const { startDate, endDate } = this.resolveRange(from, to);
    const params = {
      ...this.params,
      lang: 'en-us',
      usertz: this.usertz,
      startDate,
      endDate,
    };
    const resp = await this.http.request<EventsResponse>(
      'GET',
      this.calendarRefreshUrl,
      { params },
    );
    this.response = resp.data as Record<string, unknown>;
    return resp.data.Event;
  }

  /**
   * Fetch a single event's details by `pguid` (a calendar) and `guid` (the
   * event id). Returns the first element of the `Event` array.
   */
  async getEventDetail(pguid: string, guid: string): Promise<CalendarEvent> {
    const params = {
      ...this.params,
      lang: 'en-us',
      usertz: this.usertz,
    };
    const url = `${this.calendarEventDetailUrl}/${pguid}/${guid}`;
    const resp = await this.http.request<EventsResponse>('GET', url, { params });
    this.response = resp.data as Record<string, unknown>;
    return (resp.data.Event ?? [])[0];
  }

  /**
   * Retrieve the calendar collections for the current month. Reads the
   * PascalCase SINGULAR `Collection` key (NOT `Collections`).
   *
   * FIX #3 is applied here too: `calendars()` recomputes the same full-month
   * range independently of `events()` (plan §8.2).
   */
  async calendars(): Promise<CalendarCollection[]> {
    const { startDate, endDate } = this.resolveRange();
    const params = {
      ...this.params,
      lang: 'en-us',
      usertz: this.usertz,
      startDate,
      endDate,
    };
    const resp = await this.http.request<StartupResponse>(
      'GET',
      this.calendarsUrl,
      { params },
    );
    this.response = resp.data as unknown as Record<string, unknown>;
    return resp.data.Collection;
  }

  /**
   * Resolve the `YYYY-MM-DD` window. Either bound, when omitted, falls back to
   * the current-month default (FIX #3): start = the 1st, end = the last day of
   * the 1-indexed current month.
   */
  private resolveRange(from?: Date, to?: Date): MonthRange {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth() + 1; // 1-indexed human month (FIX #3)

    const fromDt = from ?? new Date(year, month - 1, 1);
    // `new Date(year, month, 0)` → last day of the 1-indexed `month`.
    const lastDay = new Date(year, month, 0).getDate();
    const toDt = to ?? new Date(year, month - 1, lastDay);

    return {
      startDate: CalendarService.formatDate(fromDt),
      endDate: CalendarService.formatDate(toDt),
    };
  }

  /** Format a `Date` as a local `YYYY-MM-DD` string (Python `%Y-%m-%d`). */
  private static formatDate(date: Date): string {
    const yyyy = date.getFullYear().toString().padStart(4, '0');
    const mm = (date.getMonth() + 1).toString().padStart(2, '0');
    const dd = date.getDate().toString().padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
}
