import {
  PyiCloudException,
  PyiCloudAPIResponseException,
  PyiCloudServiceNotActivatedException,
  PyiCloudFailedLoginException,
  PyiCloud2SARequiredException,
  PyiCloudNoStoredPasswordAvailableException,
  PyiCloudNoDevicesException,
} from '../src/exceptions/icloud.exceptions';

describe('icloud.exceptions', () => {
  describe('PyiCloudException (root)', () => {
    it('extends Error and is throwable/catchable', () => {
      const err = new PyiCloudException('boom');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(PyiCloudException);
      expect(err.message).toBe('boom');
      expect(err.name).toBe('PyiCloudException');
      expect(() => {
        throw err;
      }).toThrow(PyiCloudException);
    });

    it('supports an undefined message', () => {
      const err = new PyiCloudException();
      expect(err.message).toBe('');
    });

    it('has a usable stack trace', () => {
      const err = new PyiCloudException('trace');
      expect(typeof err.stack).toBe('string');
      expect(err.stack).toContain('PyiCloudException');
    });
  });

  describe('PyiCloudAPIResponseException', () => {
    it('formats message as just the reason when no code/retry', () => {
      const err = new PyiCloudAPIResponseException('Bad thing');
      expect(err.message).toBe('Bad thing');
      expect(err.reason).toBe('Bad thing');
      expect(err.code).toBeUndefined();
      expect(err.name).toBe('PyiCloudAPIResponseException');
    });

    it('appends " (code)" when a code is provided', () => {
      const err = new PyiCloudAPIResponseException('Bad thing', 421);
      expect(err.message).toBe('Bad thing (421)');
      expect(err.reason).toBe('Bad thing');
      expect(err.code).toBe(421);
    });

    it('supports a string code', () => {
      const err = new PyiCloudAPIResponseException('Denied', 'ACCESS_DENIED');
      expect(err.message).toBe('Denied (ACCESS_DENIED)');
      expect(err.code).toBe('ACCESS_DENIED');
    });

    it('appends ". Retrying ..." when retry is true', () => {
      const err = new PyiCloudAPIResponseException('Bad thing', 500, true);
      expect(err.message).toBe('Bad thing (500). Retrying ...');
    });

    it('appends ". Retrying ..." even without a code', () => {
      const err = new PyiCloudAPIResponseException('Bad thing', undefined, true);
      expect(err.message).toBe('Bad thing. Retrying ...');
    });

    it('uses an empty string when reason is falsy', () => {
      const err = new PyiCloudAPIResponseException('');
      expect(err.message).toBe('');
      expect(err.reason).toBe('');
    });

    it('omits the code suffix when code is falsy (0 / empty string)', () => {
      const zero = new PyiCloudAPIResponseException('Reason', 0);
      expect(zero.message).toBe('Reason');
      const empty = new PyiCloudAPIResponseException('Reason', '');
      expect(empty.message).toBe('Reason');
    });

    it('does NOT store the retry flag on the instance', () => {
      const err = new PyiCloudAPIResponseException('Bad thing', 500, true);
      expect((err as unknown as Record<string, unknown>).retry).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(err, 'retry')).toBe(false);
    });

    it('is a subclass of PyiCloudException', () => {
      const err = new PyiCloudAPIResponseException('x');
      expect(err).toBeInstanceOf(PyiCloudException);
      expect(err).toBeInstanceOf(PyiCloudAPIResponseException);
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('PyiCloudServiceNotActivatedException', () => {
    it('is a child of the API response exception', () => {
      const err = new PyiCloudServiceNotActivatedException('Not active', 'ZONE_NOT_FOUND');
      expect(err).toBeInstanceOf(PyiCloudServiceNotActivatedException);
      expect(err).toBeInstanceOf(PyiCloudAPIResponseException);
      expect(err).toBeInstanceOf(PyiCloudException);
      expect(err).toBeInstanceOf(Error);
    });

    it('inherits reason/code and message formatting', () => {
      const err = new PyiCloudServiceNotActivatedException('Not active', 'ZONE_NOT_FOUND');
      expect(err.message).toBe('Not active (ZONE_NOT_FOUND)');
      expect(err.reason).toBe('Not active');
      expect(err.code).toBe('ZONE_NOT_FOUND');
      expect(err.name).toBe('PyiCloudServiceNotActivatedException');
    });
  });

  describe('PyiCloudFailedLoginException (sibling, not child)', () => {
    it('is a DIRECT child of PyiCloudException', () => {
      const err = new PyiCloudFailedLoginException('Invalid email/password combination.');
      expect(err).toBeInstanceOf(PyiCloudFailedLoginException);
      expect(err).toBeInstanceOf(PyiCloudException);
      expect(err).toBeInstanceOf(Error);
    });

    it('is NOT a child of PyiCloudAPIResponseException', () => {
      const err = new PyiCloudFailedLoginException('Invalid email/password combination.');
      expect(err).not.toBeInstanceOf(PyiCloudAPIResponseException);
      expect(err).not.toBeInstanceOf(PyiCloudServiceNotActivatedException);
    });

    it('carries its message and name', () => {
      const err = new PyiCloudFailedLoginException('Invalid email/password combination.');
      expect(err.message).toBe('Invalid email/password combination.');
      expect(err.name).toBe('PyiCloudFailedLoginException');
    });
  });

  describe('PyiCloud2SARequiredException', () => {
    it('builds the standard message from the apple id', () => {
      const err = new PyiCloud2SARequiredException('user@example.com');
      expect(err.message).toBe(
        'Two-step authentication required for account: user@example.com',
      );
      expect(err.name).toBe('PyiCloud2SARequiredException');
    });

    it('is a direct child of PyiCloudException only', () => {
      const err = new PyiCloud2SARequiredException('user@example.com');
      expect(err).toBeInstanceOf(PyiCloudException);
      expect(err).not.toBeInstanceOf(PyiCloudAPIResponseException);
    });
  });

  describe('PyiCloudNoStoredPasswordAvailableException', () => {
    it('is a direct child of PyiCloudException', () => {
      const err = new PyiCloudNoStoredPasswordAvailableException('no password');
      expect(err).toBeInstanceOf(PyiCloudException);
      expect(err).not.toBeInstanceOf(PyiCloudAPIResponseException);
      expect(err.name).toBe('PyiCloudNoStoredPasswordAvailableException');
      expect(err.message).toBe('no password');
    });
  });

  describe('PyiCloudNoDevicesException', () => {
    it('is a direct child of PyiCloudException', () => {
      const err = new PyiCloudNoDevicesException('no devices');
      expect(err).toBeInstanceOf(PyiCloudException);
      expect(err).not.toBeInstanceOf(PyiCloudAPIResponseException);
      expect(err.name).toBe('PyiCloudNoDevicesException');
      expect(err.message).toBe('no devices');
    });
  });

  describe('setPrototypeOf / instanceof correctness when thrown', () => {
    it('matches the most specific class in a try/catch', () => {
      try {
        throw new PyiCloudServiceNotActivatedException('x', 'AUTHENTICATION_FAILED');
      } catch (e) {
        expect(e).toBeInstanceOf(PyiCloudServiceNotActivatedException);
        expect(e).toBeInstanceOf(PyiCloudAPIResponseException);
        expect(e).toBeInstanceOf(PyiCloudException);
      }
    });

    it('allows narrowing FailedLogin away from API exceptions in a catch', () => {
      const exceptions: PyiCloudException[] = [
        new PyiCloudFailedLoginException('login'),
        new PyiCloudAPIResponseException('api', 500),
      ];
      const apiOnes = exceptions.filter(
        (e) => e instanceof PyiCloudAPIResponseException,
      );
      expect(apiOnes).toHaveLength(1);
      expect(apiOnes[0].message).toBe('api (500)');
    });
  });
});
