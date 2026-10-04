#!/usr/bin/env python3
"""
Reference oracle for Sentinel QC.

Generates fixtures/*.json once, at development time, using numpy/scipy as the trusted
implementation. CI compares the TypeScript implementations in packages/stats against
these fixtures (tolerance 1e-9 for deterministic quantities). Python is NOT required to
run the application.

Run from the repo root:  python3 tools/reference/generate_fixtures.py
"""

import json
import os
import sys

import numpy as np
from scipy import stats as sps

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "fixtures")
os.makedirs(OUT, exist_ok=True)


def write(name, obj):
    path = os.path.join(OUT, name)
    with open(path, "w") as f:
        json.dump(obj, f, indent=1)
    print(f"wrote {path}")


# ---------------------------------------------------------------------------
# Distributions: cdf and quantile grids
# ---------------------------------------------------------------------------

def distributions():
    out = {"normal": [], "t": [], "chi2": [], "f": [], "beta": []}

    xs = [-6, -3.5, -2.0, -1.0, -0.5, 0.0, 0.3, 1.0, 1.96, 2.5, 3.5, 6.0]
    ps = [1e-6, 1e-4, 0.001, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95,
          0.975, 0.99, 0.999, 0.9999, 1 - 1e-6]

    for x in xs:
        out["normal"].append({"x": x, "cdf": float(sps.norm.cdf(x))})
    for p in ps:
        out["normal"].append({"p": p, "ppf": float(sps.norm.ppf(p))})

    for df in [1, 2, 3, 5, 10, 29.34, 60, 120, 250]:
        for x in [-4, -2.1, -1, 0, 0.5, 1.5, 2.776, 4.0]:
            out["t"].append({"df": df, "x": x, "cdf": float(sps.t.cdf(x, df))})
        for p in [0.005, 0.025, 0.05, 0.5, 0.9, 0.95, 0.975, 0.995]:
            out["t"].append({"df": df, "p": p, "ppf": float(sps.t.ppf(p, df))})

    for k in [1, 2, 3, 5, 10, 22, 50, 100]:
        for x in [0.1, 0.5, 1, 2.5, 5, 10, 25, 60, 130]:
            out["chi2"].append({"k": k, "x": x, "cdf": float(sps.chi2.cdf(x, k))})
        for p in [0.01, 0.05, 0.5, 0.9, 0.95, 0.99, 0.999]:
            out["chi2"].append({"k": k, "p": p, "ppf": float(sps.chi2.ppf(p, k))})

    for d1, d2 in [(1, 1), (2, 10), (3, 27), (5, 5), (6, 24), (10, 100), (24, 24)]:
        for x in [0.1, 0.5, 1, 2, 3.5, 8]:
            out["f"].append({"d1": d1, "d2": d2, "x": x, "cdf": float(sps.f.cdf(x, d1, d2))})
        for p in [0.01, 0.05, 0.5, 0.9, 0.95, 0.99]:
            out["f"].append({"d1": d1, "d2": d2, "p": p, "ppf": float(sps.f.ppf(p, d1, d2))})

    for a, b in [(0.5, 0.5), (1, 3), (2, 2), (2.5, 7.5), (10, 40), (30, 2)]:
        for x in [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99]:
            out["beta"].append({"a": a, "b": b, "x": x, "cdf": float(sps.beta.cdf(x, a, b))})
        for p in [0.01, 0.05, 0.5, 0.95, 0.99]:
            out["beta"].append({"a": a, "b": b, "p": p, "ppf": float(sps.beta.ppf(p, a, b))})

    write("distributions.json", out)


# ---------------------------------------------------------------------------
# Baseline datasets (mean/sd/median/MAD + iterative outlier exclusion)
# ---------------------------------------------------------------------------

def baseline():
    rng = np.random.default_rng(42)
    datasets = []

    def build(name, values, ids=None):
        values = np.asarray(values, dtype=float)
        ids = ids or [f"o{i}" for i in range(len(values))]
        # replicate the TS algorithm: iterative |z|>3 exclusion, max 2 passes
        kept = values.copy()
        kept_ids = list(ids)
        excluded = []
        for _ in range(2):
            if len(kept) < 10:
                break
            m, s = kept.mean(), kept.std(ddof=1)
            if s <= 0:
                break
            z = (kept - m) / s
            mask = np.abs(z) <= 3
            if mask.all():
                break
            excluded += [kept_ids[i] for i in range(len(kept)) if not mask[i]]
            kept_ids = [kept_ids[i] for i in range(len(kept)) if mask[i]]
            kept = kept[mask]
        mad_norm = float(sps.median_abs_deviation(kept, scale="normal"))
        datasets.append({
            "name": name,
            "values": values.tolist(),
            "ids": list(ids),
            "expected": {
                "n": int(len(kept)),
                "mean": float(kept.mean()),
                "sd": float(kept.std(ddof=1)),
                "median": float(np.median(kept)),
                "robustSd": mad_norm,
                "excludedIds": excluded,
            },
        })

    build("clean_25", rng.normal(2.5, 0.11, 25))
    build("one_outlier_30", np.concatenate([rng.normal(100, 4, 29), [130.0]]))
    build("two_pass_24", np.concatenate([rng.normal(10, 0.5, 22), [10 + 12 * 0.5, 10 + 4.5 * 0.5]]))
    build("provisional_12", rng.normal(0.85, 0.03, 12))
    build("skewed_40", rng.lognormal(0, 0.08, 40) * 3)
    build("tight_20", rng.normal(55, 1.4, 20))
    write("baseline.json", {"datasets": datasets})


# ---------------------------------------------------------------------------
# EWMA fixtures: E_t and time-varying limits on 5 series
# ---------------------------------------------------------------------------

def ewma():
    rng = np.random.default_rng(7)
    series = [
        rng.normal(0, 1, 30).tolist(),
        (rng.normal(0, 1, 60) + np.linspace(0, 1.5, 60)).tolist(),
        rng.normal(0.5, 1, 40).tolist(),
        rng.normal(0, 1.6, 25).tolist(),
        [0.2, -0.4, 1.1, 2.5, 2.4, 2.2, 1.9, 2.8, 3.0, 2.7],
    ]
    cases = []
    for lam, L in [(0.2, 2.962), (0.1, 2.814)]:
        for zs in series:
            e = 0.0
            es, limits = [], []
            for t, z in enumerate(zs, start=1):
                e = lam * z + (1 - lam) * e
                es.append(e)
                limits.append(L * np.sqrt(lam / (2 - lam) * (1 - (1 - lam) ** (2 * t))))
            cases.append({"lambda": lam, "L": L, "z": zs, "e": es, "limit": limits})
    write("ewma.json", {"cases": cases})


# ---------------------------------------------------------------------------
# Variance-EWMA limit calibration (Monte Carlo, ARL0 ~= 500)
# ---------------------------------------------------------------------------

def variance_ewma_calibration():
    rng = np.random.default_rng(2024)

    def arl0(lam, ucl, n_seq=4000, max_len=6000):
        # vectorized simulation of first passage of V_t = lam z^2 + (1-lam) V, V0 = 1
        v = np.ones(n_seq)
        alive = np.ones(n_seq, dtype=bool)
        rls = np.full(n_seq, max_len, dtype=float)
        for t in range(1, max_len + 1):
            z2 = rng.standard_normal(n_seq) ** 2
            v = lam * z2 + (1 - lam) * v
            sig = alive & (v > ucl)
            rls[sig] = t
            alive &= ~sig
            if not alive.any():
                break
        return rls.mean()

    out = {}
    for lam in [0.1, 0.2]:
        lo, hi = 1.2, 4.0
        for _ in range(18):
            mid = 0.5 * (lo + hi)
            a = arl0(lam, mid)
            if a < 500:
                lo = mid
            else:
                hi = mid
        ucl = 0.5 * (lo + hi)
        final = arl0(lam, ucl, n_seq=8000)
        out[str(lam)] = {"ucl": round(ucl, 3), "arl0_estimate": final}
        print(f"variance EWMA lam={lam}: UCL={ucl:.3f} ARL0~{final:.0f}")
    write("variance_ewma_calibration.json", out)


# ---------------------------------------------------------------------------
# CUSUM: Montgomery, Introduction to SQC, tabular CUSUM example (Table 9.1/9.2)
# ---------------------------------------------------------------------------

def cusum():
    # Montgomery 6e Example 9.1 data: target mu0 = 10, sigma = 1, k = 0.5, h = 5.
    xs = [9.45, 7.99, 9.29, 11.66, 12.16, 10.18, 8.04, 11.46, 9.20, 10.34,
          9.03, 11.47, 10.51, 9.40, 10.08, 9.37, 10.62, 10.31, 8.52, 10.84,
          10.90, 9.33, 12.29, 11.50, 10.60, 11.08, 10.38, 11.62, 11.31, 10.52]
    mu0, k, h = 10.0, 0.5, 5.0
    cp, cm = 0.0, 0.0
    rows = []
    for x in xs:
        z = x - mu0  # sigma = 1
        cp = max(0.0, cp + z - k)
        cm = max(0.0, cm - z - k)
        rows.append({"x": x, "cplus": round(cp, 10), "cminus": round(cm, 10),
                     "signal": "up" if cp > h else ("down" if cm > h else "none")})
    write("cusum_montgomery.json", {"mu0": mu0, "k": k, "h": h, "rows": rows})


# ---------------------------------------------------------------------------
# Lot comparison: Welch t, F, Levene(median)
# ---------------------------------------------------------------------------

def lot():
    rng = np.random.default_rng(11)
    cases = []
    pairs = [
        ("no_change", rng.normal(1.0, 0.05, 20), rng.normal(1.0, 0.05, 15)),
        ("mean_shift", rng.normal(1.0, 0.05, 20), rng.normal(1.05, 0.05, 12)),
        ("var_change", rng.normal(1.0, 0.05, 30), rng.normal(1.0, 0.16, 25)),
        ("both", rng.normal(2.4, 0.1, 30), rng.normal(2.55, 0.2, 10)),
    ]
    for name, a, b in pairs:
        t, p = sps.ttest_ind(a, b, equal_var=False)
        w, lp = sps.levene(a, b, center="median")
        va, vb = a.var(ddof=1), b.var(ddof=1)
        f = va / vb
        dfa, dfb = len(a) - 1, len(b) - 1
        fp = 2 * min(sps.f.cdf(f, dfa, dfb), 1 - sps.f.cdf(f, dfa, dfb))
        # Welch df
        se2 = va / len(a) + vb / len(b)
        df = se2 ** 2 / ((va / len(a)) ** 2 / (len(a) - 1) + (vb / len(b)) ** 2 / (len(b) - 1))
        cases.append({
            "name": name, "a": a.tolist(), "b": b.tolist(),
            "welch_t": float(t), "welch_p": float(p), "welch_df": float(df),
            "f": float(f), "f_p": float(min(1.0, fp)),
            "levene_w": float(w), "levene_p": float(lp),
        })
    write("lot_compare.json", {"cases": cases})


# ---------------------------------------------------------------------------
# Median polish: replicate R's stats::medpolish algorithm
# ---------------------------------------------------------------------------

def medpolish_py(x, eps=1e-6, maxiter=10):
    x = np.array(x, dtype=float)
    nr, nc = x.shape
    t = 0.0
    r = np.zeros(nr)
    c = np.zeros(nc)
    oldsum = 0.0
    converged = False
    for _ in range(maxiter):
        rdelta = np.nanmedian(x, axis=1)
        x = x - rdelta[:, None]
        r = r + rdelta
        delta = np.nanmedian(c)
        c = c - delta
        t = t + delta
        cdelta = np.nanmedian(x, axis=0)
        x = x - cdelta[None, :]
        c = c + cdelta
        delta = np.nanmedian(r)
        r = r - delta
        t = t + delta
        newsum = np.nansum(np.abs(x))
        if newsum == 0 or abs(newsum - oldsum) < eps * newsum:
            converged = True
            break
        oldsum = newsum
    return t, r, c, x, converged


def medpolish_fixture():
    rng = np.random.default_rng(3)
    mats = {
        # classic R example: deaths by cause (rows) and age (cols) — any small matrix works,
        # here reproducible synthetic tables including one with an imposed row effect
        "random_4x5": rng.normal(10, 2, (4, 5)),
        "row_effect_8x12": rng.normal(0, 0.1, (8, 12)) + np.array([0, 0, 0, 0, 0, 0.5, 0, 0])[:, None],
        "gradient_6x8": np.add.outer(np.linspace(0, 1, 6), np.linspace(0, 2, 8)) + rng.normal(0, 0.05, (6, 8)),
    }
    out = []
    for name, m in mats.items():
        t, r, c, resid, conv = medpolish_py(m.copy())
        out.append({
            "name": name, "matrix": m.tolist(),
            "overall": float(t), "row": r.tolist(), "col": c.tolist(),
            "residuals": resid.tolist(), "converged": bool(conv),
        })
    write("medpolish.json", {"cases": out})


# ---------------------------------------------------------------------------
# PCA / MSPC: 24-dim synthetic, eigenvalues + T2/SPE limits
# ---------------------------------------------------------------------------

def pca_mspc():
    rng = np.random.default_rng(5)
    n, p = 60, 22
    # low-rank structure + noise
    scores = rng.normal(0, 1, (n, 3)) * np.array([3.0, 2.0, 1.2])
    load = rng.normal(0, 1, (3, p))
    X = scores @ load + rng.normal(0, 0.6, (n, p))
    means = X.mean(axis=0)
    scales = X.std(axis=0, ddof=1)
    Xs = (X - means) / scales
    S = np.cov(Xs, rowvar=False)
    vals, vecs = np.linalg.eigh(S)
    order = np.argsort(vals)[::-1]
    vals = vals[order]
    total = vals.sum()
    A = 0
    cum = 0.0
    while A < len(vals) and (cum / total < 0.8 or A == 0):
        cum += vals[A]
        A += 1
        if A >= 6:
            break
    alpha = 0.01
    t2_ucl = A * (n - 1) * (n + 1) / (n * (n - A)) * sps.f.ppf(1 - alpha, A, n - A)
    resid = vals[A:]
    th1, th2, th3 = resid.sum(), (resid ** 2).sum(), (resid ** 3).sum()
    h0 = 1 - 2 * th1 * th3 / (3 * th2 ** 2)
    za = sps.norm.ppf(1 - alpha)
    spe_ucl = th1 * (za * np.sqrt(2 * th2 * h0 ** 2) / th1 + 1 + th2 * h0 * (h0 - 1) / th1 ** 2) ** (1 / h0)
    write("pca_mspc.json", {
        "X": X.tolist(),
        "eigenvalues": vals.tolist(),
        "aComponents": int(A),
        "alpha": alpha,
        "t2_ucl": float(t2_ucl),
        "spe_ucl": float(spe_ucl),
    })


if __name__ == "__main__":
    distributions()
    baseline()
    ewma()
    cusum()
    lot()
    medpolish_fixture()
    pca_mspc()
    if "--skip-mc" not in sys.argv:
        variance_ewma_calibration()
    print("done")
