/**
 * reminders.spec.ts — unit tests for {@link RemindersService} (plan §5.2).
 *
 * Asserts:
 *  - startup parse of `Collections` / `Reminders` into `collections` / `lists`
 *    (PascalCase keys, pGuid matching, dueDate[1..5] read, index 0 ignored);
 *  - `post()` builds the full `Reminders` body + `ClientState.Collections` from
 *    the cached collections, resolves `pGuid`, and returns `ok`;
 *  - the dueDate packed-int is UNPADDED naïve concat — `parseInt('202663')`
 *    for 2026-06-03 (NOT `20260603`).
 *
 * The HTTP layer is faked at the `request()` boundary (no nock router needed):
 * the service only reads `resp.data` and `resp.status`.
 */
import { AxiosResponse } from 'axios';

import { IcloudHttpService } from '../src/session/icloud-http.service';
import {
  RemindersService,
  packDueDate,
} from '../src/services/reminders.service';

const SERVICE_ROOT = 'https://reminders.example.com';

/** A recorded `request()` call, for body/url/params assertions. */
interface RecordedCall {
  method: string;
  url: string;
  opts: { data?: unknown; params?: Record<string, string> } | undefined;
}

/**
 * Build a fake {@link IcloudHttpService} whose `request()` returns canned
 * responses in sequence and records every call. Each canned response provides
 * `{ data, status }` (the only fields the service reads).
 */
function makeFakeHttp(
  responses: Array<{ data?: unknown; status?: number }>,
): { http: IcloudHttpService; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;

  const request = jest.fn(
    async (method: string, url: string, opts?: RecordedCall['opts']) => {
      calls.push({ method, url, opts });
      const r = responses[i++] ?? {};
      return {
        data: r.data,
        status: r.status ?? 200,
        statusText: 'OK',
        headers: {},
        config: {},
      } as unknown as AxiosResponse;
    },
  );

  const http = { request } as unknown as IcloudHttpService;
  return { http, calls };
}

/** A startup fixture: 2 collections, with a reminder that carries a dueDate. */
const STARTUP_FIXTURE = {
  Collections: [
    { title: 'Tasks', guid: 'guid-tasks', ctag: 'ctag-tasks' },
    { title: 'Groceries', guid: 'guid-groceries', ctag: 'ctag-groceries' },
  ],
  Reminders: [
    {
      pGuid: 'guid-tasks',
      title: 'Call dentist',
      description: 'before noon',
      // Packed int (index 0) intentionally bogus to prove it is IGNORED on read.
      dueDate: [999999, 2026, 6, 3, 14, 30],
    },
    {
      pGuid: 'guid-tasks',
      title: 'No due date',
      // no description, no dueDate
    },
    {
      pGuid: 'guid-groceries',
      title: 'Buy milk',
      description: '2%',
      dueDate: null,
    },
    {
      // Belongs to no known collection → must not appear under either list.
      pGuid: 'guid-unknown',
      title: 'Orphan',
    },
  ],
};

describe('packDueDate (packed-int UNPADDED concat)', () => {
  it('packs 2026-06-03 14:30 as parseInt("202663") — NOT zero-padded', () => {
    const due = new Date(2026, 5, 3, 14, 30); // 2026-06-03 14:30 local
    const arr = packDueDate(due);

    // The load-bearing assertion: naïve string concat, no zero padding.
    expect(arr[0]).toBe(parseInt('202663', 10));
    expect(arr[0]).toBe(202663);
    expect(arr[0]).not.toBe(20260603);

    // Remaining elements are the plain 1-indexed-month components.
    expect(arr).toEqual([202663, 2026, 6, 3, 14, 30]);
  });

  it('does not pad single-digit month/day (2026-01-05 → 202615)', () => {
    const due = new Date(2026, 0, 5, 9, 7); // 2026-01-05 09:07
    const arr = packDueDate(due);
    expect(arr[0]).toBe(parseInt('' + 2026 + 1 + 5, 10));
    expect(arr[0]).toBe(202615);
    expect(arr).toEqual([202615, 2026, 1, 5, 9, 7]);
  });
});

describe('RemindersService.init/refresh (startup parse)', () => {
  it('parses Collections and Reminders into collections/lists', async () => {
    const { http, calls } = makeFakeHttp([{ data: STARTUP_FIXTURE }]);
    const svc = new RemindersService(SERVICE_ROOT, http, { dsid: '123' });

    await svc.init();

    // GET /rd/startup with the reminders trio merged into the shared params.
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe(`${SERVICE_ROOT}/rd/startup`);
    expect(calls[0].opts?.params).toMatchObject({
      dsid: '123',
      clientVersion: '4.0',
      lang: 'en-us',
    });
    expect(calls[0].opts?.params?.usertz).toBeDefined();

    // Collections keyed by title → {guid, ctag}.
    expect(svc.collections).toEqual({
      Tasks: { guid: 'guid-tasks', ctag: 'ctag-tasks' },
      Groceries: { guid: 'guid-groceries', ctag: 'ctag-groceries' },
    });

    // Reminders matched by pGuid; orphan (unknown pGuid) excluded everywhere.
    expect(svc.lists.Tasks).toHaveLength(2);
    expect(svc.lists.Groceries).toHaveLength(1);
    const allTitles = [...svc.lists.Tasks, ...svc.lists.Groceries].map(
      (r) => r.title,
    );
    expect(allTitles).not.toContain('Orphan');
  });

  it('reads dueDate indices 1..5 (ignoring index 0) into a Date', async () => {
    const { http } = makeFakeHttp([{ data: STARTUP_FIXTURE }]);
    const svc = new RemindersService(SERVICE_ROOT, http, {});
    await svc.refresh();

    const withDue = svc.lists.Tasks.find((r) => r.title === 'Call dentist')!;
    expect(withDue.desc).toBe('before noon');
    expect(withDue.due).not.toBeNull();
    // dueDate = [999999(ignored), 2026, 6, 3, 14, 30] → 2026-06-03 14:30.
    const d = withDue.due as Date;
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5); // June (0-indexed)
    expect(d.getDate()).toBe(3);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);

    const noDue = svc.lists.Tasks.find((r) => r.title === 'No due date')!;
    expect(noDue.due).toBeNull();
    expect(noDue.desc).toBeUndefined();
  });
});

describe('RemindersService.post (body + ClientState + ok)', () => {
  it('builds the full body, ClientState.Collections, and returns ok', async () => {
    const { http, calls } = makeFakeHttp([
      { data: STARTUP_FIXTURE },
      { status: 200 },
    ]);
    const svc = new RemindersService(SERVICE_ROOT, http, {});
    await svc.init();

    const ok = await svc.post(
      'Renew passport',
      'urgent',
      'Tasks',
      new Date(2026, 5, 3, 14, 30),
    );
    expect(ok).toBe(true);

    const postCall = calls[1];
    expect(postCall.method).toBe('POST');
    expect(postCall.url).toBe(`${SERVICE_ROOT}/rd/reminders/tasks`);

    const body = JSON.parse(postCall.opts?.data as string);

    // Resolved pGuid (named collection → its guid).
    expect(body.Reminders.pGuid).toBe('guid-tasks');
    expect(body.Reminders.title).toBe('Renew passport');
    expect(body.Reminders.description).toBe('urgent');

    // Full pinned scaffold.
    expect(body.Reminders.etag).toBeNull();
    expect(body.Reminders.priority).toBe(0);
    expect(body.Reminders.alarms).toEqual([]);
    expect(body.Reminders.dueDateIsAllDay).toBe(false);
    expect(typeof body.Reminders.createdDateExtended).toBe('number');
    expect(typeof body.Reminders.guid).toBe('string');
    expect(body.Reminders.guid).toHaveLength(36); // uuid4

    // dueDate uses the UNPADDED packed int.
    expect(body.Reminders.dueDate).toEqual([202663, 2026, 6, 3, 14, 30]);
    expect(body.Reminders.dueDate[0]).toBe(parseInt('202663', 10));

    // ClientState.Collections is the cached collection metadata.
    expect(body.ClientState.Collections).toEqual([
      { guid: 'guid-tasks', ctag: 'ctag-tasks' },
      { guid: 'guid-groceries', ctag: 'ctag-groceries' },
    ]);
  });

  it('defaults pGuid to "tasks" and dueDate to null when omitted', async () => {
    const { http, calls } = makeFakeHttp([
      { data: STARTUP_FIXTURE },
      { status: 201 },
    ]);
    const svc = new RemindersService(SERVICE_ROOT, http, {});
    await svc.init();

    const ok = await svc.post('Simple task');
    expect(ok).toBe(true);

    const body = JSON.parse(calls[1].opts?.data as string);
    expect(body.Reminders.pGuid).toBe('tasks');
    expect(body.Reminders.description).toBe('');
    expect(body.Reminders.dueDate).toBeNull();
  });

  it('unknown collection name falls back to "tasks"', async () => {
    const { http, calls } = makeFakeHttp([
      { data: STARTUP_FIXTURE },
      { status: 200 },
    ]);
    const svc = new RemindersService(SERVICE_ROOT, http, {});
    await svc.init();

    await svc.post('x', '', 'NoSuchList');
    const body = JSON.parse(calls[1].opts?.data as string);
    expect(body.Reminders.pGuid).toBe('tasks');
  });

  it('returns false when the server responds with a non-ok status', async () => {
    const { http } = makeFakeHttp([{ data: STARTUP_FIXTURE }, { status: 500 }]);
    const svc = new RemindersService(SERVICE_ROOT, http, {});
    await svc.init();

    const ok = await svc.post('will fail');
    expect(ok).toBe(false);
  });
});
