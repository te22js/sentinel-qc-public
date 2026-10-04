/**
 * Drizzle schema — mirrors migrations/0001_init.sql exactly.
 * Migrations are the source of truth for DDL (including CHECKs and triggers);
 * this file provides the typed query layer.
 */
import { sqliteTable, text, integer, real, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const laboratory = sqliteTable('laboratory', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  settingsJson: text('settings_json').notNull().default('{}'),
});

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  role: text('role', { enum: ['technician', 'supervisor', 'admin'] }).notNull(),
  passwordHash: text('password_hash').notNull(),
  active: integer('active').notNull().default(1),
});

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
});

export const instrument = sqliteTable('instrument', {
  id: text('id').primaryKey(),
  manufacturer: text('manufacturer').notNull().default(''),
  model: text('model').notNull().default(''),
  serial: text('serial').notNull().default(''),
  label: text('label').notNull(),
  active: integer('active').notNull().default(1),
});

export const westgardProfile = sqliteTable('westgard_profile', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  rulesJson: text('rules_json').notNull(),
});

export const assay = sqliteTable('assay', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  methodology: text('methodology').notNull().default(''),
  units: text('units').notNull().default('OD'),
  transform: text('transform', { enum: ['none', 'log', 'ratio_to_cutoff'] }).notNull().default('none'),
  qcSchemeJson: text('qc_scheme_json').notNull(),
  westgardProfileId: text('westgard_profile_id').notNull().references(() => westgardProfile.id),
  platingOrder: text('plating_order', { enum: ['randomized', 'sequential', 'structured'] })
    .notNull()
    .default('randomized'),
  allowableBiasPct: real('allowable_bias_pct'),
  readerMax: real('reader_max'),
  active: integer('active').notNull().default(1),
  workspaceId: text('workspace_id'),
}, (table) => ({ workspaceName: uniqueIndex('assay_workspace_name').on(table.workspaceId, table.name) }));

export const workspace = sqliteTable('workspace', {
  id: text('id').primaryKey(),
  labName: text('lab_name').notNull().default('Laboratory'),
});

export const qcMaterial = sqliteTable('qc_material', {
  id: text('id').primaryKey(),
  assayId: text('assay_id').notNull().references(() => assay.id),
  levelCode: text('level_code').notNull(),
  manufacturer: text('manufacturer').notNull().default(''),
  lot: text('lot').notNull(),
  expiry: text('expiry'),
  targetMean: real('target_mean'),
  targetSd: real('target_sd'),
  targetLow: real('target_low'),
  targetHigh: real('target_high'),
  activeFrom: text('active_from'),
  activeTo: text('active_to'),
});

export const reagentLot = sqliteTable('reagent_lot', {
  id: text('id').primaryKey(),
  assayId: text('assay_id').notNull().references(() => assay.id),
  lot: text('lot').notNull(),
  expiry: text('expiry'),
  activeFrom: text('active_from'),
  activeTo: text('active_to'),
});

export const baseline = sqliteTable('baseline', {
  id: text('id').primaryKey(),
  assayId: text('assay_id').notNull().references(() => assay.id),
  qcMaterialId: text('qc_material_id').notNull().references(() => qcMaterial.id),
  mean: real('mean').notNull(),
  sd: real('sd').notNull(),
  n: integer('n').notNull(),
  method: text('method', {
    enum: ['manual_manufacturer', 'manual_lab', 'computed_classical', 'computed_robust'],
  }).notNull(),
  windowFrom: text('window_from'),
  windowTo: text('window_to'),
  excludedObservationIdsJson: text('excluded_observation_ids_json').notNull().default('[]'),
  effectiveFrom: text('effective_from').notNull(),
  effectiveTo: text('effective_to'),
  frozenAt: text('frozen_at').notNull(),
  frozenBy: text('frozen_by').notNull().references(() => user.id),
});

export const run = sqliteTable('run', {
  id: text('id').primaryKey(),
  assayId: text('assay_id').notNull().references(() => assay.id),
  instrumentId: text('instrument_id').references(() => instrument.id),
  operatorUserId: text('operator_user_id').notNull().references(() => user.id),
  reagentLotId: text('reagent_lot_id').references(() => reagentLot.id),
  performedAt: text('performed_at').notNull(),
  enteredAt: text('entered_at').notNull(),
  verdict: text('verdict', { enum: ['pass', 'warning', 'reject'] }).notNull(),
  overrideStatus: text('override_status', { enum: ['none', 'accepted'] }).notNull().default('none'),
  overrideReason: text('override_reason'),
  overrideBy: text('override_by').references(() => user.id),
  comment: text('comment'),
  plateId: text('plate_id'),
  technician: text('technician'),
  kitLot: text('kit_lot'),
});

export const observation = sqliteTable('observation', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => run.id),
  qcMaterialId: text('qc_material_id').notNull().references(() => qcMaterial.id),
  replicateIndex: integer('replicate_index').notNull().default(0),
  rawValue: real('raw_value').notNull(),
  transformedValue: real('transformed_value').notNull(),
  baselineId: text('baseline_id').references(() => baseline.id),
  z: real('z'),
  cutoffValue: real('cutoff_value'),
  flagsJson: text('flags_json').notNull().default('[]'),
  supersedesId: text('supersedes_id'),
  superseded: integer('superseded').notNull().default(0),
});

export const ruleEvaluation = sqliteTable('rule_evaluation', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => run.id),
  rule: text('rule').notNull(),
  scope: text('scope').notNull(),
  status: text('status', { enum: ['not_applicable', 'pass', 'warning', 'reject'] }).notNull(),
  observationIdsJson: text('observation_ids_json').notNull().default('[]'),
  message: text('message').notNull().default(''),
});

export const monitorSignal = sqliteTable('monitor_signal', {
  id: text('id').primaryKey(),
  assayId: text('assay_id').notNull().references(() => assay.id),
  qcMaterialId: text('qc_material_id').references(() => qcMaterial.id),
  monitor: text('monitor', { enum: ['ewma', 'cusum', 'ewma_var', 'changepoint'] }).notNull(),
  runId: text('run_id').references(() => run.id),
  statistic: real('statistic'),
  limit: real('limit'),
  message: text('message').notNull().default(''),
  acknowledgedBy: text('acknowledged_by').references(() => user.id),
  acknowledgedAt: text('acknowledged_at'),
});

export const plateLayout = sqliteTable('plate_layout', {
  id: text('id').primaryKey(),
  assayId: text('assay_id').notNull().references(() => assay.id),
  name: text('name').notNull(),
  wellTypesJson: text('well_types_json').notNull(),
});

export const plate = sqliteTable('plate', {
  id: text('id').primaryKey(),
  assayId: text('assay_id').notNull().references(() => assay.id),
  runId: text('run_id').references(() => run.id),
  rows: integer('rows').notNull().default(8),
  cols: integer('cols').notNull().default(12),
  importedAt: text('imported_at').notNull(),
  sourceFilename: text('source_filename').notNull().default(''),
  transformUsed: text('transform_used').notNull().default('log'),
  layoutId: text('layout_id').references(() => plateLayout.id),
});

export const wellMeasurement = sqliteTable('well_measurement', {
  id: text('id').primaryKey(),
  plateId: text('plate_id').notNull().references(() => plate.id),
  row: integer('row').notNull(),
  col: integer('col').notNull(),
  wellType: text('well_type', {
    enum: ['sample', 'blank', 'neg_ctrl', 'pos_ctrl', 'calibrator', 'empty'],
  }).notNull(),
  rawValue: real('raw_value'),
  transformedValue: real('transformed_value'),
  residual: real('residual'),
  zLocal: real('z_local'),
});

export const plateAnalysis = sqliteTable('plate_analysis', {
  id: text('id').primaryKey(),
  plateId: text('plate_id').notNull().references(() => plate.id),
  paramsJson: text('params_json').notNull(),
  mu: real('mu'),
  rowEffectsJson: text('row_effects_json').notNull().default('[]'),
  colEffectsJson: text('col_effects_json').notNull().default('[]'),
  edgeStat: real('edge_stat'),
  gradJson: text('grad_json').notNull().default('{}'),
  moranI: real('moran_i'),
  pvaluesJson: text('pvalues_json'),
  findingsJson: text('findings_json').notNull().default('[]'),
  t2: real('t2'),
  spe: real('spe'),
  phase2ModelId: text('phase2_model_id'),
  analyzedAt: text('analyzed_at').notNull(),
});

export const platePhase2Model = sqliteTable('plate_phase2_model', {
  id: text('id').primaryKey(),
  assayId: text('assay_id').notNull().references(() => assay.id),
  nPlates: integer('n_plates').notNull(),
  loadingsJson: text('loadings_json').notNull(),
  eigenJson: text('eigen_json').notNull(),
  meansJson: text('means_json').notNull(),
  scalesJson: text('scales_json').notNull(),
  aComponents: integer('a_components').notNull(),
  t2Ucl: real('t2_ucl').notNull(),
  speUcl: real('spe_ucl').notNull(),
  builtAt: text('built_at').notNull(),
  plateIdsJson: text('plate_ids_json').notNull(),
});

export const auditEvent = sqliteTable('audit_event', {
  id: text('id').primaryKey(),
  seq: integer('seq').notNull().unique(),
  at: text('at').notNull(),
  userId: text('user_id'),
  entity: text('entity').notNull(),
  entityId: text('entity_id').notNull(),
  action: text('action', {
    enum: ['create', 'update', 'override', 'freeze', 'generate_report', 'login', 'config_change'],
  }).notNull(),
  beforeJson: text('before_json'),
  afterJson: text('after_json'),
  reason: text('reason'),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
});

export const report = sqliteTable('report', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  paramsJson: text('params_json').notNull().default('{}'),
  generatedAt: text('generated_at').notNull(),
  generatedBy: text('generated_by').notNull().references(() => user.id),
  filePath: text('file_path').notNull().default(''),
  workspaceId: text('workspace_id'),
});
