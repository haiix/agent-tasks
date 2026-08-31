import { randomBytes } from "node:crypto";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Generates a collision-resistant, lexicographically sortable ULID. */
export function generateId(now = Date.now()): string {
  let timestamp = BigInt(now);
  let encodedTime = "";
  for (let index = 0; index < 10; index += 1) {
    encodedTime = CROCKFORD_BASE32[Number(timestamp & 31n)] + encodedTime;
    timestamp >>= 5n;
  }

  let randomness = BigInt(`0x${randomBytes(10).toString("hex")}`);
  let encodedRandomness = "";
  for (let index = 0; index < 16; index += 1) {
    encodedRandomness =
      CROCKFORD_BASE32[Number(randomness & 31n)] + encodedRandomness;
    randomness >>= 5n;
  }
  return encodedTime + encodedRandomness;
}
