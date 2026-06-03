/**
 * 07 — Calendar, Contacts & Reminders
 * ===================================
 *
 * Three small services in one file:
 *
 *   - Calendar  (`auth.calendar`)  — SYNC getter, GET-only. `events(from, to)`.
 *   - Contacts  (`auth.contacts`)  — SYNC getter. `all()` runs a 2-step token
 *                                    handshake and returns the contact list.
 *   - Reminders (`auth.reminders()`) — ASYNC accessor (note the parentheses):
 *                                    its `init()` loads the lists/collections,
 *                                    which `post()` then needs. `post()` creates
 *                                    a reminder.
 *
 * Run:  APPLE_ID=you@icloud.com APPLE_PASSWORD=secret \
 *         npx ts-node examples/07-calendar-contacts-reminders.ts
 */
import { IcloudAuthService, SecretsService } from '../src';

async function main(): Promise<void> {
  const accountName = process.env.APPLE_ID;
  if (!accountName) throw new Error('Set APPLE_ID in the env.');

  const auth = await IcloudAuthService.create(
    { accountName, password: process.env.APPLE_PASSWORD },
    new SecretsService(),
  );

  // =========================================================================
  // CALENDAR — list events in an explicit date range.
  // =========================================================================
  const calendar = auth.calendar; // sync getter

  // Explicit range: the next 30 days. (When called with no args, `events()`
  // defaults to the FULL current month.)
  const from = new Date();
  const to = new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);

  // Returns `undefined` when the server omits the `Event` key (no events).
  const events = await calendar.events(from, to);
  console.log(`Calendar timezone: ${calendar.usertz}`);
  console.log(`Events in range (${events?.length ?? 0}):`);
  for (const ev of events ?? []) {
    // CalendarEvent is an open-ended record; `title`/`guid` are common keys.
    console.log(`  - ${ev.title ?? '(untitled)'} (${ev.guid ?? 'no-guid'})`);
  }

  // =========================================================================
  // CONTACTS — fetch all contacts via the two-step handshake.
  // =========================================================================
  const contacts = auth.contacts; // sync getter

  // `all()` runs `/co/startup` then `/co/contacts` and returns the list (or
  // `undefined` if the payload carries no `contacts` array).
  const allContacts = await contacts.all();
  console.log(`\nContacts (${allContacts?.length ?? 0}):`);
  for (const c of (allContacts ?? []).slice(0, 5)) {
    const name =
      c.normalized ??
      [c.firstName, c.lastName].filter(Boolean).join(' ') ??
      '(no name)';
    console.log(`  - ${name} (id=${c.contactId ?? 'n/a'})`);
  }

  // =========================================================================
  // REMINDERS — list collections, then create a reminder.
  // =========================================================================
  // ASYNC accessor: init()/refresh() has already populated `lists` +
  // `collections`. `post()` REQUIRES those collections to be loaded because it
  // builds a ClientState snapshot from the cache — so always go through the
  // accessor (never `new RemindersService`).
  const reminders = await auth.reminders();

  console.log('\nReminder lists:', Object.keys(reminders.lists).join(', '));

  // Create a reminder. Signature: post(title, description?, collection?, dueDate?).
  // `collection` must be one of the loaded collection titles, else it falls
  // back to the default 'tasks' list. Returns true on HTTP status < 400.
  if (process.env.CREATE_REMINDER === '1') {
    const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // tomorrow
    const ok = await reminders.post(
      'Buy milk (created by jsicloud example)',
      'Two litres, semi-skimmed.',
      undefined, // default 'tasks' collection
      dueDate,
    );
    console.log(ok ? 'Reminder created.' : 'Reminder creation failed.');
  } else {
    console.log('Skipping reminder creation (set CREATE_REMINDER=1 to enable).');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
