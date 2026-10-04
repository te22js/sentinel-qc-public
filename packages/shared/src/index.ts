/**
 * Shared zod schemas and DTO types used by both the server and the web client.
 * The database rows themselves are typed by packages/db; these are the wire shapes.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const Role = z.enum(['technician', 'supervisor', 'admin']);
export type Role = z.infer<typeof Role>;

export const TransformKind = z.enum(['none', 'log', 'ratio_to_cutoff']);
export type TransformKind = z.infer<typeof TransformKind>;

export const PlatingOrder = z.enum(['randomized', 'sequential', 'structured']);
export type PlatingOrder = z.infer<typeof PlatingOrder>;

export const Verdict = z.enum(['pass', 'warning', 'reject']);
export type Verdict = z.infer<typeof Verdict>;

export const OverrideStatus = z.enum(['none', 'accepted']);
export type OverrideStatus = z.infer<typeof OverrideStatus>;

export const BaselineMethod = z.enum([
  'manual_manufacturer',
  'manual_lab',
  'computed_classical',
  'computed_robust',
]);
export type BaselineMethod = z.infer<typeof BaselineMethod>;

export const RuleId = z.enum([
  '1_2s', '1_3s', '2_2s', '2of3_2s', 'R_4s', '3_1s', '4_1s', '6x', '8x', '9x', '10x', '12x', '7T',
]);
export type RuleId = z.infer<typeof RuleId>;

export const RuleScope = z.enum(['within_run', 'across_runs', 'both']);
export type RuleScope = z.infer<typeof RuleScope>;

export const MonitorKind = z.enum(['ewma', 'cusum', 'ewma_var', 'changepoint']);
export type MonitorKind = z.infer<typeof MonitorKind>;

export const WellTypeEnum = z.enum(['sample', 'blank', 'neg_ctrl', 'pos_ctrl', 'calibrator', 'empty']);
export type WellTypeEnum = z.infer<typeof WellTypeEnum>;

export const AuditAction = z.enum([
  'create', 'update', 'override', 'freeze', 'generate_report', 'login', 'config_change',
]);
export type AuditAction = z.infer<typeof AuditAction>;

// ---------------------------------------------------------------------------
// Profile / scheme shapes stored as JSON
// ---------------------------------------------------------------------------

export const ProfileRuleSchema = z.object({
  rule: RuleId,
  enabled: z.boolean(),
  scope: RuleScope,
  severity: z.enum(['warning', 'reject']),
});
export type ProfileRuleDto = z.infer<typeof ProfileRuleSchema>;

export const QcSchemeSchema = z.object({
  levels: z.array(
    z.object({
      level_code: z.string().trim().min(1).max(40),
      replicates: z.number().int().min(1).max(4),
    }),
  ).min(1).max(6),
});
export type QcScheme = z.infer<typeof QcSchemeSchema>;

// ---------------------------------------------------------------------------
// Request DTOs
// ---------------------------------------------------------------------------

export const LoginRequest = z.object({
  username: z.string().min(1).max(60),
  password: z.string().min(1).max(256),
});

export const CreateAssayRequest = z.object({
  name: z.string().min(1).max(120),
  methodology: z.string().max(200).default(''),
  units: z.string().max(40).default('OD'),
  transform: TransformKind.default('none'),
  qcScheme: QcSchemeSchema,
  westgardProfileId: z.string(),
  platingOrder: PlatingOrder.default('randomized'),
  allowableBiasPct: z.number().positive().max(100).nullable().default(null),
  readerMax: z.number().positive().nullable().default(null),
});

export const CreateRunRequest = z.object({
  assayId: z.string(),
  instrumentId: z.string().nullable().default(null),
  reagentLotId: z.string().nullable().default(null),
  performedAt: z.string().datetime({ offset: true }).optional(),
  comment: z.string().max(2000).optional(),
  /** raw values per level code, in replicate order */
  values: z.record(z.string(), z.array(z.number().finite())),
  /** cutoff for ratio_to_cutoff assays */
  cutoff: z.number().positive().optional(),
  /** technician name as written at the bench */
  technician: z.string().max(120).optional(),
  /** kit/reagent lot as written; auto-registered for lot tracking */
  kitLot: z.string().max(120).optional(),
});
export type CreateRunRequestDto = z.infer<typeof CreateRunRequest>;

export const OverrideRunRequest = z.object({
  reason: z.string().min(3).max(2000),
});

export const FreezeBaselineRequest = z.object({
  assayId: z.string(),
  qcMaterialId: z.string(),
  method: BaselineMethod,
  mean: z.number().finite().optional(),
  sd: z.number().positive().optional(),
  n: z.number().int().positive().optional(),
  windowFrom: z.string().optional(),
  windowTo: z.string().optional(),
  excludedObservationIds: z.array(z.string()).default([]),
  effectiveFrom: z.string().datetime({ offset: true }).optional(),
});

export const CsvImportCommitRequest = z.object({
  assayId: z.string(),
  mapping: z.object({
    performedAt: z.string(),
    level: z.string(),
    value: z.string(),
    operator: z.string().optional(),
    instrument: z.string().optional(),
    lot: z.string().optional(),
  }),
  rows: z.array(z.record(z.string(), z.string())),
  dryRun: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export const ROW_LETTERS = 'ABCDEFGHIJKLMNOP';

export function wellLabel(row: number, col: number): string {
  return `${ROW_LETTERS[row]}${col + 1}`;
}
