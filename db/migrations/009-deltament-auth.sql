CREATE TABLE IF NOT EXISTS deltament_auth_challenges (
  challenge_id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  server_user_id BIGINT NOT NULL,
  code_digest TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);
CREATE INDEX IF NOT EXISTS deltament_auth_challenges_expiry_idx
  ON deltament_auth_challenges(expires_at);
CREATE TABLE IF NOT EXISTS deltament_auth_rate_limits (
  phone TEXT PRIMARY KEY,
  requested_at BIGINT NOT NULL
);
