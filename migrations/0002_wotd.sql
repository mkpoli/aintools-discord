-- Word-of-the-day post history (idempotency + 180-day repeat exclusion).

CREATE TABLE wotd_history (
	date TEXT PRIMARY KEY,
	token TEXT NOT NULL,
	posted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX wotd_history_token_idx ON wotd_history (token);
