/**
 * Canonical JSON: deterministic serialization with recursively sorted object keys.
 * Used for the audit hash chain so the hash of a row is stable across writers.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortValue(val);
    }
    return out;
  }
  return v;
}
