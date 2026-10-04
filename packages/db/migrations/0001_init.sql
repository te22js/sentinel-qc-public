-- Sentinel QC schema. All ids are ULIDs (26-char text); timestamps are ISO-8601 UTC text.
-- No patient fields exist anywhere in this schema, by design.

CREATE TABLE laboratory (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  settings_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE user (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('technician','supervisor','admin')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE instrument (
  id TEXT PRIMARY KEY,
  manufacturer TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  serial TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE westgard_profile (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  rules_json TEXT NOT NULL
);

CREATE TABLE assay (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  methodology TEXT NOT NULL DEFAULT '',
  units TEXT NOT NULL DEFAULT 'OD',
  transform TEXT NOT NULL DEFAULT 'none' CHECK (transform IN ('none','log','ratio_to_cutoff')),
  qc_scheme_json TEXT NOT NULL,
  westgard_profile_id TEXT NOT NULL REFERENCES westgard_profile(id),
  plating_order TEXT NOT NULL DEFAULT 'randomized' CHECK (plating_order IN ('randomized','sequential','structured')),
  allowable_bias_pct REAL,
  reader_max REAL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE qc_material (
  id TEXT PRIMARY KEY,
  assay_id TEXT NOT NULL REFERENCES assay(id),
  level_code TEXT NOT NULL,
  manufacturer TEXT NOT NULL DEFAULT '',
  lot TEXT NOT NULL,
  expiry TEXT,
  target_mean REAL,
  target_sd REAL,
  target_low REAL,
  target_high REAL,
  active_from TEXT,
  active_to TEXT
);
CREATE INDEX idx_qc_material_assay ON qc_material(assay_id, level_code);

CREATE TABLE reagent_lot (
  id TEXT PRIMARY KEY,
  assay_id TEXT NOT NULL REFERENCES assay(id),
  lot TEXT NOT NULL,
  expiry TEXT,
  active_from TEXT,
  active_to TEXT
);
CREATE INDEX idx_reagent_lot_assay ON reagent_lot(assay_id);

CREATE TABLE baseline (
  id TEXT PRIMARY KEY,
  assay_id TEXT NOT NULL REFERENCES assay(id),
  qc_material_id TEXT NOT NULL REFERENCES qc_material(id),
  mean REAL NOT NULL,
  sd REAL NOT NULL CHECK (sd > 0),
  n INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('manual_manufacturer','manual_lab','computed_classical','computed_robust')),
  window_from TEXT,
  window_to TEXT,
  excluded_observation_ids_json TEXT NOT NULL DEFAULT '[]',
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  frozen_at TEXT NOT NULL,
  frozen_by TEXT NOT NULL REFERENCES user(id)
);
CREATE INDEX idx_baseline_material ON baseline(qc_material_id, effective_from);

CREATE TABLE run (
  id TEXT PRIMARY KEY,
  assay_id TEXT NOT NULL REFERENCES assay(id),
  instrument_id TEXT REFERENCES instrument(id),
  operator_user_id TEXT NOT NULL REFERENCES user(id),
  reagent_lot_id TEXT REFERENCES reagent_lot(id),
  performed_at TEXT NOT NULL,
  entered_at TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','warning','reject')),
  override_status TEXT NOT NULL DEFAULT 'none' CHECK (override_status IN ('none','accepted')),
  override_reason TEXT,
  override_by TEXT REFERENCES user(id),
  comment TEXT,
  plate_id TEXT
);
CREATE INDEX idx_run_assay_time ON run(assay_id, performed_at);

CREATE TABLE observation (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(id),
  qc_material_id TEXT NOT NULL REFERENCES qc_material(id),
  replicate_index INTEGER NOT NULL DEFAULT 0,
  raw_value REAL NOT NULL,
  transformed_value REAL NOT NULL,
  baseline_id TEXT REFERENCES baseline(id),
  z REAL,
  cutoff_value REAL,
  flags_json TEXT NOT NULL DEFAULT '[]',
  supersedes_id TEXT REFERENCES observation(id),
  superseded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_observation_run ON observation(run_id);
CREATE INDEX idx_observation_material ON observation(qc_material_id);

-- Corrections are new versions via supersedes_id; direct value edits are forbidden.
CREATE TRIGGER observation_no_value_update
BEFORE UPDATE OF raw_value, transformed_value, z ON observation
BEGIN
  SELECT RAISE(ABORT, 'observation values are immutable; insert a correction with supersedes_id');
END;

CREATE TABLE rule_evaluation (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(id),
  rule TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('not_applicable','pass','warning','reject')),
  observation_ids_json TEXT NOT NULL DEFAULT '[]',
  message TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_rule_eval_run ON rule_evaluation(run_id);

CREATE TABLE monitor_signal (
  id TEXT PRIMARY KEY,
  assay_id TEXT NOT NULL REFERENCES assay(id),
  qc_material_id TEXT REFERENCES qc_material(id),
  monitor TEXT NOT NULL CHECK (monitor IN ('ewma','cusum','ewma_var','changepoint')),
  run_id TEXT REFERENCES run(id),
  statistic REAL,
  "limit" REAL,
  message TEXT NOT NULL DEFAULT '',
  acknowledged_by TEXT REFERENCES user(id),
  acknowledged_at TEXT
);
CREATE INDEX idx_monitor_signal_assay ON monitor_signal(assay_id);

CREATE TABLE plate_layout (
  id TEXT PRIMARY KEY,
  assay_id TEXT NOT NULL REFERENCES assay(id),
  name TEXT NOT NULL,
  well_types_json TEXT NOT NULL
);

CREATE TABLE plate (
  id TEXT PRIMARY KEY,
  assay_id TEXT NOT NULL REFERENCES assay(id),
  run_id TEXT REFERENCES run(id),
  rows INTEGER NOT NULL DEFAULT 8,
  cols INTEGER NOT NULL DEFAULT 12,
  imported_at TEXT NOT NULL,
  source_filename TEXT NOT NULL DEFAULT '',
  transform_used TEXT NOT NULL DEFAULT 'log',
  layout_id TEXT REFERENCES plate_layout(id)
);
CREATE INDEX idx_plate_assay ON plate(assay_id, imported_at);

CREATE TABLE well_measurement (
  id TEXT PRIMARY KEY,
  plate_id TEXT NOT NULL REFERENCES plate(id),
  row INTEGER NOT NULL,
  col INTEGER NOT NULL,
  well_type TEXT NOT NULL CHECK (well_type IN ('sample','blank','neg_ctrl','pos_ctrl','calibrator','empty')),
  raw_value REAL,
  transformed_value REAL,
  residual REAL,
  z_local REAL
);
CREATE INDEX idx_well_plate ON well_measurement(plate_id);

CREATE TABLE plate_analysis (
  id TEXT PRIMARY KEY,
  plate_id TEXT NOT NULL REFERENCES plate(id),
  params_json TEXT NOT NULL,
  mu REAL,
  row_effects_json TEXT NOT NULL DEFAULT '[]',
  col_effects_json TEXT NOT NULL DEFAULT '[]',
  edge_stat REAL,
  grad_json TEXT NOT NULL DEFAULT '{}',
  moran_i REAL,
  pvalues_json TEXT,
  findings_json TEXT NOT NULL DEFAULT '[]',
  t2 REAL,
  spe REAL,
  phase2_model_id TEXT,
  analyzed_at TEXT NOT NULL
);
CREATE INDEX idx_plate_analysis_plate ON plate_analysis(plate_id);

CREATE TABLE plate_phase2_model (
  id TEXT PRIMARY KEY,
  assay_id TEXT NOT NULL REFERENCES assay(id),
  n_plates INTEGER NOT NULL,
  loadings_json TEXT NOT NULL,
  eigen_json TEXT NOT NULL,
  means_json TEXT NOT NULL,
  scales_json TEXT NOT NULL,
  a_components INTEGER NOT NULL,
  t2_ucl REAL NOT NULL,
  spe_ucl REAL NOT NULL,
  built_at TEXT NOT NULL,
  plate_ids_json TEXT NOT NULL
);

CREATE TABLE audit_event (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  at TEXT NOT NULL,
  user_id TEXT,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create','update','override','freeze','generate_report','login','config_change')),
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

-- The audit log is append-only.
CREATE TRIGGER audit_event_no_update
BEFORE UPDATE ON audit_event
BEGIN
  SELECT RAISE(ABORT, 'audit_event is append-only');
END;
CREATE TRIGGER audit_event_no_delete
BEFORE DELETE ON audit_event
BEGIN
  SELECT RAISE(ABORT, 'audit_event is append-only');
END;

CREATE TABLE report (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  generated_at TEXT NOT NULL,
  generated_by TEXT NOT NULL REFERENCES user(id),
  file_path TEXT NOT NULL DEFAULT ''
);
