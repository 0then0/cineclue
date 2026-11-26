CREATE TABLE telegram_login_attempt (
  visitor_id uuid PRIMARY KEY,
  state_hash text NOT NULL UNIQUE,
  nonce text NOT NULL,
  verifier text NOT NULL,
  return_path text NOT NULL,
  claimed boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL
);
CREATE INDEX telegram_login_attempt_expiry_idx ON telegram_login_attempt(expires_at);

CREATE TABLE telegram_session (
  visitor_id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  bot_id text NOT NULL,
  player_id uuid NOT NULL,
  mini_app boolean NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX telegram_session_expiry_idx ON telegram_session(expires_at);
