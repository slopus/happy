import { createHmac } from "node:crypto";
import type { AuthenticatorKey } from "@rakazo/contracts";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Bytes(secret: string): Buffer {
  let bits = "";
  for (const char of secret) bits += BASE32.indexOf(char).toString(2).padStart(5, "0");
  return Buffer.from(bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? []);
}

/** When the code this key shows at `now` gives way to its next one. */
export function totpCodeEnd(key: AuthenticatorKey, now: number): number {
  return (Math.floor(now / 1000 / key.period) + 1) * key.period * 1000;
}

/** The RFC 6238 code an authenticator app shows for this key at `now`. */
export function totpCode(key: AuthenticatorKey, now: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / key.period)));
  const mac = createHmac(key.algorithm, base32Bytes(key.secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** key.digits;
  return String(code).padStart(key.digits, "0");
}
