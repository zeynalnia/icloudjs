# Contributing to jsicloud

Thanks for your interest in contributing! This document defines the rules and
workflow for changes to this repository.

By participating, you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Ground rules

- **All changes land through pull requests.** New features, bug fixes, and
  refactors must be proposed as a PR against `main` — direct pushes to `main`
  are not allowed. (The repository owner, [@zeynalnia](https://github.com/zeynalnia),
  may push directly when needed.)
- **A maintainer must approve every PR before it is merged.** PRs require review
  and explicit approval from [@zeynalnia](https://github.com/zeynalnia) (see
  [`.github/CODEOWNERS`](./.github/CODEOWNERS)). Do not merge your own PR without
  that approval.
- **Keep the docs in sync with your code.** Any change that affects behavior,
  options, the public API, or the CLI **must** update the relevant documentation
  in the same PR:
  - [`README.md`](./README.md)
  - [`examples/README.md`](./examples/README.md) (and the `examples/` snippets)
  - the agent skill: [`skills/jsicloud/SKILL.md`](./skills/jsicloud/SKILL.md) and
    [`skills/jsicloud/references/`](./skills/jsicloud/references/)
    (`api-reference.md`, `recipes.md`)

  A PR that changes behavior but not the docs will be sent back.
- **Update the changelog.** Add a bullet to the `## [Unreleased]` section of
  [`CHANGELOG.md`](./CHANGELOG.md) for any user-facing change
  (Added / Changed / Fixed / Removed / Security).
- **Never commit secrets or personal data.** No real Apple IDs, passwords,
  tokens, `*.session`, or `*.cookies.json` files. Use the synthetic fixtures
  pattern already in `test/fixtures/` (fictional names, placeholder ids).

## Development setup

```bash
npm ci            # install exact dependency versions
npm run build     # type-check + compile (tsc)
npm test          # run the Jest suite
npm run lint      # ESLint (runs with --max-warnings 0)
npm run format    # Prettier (write)
```

Requirements: **Node >= 18**. `keytar` is a native module; on headless Linux
install `libsecret` (`apt-get install libsecret-1-dev gnome-keyring`).

## Before you open a PR

Your PR must pass all of these locally (CI enforces them too):

- [ ] `npm run build` succeeds (no type errors).
- [ ] `npm test` — all tests pass, and new code has tests. HTTP is mocked with
      `nock` (`nock.disableNetConnect()` is on); the OS keychain is mocked with
      `jest.mock('keytar')`. **Tests must never hit the real network or
      keychain.**
- [ ] `npm run lint` is clean (zero warnings).
- [ ] Docs updated (see Ground rules).
- [ ] `CHANGELOG.md` `[Unreleased]` updated.

## Commit and PR conventions

- **Conventional Commits** for messages: `feat:`, `fix:`, `docs:`, `test:`,
  `refactor:`, `chore:`, `ci:`, plus an optional scope, e.g.
  `fix(fmip): poll for a fresh location`.
- **One focused change per PR.** Keep diffs small and reviewable; split unrelated
  changes into separate PRs.
- Write a clear PR description: what changed, why, and how it was tested. Link any
  related issue.
- Rebase on the latest `main` and resolve conflicts before requesting review.

## Porting fidelity

This project is a port of Python `pyicloud`. Where a behavior mirrors the
upstream library, keep it faithful and note any intentional divergence in a code
comment (search the source for existing "Divergence from Python" notes). Don't
silently "fix" quirks that match Apple's actual API behavior.

## Reporting bugs and requesting features

- **Bugs / features:** open a GitHub Issue with clear steps to reproduce (for
  bugs) or a concrete use case (for features).
- **Security vulnerabilities:** do **not** open a public issue — follow the
  [Security Policy](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](./LICENSE).
