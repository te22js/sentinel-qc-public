/**
 * Assay value transforms. Baselines and all monitoring statistics live on the
 * transformed (x) scale; z = (x − μ)/σ against a frozen baseline.
 */

export type TransformKind = 'none' | 'log' | 'ratio_to_cutoff';

export const LOG_EPSILON = 0.001;

/**
 * Apply an assay transform.
 *  - none:            x = y
 *  - log:             x = ln(max(y, ε)), ε = 0.001 OD (reader error is ~multiplicative)
 *  - ratio_to_cutoff: x = y / cutoff  (cutoff from the run's controls per kit instruction)
 */
export function applyTransform(kind: TransformKind, y: number, cutoff?: number): number {
  switch (kind) {
    case 'none':
      return y;
    case 'log':
      return Math.log(Math.max(y, LOG_EPSILON));
    case 'ratio_to_cutoff': {
      if (cutoff === undefined || cutoff <= 0) {
        throw new Error('ratio_to_cutoff transform requires a positive cutoff value');
      }
      return y / cutoff;
    }
  }
}

export function zScore(x: number, mean: number, sd: number): number {
  if (sd <= 0) throw new Error('z-score requires sd > 0');
  return (x - mean) / sd;
}
