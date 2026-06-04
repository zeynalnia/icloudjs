# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- CLI diagnostics no longer pollute stdout. The library's logs are routed to
  **stderr** and silenced by default, so `jsicloud --json` (and `--list`) emit
  only the data on stdout — e.g. `jsicloud --json > devices.json` is now clean.
  Pass `-v`/`--verbose` to print diagnostic logs (still to stderr).

### Changed

- **BREAKING: minimum Node is now `>=22`** (was `>=18`). Upgraded
  `http-cookie-agent` 6→8, `axios-cookiejar-support` 5→7, and `commander` 12→15,
  all of which require Node 22+ (commander recommends 22.12+). Node 18 and 20 are
  end-of-life; CI and the publish workflow now run on Node 22. The test runner
  transpiles these now-ESM-only dependencies via ts-jest.

## [1.1.0] - 2026-06-04

### Added

- **Encryption at rest** for the persisted session (`.session`) and cookie jar
  (`.cookies.json`) files, using AES-256-GCM. Enabled by default. The key is
  resolved from an explicit base64 key file (`encryptionKeyFile`), else the OS
  keychain, else a freshly generated key that is stored in the keychain. New
  options `encrypt` and `encryptionKeyFile`; new CLI flags `--no-encrypt` and
  `-k, --encryption-key-file`; new public exports `SessionCipher`,
  `SessionKeyService`, and the `PyiCloudSessionDecryptionException` error.
- `AppleDevice.locate({ attempts?, intervalMs? })` — actively locates a Find My
  iPhone device and polls until a fresh fix arrives, instead of returning the
  stale cached position.

### Changed

- The default session/cookie directory moved from the shared system temp
  directory to a durable per-user state directory (`$XDG_STATE_HOME` /
  `~/Library/Application Support` / `%LOCALAPPDATA%`, with a temp-dir fallback
  when headless), created with mode `0o700`; the token files inside are now
  written with mode `0o600`. Existing plaintext session files are migrated to
  the encrypted format transparently, with no re-login required.
- CLI `--locate` now polls for a fresh location fix before printing, rather than
  showing the stale (`isOld`) position from the first refresh.
- CLI `--json` combined with `--device <id>` now emits the single matching
  device object (or `null` when nothing matched) instead of a one-element array.

### Security

- The Find My iPhone `--outputfile` filename is sanitized (reduced to a basename
  with a safe character set) to prevent path traversal (CWE-22) from a
  device-supplied name.

## [1.0.0] - 2026-06-03

### Added

- Initial release: a NestJS / TypeScript port of Python `pyicloud`. Apple ID
  authentication via SRP with 2FA (HSA2) / 2SA (HSA1) and session trust, and
  clients for iCloud Drive, Photos, Find My iPhone, Account
  (devices / family / storage), Calendar, Contacts, and Reminders. Includes the
  Find My iPhone command-line tool and npm publishing via GitHub OIDC Trusted
  Publishing.

[Unreleased]: https://github.com/zeynalnia/icloudjs/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/zeynalnia/icloudjs/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/zeynalnia/icloudjs/releases/tag/v1.0.0
