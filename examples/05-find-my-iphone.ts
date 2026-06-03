/**
 * 05 — Find My iPhone: list devices, locate, play sound, message, lost mode
 * =========================================================================
 *
 * `auth.findMyiPhone()` is an ASYNC method: its one-time `init()` runs the
 * initial device-list refresh, so the returned `FindMyiPhoneService` already
 * has the device map populated. An account with zero devices throws
 * `PyiCloudNoDevicesException` during that init.
 *
 * WHY does `location()` refresh the whole list?
 *   There is no per-device location endpoint. Each `location()` / `status()`
 *   call POSTs a fresh whole-list `refreshClient`, then reads the (just
 *   replaced) content for that device. So the data you read is always current.
 *
 * SAFETY: the commands below (playSound, displayMessage, lostDevice) actually
 * affect a real device. They are GUARDED behind env flags so running this file
 * is harmless by default.
 *
 * Run:  APPLE_ID=you@icloud.com APPLE_PASSWORD=secret \
 *         npx ts-node examples/05-find-my-iphone.ts
 */
import {
  IcloudAuthService,
  SecretsService,
  AppleDevice,
  PyiCloudNoDevicesException,
} from '../src';

async function main(): Promise<void> {
  const accountName = process.env.APPLE_ID;
  if (!accountName) throw new Error('Set APPLE_ID in the env.');

  const auth = await IcloudAuthService.create(
    { accountName, password: process.env.APPLE_PASSWORD },
    new SecretsService(),
  );

  // ASYNC accessor — init()/refreshClient() has already run.
  let fmip;
  try {
    fmip = await auth.findMyiPhone();
  } catch (err) {
    if (err instanceof PyiCloudNoDevicesException) {
      console.error('This account has no Find My devices.');
      process.exit(1);
    }
    throw err;
  }

  // -------------------------------------------------------------------------
  // 1. List devices. `all` is a getter returning every AppleDevice in
  //    insertion order; `keys()` gives the matching device ids.
  // -------------------------------------------------------------------------
  const devices: AppleDevice[] = fmip.all;
  console.log(`Found ${devices.length} device(s):`);
  devices.forEach((d, i) => {
    // `data` is the raw content blob; name/deviceDisplayName are common fields.
    console.log(`  [${i}] ${d.data.name ?? d.data.deviceDisplayName ?? d.data.id}`);
  });

  // Pick the first device. `get(0)` indexes by ORDER; `get('iPhone12,1')` would
  // look up by device id string. Both throw PyiCloudNoDevicesException if missing.
  const device = fmip.get(0);

  // -------------------------------------------------------------------------
  // 2. Locate it (triggers a whole-list refresh, then reads `content.location`).
  // -------------------------------------------------------------------------
  const location = await device.location();
  console.log('Location:', location ?? '(unavailable)');

  // A small status snapshot (battery, display name, status code, name). Pass
  // extra field names as `status(['isLocating', ...])` to widen the selection.
  const status = await device.status();
  console.log('Status:', status);

  // -------------------------------------------------------------------------
  // 3. Play a sound (default subject "Find My iPhone Alert"). GUARDED.
  // -------------------------------------------------------------------------
  if (process.env.FMIP_PLAY_SOUND === '1') {
    await device.playSound(); // or playSound('Custom subject')
    console.log('Played sound on the device.');
  } else {
    console.log('Skipping playSound (set FMIP_PLAY_SOUND=1 to enable).');
  }

  // -------------------------------------------------------------------------
  // 4. Display a message (optionally with a sound). GUARDED.
  //    Options: { subject?, message?, sounds? } — all optional with defaults.
  // -------------------------------------------------------------------------
  if (process.env.FMIP_MESSAGE === '1') {
    await device.displayMessage({
      subject: 'Hello',
      message: 'This is a test message from jsicloud.',
      sounds: true,
    });
    console.log('Displayed message on the device.');
  } else {
    console.log('Skipping displayMessage (set FMIP_MESSAGE=1 to enable).');
  }

  // -------------------------------------------------------------------------
  // 5. Lost mode. GUARDED — this LOCKS the device, so it is opt-in and needs a
  //    callback number. Options: { number, text?, newpasscode? }.
  // -------------------------------------------------------------------------
  if (process.env.FMIP_LOST_NUMBER) {
    await device.lostDevice({
      number: process.env.FMIP_LOST_NUMBER,
      text: 'This device has been lost. Please call the number shown.',
      // newpasscode: '' leaves the existing passcode unchanged (the default).
    });
    console.log('Enabled lost mode on the device.');
  } else {
    console.log('Skipping lostDevice (set FMIP_LOST_NUMBER=<phone> to enable).');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
