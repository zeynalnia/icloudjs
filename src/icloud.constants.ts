/**
 * NestJS dependency-injection tokens for the Icloud module.
 *
 * Used by `IcloudModule.forRoot`/`forRootAsync` to register the resolved
 * options, and injected into the `IcloudAuthService` async factory.
 */

/** Injection token for the resolved `IcloudModuleOptions`. */
export const ICLOUD_OPTIONS = Symbol('ICLOUD_OPTIONS');

/**
 * Injection token for the async-options factory passed to `forRootAsync`.
 * (Used internally when the consumer supplies a `useFactory` producing the
 * `IcloudModuleOptions`.)
 */
export const ICLOUD_MODULE_OPTIONS = Symbol('ICLOUD_MODULE_OPTIONS');
