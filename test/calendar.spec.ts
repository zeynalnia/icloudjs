/**
 * calendar.spec.ts — unit tests for {@link CalendarService} (plan §4.9, §8.2).
 *
 * The service is exercised in isolation against a stubbed
 * {@link IcloudHttpService}: each test inspects the exact `(method, url, opts)`
 * the service issues and feeds back a canned `AxiosResponse`. This keeps the
 * assertions focused on the porting contract:
 *
 *   - `events()` returns the PascalCase `Event` array;
 *   - `calendars()` reads the PascalCase SINGULAR `Collection` key;
 *   - `getEventDetail()` returns `Event[0]`;
 *   - the `YYYY-MM-DD` date format and the `lang`/`usertz` params;
 *   - FIX #3 — with no explicit range, the default window is the FULL current
 *     month (start = 1st, end = last day). Pinned with a frozen clock at
 *     2026-02-15 ⇒ startDate '2026-02-01', endDate '2026-02-28' — asserted for
 *     BOTH `events()` and `calendars()`.
 */
import type { AxiosResponse } from 'axios';

import { CalendarService } from '../src/services/calendar.service';
import type { IcloudHttpService } from '../src/session/icloud-http.service';

const SERVICE_ROOT = 'https://p31-calendarws.icloud.com:443';

/** Build a minimal AxiosResponse around a JSON body. */
function makeResponse<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as never,
  } as AxiosResponse<T>;
}

/** A stub IcloudHttpService whose `request` is a jest mock. */
interface StubHttp {
  request: jest.Mock;
}

/** Create the service plus a captured reference to its stub http mock. */
function makeService(
  params: Record<string, string> = {},
): { service: CalendarService; http: StubHttp } {
  const http: StubHttp = { request: jest.fn() };
  const service = new CalendarService(
    SERVICE_ROOT,
    http as unknown as IcloudHttpService,
    params,
  );
  return { service, http };
}

describe('CalendarService', () => {
  describe('events()', () => {
    it('GETs /ca/events and returns the PascalCase Event array', async () => {
      const events = [
        { guid: 'evt-1', title: 'Standup' },
        { guid: 'evt-2', title: 'Lunch' },
      ];
      const { service, http } = makeService();
      http.request.mockResolvedValue(makeResponse({ Event: events }));

      const result = await service.events(
        new Date(2026, 0, 5),
        new Date(2026, 0, 9),
      );

      expect(result).toEqual(events);
      expect(http.request).toHaveBeenCalledTimes(1);

      const [method, url, opts] = http.request.mock.calls[0];
      expect(method).toBe('GET');
      expect(url).toBe(`${SERVICE_ROOT}/ca/events`);
      expect(opts.params).toMatchObject({
        lang: 'en-us',
        usertz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        startDate: '2026-01-05',
        endDate: '2026-01-09',
      });
    });

    it('returns undefined when the server omits the Event key', async () => {
      const { service, http } = makeService();
      http.request.mockResolvedValue(makeResponse({}));

      const result = await service.events(
        new Date(2026, 0, 1),
        new Date(2026, 0, 31),
      );

      expect(result).toBeUndefined();
    });

    it('threads the shared params bag into the query', async () => {
      const { service, http } = makeService({
        dsid: '12345',
        clientId: 'auth-abc',
      });
      http.request.mockResolvedValue(makeResponse({ Event: [] }));

      await service.events(new Date(2026, 0, 1), new Date(2026, 0, 31));

      const [, , opts] = http.request.mock.calls[0];
      expect(opts.params).toMatchObject({
        dsid: '12345',
        clientId: 'auth-abc',
      });
    });
  });

  describe('getEventDetail()', () => {
    it('GETs /ca/eventdetail/{pguid}/{guid} and returns Event[0]', async () => {
      const detail = { guid: 'evt-1', title: 'Standup', detailed: true };
      const { service, http } = makeService();
      http.request.mockResolvedValue(makeResponse({ Event: [detail] }));

      const result = await service.getEventDetail('cal-p', 'evt-1');

      expect(result).toEqual(detail);
      const [method, url, opts] = http.request.mock.calls[0];
      expect(method).toBe('GET');
      expect(url).toBe(`${SERVICE_ROOT}/ca/eventdetail/cal-p/evt-1`);
      expect(opts.params).toMatchObject({
        lang: 'en-us',
        usertz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      // Detail does NOT include a date range.
      expect(opts.params).not.toHaveProperty('startDate');
      expect(opts.params).not.toHaveProperty('endDate');
    });
  });

  describe('calendars()', () => {
    it('GETs /ca/startup and returns the SINGULAR Collection key', async () => {
      const collections = [
        { guid: 'cal-1', title: 'Home' },
        { guid: 'cal-2', title: 'Work' },
      ];
      const { service, http } = makeService();
      http.request.mockResolvedValue(
        makeResponse({ Collection: collections }),
      );

      const result = await service.calendars();

      expect(result).toEqual(collections);
      const [method, url] = http.request.mock.calls[0];
      expect(method).toBe('GET');
      expect(url).toBe(`${SERVICE_ROOT}/ca/startup`);
    });
  });

  // -------------------------------------------------------------------------
  // FIX #3 — default month range with a FROZEN clock at 2026-02-15.
  // Expected: startDate '2026-02-01', endDate '2026-02-28'.
  // The clock is set to noon LOCAL time so the local year/month/day land on
  // 2026-02-15 regardless of the test machine's timezone.
  // -------------------------------------------------------------------------
  describe('FIX #3 — default month range (frozen clock 2026-02-15)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(2026, 1, 15, 12, 0, 0));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('events() with no range defaults to start=1st end=last-day of month', async () => {
      const { service, http } = makeService();
      http.request.mockResolvedValue(makeResponse({ Event: [] }));

      await service.events();

      const [, , opts] = http.request.mock.calls[0];
      expect(opts.params.startDate).toBe('2026-02-01');
      expect(opts.params.endDate).toBe('2026-02-28');
    });

    it('calendars() recomputes the SAME default month range independently', async () => {
      const { service, http } = makeService();
      http.request.mockResolvedValue(makeResponse({ Collection: [] }));

      await service.calendars();

      const [, , opts] = http.request.mock.calls[0];
      expect(opts.params.startDate).toBe('2026-02-01');
      expect(opts.params.endDate).toBe('2026-02-28');
    });

    it('events() honors an explicit from/to even under the frozen clock', async () => {
      const { service, http } = makeService();
      http.request.mockResolvedValue(makeResponse({ Event: [] }));

      await service.events(new Date(2026, 2, 10), new Date(2026, 2, 20));

      const [, , opts] = http.request.mock.calls[0];
      expect(opts.params.startDate).toBe('2026-03-10');
      expect(opts.params.endDate).toBe('2026-03-20');
    });
  });
});
