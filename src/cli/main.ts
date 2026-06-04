#!/usr/bin/env node
/**
 * main.ts — the `#!/usr/bin/env node` entry point for the Find My iPhone CLI
 * (plan §4.10). Thin wrapper: it wires the REAL dependencies and delegates all
 * logic to {@link runCli} in `./fmip-cli`.
 *
 * Real dependencies:
 *  - `createService` → {@link IcloudAuthService.create} (the async auth factory);
 *  - `secrets`       → a {@link SecretsService} instance;
 *  - `stdin`         → `readline/promises` line prompt;
 *  - `confirm`       → `readline/promises` yes/no prompt;
 *  - `exit`          → `process.exit`;
 *  - `log`/`errlog`  → `console.log` / `console.error`.
 *
 * Exposed as the package `bin` (`jsicloud`) via `dist/cli/main.js`.
 */
import * as readline from 'readline/promises';

import { IcloudAuthService } from '../auth/icloud-auth.service';
import { SecretsService } from '../secrets/secrets.service';
import { SessionKeyService } from '../secrets/session-key.service';
import { CliApi, CliDeps, runCli } from './fmip-cli';

/** Prompt for a single line of input on the controlling terminal. */
async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Yes/no confirmation prompt (`[y/N]`); anything starting with `y` is yes. */
async function confirm(question: string): Promise<boolean> {
  const answer = await prompt(`${question} [y/N] `);
  return /^y(es)?$/i.test(answer.trim());
}

/** Build the real dependency bundle and run the CLI. */
async function main(argv: string[]): Promise<void> {
  const secrets = new SecretsService();
  const sessionKey = new SessionKeyService();

  const deps: CliDeps = {
    createService: async (
      username: string,
      password: string,
      china: boolean,
      encrypt: boolean,
      encryptionKeyFile: string,
    ): Promise<CliApi> =>
      IcloudAuthService.create(
        {
          accountName: username,
          password,
          chinaMainland: china,
          encrypt,
          encryptionKeyFile: encryptionKeyFile || undefined,
        },
        secrets,
        sessionKey,
      ),
    secrets,
    sessionKey,
    stdin: prompt,
    confirm,
    exit: (code: number): never => process.exit(code),
    log: (line: string): void => console.log(line),
    errlog: (line: string): void => console.error(line),
  };

  await runCli(argv, deps);
}

// Only auto-run when invoked as a script (not when imported for testing).
if (require.main === module) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

export { main };
