-- Recurring daily Stars grants configured from the Telegram admin panel.
--
-- One row per DeltaGram account. `last_granted_date` is the civil date
-- (YYYY-MM-DD in the configured timezone) of the latest successful grant, so
-- the scheduler is idempotent across restarts and the Admin API command key
-- `recurring:<account_id>:<date>` can never credit the same day twice.
-- `next_attempt_at` is a Unix timestamp used for retry backoff after a failed
-- grant; a successful grant resets it to 0.
CREATE TABLE IF NOT EXISTS recurring_star_grants (
  id BIGSERIAL PRIMARY KEY,
  server_user_id BIGINT NOT NULL UNIQUE,
  telegram_id BIGINT NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL CHECK (amount > 0 AND amount <= 1000000000),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_granted_date TEXT NOT NULL DEFAULT '',
  next_attempt_at BIGINT NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

CREATE INDEX IF NOT EXISTS recurring_star_grants_due_idx
  ON recurring_star_grants(last_granted_date, next_attempt_at)
  WHERE enabled;

CREATE INDEX IF NOT EXISTS recurring_star_grants_telegram_idx
  ON recurring_star_grants(telegram_id)
  WHERE telegram_id > 0;
