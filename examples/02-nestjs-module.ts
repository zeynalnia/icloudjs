/**
 * 02 — NestJS module integration (`IcloudModule.forRootAsync`)
 * ===========================================================
 *
 * The idiomatic way to use this library inside a NestJS app. `IcloudModule`
 * registers an already-authenticated `IcloudAuthService` as a provider, so any
 * service can simply inject it.
 *
 * WHY `forRootAsync`?
 *   It lets you build the iCloud options ASYNCHRONOUSLY from other providers —
 *   most commonly a `ConfigService`. The `useFactory` receives whatever you list
 *   in `inject` (positionally) and returns the resolved `IcloudModuleOptions`.
 *
 * IMPORTANT — authentication happens at MODULE INIT:
 *   The `IcloudAuthService` provider is an async factory that calls
 *   `IcloudAuthService.create(options, secrets)`. Nest awaits it during module
 *   bootstrap, so by the time your code runs the service is ALREADY
 *   authenticated. The flip side: if the account needs an interactive 2FA/2SA
 *   code, bootstrap will block / fail unless a previously trusted session is on
 *   disk (the cookie/session files). For a server you typically pre-trust the
 *   session once via example 01, then this module reuses it silently.
 *
 * Run:  APPLE_ID=you@icloud.com APPLE_PASSWORD=secret \
 *         npx ts-node examples/02-nestjs-module.ts
 */
import 'reflect-metadata'; // required by Nest's decorator metadata at runtime
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { IcloudModule, IcloudAuthService } from '../src';

/**
 * A minimal, self-contained ConfigService-style provider.
 *
 * In a real app you would use `@nestjs/config`'s `ConfigService` (and import
 * its `ConfigModule`). We hand-roll an equivalent here so this example has no
 * extra dependency beyond what the library already ships — the wiring pattern
 * (`imports` + `inject` + `useFactory`) is IDENTICAL to the real thing.
 */
@Injectable()
class ConfigService {
  get<T = string>(key: string): T | undefined {
    return process.env[key] as unknown as T | undefined;
  }
}

/** A tiny module that exports our stand-in ConfigService. */
@Module({ providers: [ConfigService], exports: [ConfigService] })
class ConfigModule {}

/**
 * A consumer service. It injects `IcloudAuthService` exactly like any other
 * Nest provider — `IcloudModule` exports it, so it is available app-wide.
 */
@Injectable()
class MyIcloudConsumer {
  // Constructor injection: Nest resolves the already-authenticated instance.
  constructor(private readonly auth: IcloudAuthService) {}

  /** Example business method: list the iCloud Drive root folder. */
  async listDriveRoot(): Promise<string[] | null> {
    // `drive` is a sync getter; `dir()` does the network call.
    return this.auth.drive.dir();
  }

  /** Example business method: show who is signed in. */
  whoAmI(): string {
    return this.auth.data.dsInfo?.fullName ?? this.auth.user.accountName;
  }
}

/**
 * The application module. `IcloudModule.forRootAsync` wires the iCloud options
 * from `ConfigService`. We import `ConfigModule` so `ConfigService` resolves,
 * and list it in `inject` so the factory receives it positionally.
 */
@Module({
  imports: [
    // Make ConfigService available to the async factory below.
    ConfigModule,

    IcloudModule.forRootAsync({
      // `imports` here ensures the `inject` tokens are resolvable in this
      // module's injection scope.
      imports: [ConfigModule],
      // Positional dependencies passed to `useFactory`, in order.
      inject: [ConfigService],
      // The factory may be sync or async; it returns IcloudModuleOptions.
      // Its parameters are typed `unknown` (the generic Nest async-options
      // signature), so we narrow the injected dependency at the top.
      useFactory: (...args: unknown[]) => {
        const config = args[0] as ConfigService;
        return {
          // `accountName` is the only REQUIRED field.
          accountName: config.get<string>('APPLE_ID') ?? '',
          // `password` is optional: omit it to fall back to the OS keyring.
          password: config.get<string>('APPLE_PASSWORD'),
          // Set `chinaMainland: true` for Apple IDs registered in mainland China.
          // chinaMainland: (config.get<string>('APPLE_CHINA') === 'true'),
        };
      },
    }),
  ],
  providers: [MyIcloudConsumer],
})
class AppModule {}

async function main(): Promise<void> {
  if (!process.env.APPLE_ID) {
    throw new Error('Set APPLE_ID (and optionally APPLE_PASSWORD) in the env.');
  }

  // `createApplicationContext` boots the DI container WITHOUT an HTTP server —
  // perfect for scripts. The iCloud `create()` factory runs (and authenticates)
  // during this await.
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    // Pull the consumer out of the container and exercise it.
    const consumer = app.get(MyIcloudConsumer);
    console.log('Signed in as:', consumer.whoAmI());
    console.log('Drive root:', (await consumer.listDriveRoot()) ?? '(empty)');

    // You can also resolve the auth service directly if you prefer:
    const auth = app.get(IcloudAuthService);
    if (auth.requires2fa || auth.requires2sa) {
      console.warn(
        'Session not yet trusted — run example 01 once to complete 2FA/2SA ' +
          'and persist a trusted session for this account.',
      );
    }
  } finally {
    // Always close the context so the process can exit cleanly.
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
