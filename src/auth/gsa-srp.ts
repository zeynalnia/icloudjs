/**
 * Apple GSA (idmsa) SRP-6a authenticator.
 *
 * Apple deprecated the legacy plaintext `POST /signin` flow — it now answers
 * `503 Service Temporarily Unavailable` for accounts that must use SRP. This
 * implements the modern handshake: `POST /signin/init` (exchange the SRP public
 * value `A` for the server salt/`B`) then `POST /signin/complete` (prove
 * knowledge of the password with `M1`/`M2`).
 *
 * The SRP math (group, hashing, `x`/`M1`/`M2` derivation — Apple's GSA variant)
 * is delegated to `@foxt/js-srp` (`Mode.GSA`, `Hash.SHA256`, 2048-bit group), so
 * the cryptography matches Apple byte-for-byte. This module is a faithful port
 * of that library's documented `GSASRPAuthenticator` reference, adapted to the
 * project's types. Only the password derivation (s2k / s2k_fo → PBKDF2-SHA256)
 * and the request/response shapes live here.
 */
import { webcrypto } from 'crypto';
import { Client, Hash, Mode, Srp, util } from '@foxt/js-srp';

export type SrpProtocol = 's2k' | 's2k_fo';

/** Response body of `POST {AUTH}/signin/init`. */
export interface ServerSrpInitResponse {
  iteration: number;
  salt: string; // base64
  protocol: SrpProtocol;
  b: string; // base64 — server public value B
  c: string; // opaque challenge id, echoed back on complete
}

/** Request body of `POST {AUTH}/signin/init`. */
export interface ServerSrpInitRequest {
  a: string; // base64 — client public value A
  accountName: string;
  protocols: SrpProtocol[];
}

/** The SRP-derived portion of the `POST {AUTH}/signin/complete` body. */
export interface SrpCompleteProof {
  accountName: string;
  c: string;
  m1: string; // base64
  m2: string; // base64
}

const srp = new Srp(Mode.GSA, Hash.SHA256, 2048);
const encode = (str: string): Uint8Array => new TextEncoder().encode(str);
const fromBase64 = (str: string): Uint8Array =>
  Uint8Array.from(Buffer.from(str, 'base64'));
const toBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64');

export class GsaSrpAuthenticator {
  private client?: Client;

  constructor(private readonly username: string) {}

  /**
   * Derive the SRP password from the account password per the server-selected
   * protocol: SHA-256 the password (hex-encode it for `s2k_fo`) then
   * PBKDF2-HMAC-SHA256 with the server salt + iteration count, 32-byte output.
   */
  private async derivePassword(
    protocol: SrpProtocol,
    password: string,
    salt: Uint8Array,
    iterations: number,
  ): Promise<Uint8Array> {
    let passHash: Uint8Array = new Uint8Array(
      await util.hash(srp.h, encode(password) as unknown as ArrayBuffer),
    );
    if (protocol === 's2k_fo') {
      passHash = encode(util.toHex(passHash));
    }

    const key = await webcrypto.subtle.importKey(
      'raw',
      passHash,
      { name: 'PBKDF2' },
      false,
      ['deriveBits'],
    );
    const derived = await webcrypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: { name: 'SHA-256' }, iterations, salt },
      key,
      256,
    );
    return new Uint8Array(derived);
  }

  /** Step 1 — build the `signin/init` request (random `A`, empty password). */
  async getInit(): Promise<ServerSrpInitRequest> {
    if (this.client) {
      throw new Error('SRP authenticator already initialized');
    }
    this.client = await srp.newClient(encode(this.username), new Uint8Array());
    const a = toBase64(util.bytesFromBigint(this.client.A));
    return { a, accountName: this.username, protocols: ['s2k', 's2k_fo'] };
  }

  /** Step 2 — using the server's init response, compute `M1`/`M2`. */
  async getComplete(
    password: string,
    serverData: ServerSrpInitResponse,
  ): Promise<SrpCompleteProof> {
    if (!this.client) {
      throw new Error('SRP authenticator not initialized');
    }
    if (serverData.protocol !== 's2k' && serverData.protocol !== 's2k_fo') {
      throw new Error(`Unsupported SRP protocol: ${serverData.protocol}`);
    }
    const salt = fromBase64(serverData.salt);
    const serverPub = fromBase64(serverData.b);
    const derived = await this.derivePassword(
      serverData.protocol,
      password,
      salt,
      serverData.iteration,
    );
    this.client.p = derived;
    await this.client.generate(salt, serverPub);
    const m1 = toBase64(this.client.M);
    const m2 = toBase64(await this.client.generateM2());
    return { accountName: this.username, c: serverData.c, m1, m2 };
  }
}
