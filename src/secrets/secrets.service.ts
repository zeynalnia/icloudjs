/**
 * Secrets / credential storage — TypeScript port of `pyicloud/utils.py`.
 *
 * Thin, stateless wrapper around `keytar` (the OS keychain) plus the interactive
 * password prompt. All keytar calls use `service = KEYRING_SERVICE`
 * (`'pyicloud://icloud-password'`) and `account = username`, so credentials
 * stored by the Python pyicloud library are readable here and vice versa.
 *
 * Never logs the password.
 */
import { Injectable } from '@nestjs/common';
import * as readline from 'readline/promises';
import * as keytar from 'keytar';

import { KEYRING_SERVICE } from '../constants';
import { PyiCloudNoStoredPasswordAvailableException } from '../exceptions/icloud.exceptions';

/**
 * Re-export of the casing helper so it is reachable from the secrets module's
 * public surface (the Python `utils` module co-located it with the keyring
 * helpers). Canonical implementation lives in `../util/camelcase`.
 */
export { underscoreToCamelcase } from '../util/camelcase';

@Injectable()
export class SecretsService {
  /**
   * Resolve a password for `username`: keyring first, falling back to an
   * interactive prompt.
   *
   * FIX #5: `interactive` defaults to `process.stdout.isTTY` evaluated at CALL
   * TIME (a default-parameter expression), not once at import (the Python bug
   * captured `sys.stdout.isatty()` at import time).
   *
   * @param username    The Apple ID.
   * @param interactive Whether prompting is allowed. Defaults to the current
   *                    TTY state, evaluated on each call.
   * @returns The resolved password.
   * @throws PyiCloudNoStoredPasswordAvailableException when no stored password
   *         exists and the session is non-interactive.
   */
  async getPassword(
    username: string,
    interactive: boolean = !!process.stdout.isTTY,
  ): Promise<string> {
    try {
      return await this.getPasswordFromKeyring(username);
    } catch (err) {
      if (err instanceof PyiCloudNoStoredPasswordAvailableException) {
        if (!interactive) {
          throw err;
        }
        return this.promptForPassword(username);
      }
      throw err;
    }
  }

  /** Return true when a stored password exists in the keyring for `username`. */
  async passwordExistsInKeyring(username: string): Promise<boolean> {
    try {
      await this.getPasswordFromKeyring(username);
    } catch (err) {
      if (err instanceof PyiCloudNoStoredPasswordAvailableException) {
        return false;
      }
      throw err;
    }
    return true;
  }

  /**
   * Read the stored password from the keyring.
   *
   * @throws PyiCloudNoStoredPasswordAvailableException when keytar resolves
   *         `null` (no entry).
   */
  async getPasswordFromKeyring(username: string): Promise<string> {
    const result = await keytar.getPassword(KEYRING_SERVICE, username);
    if (result === null || result === undefined) {
      throw new PyiCloudNoStoredPasswordAvailableException(
        `No pyicloud password for ${username} could be found in the system ` +
          'keychain. Use the `--store-in-keyring` command-line option for ' +
          'storing a password for this username.',
      );
    }
    return result;
  }

  /** Store (or overwrite) the password for `username` in the keyring. */
  async storePasswordInKeyring(username: string, password: string): Promise<void> {
    await keytar.setPassword(KEYRING_SERVICE, username, password);
  }

  /** Delete the stored password for `username` from the keyring. */
  async deletePasswordInKeyring(username: string): Promise<void> {
    await keytar.deletePassword(KEYRING_SERVICE, username);
  }

  /**
   * Prompt the user for a password on the controlling terminal. Split out so it
   * can be overridden/spied in tests. The entered value is returned verbatim
   * and never logged.
   */
  protected async promptForPassword(username: string): Promise<string> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await rl.question(`Enter iCloud password for ${username}: `);
    } finally {
      rl.close();
    }
  }
}
