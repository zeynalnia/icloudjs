/**
 * `IcloudModule` — the dynamic NestJS module wiring an authenticated iCloud
 * session (plan §3.2).
 *
 * Both `forRoot` and `forRootAsync` register:
 *   - the resolved `IcloudModuleOptions` under the `ICLOUD_OPTIONS` token,
 *   - the stateless `SecretsService` (keytar wrapper),
 *   - an async factory provider for `IcloudAuthService` that calls
 *     `IcloudAuthService.create(options, secrets)`.
 *
 * The auth factory is where ALL network I/O happens (sign-in, token exchange,
 * params population). This honours the "no network in constructors" rule from
 * §0 / §3.3 — Nest awaits the async `useFactory` during module init, so the
 * `IcloudAuthService` instance handed to consumers is already authenticated.
 *
 * `IcloudHttpService` and `SessionStore` are constructed INSIDE
 * `IcloudAuthService.create()` (they need account-derived cookie paths), so
 * they are intentionally not separate Nest providers here (§3.2).
 */
import {
  DynamicModule,
  InjectionToken,
  Module,
  Provider,
  Type,
} from '@nestjs/common';

import { ICLOUD_OPTIONS } from './icloud.constants';
import { IcloudModuleOptions } from './interfaces/options.interface';
import { SecretsService } from './secrets/secrets.service';
import { IcloudAuthService } from './auth/icloud-auth.service';

/**
 * Options object for `IcloudModule.forRootAsync`. Mirrors the standard Nest
 * async-options pattern: the consumer supplies a factory (optionally with
 * injected dependencies and extra imports) that yields the resolved
 * `IcloudModuleOptions`.
 */
export interface IcloudModuleAsyncOptions {
  /**
   * Factory producing the resolved options. May be sync or async. Its injected
   * arguments are resolved from `inject` (in order).
   */
  useFactory: (
    ...args: unknown[]
  ) => Promise<IcloudModuleOptions> | IcloudModuleOptions;
  /** Providers/tokens to inject into `useFactory`, in positional order. */
  inject?: InjectionToken[];
  /** Extra modules to import so `inject` tokens resolve (e.g. ConfigModule). */
  imports?: Array<Type<unknown> | DynamicModule | Promise<DynamicModule>>;
}

/**
 * The async factory provider for `IcloudAuthService`, shared by both
 * registration paths. It depends on the resolved options (already registered
 * under `ICLOUD_OPTIONS`) and `SecretsService`, and performs the authenticated
 * `create()` — the single place network I/O occurs at module init.
 */
const authServiceProvider: Provider = {
  provide: IcloudAuthService,
  useFactory: async (
    options: IcloudModuleOptions,
    secrets: SecretsService,
  ): Promise<IcloudAuthService> => IcloudAuthService.create(options, secrets),
  inject: [ICLOUD_OPTIONS, SecretsService],
};

@Module({})
export class IcloudModule {
  /**
   * Register the module with statically-known options.
   *
   * @param options Resolved `IcloudModuleOptions` (account name, optional
   *                password, cookie dir, China mode, etc.).
   */
  static forRoot(options: IcloudModuleOptions): DynamicModule {
    return {
      module: IcloudModule,
      providers: [
        { provide: ICLOUD_OPTIONS, useValue: options },
        SecretsService,
        authServiceProvider,
      ],
      exports: [IcloudAuthService, SecretsService],
    };
  }

  /**
   * Register the module with options produced asynchronously (e.g. from a
   * `ConfigService`). The supplied `useFactory`/`inject`/`imports` are wired to
   * the `ICLOUD_OPTIONS` token; the `IcloudAuthService` factory then consumes
   * the resolved options exactly as in `forRoot`.
   */
  static forRootAsync(opts: IcloudModuleAsyncOptions): DynamicModule {
    const optionsProvider: Provider = {
      provide: ICLOUD_OPTIONS,
      useFactory: opts.useFactory,
      inject: opts.inject ?? [],
    };

    return {
      module: IcloudModule,
      imports: opts.imports ?? [],
      providers: [optionsProvider, SecretsService, authServiceProvider],
      exports: [IcloudAuthService, SecretsService],
    };
  }
}
