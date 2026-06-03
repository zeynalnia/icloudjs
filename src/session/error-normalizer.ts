/**
 * Error normalization — port of `PyiCloudSession._raise_error` and the inline
 * reason/code extraction in `PyiCloudSession.request` (`base.py`).
 *
 * iCloud JSON error bodies use inconsistent key names across endpoints, and
 * some endpoints return HTTP 2xx with an error payload. `extractReasonCode`
 * normalizes those into `{ reason, code }` using the exact key-priority order
 * from the source; `raiseError` maps `(code, reason)` to a typed exception via
 * an ordered special-case table.
 */
import {
  PyiCloud2SARequiredException,
  PyiCloudAPIResponseException,
  PyiCloudServiceNotActivatedException,
} from '../exceptions/icloud.exceptions';

/** Context needed by `raiseError`'s 2SA special case. */
export interface RaiseErrorContext {
  /** True when the service currently requires two-step authentication. */
  requires2sa: boolean;
  /** Apple ID used in the 2SA-required exception message. */
  appleId: string;
}

/**
 * Extract `{ reason, code }` from a parsed JSON error body.
 *
 * Reason priority (first truthy wins), mirroring `base.py`:
 *   errorMessage → reason → errorReason
 *   → (error, when it is a string)
 *   → 'Unknown reason' (when `error` is otherwise truthy)
 *
 * Code priority:
 *   errorCode → serverErrorCode
 *
 * A non-object body (array, string, number, null) yields no reason/code.
 */
export function extractReasonCode(body: unknown): {
  reason?: string;
  code?: string | number;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {};
  }

  const data = body as Record<string, unknown>;

  let reason: string | undefined;
  if (data.errorMessage) {
    reason = data.errorMessage as string;
  } else if (data.reason) {
    reason = data.reason as string;
  } else if (data.errorReason) {
    reason = data.errorReason as string;
  } else if (typeof data.error === 'string') {
    reason = data.error;
  } else if (data.error) {
    reason = 'Unknown reason';
  }

  let code: string | number | undefined;
  if (data.errorCode) {
    code = data.errorCode as string | number;
  } else if (data.serverErrorCode) {
    code = data.serverErrorCode as string | number;
  }

  return { reason, code };
}

/**
 * Map `(code, reason)` to a typed exception and throw it.
 *
 * Special-case table, applied IN ORDER (matches `_raise_error`):
 *   1. requires2sa AND reason === 'Missing X-APPLE-WEBAUTH-TOKEN cookie'
 *        → PyiCloud2SARequiredException(appleId)
 *   2. code in {'ZONE_NOT_FOUND','AUTHENTICATION_FAILED'}
 *        → PyiCloudServiceNotActivatedException(<setup-your-service message>, code)
 *   3. code === 'ACCESS_DENIED'
 *        → append throttle note to reason (falls through to default throw)
 *   4. code in {421,450,500}
 *        → reason replaced with 'Authentication required for Account.'
 *           (falls through to default throw)
 *   5. else → PyiCloudAPIResponseException(reason, code)
 *
 * Cases 3 and 4 mutate `reason`/`code` only; the actual throw happens at the
 * tail so they share the default `PyiCloudAPIResponseException` construction.
 */
export function raiseError(
  code: string | number | undefined,
  reason: string,
  ctx: RaiseErrorContext,
): never {
  // 1. 2SA challenge surfaced as a missing-cookie error.
  if (ctx.requires2sa && reason === 'Missing X-APPLE-WEBAUTH-TOKEN cookie') {
    throw new PyiCloud2SARequiredException(ctx.appleId);
  }

  // 2. Service not provisioned for this account.
  if (code === 'ZONE_NOT_FOUND' || code === 'AUTHENTICATION_FAILED') {
    const notActivatedReason =
      'Please log into https://icloud.com/ to manually ' +
      'finish setting up your iCloud service';
    throw new PyiCloudServiceNotActivatedException(notActivatedReason, code);
  }

  // 3. Throttling — augment the reason, then fall through to the default throw.
  let finalReason = reason;
  if (code === 'ACCESS_DENIED') {
    finalReason =
      finalReason +
      '.  Please wait a few minutes then try again.' +
      'The remote servers might be trying to throttle requests.';
  }

  // 4. Auth-required HTTP statuses — replace the reason wholesale.
  if (code === 421 || code === 450 || code === 500) {
    finalReason = 'Authentication required for Account.';
  }

  // 5. Default.
  throw new PyiCloudAPIResponseException(finalReason, code);
}
