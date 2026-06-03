/**
 * make-service.ts — builds a fully authenticated {@link IcloudAuthService}
 * against the nock mock router (`installMockRouter`), for use by `auth.spec.ts`
 * (and any service spec that needs a live, logged-in auth orchestrator).
 *
 * It runs the REAL `IcloudAuthService.create()` factory — the same async
 * factory the NestJS module uses — so the genuine signin → accountLogin flow,
 * header harvesting, and `populateParams` are exercised end to end against the
 * wire-level mock.
 *
 * Each call uses a fresh temporary cookie directory (so there is no persisted
 * session_token and authentication always starts from a full sign-in) and a
 * stubbed `SecretsService` (no real keyring access). The returned `cleanup()`
 * removes the temp directory; call it in an `afterEach`.
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { IcloudAuthService } from '../../src/auth/icloud-auth.service';
import { IcloudModuleOptions } from '../../src/interfaces/options.interface';
import { SecretsService } from '../../src/secrets/secrets.service';

import { AUTHENTICATED_USER, VALID_PASSWORD } from './auth-state';

/** Overrides for {@link makeAuthService}. */
export interface MakeServiceOptions extends Partial<IcloudModuleOptions> {
  /** Apple ID; defaults to the authenticated fixture user. */
  accountName?: string;
  /** Password; defaults to the valid fixture password. */
  password?: string;
}

/** Result of {@link makeAuthService}: the live service + a temp-dir cleanup. */
export interface MadeService {
  service: IcloudAuthService;
  /** The temporary cookie directory used for this service. */
  cookieDir: string;
  /** Remove the temporary cookie directory (call in afterEach). */
  cleanup: () => Promise<void>;
}

/**
 * A minimal {@link SecretsService} stub: never touches the real keyring. The
 * auth factory only calls `getPasswordFromKeyring` when no explicit password is
 * supplied; we always supply one, so this stub simply rejects to make any
 * accidental keyring access loud.
 */
export function stubSecrets(): SecretsService {
  const stub: Partial<SecretsService> = {
    getPasswordFromKeyring: jest.fn(async (username: string) => {
      throw new Error(`unexpected keyring access for ${username}`);
    }),
    getPassword: jest.fn(async () => VALID_PASSWORD),
    passwordExistsInKeyring: jest.fn(async () => false),
    storePasswordInKeyring: jest.fn(async () => undefined),
    deletePasswordInKeyring: jest.fn(async () => undefined),
  };
  return stub as SecretsService;
}

/**
 * Build and authenticate an {@link IcloudAuthService} against the (already
 * installed) mock router.
 *
 * Precondition: `installMockRouter()` has been called for this test and
 * `nock.disableNetConnect()` is active (both handled by `test/setup.ts` +
 * the spec's `beforeEach`).
 */
export async function makeAuthService(
  overrides: MakeServiceOptions = {},
): Promise<MadeService> {
  const cookieDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsicloud-auth-'));

  const options: IcloudModuleOptions = {
    accountName: overrides.accountName ?? AUTHENTICATED_USER,
    password: overrides.password ?? VALID_PASSWORD,
    cookieDir,
    chinaMainland: overrides.chinaMainland,
    verify: overrides.verify,
    clientId: overrides.clientId,
  };

  const service = await IcloudAuthService.create(options, stubSecrets());

  const cleanup = async (): Promise<void> => {
    await fs.rm(cookieDir, { recursive: true, force: true }).catch(() => undefined);
  };

  return { service, cookieDir, cleanup };
}
