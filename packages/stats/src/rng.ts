/**
 * PCG32 pseudo-random number generator.
 *
 * Reference: O'Neill, M.E. (2014). "PCG: A Family of Simple Fast Space-Efficient
 * Statistically Good Algorithms for Random Number Generation." HMC-CS-2014-0905.
 *
 * State transition: state = state * 6364136223846793005 + inc  (mod 2^64), inc odd.
 * Output (XSH-RR): rot32( ((state >> 18) ^ state) >> 27, state >> 59 ).
 *
 * Deterministic and seedable; used by PSAD permutations, Monte-Carlo tests and the
 * demo data generator so every result is reproducible.
 */

const MULT = 6364136223846793005n;
const MASK64 = (1n << 64n) - 1n;

export class Pcg32 {
  private state: bigint;
  private inc: bigint;
  private spareNormal: number | null = null;

  constructor(seed: number | bigint, seq: number | bigint = 54n) {
    const seedB = BigInt(seed) & MASK64;
    const seqB = BigInt(seq) & MASK64;
    this.inc = ((seqB << 1n) | 1n) & MASK64;
    this.state = 0n;
    this.nextUint32();
    this.state = (this.state + seedB) & MASK64;
    this.nextUint32();
  }

  /** Next uniform 32-bit unsigned integer. */
  nextUint32(): number {
    const old = this.state;
    this.state = (old * MULT + this.inc) & MASK64;
    const xorshifted = Number((((old >> 18n) ^ old) >> 27n) & 0xffffffffn);
    const rot = Number(old >> 59n);
    // 32-bit rotate right
    return ((xorshifted >>> rot) | (xorshifted << ((-rot) & 31))) >>> 0;
  }

  /** Uniform float in [0, 1). 32 bits of precision. */
  nextFloat(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform integer in [0, n) without modulo bias (Lemire-style rejection). */
  nextInt(n: number): number {
    if (n <= 0 || !Number.isInteger(n)) throw new Error(`nextInt: invalid bound ${n}`);
    const threshold = (4294967296 % n) >>> 0;
    for (;;) {
      const r = this.nextUint32();
      if (r >= threshold) return r % n;
    }
  }

  /**
   * Standard normal deviate by Box–Muller (polar/Marsaglia form), with the spare cached.
   */
  nextNormal(): number {
    if (this.spareNormal !== null) {
      const v = this.spareNormal;
      this.spareNormal = null;
      return v;
    }
    for (;;) {
      const u = 2 * this.nextFloat() - 1;
      const v = 2 * this.nextFloat() - 1;
      const s = u * u + v * v;
      if (s > 0 && s < 1) {
        const f = Math.sqrt((-2 * Math.log(s)) / s);
        this.spareNormal = v * f;
        return u * f;
      }
    }
  }

  /** In-place Fisher–Yates shuffle. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }
}
