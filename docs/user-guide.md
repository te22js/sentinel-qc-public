# User Guide

## Signing in

The default is a single shared lab account — **`labqc`** — with full access: sign
in, enter runs, review monitoring, download reports. Nothing else to set up.

If your lab prefers per-person logins, create them in Admin → Users; roles then
apply: **technician** (enter runs, view charts and history), **supervisor** (plus
monitoring, overrides, baselines, corrections, configuration), **admin** (plus
user management and backups).

---

## The QC page (the main workflow)

Everything lives on one page, laid out like the QC report you file:

1. Pick the assay. The **status card** answers the only question that matters —
   **In Control / Out of Control** — next to tiles for Runs, Mean, SD and CV%.
2. **Add a run**: date (defaults to today), technician, kit lot, and the value —
   for E-ratio assays that's IQC OD and cutoff OD with the E-ratio computed live.
   Technician and kit lot pre-fill from the last run; a changed kit lot is
   automatically tracked as a lot change. Enter submits.
3. The **Levey–Jennings chart** updates immediately, with the actual control-band
   values on the axis and violations circled; the **control-limits strip** and the
   newest-first **QC Run Log** (with per-run rule flags — hover a flag for the
   plain-English meaning) sit right below.
4. **Download report** produces the printable QC report (status card, tiles, chart,
   limits, run log, sign-off line); **Data CSV** exports the raw data. **Bulk
   entry** at the bottom takes a pasted column of values (with optional real dates
   and cutoffs) or a CSV file.

**Control limits without setup**: until a baseline is frozen, limits are the mean
and SD of the current runs (the standard retrospective practice), with one honest
improvement — gross outliers (robust screen, modified z > 3.5) are excluded from
the *estimate* so they cannot mask themselves, while still being shown and
flagged. Freezing a baseline in Admin at any time switches the assay to fixed,
prospective limits.

### History and CSV import

**History** filters by assay, verdict and date; click a row for the full drawer:
observations (with correction trail), every rule evaluated, and the run's audit
records. **Import CSV** walks you through upload → column mapping → a row-by-row
validation preview (green/amber/red with messages) → commit. Error rows are always
skipped, never silently fixed.

### Charts

Levey–Jennings with mean ±1/2/3 SD dashed lines. Violations are hollow red circles —
hover for the rule name. Vertical dashed lines mark reagent-lot, control-lot and
baseline changes. Toggle value/z-score; use ← → to step through points. The strip
below shows n, mean, SD, CV and the frozen baseline in effect.

---

## For supervisors

### Monitoring

Pick a series (assay · level · control lot). Each tab starts with a sentence — if it
says "No signal in the last 60 runs", you are done.

- **Drift (EWMA)** small sustained shifts long before Westgard rules fire. Signal
  text estimates the shift size and onset. Acknowledging a signal (after corrective
  action) resets the monitor from that run.
- **CUSUM** sequential detection with an onset estimate ("accumulating since run
  128").
- **Variance** an EWMA of z² that catches growing imprecision with a
  Monte-Carlo-calibrated limit.
- **Change points** retrospective segmentation (PELT); each change is matched to
  nearby lot/instrument/baseline events.
- **Lot transitions** old vs new reagent lot: Welch t, F/Levene, bias% vs the
  assay's allowable bias, and a recommendation ("re-baseline: new mean, retain SD").

### Baselines

Admin → Materials: "compute baseline" previews mean/SD (and robust median/MAD) from
the accumulated observations, lists the |z| > 3 outliers it wants to exclude, and
freezes only on your confirmation. Frozen baselines are immutable and dated;
re-baselining preserves the old one for history.

### Overrides and corrections

Accepting a rejected run and correcting a mistyped observation both require a
reason and both land in the append-only audit log; corrections never overwrite —
they supersede, and the original stays visible struck-through.

### Plates (research feature)

Import a reader export (8×12 CSV; the importer accepts only numeric grids and
rejects files with text in sample cells). PSAD analyses the plate on the spot:
two heat maps (values and residuals), row/column effect bars with permutation
p-values, and findings in plain sentences with the affected wells highlighted on
hover. The plating-order declaration on the assay matters: if plating is
structured (not random), p-values are suppressed and you should read effects
descriptively.

Once ≥ 30 clean plates exist, build the **Phase-II model** (Plates page). New
plates then also get T²/SPE scores — "this plate's artifact profile is unusual
relative to this lab's history" — with per-variable contributions. Read T²
exceedances as calibrated alarms; read SPE exceedances as screening hints (its
theoretical limit runs hot at small plate histories — see the validation report)
and weigh them together with the plate's own permutation findings.

### Reports

Admin → Backup tab: daily QC report and monthly summary (with server-rendered LJ
charts); Plates → plate detail → "Generate report". All reports are HTML with
print CSS (print to PDF from the browser) and every generation is audited.
