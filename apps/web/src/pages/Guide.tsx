/** Guide: plain-language explanations of the whole system. */
import type { ReactNode } from 'react';

function Section({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <section className="card p-5">
      <div className="flex items-baseline gap-3 mb-2">
        <span className="num text-slate-300 text-[13px]">{n}</span>
        <h2 className="font-semibold text-slate-900 tracking-[-0.01em] text-[14px]">{title}</h2>
      </div>
      <div className="text-slate-600 space-y-2 leading-relaxed">{children}</div>
    </section>
  );
}

function Term({ k, children }: { k: string; children: ReactNode }) {
  return (
    <p>
      <span className="font-medium text-slate-800">{k}</span> — {children}
    </p>
  );
}

export function GuidePage() {
  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h1 className="page-title">How it works</h1>
        <p className="page-sub">Everything explained in plain language.</p>
      </div>

      <Section n="01" title="The daily flow">
        <p>
          After each QC run, enter the <span className="font-medium text-slate-800">date, technician, kit lot, IQC OD and
          cutoff OD</span> on the QC page. The E-ratio (IQC ÷ cutoff) is computed as you type; press Enter and the run is
          on the log with its verdict. That is the entire routine — under ten seconds per run.
        </p>
        <p>
          The status line answers the only question that matters: <span className="font-medium text-green-600">In
          Control</span> means carry on; <span className="font-medium text-red-600">Out of Control</span> means at least
          one run broke a rejection rule — check the flagged rows in the log.
        </p>
      </Section>

      <Section n="02" title="Where the limits come from">
        <p>
          Control limits are the <span className="font-medium text-slate-800">mean ± 1/2/3 SD of your own runs</span>,
          recalculated as you add data — the same idea as a paper Levey–Jennings sheet, with three statistical
          safeguards the paper sheet lacks:
        </p>
        <Term k="Log scale for ratios">
          the E-ratio is a ratio, so its noise is multiplicative and right-skewed. Limits are computed on the log
          scale and shown as geometric bands — slightly asymmetric around the mean, which is correct for ratio data
          and keeps full sensitivity to a weakening positive control.
        </Term>
        <Term k="Leave-one-out">
          each run is judged against limits estimated from the <em>other</em> runs, so a bad run can never pull the
          limits toward itself and slip through. Gross outliers are excluded from the estimate entirely (still
          plotted and flagged).
        </Term>
        <Term k="A minimum history">
          with only a handful of runs the SD estimate is too shaky for ±2SD/±3SD limits to mean anything, so rule
          flags start at 6 runs — before that the limits are shown but marked provisional. About 20 runs is the
          textbook comfort zone.
        </Term>
      </Section>

      <Section n="03" title="What the flags mean">
        <p>Every run is checked against the Westgard multirules — the standard grammar of QC:</p>
        <Term k="OK">inside the limits, nothing to do.</Term>
        <Term k="1₂ₛ (amber)">one run beyond ±2SD. A warning, not a rejection — statistically this happens ~5% of the time even when everything is fine. Look, don't panic.</Term>
        <Term k="1₃ₛ">beyond ±3SD — a random error. Reject the run, re-run the control.</Term>
        <Term k="2₂ₛ">two consecutive runs beyond the same 2SD limit — a systematic shift (new kit lot? calibration? temperature?).</Term>
        <Term k="4₁ₛ / 10ₓ">four consecutive beyond 1SD on one side, or ten consecutive on one side of the mean — a slow drift that single runs would never show.</Term>
        <p className="text-slate-400 text-[12px]">Hover any flag in the run log for its one-line meaning; the PDF report carries the same legend.</p>
      </Section>

      <Section n="04" title="Monitoring — the early-warning layer">
        <p>
          Westgard rules catch problems run by run. The Monitoring tab watches the <em>whole series</em> and often rings
          earlier:
        </p>
        <Term k="Drift (EWMA)">a smoothed average of recent runs. It crosses its limit when a small, sustained shift is underway — typically well before any single run breaks a rule.</Term>
        <Term k="CUSUM">accumulates every small deviation from the mean; tells you the shift size and roughly when it started.</Term>
        <Term k="Imprecision">watches the spread (SD) rather than the level — catches an assay becoming noisy while its average still looks fine.</Term>
        <Term k="Change points">looks back over the log and marks where the level genuinely changed — useful for pinning a shift to a kit-lot change.</Term>
        <p>
          It all feeds automatically from the runs you enter — nothing to configure. The{' '}
          <span className="font-medium text-slate-800">Download report (PDF)</span> button gives a one-page summary with
          both charts.
        </p>
      </Section>

      <Section n="05" title="The plate anomaly detector">
        <p>
          Your control well sits in one position on the plate. A tilted incubator, an edge-evaporation problem or a
          mis-pipetting robot damages <em>rows, columns, edges or gradients</em> — patterns a single control well can
          sail straight through. The Plates tab takes the full 96-well reader export and tests every one of those
          patterns statistically.
        </p>
        <p>
          Press <span className="font-medium text-slate-800">Load example plates</span> on the Plates page to see it in
          action: one clean plate, and one where row F was made systematically high — the detector names the row, shows
          the evidence heat-map, and states the probability the pattern is real.
        </p>
      </Section>

      <Section n="06" title="Reports & your data">
        <p>
          <span className="font-medium text-slate-800">Download report (PDF)</span> produces the signed-off document:
          status, statistics, the Levey–Jennings chart, control limits, and the full run log.{' '}
          <span className="font-medium text-slate-800">Data CSV</span> exports the raw numbers.
        </p>
        <p>
          Each sign-in is its own private workspace — two people using the shared account at once never see each other's
          entries. Data lives for the login session and is cleared afterwards, so{' '}
          <span className="font-medium text-slate-800">the PDF you download is the permanent record</span>: enter your
          runs, download the report, file it.
        </p>
      </Section>

    </div>
  );
}
