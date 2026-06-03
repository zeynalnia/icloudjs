/**
 * Tests for SecretsService (port of `pyicloud/utils.py`).
 *
 * keytar is mocked via `jest.mock('keytar')` so no OS keychain is touched.
 */
import { PassThrough, Writable } from 'stream';
import * as keytar from 'keytar';

import {
  SecretsService,
  underscoreToCamelcase,
} from '../src/secrets/secrets.service';
import { KEYRING_SERVICE } from '../src/constants';
import { PyiCloudNoStoredPasswordAvailableException } from '../src/exceptions/icloud.exceptions';

jest.mock('keytar');

const mockedKeytar = keytar as jest.Mocked<typeof keytar>;

const USERNAME = 'quentintarantino@hotmail.fr';
const PASSWORD = 'valid_password';

describe('SecretsService', () => {
  let service: SecretsService;
  /** Snapshot/restore of the real isTTY so we can drive the call-time default. */
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    service = new SecretsService();
    originalIsTTY = process.stdout.isTTY;
  });

  afterEach(() => {
    // Restore isTTY (it is a plain property on the stream).
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: originalIsTTY,
    });
  });

  describe('KEYRING_SERVICE', () => {
    it('uses the exact pyicloud keyring service name for cross-compat', () => {
      expect(KEYRING_SERVICE).toBe('pyicloud://icloud-password');
    });
  });

  describe('getPasswordFromKeyring', () => {
    it('returns the stored password and queries the correct service/account', async () => {
      mockedKeytar.getPassword.mockResolvedValue(PASSWORD);

      await expect(service.getPasswordFromKeyring(USERNAME)).resolves.toBe(PASSWORD);
      expect(mockedKeytar.getPassword).toHaveBeenCalledWith(
        'pyicloud://icloud-password',
        USERNAME,
      );
    });

    it('throws PyiCloudNoStoredPasswordAvailableException when keytar returns null', async () => {
      mockedKeytar.getPassword.mockResolvedValue(null);

      await expect(service.getPasswordFromKeyring(USERNAME)).rejects.toBeInstanceOf(
        PyiCloudNoStoredPasswordAvailableException,
      );
    });
  });

  describe('passwordExistsInKeyring', () => {
    it('returns true when a password is stored', async () => {
      mockedKeytar.getPassword.mockResolvedValue(PASSWORD);
      await expect(service.passwordExistsInKeyring(USERNAME)).resolves.toBe(true);
    });

    it('returns false when no password is stored', async () => {
      mockedKeytar.getPassword.mockResolvedValue(null);
      await expect(service.passwordExistsInKeyring(USERNAME)).resolves.toBe(false);
    });
  });

  describe('storePasswordInKeyring', () => {
    it('delegates to keytar.setPassword with the correct service/account', async () => {
      mockedKeytar.setPassword.mockResolvedValue();

      await service.storePasswordInKeyring(USERNAME, PASSWORD);

      expect(mockedKeytar.setPassword).toHaveBeenCalledWith(
        'pyicloud://icloud-password',
        USERNAME,
        PASSWORD,
      );
    });
  });

  describe('deletePasswordInKeyring', () => {
    it('delegates to keytar.deletePassword with the correct service/account', async () => {
      mockedKeytar.deletePassword.mockResolvedValue(true);

      await service.deletePasswordInKeyring(USERNAME);

      expect(mockedKeytar.deletePassword).toHaveBeenCalledWith(
        'pyicloud://icloud-password',
        USERNAME,
      );
    });
  });

  describe('getPassword', () => {
    it('returns the keyring password when one exists (no prompt)', async () => {
      mockedKeytar.getPassword.mockResolvedValue(PASSWORD);
      const promptSpy = jest
        .spyOn(service as unknown as { promptForPassword: () => Promise<string> }, 'promptForPassword')
        .mockResolvedValue('should-not-be-used');

      await expect(service.getPassword(USERNAME)).resolves.toBe(PASSWORD);
      expect(promptSpy).not.toHaveBeenCalled();
    });

    it('re-throws NoStoredPassword when non-interactive and nothing stored', async () => {
      mockedKeytar.getPassword.mockResolvedValue(null);

      await expect(service.getPassword(USERNAME, false)).rejects.toBeInstanceOf(
        PyiCloudNoStoredPasswordAvailableException,
      );
    });

    it('prompts interactively when nothing stored and interactive=true', async () => {
      mockedKeytar.getPassword.mockResolvedValue(null);
      const promptSpy = jest
        .spyOn(service as unknown as { promptForPassword: () => Promise<string> }, 'promptForPassword')
        .mockResolvedValue('typed-password');

      await expect(service.getPassword(USERNAME, true)).resolves.toBe('typed-password');
      expect(promptSpy).toHaveBeenCalledWith(USERNAME);
    });

    it('evaluates process.stdout.isTTY at CALL TIME for the interactive default (FIX #5)', async () => {
      mockedKeytar.getPassword.mockResolvedValue(null);
      const promptSpy = jest
        .spyOn(service as unknown as { promptForPassword: () => Promise<string> }, 'promptForPassword')
        .mockResolvedValue('tty-typed');

      // Flip isTTY to true AFTER construction/import — the default must observe
      // this current value, not a value captured at import time.
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: true,
      });

      await expect(service.getPassword(USERNAME)).resolves.toBe('tty-typed');
      expect(promptSpy).toHaveBeenCalledWith(USERNAME);
    });

    it('re-throws (no prompt) when isTTY is false at call time and nothing stored', async () => {
      mockedKeytar.getPassword.mockResolvedValue(null);
      const promptSpy = jest
        .spyOn(service as unknown as { promptForPassword: () => Promise<string> }, 'promptForPassword')
        .mockResolvedValue('should-not-be-used');

      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: false,
      });

      await expect(service.getPassword(USERNAME)).rejects.toBeInstanceOf(
        PyiCloudNoStoredPasswordAvailableException,
      );
      expect(promptSpy).not.toHaveBeenCalled();
    });
  });

  describe('promptForPassword (input masking)', () => {
    it('does NOT echo the typed password to the output stream', async () => {
      const SECRET = 'PLAINTEXT-s3cret!';
      // A fake TTY input: isTTY true forces readline into terminal/echo mode,
      // which is exactly the path that must be masked.
      const fakeIn = new PassThrough() as PassThrough & {
        isTTY?: boolean;
        setRawMode?: (mode: boolean) => void;
      };
      fakeIn.isTTY = true;
      fakeIn.setRawMode = (): void => undefined;

      const written: string[] = [];
      const fakeOut = new Writable({
        write(chunk, _enc, cb): void {
          written.push(String(chunk));
          cb();
        },
      });

      const promise = (
        service as unknown as {
          promptForPassword: (
            u: string,
            i: unknown,
            o: unknown,
          ) => Promise<string>;
        }
      ).promptForPassword(USERNAME, fakeIn, fakeOut);

      fakeIn.write(`${SECRET}\n`);
      const answer = await promise;

      const out = written.join('');
      expect(answer).toBe(SECRET); // the password is still captured correctly
      expect(out).toContain('Enter iCloud password'); // the prompt IS visible
      expect(out).not.toContain(SECRET); // ...but the password is NOT echoed
    });
  });

  describe('underscoreToCamelcase (re-exported)', () => {
    it("converts 'foo_bar' to 'fooBar'", () => {
      expect(underscoreToCamelcase('foo_bar')).toBe('fooBar');
    });

    it('supports initial capital (PascalCase)', () => {
      expect(underscoreToCamelcase('foo_bar', true)).toBe('FooBar');
    });
  });
});
