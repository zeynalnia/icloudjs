/**
 * 04 — Photos (CloudKit): albums, "All Photos", iterate assets, versions, download
 * ===============================================================================
 *
 * `auth.photos()` is an ASYNC method (note the parentheses + await): it runs a
 * one-time `init()` that probes the CloudKit indexing state and throws
 * `PyiCloudServiceNotActivatedException` unless indexing has FINISHED. After
 * that the returned `PhotosService` is cached.
 *
 * WHY async-iterate?
 *   A `PhotoAlbum` implements `AsyncIterable<PhotoAsset>` and paginates the
 *   CloudKit database under the hood (100 assets per page by default). Using
 *   `for await` streams them lazily so you never load the whole library into
 *   memory — important for accounts with tens of thousands of photos.
 *
 * Run:  APPLE_ID=you@icloud.com APPLE_PASSWORD=secret \
 *         npx ts-node examples/04-photos.ts
 */
import { Readable } from 'stream';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

import {
  IcloudAuthService,
  SecretsService,
  PhotoAsset,
  PyiCloudServiceNotActivatedException,
} from '../src';

async function main(): Promise<void> {
  const accountName = process.env.APPLE_ID;
  if (!accountName) throw new Error('Set APPLE_ID in the env.');

  const auth = await IcloudAuthService.create(
    { accountName, password: process.env.APPLE_PASSWORD },
    new SecretsService(),
  );

  // ASYNC accessor — init() (the CheckIndexingState probe) has already run by
  // the time this resolves. If the library is still indexing it throws.
  let photos;
  try {
    photos = await auth.photos();
  } catch (err) {
    if (err instanceof PyiCloudServiceNotActivatedException) {
      console.error('Photo library not finished indexing yet — try later.');
      process.exit(1);
    }
    throw err;
  }

  // -------------------------------------------------------------------------
  // 1. List all albums (smart folders like "All Photos", "Videos",
  //    "Favorites", plus the user's own albums). The map is keyed by name.
  // -------------------------------------------------------------------------
  const albums = await photos.albums();
  console.log('Albums:', Object.keys(albums).join(', '));

  // -------------------------------------------------------------------------
  // 2. Pick the "All Photos" smart album. `photos.all()` is the shortcut for
  //    `albums['All Photos']`.
  // -------------------------------------------------------------------------
  const all = await photos.all();
  // `length()` does a separate count query (cached after the first call).
  console.log(`"${all.title}" contains ${await all.length()} assets.`);

  // -------------------------------------------------------------------------
  // 3. Async-iterate the assets. We only look at the first few here.
  // -------------------------------------------------------------------------
  let count = 0;
  const MAX = 3;
  let firstAsset: PhotoAsset | undefined;

  for await (const asset of all) {
    if (!firstAsset) firstAsset = asset;

    const [w, h] = asset.dimensions;
    console.log(
      `  ${asset.filename}  ` +
        `${w}x${h}  ${asset.size} bytes  ` +
        `created=${asset.created.toISOString()}`,
    );

    // 4. Inspect the available versions (e.g. 'original', 'medium', 'thumb').
    //    `versions` is a LOCAL (synchronous) getter — no network call.
    const versionNames = Object.keys(asset.versions);
    console.log('      versions:', versionNames.join(', ') || '(none)');

    if (++count >= MAX) break; // stop early so the example finishes quickly
  }

  // -------------------------------------------------------------------------
  // 5. Download the ORIGINAL of the first asset (streamed).
  //    `download(version?)` defaults to 'original' and returns null if that
  //    version (or its URL) is missing.
  // -------------------------------------------------------------------------
  if (firstAsset) {
    const stream: Readable | null = await firstAsset.download('original');
    if (stream) {
      const dest = `/tmp/${firstAsset.filename}`;
      await pipeline(stream, createWriteStream(dest));
      console.log(`Downloaded original -> ${dest}`);
    } else {
      console.log('Original version unavailable for the first asset.');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
