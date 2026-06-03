/**
 * ContactsService — TypeScript port of `pyicloud.services.contacts.ContactsService`
 * (`services/contacts.py`).
 *
 * The Contacts iCloud service connects to the `{contacts}` webservice root and
 * returns the account's contacts. Its defining characteristic is a **two-step
 * sequential token handshake** (plan §4.9 / ARCHITECTURE_MAP §3.5):
 *
 *   Step 1 — `GET {root}/co/startup?clientVersion=2.1&locale=en_US&order=last,first`
 *            → returns a `prefToken` and a `syncToken`.
 *   Step 2 — `GET {root}/co/contacts?…&prefToken=<>&syncToken=<>&limit=0&offset=0`
 *            (`limit=0` means "all") → returns the full `contacts[]` payload,
 *            which OVERWRITES `response`.
 *
 * The two steps are strictly SEQUENTIAL — step 2 threads the `prefToken` and
 * `syncToken` harvested from step 1's body, so the handshake must NOT be
 * parallelized. The Python source awaits each request in turn; we mirror that
 * exactly (one `await`, then the next).
 *
 * Constructor signature is pinned by the auth-service accessor: `(serviceRoot,
 * http, params)` — the shared, post-login mutable `params` bag is threaded into
 * the query string of BOTH requests (it carries `clientId`/`dsid`/build numbers
 * populated by `populateParams`).
 *
 * Response key casing is camelCase for contacts (`contacts`, `prefToken`,
 * `syncToken`) — accessed literally, never auto-transformed (plan §0).
 */
import { IcloudHttpService } from '../session/icloud-http.service';

/**
 * The body shape returned by the `/co/startup` handshake step. Only the two
 * tokens that thread into step 2 are load-bearing; the rest of the payload is
 * discarded when step 2 overwrites `response`.
 */
export interface ContactsStartupResponse {
  prefToken: string;
  syncToken: string;
  [key: string]: unknown;
}

/**
 * The body shape returned by the `/co/contacts` step. `contacts` is the array
 * of contact records surfaced by {@link ContactsService.all}.
 */
export interface ContactsListResponse {
  contacts?: Contact[];
  [key: string]: unknown;
}

/**
 * A single contact record. The server payload is open-ended (many optional
 * fields per contact); we type the well-known identity fields and keep an index
 * signature so callers can read the rest without losing type-safety on the
 * common ones.
 */
export interface Contact {
  /** Stable per-contact identifier. */
  contactId?: string;
  /** ETag for optimistic concurrency. */
  etag?: string;
  firstName?: string;
  lastName?: string;
  /** Display name as rendered by iCloud. */
  normalized?: string;
  phones?: Array<Record<string, unknown>>;
  emailAddresses?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export class ContactsService {
  /** `{serviceRoot}/co` — the contacts endpoint base. */
  private readonly contactsEndpoint: string;
  /** Step 1 URL: `{…}/co/startup`. */
  private readonly contactsRefreshUrl: string;
  /** Step 2 URL: `{…}/co/contacts`. */
  private readonly contactsNextUrl: string;
  /**
   * `{…}/co/changeset` — declared (mirrors the Python source) but unused; kept
   * for parity / future incremental-sync support.
   */
  private readonly contactsChangesetUrl: string;

  /** The most recently fetched response body (overwritten by step 2). */
  response: ContactsListResponse = {};

  constructor(
    protected readonly serviceRoot: string,
    protected readonly http: IcloudHttpService,
    protected readonly params: Record<string, string>,
  ) {
    this.contactsEndpoint = `${this.serviceRoot}/co`;
    this.contactsRefreshUrl = `${this.contactsEndpoint}/startup`;
    this.contactsNextUrl = `${this.contactsEndpoint}/contacts`;
    this.contactsChangesetUrl = `${this.contactsEndpoint}/changeset`;
  }

  /**
   * Refresh the contacts data via the two-step, strictly-sequential handshake.
   *
   * Step 1 (`/co/startup`) yields `prefToken`/`syncToken`; step 2
   * (`/co/contacts`) threads those tokens plus `limit=0`/`offset=0` (all
   * contacts) and OVERWRITES `response` with the full contact list.
   *
   * The steps MUST run in order — do not parallelize: step 2 depends on tokens
   * produced by step 1.
   */
  async refreshClient(): Promise<void> {
    // Step 1 — startup handshake. Start from a copy of the shared params bag,
    // then add the contacts-specific query params.
    const paramsContacts: Record<string, string> = {
      ...this.params,
      clientVersion: '2.1',
      locale: 'en_US',
      order: 'last,first',
    };

    const startupResp = await this.http.request<ContactsStartupResponse>(
      'GET',
      this.contactsRefreshUrl,
      { params: paramsContacts },
    );
    const startup = startupResp.data;

    // Step 2 — fetch all contacts, threading the tokens from step 1.
    // `limit=0` means "all"; `offset=0` starts at the beginning.
    const paramsNext: Record<string, string> = {
      ...paramsContacts,
      prefToken: startup.prefToken,
      syncToken: startup.syncToken,
      limit: '0',
      offset: '0',
    };

    const listResp = await this.http.request<ContactsListResponse>(
      'GET',
      this.contactsNextUrl,
      { params: paramsNext },
    );
    // Overwrite the response with the full contacts payload.
    this.response = listResp.data;
  }

  /**
   * Retrieve all contacts. Runs the two-step handshake, then returns
   * `response.contacts` (the camelCase server key). Returns `undefined` when the
   * payload carries no `contacts` array (mirrors the Python `.get("contacts")`).
   */
  async all(): Promise<Contact[] | undefined> {
    await this.refreshClient();
    return this.response.contacts;
  }
}
