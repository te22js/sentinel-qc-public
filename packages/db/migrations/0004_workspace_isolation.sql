-- Session workspaces are the privacy boundary, even for the shared account.
CREATE TABLE workspace (
  id TEXT PRIMARY KEY,
  lab_name TEXT NOT NULL DEFAULT 'Laboratory'
);
INSERT INTO workspace (id) SELECT id FROM session;
INSERT OR IGNORE INTO workspace (id) SELECT workspace_id FROM assay WHERE workspace_id IS NOT NULL;

-- Rebuild to remove the old global UNIQUE(name) constraint. The migrator disables
-- FK enforcement outside this transaction and checks all references before commit.
CREATE TABLE assay_workspace (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  methodology TEXT NOT NULL DEFAULT '',
  units TEXT NOT NULL DEFAULT 'OD',
  transform TEXT NOT NULL DEFAULT 'none' CHECK (transform IN ('none','log','ratio_to_cutoff')),
  qc_scheme_json TEXT NOT NULL,
  westgard_profile_id TEXT NOT NULL REFERENCES westgard_profile(id),
  plating_order TEXT NOT NULL DEFAULT 'randomized' CHECK (plating_order IN ('randomized','sequential','structured')),
  allowable_bias_pct REAL,
  reader_max REAL,
  active INTEGER NOT NULL DEFAULT 1,
  workspace_id TEXT,
  UNIQUE(workspace_id, name)
);
INSERT INTO assay_workspace SELECT * FROM assay;
DROP TABLE assay;
ALTER TABLE assay_workspace RENAME TO assay;
CREATE INDEX idx_assay_workspace ON assay(workspace_id);

ALTER TABLE report ADD COLUMN workspace_id TEXT;
CREATE INDEX idx_report_workspace ON report(workspace_id);
-- Unowned legacy reports stay inaccessible. Never infer ownership from user_id:
-- many private workspaces deliberately share the very same account.
