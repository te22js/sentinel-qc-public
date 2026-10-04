/**
 * ULID generator (Crockford base32, 48-bit timestamp + 80-bit randomness),
 * monotonic within a millisecond. Dependency-free.
 * Spec: https://github.com/ulid/spec
 */
import { randomBytes } from 'node:crypto';

const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = -1;
let lastRandom: number[] = [];

export function ulid(now = Date.now()): string {
  let time = now;
  let random: number[];
  if (time === lastTime) {
    // increment the previous randomness to stay monotonic
    random = lastRandom.slice();
    for (let i = random.length - 1; i >= 0; i--) {
      if (random[i] < 31) {
        random[i]++;
        break;
      }
      random[i] = 0;
    }
  } else {
    const bytes = randomBytes(16);
    random = [];
    for (let i = 0; i < 16; i++) random.push(bytes[i] % 32);
  }
  lastTime = time;
  lastRandom = random;

  let ts = '';
  for (let i = 9; i >= 0; i--) {
    ts = ENC[time % 32] + ts;
    time = Math.floor(time / 32);
  }
  return ts + random.map((r) => ENC[r]).join('');
}
