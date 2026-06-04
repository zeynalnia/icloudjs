# Security Policy

`jsicloud` authenticates Apple IDs and persists session/cookie credentials, so we
take security reports seriously.

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.x     | ✅        |
| < 1.0   | ❌        |

Security fixes are released against the latest `1.x` minor.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, use one of these private channels:

1. **Preferred — GitHub Private Vulnerability Reporting:** open a report at
   <https://github.com/zeynalnia/icloudjs/security/advisories/new>.
   (The maintainer must enable *Private vulnerability reporting* under the
   repository's Security settings for this to be available.)
2. **Email:** `<add a security contact email here>`.

Please include:

- a description of the vulnerability and its impact,
- the affected version(s),
- steps to reproduce or a proof of concept,
- any suggested remediation.

## What to expect

- We aim to acknowledge a report within **3 business days**.
- We will keep you updated on remediation progress and coordinate a disclosure
  timeline with you.
- With your permission, we will credit you in the release notes and advisory.

## Scope notes for this project

When investigating or reporting, keep in mind how the library handles secrets:

- The account password is never logged and never leaves the process (SRP only
  transmits `A`/`M1`/`M2`); debug logging is scrubbed of the password and
  harvested auth tokens.
- Session and cookie state is **encrypted at rest** by default (AES-256-GCM) and
  written with `0o600` permissions in a per-user directory created `0o700`.
- Never include real credentials, tokens, or `*.session` / `*.cookies.json` files
  in a report; redact them.
