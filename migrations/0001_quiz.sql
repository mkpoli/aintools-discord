-- /quiz scores and streaks.

CREATE TABLE quiz_users (
	user_id TEXT PRIMARY KEY,
	total_answered INTEGER NOT NULL DEFAULT 0,
	total_correct INTEGER NOT NULL DEFAULT 0,
	streak INTEGER NOT NULL DEFAULT 0,
	best_streak INTEGER NOT NULL DEFAULT 0,
	daily_streak INTEGER NOT NULL DEFAULT 0,
	last_played_date TEXT,
	updated_at TEXT NOT NULL
);

CREATE TABLE quiz_attempts (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL,
	item_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	correct INTEGER NOT NULL,
	answered_at TEXT NOT NULL
);

CREATE INDEX quiz_attempts_user_id_idx ON quiz_attempts (user_id);
