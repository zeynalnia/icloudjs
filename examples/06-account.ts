/**
 * 06 — Account: paired devices, family members (+ avatar), storage usage
 * ======================================================================
 *
 * `auth.account` is a SYNC getter returning an `AccountService`. Its three
 * accessors — `devices()`, `family()`, `storage()` — are async, lazy, and
 * cached (the first call fetches; later calls return the cached value).
 *
 * Run:  APPLE_ID=you@icloud.com APPLE_PASSWORD=secret \
 *         npx ts-node examples/06-account.ts
 */
import { Readable } from 'stream';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

import { IcloudAuthService, SecretsService } from '../src';

async function main(): Promise<void> {
  const accountName = process.env.APPLE_ID;
  if (!accountName) throw new Error('Set APPLE_ID in the env.');

  const auth = await IcloudAuthService.create(
    { accountName, password: process.env.APPLE_PASSWORD },
    new SecretsService(),
  );

  const account = auth.account; // sync getter

  // -------------------------------------------------------------------------
  // 1. Paired devices. Each AccountDevice carries model/name/serial/os/etc.
  // -------------------------------------------------------------------------
  const devices = await account.devices();
  console.log(`Paired devices (${devices.length}):`);
  for (const d of devices) {
    console.log(
      `  - ${d.name} — ${d.modelDisplayName} ` +
        `(model=${d.model}, os=${d.osVersion}, serial=${d.serialNumber})`,
    );
  }

  // -------------------------------------------------------------------------
  // 2. Family Sharing members. Each FamilyMember exposes typed getters and a
  //    streamed `getPhoto()` avatar.
  // -------------------------------------------------------------------------
  const family = await account.family();
  console.log(`\nFamily members (${family.length}):`);
  for (const member of family) {
    console.log(
      `  - ${member.fullName ?? '(unknown)'} ` +
        `[${member.ageClassification ?? 'n/a'}] ` +
        `appleId=${member.appleId ?? 'n/a'}`,
    );
  }

  // Download the first member's avatar (streamed) to /tmp.
  if (family.length > 0) {
    const photo: Readable = await family[0].getPhoto();
    const dest = '/tmp/family-member-photo.jpg';
    await pipeline(photo, createWriteStream(dest));
    console.log(`Saved first member's avatar -> ${dest}`);
  }

  // -------------------------------------------------------------------------
  // 3. Storage usage. `storage()` returns an AccountStorage with an overall
  //    `usage` summary plus a per-media breakdown keyed by media key.
  // -------------------------------------------------------------------------
  const storage = await account.storage();
  const u = storage.usage;
  console.log('\nStorage:');
  console.log(
    `  ${u.usedStorageInBytes} / ${u.totalStorageInBytes} bytes ` +
      `(${u.usedStorageInPercent}% used, ` +
      `${u.availableStorageInBytes} bytes free)`,
  );
  console.log(
    `  quotaOver=${u.quotaOver} quotaAlmostFull=${u.quotaAlmostFull} ` +
      `quotaPaid=${u.quotaPaid}`,
  );

  // Per-media breakdown (photos, backup, docs, mail, ...).
  console.log('  By media:');
  for (const [mediaKey, media] of Object.entries(storage.usagesByMedia)) {
    console.log(`    ${mediaKey}: ${media.label} — ${media.usageInBytes} bytes`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
