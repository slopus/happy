import { randomBytes, randomInt } from "node:crypto";

const BLOCK = 36 ** 4;
let counter = randomInt(BLOCK);
const fingerprint = randomInt(BLOCK).toString(36).padStart(4, "0");

/**
 * Collision-resistant ids shaped like Prisma's `cuid()` defaults (25 characters,
 * time-ordered prefix). Encrypted rows need their id before the insert because
 * the id is bound into each ciphertext.
 */
export function createRowId(): string {
  counter = (counter + 1) % BLOCK;
  const time = Date.now().toString(36).padStart(8, "0").slice(-8);
  const count = counter.toString(36).padStart(4, "0");
  const random = (randomBytes(6).readUIntBE(0, 6) % 36 ** 8).toString(36).padStart(8, "0");
  return `c${time}${count}${fingerprint}${random}`;
}
