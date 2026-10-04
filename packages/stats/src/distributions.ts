/**
 * Probability distributions: normal, Student t, chi-square, F, Beta — cdf and quantile.
 *
 * Building blocks:
 *  - lgamma: Lanczos approximation (g = 607/128, 15 coefficients; Boost/Godfrey values),
 *    |rel err| ~ 1e-15.
 *  - Regularized incomplete gamma P(a,x), Q(a,x): series expansion for x < a+1,
 *    Lentz continued fraction otherwise. (Numerical Recipes §6.2; Press et al. 2007.)
 *  - Regularized incomplete beta I_x(a,b): Lentz continued fraction with the standard
 *    symmetry transformation. (Numerical Recipes §6.4.)
 *  - Normal quantile: Wichura (1988), Algorithm AS 241, PPND16 — double precision.
 *  - Other quantiles: safeguarded Newton on the cdf with bisection fallback, converging
 *    to ~1e-14 relative, which comfortably meets the 1e-9 fixture tolerance vs SciPy.
 */

const LANCZOS_G = 607 / 128;
const LANCZOS = [
  0.99999999999999709182, 57.156235665862923517, -59.597960355475491248,
  14.136097974741747174, -0.49191381609762019978, 0.33994649984811888699e-4,
  0.46523628927048575665e-4, -0.98374475304879564677e-4, 0.15808870322491248884e-3,
  -0.21026444172410488319e-3, 0.21743961811521264320e-3, -0.16431810653676389022e-3,
  0.84418223983852743293e-4, -0.26190838401581408670e-4, 0.36899182659531622704e-5,
];

/** log Γ(x) for x > 0. */
export function lgamma(x: number): number {
  if (x <= 0) {
    if (Number.isInteger(x)) return Infinity;
    // reflection: Γ(x)Γ(1−x) = π / sin(πx)
    return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  }
  let sum = LANCZOS[0];
  for (let k = 1; k < LANCZOS.length; k++) sum += LANCZOS[k] / (x + k - 1);
  const t = x + LANCZOS_G - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (x - 0.5) * Math.log(t) - t + Math.log(sum);
}

const EPS = 1e-16;
const FPMIN = Number.MIN_VALUE / EPS;
const ITMAX = 1000;

/** Regularized lower incomplete gamma P(a, x). */
export function gammaincLower(a: number, x: number): number {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 0;
  if (x < a + 1) {
    // series representation
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let i = 0; i < ITMAX; i++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * EPS) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  return 1 - gammaincUpperCF(a, x);
}

/** Regularized upper incomplete gamma Q(a, x). */
export function gammaincUpper(a: number, x: number): number {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 1;
  if (x < a + 1) return 1 - gammaincLower(a, x);
  return gammaincUpperCF(a, x);
}

/** Continued-fraction evaluation of Q(a,x), valid for x ≥ a+1 (modified Lentz). */
function gammaincUpperCF(a: number, x: number): number {
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= ITMAX; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}

/** Continued fraction for the incomplete beta (Numerical Recipes betacf, modified Lentz). */
function betacf(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= ITMAX; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function betainc(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lgamma(a + b) - lgamma(a) - lgamma(b);
  const front = Math.exp(lbeta + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betacf(a, b, x)) / a;
  }
  return 1 - (front * betacf(b, a, 1 - x)) / b;
}

/** erfc via the incomplete gamma: erfc(z) = Q(1/2, z²) for z ≥ 0. */
export function erfc(z: number): number {
  if (z < 0) return 2 - erfc(-z);
  return gammaincUpper(0.5, z * z);
}

export function erf(z: number): number {
  if (z < 0) return -erf(-z);
  return gammaincLower(0.5, z * z);
}

// ---------------------------------------------------------------------------
// Normal
// ---------------------------------------------------------------------------

export function normalPdf(x: number, mu = 0, sigma = 1): number {
  const z = (x - mu) / sigma;
  return Math.exp(-0.5 * z * z) / (sigma * Math.sqrt(2 * Math.PI));
}

export function normalCdf(x: number, mu = 0, sigma = 1): number {
  const z = (x - mu) / sigma;
  return 0.5 * erfc(-z / Math.SQRT2);
}

/**
 * Inverse standard normal cdf. Wichura (1988) AS 241, PPND16: |rel err| < 1e-15
 * for p in (0, 1).
 */
export function normalQuantile(p: number, mu = 0, sigma = 1): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const q = p - 0.5;
  let r: number;
  let val: number;
  if (Math.abs(q) <= 0.425) {
    r = 0.180625 - q * q;
    val =
      (q *
        (((((((2509.0809287301226727 * r + 33430.575583588128105) * r + 67265.770927008700853) * r +
          45921.953931549871457) *
          r +
          13731.693765509461125) *
          r +
          1971.5909503065514427) *
          r +
          133.14166789178437745) *
          r +
          3.387132872796366608)) /
      (((((((5226.495278852545703 * r + 28729.085735721942674) * r + 39307.89580009271061) * r +
        21213.794301586595867) *
        r +
        5394.1960214247511077) *
        r +
        687.1870074920579083) *
        r +
        42.313330701600911252) *
        r +
        1);
    return mu + sigma * val;
  }
  r = q < 0 ? p : 1 - p;
  r = Math.sqrt(-Math.log(r));
  if (r <= 5) {
    r -= 1.6;
    val =
      (((((((7.7454501427834140764e-4 * r + 0.0227238449892691845833) * r + 0.24178072517745061177) *
        r +
        1.27045825245236838258) *
        r +
        3.64784832476320460504) *
        r +
        5.7694972214606914055) *
        r +
        4.6303378461565452959) *
        r +
        1.42343711074968357734) /
      (((((((1.05075007164441684324e-9 * r + 5.475938084995344946e-4) * r + 0.0151986665636164571966) *
        r +
        0.14810397642748007459) *
        r +
        0.68976733498510000455) *
        r +
        1.6763848301838038494) *
        r +
        2.05319162663775882187) *
        r +
        1);
  } else {
    r -= 5;
    val =
      (((((((2.01033439929228813265e-7 * r + 2.71155556874348757815e-5) * r +
        0.0012426609473880784386) *
        r +
        0.026532189526576123093) *
        r +
        0.29656057182850489123) *
        r +
        1.7848265399172913358) *
        r +
        5.4637849111641143699) *
        r +
        6.6579046435011037772) /
      (((((((2.04426310338993978564e-15 * r + 1.4215117583164458887e-7) * r +
        1.8463183175100546818e-5) *
        r +
        7.868691311456132591e-4) *
        r +
        0.0148753612908506148525) *
        r +
        0.13692988092273580531) *
        r +
        0.59983220655588793769) *
        r +
        1);
  }
  if (q < 0) val = -val;
  return mu + sigma * val;
}

// ---------------------------------------------------------------------------
// Student t
// ---------------------------------------------------------------------------

export function tCdf(x: number, df: number): number {
  if (df <= 0) return NaN;
  if (x === 0) return 0.5;
  const ib = betainc(df / 2, 0.5, df / (df + x * x));
  return x > 0 ? 1 - 0.5 * ib : 0.5 * ib;
}

export function tPdf(x: number, df: number): number {
  const lognorm = lgamma((df + 1) / 2) - lgamma(df / 2) - 0.5 * Math.log(df * Math.PI);
  return Math.exp(lognorm - ((df + 1) / 2) * Math.log1p((x * x) / df));
}

export function tQuantile(p: number, df: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;
  const start = normalQuantile(p); // good start for df ≳ 5, safeguard handles the rest
  return invertCdf((x) => tCdf(x, df), (x) => tPdf(x, df), p, start, -1e10, 1e10);
}

// ---------------------------------------------------------------------------
// Chi-square
// ---------------------------------------------------------------------------

export function chi2Cdf(x: number, k: number): number {
  if (x <= 0) return 0;
  return gammaincLower(k / 2, x / 2);
}

export function chi2Pdf(x: number, k: number): number {
  if (x <= 0) return 0;
  return Math.exp((k / 2 - 1) * Math.log(x) - x / 2 - lgamma(k / 2) - (k / 2) * Math.LN2);
}

export function chi2Quantile(p: number, k: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return Infinity;
  // Wilson–Hilferty starting value
  const z = normalQuantile(p);
  const h = 2 / (9 * k);
  let start = k * Math.pow(1 - h + z * Math.sqrt(h), 3);
  if (!(start > 0)) start = k * p;
  return invertCdf((x) => chi2Cdf(x, k), (x) => chi2Pdf(x, k), p, start, 0, 1e12);
}

// ---------------------------------------------------------------------------
// F
// ---------------------------------------------------------------------------

export function fCdf(x: number, d1: number, d2: number): number {
  if (x <= 0) return 0;
  return betainc(d1 / 2, d2 / 2, (d1 * x) / (d1 * x + d2));
}

export function fPdf(x: number, d1: number, d2: number): number {
  if (x <= 0) return 0;
  const l =
    (d1 / 2) * Math.log(d1) +
    (d2 / 2) * Math.log(d2) +
    (d1 / 2 - 1) * Math.log(x) -
    ((d1 + d2) / 2) * Math.log(d2 + d1 * x) -
    (lgamma(d1 / 2) + lgamma(d2 / 2) - lgamma((d1 + d2) / 2));
  return Math.exp(l);
}

export function fQuantile(p: number, d1: number, d2: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return Infinity;
  // start from beta quantile relation x = d2 b / (d1 (1−b)) with a rough b = p
  const b = betaQuantile(p, d1 / 2, d2 / 2);
  let start = (d2 * b) / (d1 * (1 - b));
  if (!Number.isFinite(start) || start <= 0) start = 1;
  return invertCdf((x) => fCdf(x, d1, d2), (x) => fPdf(x, d1, d2), p, start, 0, 1e12);
}

// ---------------------------------------------------------------------------
// Beta
// ---------------------------------------------------------------------------

export function betaCdf(x: number, a: number, b: number): number {
  return betainc(a, b, x);
}

export function betaPdf(x: number, a: number, b: number): number {
  if (x <= 0 || x >= 1) return 0;
  const l =
    (a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - (lgamma(a) + lgamma(b) - lgamma(a + b));
  return Math.exp(l);
}

export function betaQuantile(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  // moment-matched normal start, clipped into (0,1)
  const m = a / (a + b);
  const v = (a * b) / ((a + b) * (a + b) * (a + b + 1));
  let start = m + normalQuantile(p) * Math.sqrt(v);
  if (start <= 0) start = Math.min(0.5, m / 2);
  if (start >= 1) start = Math.max(0.5, (1 + m) / 2);
  return invertCdf((x) => betaCdf(x, a, b), (x) => betaPdf(x, a, b), p, start, 0, 1);
}

// ---------------------------------------------------------------------------
// Safeguarded Newton inversion
// ---------------------------------------------------------------------------

/**
 * Solve cdf(x) = p by Newton iteration safeguarded with bisection on a bracket
 * that is expanded from the start value if needed. Converges to ~machine precision.
 */
function invertCdf(
  cdf: (x: number) => number,
  pdf: (x: number) => number,
  p: number,
  start: number,
  lo: number,
  hi: number,
): number {
  // establish a bracket [a, b] with cdf(a) ≤ p ≤ cdf(b)
  let a = lo;
  let b = hi;
  let x = Math.min(Math.max(start, lo), hi);
  // expand outward from start to find a finite bracket faster
  {
    let step = Math.max(1, Math.abs(x) * 0.5);
    let xa = x;
    let xb = x;
    let fa = cdf(xa) - p;
    let fb = fa;
    for (let i = 0; i < 200 && fa > 0; i++) {
      xa = Math.max(lo, xa - step);
      fa = cdf(xa) - p;
      step *= 2;
      if (xa === lo) break;
    }
    step = Math.max(1, Math.abs(x) * 0.5);
    for (let i = 0; i < 200 && fb < 0; i++) {
      xb = Math.min(hi, xb + step);
      fb = cdf(xb) - p;
      step *= 2;
      if (xb === hi) break;
    }
    a = xa;
    b = xb;
  }
  for (let iter = 0; iter < 200; iter++) {
    const f = cdf(x) - p;
    if (f > 0) b = Math.min(b, x);
    else a = Math.max(a, x);
    const d = pdf(x);
    let xNew: number;
    if (d > 0 && Number.isFinite(d)) {
      xNew = x - f / d;
      if (!(xNew > a && xNew < b)) xNew = (a + b) / 2; // Newton left the bracket
    } else {
      xNew = (a + b) / 2;
    }
    const tol = 1e-14 * Math.max(1, Math.abs(xNew));
    if (Math.abs(xNew - x) <= tol) return xNew;
    x = xNew;
  }
  return x;
}
