# Research: the Plate Spatial Artifact Detector

## Question

*In screening-type microplate immunoassays, what fraction of spatially structured
process failures (row/column dispensing errors, edge evaporation, incubation
gradients) go undetected by control-well Westgard rules, and can a
permutation-tested robust two-way decomposition of the full plate detect them with
a family-wise false-positive rate ≤ 1% per family?*

## Why not PCA on raw plates

A screening ELISA plate is ~90 patient wells whose OD distribution is a heavy-tailed
mixture: most negatives near the cutoff, a few positives at 5–20× signal. The
dominant variance directions of such plates are *which wells happened to hold
positive samples*. A low-rank model fit to plate history learns biology-placement
noise, and its reconstruction error on a new plate measures how many positives it
had — not whether the process failed. That is a confound, not a tuning problem.

## The exchangeability argument (ours)

Sample-to-well placement is unrelated to well position when plating is randomized
(or effectively arbitrary). Under H₀ "the process imposes no position-dependent
effect", the transformed sample-well values are exchangeable within well-type
strata — so permuting them yields an exact null distribution for *any* spatial
statistic, valid on a single plate with no history required. Position-structured
signal beyond that null is, by construction, process artifact (or a violation of
the plating assumption, which the assay configuration must declare — the UI then
suppresses p-values).

## What is established vs ours

Established: median polish / B-score for plate effects (Malo et al. 2006);
detect-before-correct (Makarenkov 2007, Dragiev 2011, Caraus 2015); T²/SPE
monitoring on feature vectors (Jackson & Mudholkar 1979; Kourti & MacGregor 1996).
Ours: the exchangeability-based permutation null for clinical plates; max-statistic
family-wise control for row/column localization; the explicit Westgard-blindness
comparison on the same plates; the Phase-II monitor over per-plate effect vectors;
the plating-order failure analysis.

## Experiment design

Implemented in `packages/stats/experiments/run.ts` (`pnpm experiments`), fully
deterministic; results in `docs/validation.md`:

- **Null**: 2000 clean synthetic plates (log-normal negative mixture, 10%
  positives), per-family and any-family FP rates at α = 0.01, B = 499.
- **Power × magnitude**: row/column faults at {0.5, 1, 1.5, 2, 3}·s, edge at
  {0.25, 0.5, 1, 1.5}·s, gradients at {0.5, 1, 1.5, 2}·s span, 200 plates per point;
  localization accuracy for row/column.
- **Westgard-miss fraction**: among detected fault plates, the share whose control
  wells pass 1_3s/2_2s/R_4s (control noise σ_log 0.15, fault applied at the control
  positions where geometry dictates).
- **Specificity**: uniform +1 log-OD global shifts must produce no spatial flags.
- **Ablations**: prevalence 5/10/20%; log vs rank transform; sequential plating
  (assumption violation → documented FP inflation).
- **Phase II**: FP rate of T²/SPE at history sizes 20/30/60/120 — showing 20 is too
  few and motivating the ≥30 product gate.

## Findings worth stating up front

Two properties discovered during implementation, both visible in the validation
report and both inherent to the method rather than implementation artifacts:

1. **Column faults are harder than row faults.** A column has 8 wells to a row's
   11–12, and a strong fault inflates its own permutation null (its shifted values
   participate in the permutations). Power curves reflect this asymmetry.
2. **The rank transform trades power for robustness.** It bounds the influence of
   extreme positives (protecting the null at high prevalence) but *caps* the
   attainable row/column effect size — once a shifted row's negatives outrank all
   other negatives, further shift changes nothing. Edge/gradient statistics, which
   pool 34+ wells, keep excellent power under rank.

## What can honestly be claimed

On synthetic plates with realistic OD mixtures: detection rates as tabulated in
`docs/validation.md` at controlled family-wise error, silence on global shifts, and
structural blindness of control-well QC to row/column faults. **Cannot** be claimed:
clinical impact, patient outcomes, regulatory fitness, generalization beyond the
simulated assay classes. The single most valuable next result — the empirical null
on real clean plates — requires a partner laboratory's exports (any reader that
produces an 8×12 CSV works).
