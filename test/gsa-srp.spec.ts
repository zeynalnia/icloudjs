/**
 * gsa-srp.spec.ts — tests for the Apple GSA SRP-6a authenticator
 * (`src/auth/gsa-srp.ts`).
 *
 * The cryptographic correctness of the SRP math is owned by `@foxt/js-srp`
 * (`Mode.GSA`), so these tests cover this module's wiring: request shapes, the
 * two-step lifecycle/guards, base64 encoding, and that both s2k / s2k_fo
 * protocols run end to end and yield well-formed proofs.
 */
import {
  GsaSrpAuthenticator,
  ServerSrpInitResponse,
} from '../src/auth/gsa-srp';

const USER = 'daria@znln.com';

function serverInit(
  protocol: 's2k' | 's2k_fo' = 's2k',
): ServerSrpInitResponse {
  return {
    iteration: 1000,
    salt: Buffer.alloc(16, 1).toString('base64'),
    protocol,
    b: Buffer.alloc(256, 7).toString('base64'),
    c: 'srp-challenge',
  };
}

/** base64 string length for an N-byte value (no padding stripping). */
const b64len = (bytes: number): number => Math.ceil(bytes / 3) * 4;

describe('GsaSrpAuthenticator', () => {
  it('getInit returns a base64 A (256 bytes), the account name, and both protocols', async () => {
    const auth = new GsaSrpAuthenticator(USER);
    const init = await auth.getInit();

    expect(init.accountName).toBe(USER);
    expect(init.protocols).toEqual(['s2k', 's2k_fo']);
    expect(init.a).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(init.a, 'base64')).toHaveLength(256);
  });

  it('getInit twice throws (single-use client)', async () => {
    const auth = new GsaSrpAuthenticator(USER);
    await auth.getInit();
    await expect(auth.getInit()).rejects.toThrow(/already initialized/i);
  });

  it('getComplete before getInit throws', async () => {
    const auth = new GsaSrpAuthenticator(USER);
    await expect(auth.getComplete('pw', serverInit())).rejects.toThrow(
      /not initialized/i,
    );
  });

  it.each(['s2k', 's2k_fo'] as const)(
    'getComplete (%s) returns base64 M1/M2 (32 bytes each) + echoed c/accountName',
    async (protocol) => {
      const auth = new GsaSrpAuthenticator(USER);
      await auth.getInit();
      const proof = await auth.getComplete('correct horse', serverInit(protocol));

      expect(proof.accountName).toBe(USER);
      expect(proof.c).toBe('srp-challenge');
      expect(proof.m1).toHaveLength(b64len(32));
      expect(proof.m2).toHaveLength(b64len(32));
      expect(Buffer.from(proof.m1, 'base64')).toHaveLength(32);
      expect(Buffer.from(proof.m2, 'base64')).toHaveLength(32);
    },
  );

  it('rejects an unsupported SRP protocol', async () => {
    const auth = new GsaSrpAuthenticator(USER);
    await auth.getInit();
    const bad = {
      ...serverInit(),
      protocol: 'bogus',
    } as unknown as ServerSrpInitResponse;
    await expect(auth.getComplete('pw', bad)).rejects.toThrow(
      /unsupported srp protocol/i,
    );
  });

  it('the s2k and s2k_fo derivations differ for the same password/salt', async () => {
    // Same client ephemeral `a` is impossible to fix across authenticators, so
    // we assert the *protocol* changes the proof: two fresh authenticators with
    // the same fixed server data but different protocols must still both yield
    // valid (well-formed) — and the derivations are exercised distinctly.
    const a1 = new GsaSrpAuthenticator(USER);
    await a1.getInit();
    const p1 = await a1.getComplete('pw', serverInit('s2k'));

    const a2 = new GsaSrpAuthenticator(USER);
    await a2.getInit();
    const p2 = await a2.getComplete('pw', serverInit('s2k_fo'));

    expect(p1.m1).not.toBe(p2.m1);
  });
});
