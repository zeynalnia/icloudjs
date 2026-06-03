/**
 * Library exceptions — TypeScript port of `pyicloud/exceptions.py`.
 *
 * Hierarchy (matches the Python source exactly):
 *
 *   PyiCloudException                                  (root, extends Error)
 *   ├── PyiCloudAPIResponseException                   (API errors)
 *   │   └── PyiCloudServiceNotActivatedException
 *   ├── PyiCloudFailedLoginException                   (SIBLING of API exc, NOT a child)
 *   ├── PyiCloud2SARequiredException
 *   ├── PyiCloudNoStoredPasswordAvailableException
 *   └── PyiCloudNoDevicesException
 *
 * Every subclass sets `this.name` and calls `Object.setPrototypeOf(this, X.prototype)`
 * so that `instanceof` works correctly across the prototype chain even when the
 * code is transpiled to a CommonJS target that down-levels `extends Error`
 * (the well-known TypeScript "extending built-ins" caveat).
 */

/** Generic iCloud exception (root of the hierarchy). */
export class PyiCloudException extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'PyiCloudException';
    Object.setPrototypeOf(this, PyiCloudException.prototype);
  }
}

/**
 * iCloud response exception.
 *
 * Message formatting mirrors the Python `__init__` exactly:
 *   - start with `reason` (or empty string when falsy),
 *   - append ` (<code>)` when a truthy `code` is provided,
 *   - append `. Retrying ...` when `retry` is true.
 *
 * `reason` and `code` are stored on the instance; `retry` is intentionally
 * NOT stored (it only influences the formatted message), matching the source.
 */
export class PyiCloudAPIResponseException extends PyiCloudException {
  readonly reason: string;
  readonly code?: string | number;

  constructor(reason: string, code?: string | number, retry = false) {
    let message = reason || '';
    if (code) {
      message += ` (${code})`;
    }
    if (retry) {
      message += '. Retrying ...';
    }
    super(message);
    this.name = 'PyiCloudAPIResponseException';
    this.reason = reason;
    this.code = code;
    // retry is NOT stored (matches pyicloud).
    Object.setPrototypeOf(this, PyiCloudAPIResponseException.prototype);
  }
}

/** iCloud service not activated exception (child of the API response exception). */
export class PyiCloudServiceNotActivatedException extends PyiCloudAPIResponseException {
  constructor(reason: string, code?: string | number, retry = false) {
    super(reason, code, retry);
    this.name = 'PyiCloudServiceNotActivatedException';
    Object.setPrototypeOf(this, PyiCloudServiceNotActivatedException.prototype);
  }
}

/**
 * iCloud failed login exception.
 *
 * IMPORTANT: this is a DIRECT child of `PyiCloudException` (a sibling of
 * `PyiCloudAPIResponseException`), NOT a child of the API exception. This
 * preserves the catch-specificity contract: catching `PyiCloudFailedLoginException`
 * must not catch generic API response errors and vice versa.
 */
export class PyiCloudFailedLoginException extends PyiCloudException {
  constructor(message?: string) {
    super(message);
    this.name = 'PyiCloudFailedLoginException';
    Object.setPrototypeOf(this, PyiCloudFailedLoginException.prototype);
  }
}

/** iCloud 2SA (two-step authentication) required exception. */
export class PyiCloud2SARequiredException extends PyiCloudException {
  constructor(appleId: string) {
    super(`Two-step authentication required for account: ${appleId}`);
    this.name = 'PyiCloud2SARequiredException';
    Object.setPrototypeOf(this, PyiCloud2SARequiredException.prototype);
  }
}

/** iCloud no stored password (in keyring) exception. */
export class PyiCloudNoStoredPasswordAvailableException extends PyiCloudException {
  constructor(message?: string) {
    super(message);
    this.name = 'PyiCloudNoStoredPasswordAvailableException';
    Object.setPrototypeOf(this, PyiCloudNoStoredPasswordAvailableException.prototype);
  }
}

/** iCloud no devices exception (webservice specific). */
export class PyiCloudNoDevicesException extends PyiCloudException {
  constructor(message?: string) {
    super(message);
    this.name = 'PyiCloudNoDevicesException';
    Object.setPrototypeOf(this, PyiCloudNoDevicesException.prototype);
  }
}
