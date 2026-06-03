/**
 * 03 — iCloud Drive (CloudDocs): navigate, download, upload, mkdir, rename, delete
 * ===============================================================================
 *
 * `auth.drive` is a SYNC getter returning a `DriveService` (no async init). The
 * drive is a tree of `DriveNode`s: each node is a folder, a file, or an app
 * library. Folder nodes lazily fetch + cache their children; file nodes stream.
 *
 * WHY the two-phase navigation (`root()` then `dir()`/`get()`)?
 *   The root metadata is fetched once on the first `root()` call and cached.
 *   `dir()` returns child NAMES; `get(name)` returns the child NODE so you can
 *   recurse or operate on it. This mirrors a filesystem walk.
 *
 * Run:  APPLE_ID=you@icloud.com APPLE_PASSWORD=secret \
 *         npx ts-node examples/03-drive.ts
 */
import { Readable } from 'stream';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

import { IcloudAuthService, SecretsService, DriveNode } from '../src';

async function main(): Promise<void> {
  const accountName = process.env.APPLE_ID;
  if (!accountName) throw new Error('Set APPLE_ID in the env.');

  const auth = await IcloudAuthService.create(
    { accountName, password: process.env.APPLE_PASSWORD },
    new SecretsService(),
  );
  // (For brevity this example assumes a trusted session — see example 01 for
  // the full 2FA/2SA flow.)

  const drive = auth.drive; // sync getter — no await, no init()

  // -------------------------------------------------------------------------
  // 1. Navigate the tree.
  // -------------------------------------------------------------------------
  const root: DriveNode = await drive.root();
  console.log('Root child names:', await root.dir());

  // Walk one level deep, printing type/size/modified for each child.
  for (const child of await root.getChildren()) {
    console.log(
      `  - ${child.name} ` +
        `[type=${child.type ?? '?'}, ` +
        `size=${child.size ?? 'n/a'}, ` +
        // Folders return null for dates; files return a Date.
        `modified=${child.dateModified?.toISOString() ?? 'n/a'}]`,
    );
  }

  // -------------------------------------------------------------------------
  // 2. Download a file (streamed).
  //    `open()` returns a Readable. NOTE: a 0-byte file short-circuits to an
  //    empty stream with NO HTTP call (iCloud 400s on a 0-byte download).
  // -------------------------------------------------------------------------
  const targetName = process.env.DRIVE_FILE; // e.g. "report.pdf" at the root
  if (targetName) {
    // `get()` throws if no child with that name exists, so guard with the
    // listing or wrap in try/catch in real code.
    const fileNode = await root.get(targetName);
    if (fileNode.type === 'file') {
      const stream: Readable = await fileNode.open();
      const dest = `/tmp/${fileNode.name}`;
      await pipeline(stream, createWriteStream(dest));
      console.log(`Downloaded ${fileNode.name} (${fileNode.size} bytes) -> ${dest}`);
    }
  }

  // -------------------------------------------------------------------------
  // 3. Upload a file into the root folder.
  //    `upload(fileName, stream, size)` runs the 3-POST CloudDocs upload saga.
  //    The `size` MUST match the byte length of the stream's contents.
  // -------------------------------------------------------------------------
  const payload = Buffer.from('Hello from jsicloud examples!\n', 'utf-8');
  await root.upload('jsicloud-example.txt', Readable.from(payload), payload.length);
  console.log('Uploaded jsicloud-example.txt');

  // Re-fetch children so the new file shows up. `getChildren()` caches, so we
  // navigate from a FRESH root() to bypass the cached child list.
  const freshRoot = await drive.root();

  // -------------------------------------------------------------------------
  // 4. mkdir — create a sub-folder under a node.
  // -------------------------------------------------------------------------
  await freshRoot.mkdir('jsicloud-example-folder');
  console.log('Created folder jsicloud-example-folder');

  // -------------------------------------------------------------------------
  // 5. rename — rename uses the node's etag internally for optimistic
  //    concurrency, so you only pass the new name.
  // -------------------------------------------------------------------------
  try {
    const uploaded = await freshRoot.get('jsicloud-example.txt');
    await uploaded.rename('jsicloud-example-renamed.txt');
    console.log('Renamed jsicloud-example.txt -> jsicloud-example-renamed.txt');

    // -----------------------------------------------------------------------
    // 6. delete — soft delete (moves the node to the iCloud trash).
    //    We re-fetch the node first so we hold the post-rename etag.
    // -----------------------------------------------------------------------
    const renamed = await (await drive.root()).get('jsicloud-example-renamed.txt');
    await renamed.delete();
    console.log('Moved jsicloud-example-renamed.txt to trash');
  } catch (err) {
    // `get()` throws if the child is not yet visible (eventual consistency).
    console.warn('Rename/delete skipped:', (err as Error).message);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
