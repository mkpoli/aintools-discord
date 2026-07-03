-- Continuous message archive: per-channel crawl cursors + archived messages.
-- See src/services/archive.ts for the crawler and README's "Message archive"
-- section for cadence/backfill semantics.

CREATE TABLE archive_channels (
	channel_id TEXT PRIMARY KEY,
	guild_id TEXT NOT NULL,
	name TEXT,
	type INTEGER,
	parent_id TEXT,
	is_thread INTEGER NOT NULL DEFAULT 0,
	-- Newest message id already archived (incremental catch-up cursor).
	last_message_id TEXT,
	-- Oldest-so-far `before` cursor for historical backfill.
	backfill_before_id TEXT,
	backfill_done INTEGER NOT NULL DEFAULT 0,
	-- 0 once the crawler sees 403/404 for this channel (e.g. lost access).
	archivable INTEGER NOT NULL DEFAULT 1,
	updated_at TEXT
);

CREATE TABLE archive_messages (
	id TEXT PRIMARY KEY,
	channel_id TEXT NOT NULL,
	guild_id TEXT NOT NULL,
	author_id TEXT,
	author_name TEXT,
	author_bot INTEGER NOT NULL DEFAULT 0,
	type INTEGER,
	content TEXT,
	created_at TEXT NOT NULL,
	edited_at TEXT,
	reply_to_id TEXT,
	-- Compact JSON array: {url, filename, content_type, size}[]; NULL if none.
	attachments TEXT,
	-- Compact JSON array: {name, count}[]; NULL if none.
	reactions TEXT,
	-- Full message JSON from the API, future-proofing; NULL for imported legacy rows.
	raw TEXT,
	source TEXT NOT NULL DEFAULT 'bot',
	archived_at TEXT NOT NULL
);

CREATE INDEX archive_messages_channel_created_idx ON archive_messages (channel_id, created_at);
CREATE INDEX archive_messages_author_idx ON archive_messages (author_id);
