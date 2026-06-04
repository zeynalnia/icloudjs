/**
 * Public barrel for the `jsicloud` package.
 *
 * Re-exports the NestJS module, the infrastructure services
 * (`IcloudAuthService`, `SecretsService`, `IcloudHttpService`, `SessionStore`,
 * `SessionKeyService`, `SessionCipher`),
 * every per-service class (Drive, Ubiquity, Photos, Account, FindMyiPhone,
 * Calendar, Contacts, Reminders) plus their nodes/value objects, all public
 * interfaces/types, the constants, and the full exception hierarchy.
 *
 * Verified collision-free: no two source modules export the same symbol name,
 * so wildcard re-exports are safe.
 */

// ---------------------------------------------------------------------------
// Module + DI tokens
// ---------------------------------------------------------------------------
export { IcloudModule, IcloudModuleAsyncOptions } from './icloud.module';
export { ICLOUD_OPTIONS, ICLOUD_MODULE_OPTIONS } from './icloud.constants';

// ---------------------------------------------------------------------------
// Infrastructure services
// ---------------------------------------------------------------------------
export { IcloudAuthService, AuthenticateOptions } from './auth/icloud-auth.service';
export { SecretsService, underscoreToCamelcase } from './secrets/secrets.service';
export {
  IcloudHttpService,
  Endpoints,
  IcloudAuthLike,
  IcloudRequestOptions,
} from './session/icloud-http.service';
export { SessionStore } from './session/session-store';
export { SessionCipher } from './session/session-cipher';
export { SessionKeyService } from './secrets/session-key.service';
export {
  RaiseErrorContext,
  extractReasonCode,
  raiseError,
} from './session/error-normalizer';

// ---------------------------------------------------------------------------
// Per-service classes / nodes / value objects
// ---------------------------------------------------------------------------
export * from './services/drive.service';
export * from './services/ubiquity.service';
export * from './services/photos.service';
export * from './services/account.service';
export * from './services/findmyiphone.service';
export * from './services/calendar.service';
export * from './services/contacts.service';
export * from './services/reminders.service';

// ---------------------------------------------------------------------------
// Interfaces / types
// ---------------------------------------------------------------------------
export * from './interfaces/options.interface';
export * from './interfaces/session-data.interface';
export * from './interfaces/login-response.interface';
export * from './interfaces/webservices.interface';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export * from './constants';

// ---------------------------------------------------------------------------
// Exceptions (full hierarchy)
// ---------------------------------------------------------------------------
export * from './exceptions/icloud.exceptions';
