-- Per-login workspaces on the shared account: every assay created through the UI is
-- stamped with the creating session's id. Each sign-in sees only its own workspace
-- (NULL = shared/legacy), and workspaces whose sessions have expired are purged at
-- boot — entered data lives for the session, not forever.
ALTER TABLE assay ADD COLUMN workspace_id TEXT;
CREATE INDEX idx_assay_workspace ON assay(workspace_id);
