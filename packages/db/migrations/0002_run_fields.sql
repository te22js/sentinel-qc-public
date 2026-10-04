-- Per-run technician name and kit lot, entered free-text at the bench (the shared
-- single-login model means the operator account no longer identifies the person).
ALTER TABLE run ADD COLUMN technician TEXT;
ALTER TABLE run ADD COLUMN kit_lot TEXT;
