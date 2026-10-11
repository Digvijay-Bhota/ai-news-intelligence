-- Migration 0013: Gemini 3.6 Flash Escalation Budget
--
-- Backs the atomic daily reservation for the opt-in Gemini 3.6 Flash quality
-- escalation path (see workers/src/tasks/gemini-escalation.ts). One row per
-- (Pacific calendar date, model). reserved_count is incremented atomically via
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING, the same pattern already
-- used for rate_limit_logs (see 0010_rate_limit_unique.sql and
-- workers/src/utils/rate-limiter.ts). Not applied to production by this change.

CREATE TABLE IF NOT EXISTS gemini_escalation_budget (
    bucket_date TEXT NOT NULL,
    model TEXT NOT NULL,
    reserved_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (bucket_date, model)
);
