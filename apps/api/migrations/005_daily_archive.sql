ALTER TABLE game_session
  DROP CONSTRAINT game_session_mode_check,
  ADD CONSTRAINT game_session_mode_check CHECK (mode IN ('daily', 'unlimited', 'challenge', 'archive')),
  ADD COLUMN archive_puzzle_id uuid REFERENCES daily_puzzle,
  ADD UNIQUE (visitor_id, archive_puzzle_id),
  ADD CONSTRAINT game_session_archive_puzzle_check CHECK (
    (mode <> 'archive' AND archive_puzzle_id IS NULL) OR
    (mode = 'archive' AND archive_puzzle_id IS NOT NULL AND puzzle_id IS NULL AND challenge_id IS NULL)
  );
