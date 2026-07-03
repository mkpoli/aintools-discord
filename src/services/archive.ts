/**
 * Message archive cron: `app.cron("*\/10 * * * *", runArchive)` in
 * src/index.ts. Replaces the old manual DiscordChatExporter workflow with a
 * continuous, self-healing REST crawler — there is no gateway connection (an
 * HTTP-interactions bot gets no `MESSAGE_CREATE` events), so every 10 minutes
 * this walks the guild's channels/threads with per-channel snowflake cursors
 * stored in D1 (migrations/0003_archive.sql).
 *
 * One code path does both:
 *  - **incremental catch-up**: page `after=last_message_id` toward "now"
 *  - **historical backfill**: page `before=backfill_before_id` toward the
 *    channel's first message
 * capped at `ARCHIVE_REST_BUDGET` REST calls per run so it always fits
 * inside a Worker's subrequest limits; both cursors converge over successive
 * 10-minute runs rather than in one shot.
 *
 * Decomposed like src/cron/wotd.ts: pure mapping/cursor helpers (tested in
 * test/archive-mapping.test.ts) around a thin I/O shell (tested with a stub
 * `fetch` + an in-memory D1 in test/archive-crawler.test.ts).
 */
import type { CronContext } from "discord-hono";
import type { AppEnv } from "../lib/errors.js";

export const ARCHIVE_REST_BUDGET = 35;
const MESSAGE_PAGE_LIMIT = 100;
const DISCORD_API_BASE = "https://discord.com/api/v10";

// ---------------------------------------------------------------- pure ----

/** GUILD_TEXT / GUILD_ANNOUNCEMENT — message-bearing top-level channels. */
const MESSAGE_CHANNEL_TYPES = new Set([0, 5]);
/** GUILD_FORUM / GUILD_MEDIA — no messages of their own; only their threads matter. */
const CONTAINER_CHANNEL_TYPES = new Set([15, 16]);

export function isMessageChannelType(type: number): boolean {
	return MESSAGE_CHANNEL_TYPES.has(type);
}

export function isContainerType(type: number | null): boolean {
	return type !== null && CONTAINER_CHANNEL_TYPES.has(type);
}

export interface DiscordChannel {
	id: string;
	type: number;
	name?: string | null;
	parent_id?: string | null;
}

export interface ChannelCandidate {
	channel_id: string;
	guild_id: string;
	name: string | null;
	type: number;
	parent_id: string | null;
	is_thread: boolean;
	/** Forum/media containers have no messages of their own to backfill. */
	initialBackfillDone: boolean;
}

/** A top-level guild channel, filtered to the ones the crawler cares about. */
export function mapChannelCandidate(
	channel: DiscordChannel,
	guildId: string,
): ChannelCandidate | undefined {
	if (!isMessageChannelType(channel.type) && !isContainerType(channel.type)) {
		return undefined;
	}
	return {
		channel_id: channel.id,
		guild_id: guildId,
		name: channel.name ?? null,
		type: channel.type,
		parent_id: channel.parent_id ?? null,
		is_thread: false,
		initialBackfillDone: isContainerType(channel.type),
	};
}

/** Any thread (active or swept from an archived-thread listing). */
export function mapThreadCandidate(
	thread: DiscordChannel,
	guildId: string,
): ChannelCandidate {
	return {
		channel_id: thread.id,
		guild_id: guildId,
		name: thread.name ?? null,
		type: thread.type,
		parent_id: thread.parent_id ?? null,
		is_thread: true,
		initialBackfillDone: false,
	};
}

/** Snowflakes are 64-bit — compare as `bigint`, never as a number or string. */
export function compareSnowflakes(a: string, b: string): number {
	const bigA = BigInt(a);
	const bigB = BigInt(b);
	if (bigA < bigB) return -1;
	if (bigA > bigB) return 1;
	return 0;
}

export function maxSnowflake(ids: readonly string[]): string | undefined {
	return ids.reduce<string | undefined>(
		(max, id) =>
			max === undefined || compareSnowflakes(id, max) > 0 ? id : max,
		undefined,
	);
}

export function minSnowflake(ids: readonly string[]): string | undefined {
	return ids.reduce<string | undefined>(
		(min, id) =>
			min === undefined || compareSnowflakes(id, min) < 0 ? id : min,
		undefined,
	);
}

export interface DiscordAttachment {
	url: string;
	filename: string;
	content_type?: string | null;
	size?: number;
}

export interface DiscordReactionEmoji {
	id: string | null;
	name: string | null;
}

export interface DiscordReaction {
	emoji: DiscordReactionEmoji;
	count: number;
}

export interface DiscordMessage {
	id: string;
	type?: number;
	content?: string;
	timestamp: string;
	edited_timestamp?: string | null;
	author?: { id: string; username?: string; bot?: boolean };
	message_reference?: { message_id?: string };
	attachments?: DiscordAttachment[];
	reactions?: DiscordReaction[];
	[key: string]: unknown;
}

export interface ArchiveMessageRow {
	id: string;
	channel_id: string;
	guild_id: string;
	author_id: string | null;
	author_name: string | null;
	author_bot: number;
	type: number | null;
	content: string | null;
	created_at: string;
	edited_at: string | null;
	reply_to_id: string | null;
	attachments: string | null;
	reactions: string | null;
	raw: string;
	source: "bot";
	archived_at: string;
}

/** Compact `{url, filename, content_type, size}[]` JSON — `null` when there are none. */
export function serializeAttachments(
	attachments: readonly DiscordAttachment[] | undefined,
): string | null {
	if (!attachments || attachments.length === 0) return null;
	return JSON.stringify(
		attachments.map((a) => ({
			url: a.url,
			filename: a.filename,
			content_type: a.content_type ?? null,
			size: a.size ?? null,
		})),
	);
}

/** Compact `{name, count}[]` JSON — `null` when there are none. */
export function serializeReactions(
	reactions: readonly DiscordReaction[] | undefined,
): string | null {
	if (!reactions || reactions.length === 0) return null;
	return JSON.stringify(
		reactions.map((r) => ({
			name: r.emoji.name ?? r.emoji.id ?? null,
			count: r.count,
		})),
	);
}

/** Maps one Discord API message object to its `archive_messages` row. `raw` keeps the full JSON (future-proofing). */
export function messageToRow(
	message: DiscordMessage,
	channelId: string,
	guildId: string,
	archivedAt: string,
): ArchiveMessageRow {
	return {
		id: message.id,
		channel_id: channelId,
		guild_id: guildId,
		author_id: message.author?.id ?? null,
		author_name: message.author?.username ?? null,
		author_bot: message.author?.bot ? 1 : 0,
		type: message.type ?? null,
		content: message.content ?? null,
		created_at: message.timestamp,
		edited_at: message.edited_timestamp ?? null,
		reply_to_id: message.message_reference?.message_id ?? null,
		attachments: serializeAttachments(message.attachments),
		reactions: serializeReactions(message.reactions),
		raw: JSON.stringify(message),
		source: "bot",
		archived_at: archivedAt,
	};
}

// ---------------------------------------------------------------- REST ----

export class RateLimitedError extends Error {
	constructor(public readonly retryAfterSeconds: number) {
		super(`rate limited — retry after ${retryAfterSeconds}s`);
		this.name = "RateLimitedError";
	}
}

export class ChannelUnavailableError extends Error {
	constructor(public readonly status: number) {
		super(`channel unavailable — HTTP ${status}`);
		this.name = "ChannelUnavailableError";
	}
}

export interface DiscordRest {
	readonly calls: number;
	exhausted(): boolean;
	get(path: string): Promise<unknown>;
	getMessages(
		channelId: string,
		opts: { after?: string; before?: string },
	): Promise<DiscordMessage[]>;
}

/**
 * Plain-`fetch` Discord REST client for this cron — deliberately NOT
 * discord-hono's `c.rest` (an interaction-context helper typed only for the
 * handful of endpoints a command/component response needs). This cron reads
 * arbitrary guild/channel/thread/message list endpoints, so it talks to
 * `https://discord.com/api/v10` directly with a bot-token header and an 8s
 * timeout, matching services/http.ts's upstream-fetch conventions. Every
 * dispatched request counts against `limit` so a run stops cleanly at the
 * per-run REST budget instead of risking the Worker's subrequest cap.
 */
export function createDiscordRest(token: string, limit: number): DiscordRest {
	let calls = 0;

	async function get(path: string): Promise<unknown> {
		calls++;
		let res: Response;
		try {
			res = await fetch(`${DISCORD_API_BASE}${path}`, {
				headers: { Authorization: `Bot ${token}` },
				signal: AbortSignal.timeout(8000),
			});
		} catch (err) {
			throw new Error(
				`Discord API ${path}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		if (res.status === 429) {
			let retryAfterSeconds = 1;
			try {
				const body = (await res.json()) as { retry_after?: number };
				retryAfterSeconds = body.retry_after ?? 1;
			} catch {
				// no/invalid JSON body — fall back to the 1s default above
			}
			throw new RateLimitedError(retryAfterSeconds);
		}
		if (res.status === 403 || res.status === 404) {
			throw new ChannelUnavailableError(res.status);
		}
		if (!res.ok) {
			throw new Error(`Discord API ${path} → HTTP ${res.status}`);
		}
		try {
			return await res.json();
		} catch {
			throw new Error(`Discord API ${path}: response was not valid JSON`);
		}
	}

	async function getMessages(
		channelId: string,
		opts: { after?: string; before?: string },
	): Promise<DiscordMessage[]> {
		const params = new URLSearchParams({ limit: String(MESSAGE_PAGE_LIMIT) });
		if (opts.after) params.set("after", opts.after);
		else if (opts.before) params.set("before", opts.before);
		return (await get(
			`/channels/${channelId}/messages?${params}`,
		)) as DiscordMessage[];
	}

	return {
		get calls() {
			return calls;
		},
		exhausted: () => calls >= limit,
		get,
		getMessages,
	};
}

// ----------------------------------------------------------------- D1 ----

export interface ArchiveChannelRow {
	channel_id: string;
	guild_id: string;
	name: string | null;
	type: number | null;
	parent_id: string | null;
	is_thread: number;
	last_message_id: string | null;
	backfill_before_id: string | null;
	backfill_done: number;
	archivable: number;
	updated_at: string | null;
}

async function upsertChannels(
	db: D1Database,
	candidates: readonly ChannelCandidate[],
	nowIso: string,
): Promise<void> {
	if (candidates.length === 0) return;
	// Only descriptive columns are ever touched on conflict — cursor state
	// (last_message_id/backfill_before_id/backfill_done/archivable) is left
	// alone so a re-discovered channel never loses its crawl progress.
	await db.batch(
		candidates.map((ch) =>
			db
				.prepare(
					`INSERT INTO archive_channels
						(channel_id, guild_id, name, type, parent_id, is_thread, archivable, backfill_done, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
					 ON CONFLICT(channel_id) DO UPDATE SET
						name = excluded.name,
						type = excluded.type,
						parent_id = excluded.parent_id,
						updated_at = excluded.updated_at`,
				)
				.bind(
					ch.channel_id,
					ch.guild_id,
					ch.name,
					ch.type,
					ch.parent_id,
					ch.is_thread ? 1 : 0,
					ch.initialBackfillDone ? 1 : 0,
					nowIso,
				),
		),
	);
}

async function stalestChannels(
	db: D1Database,
	guildId: string,
): Promise<ArchiveChannelRow[]> {
	// SQLite sorts NULL first for ASC, so never-touched channels (updated_at
	// IS NULL — can't happen after upsertChannels, but defensive) win ties.
	const { results } = await db
		.prepare(
			"SELECT * FROM archive_channels WHERE guild_id = ? AND archivable = 1 ORDER BY updated_at ASC",
		)
		.bind(guildId)
		.all<ArchiveChannelRow>();
	return results;
}

async function markUnarchivable(
	db: D1Database,
	channelId: string,
	nowIso: string,
): Promise<void> {
	await db
		.prepare(
			"UPDATE archive_channels SET archivable = 0, updated_at = ? WHERE channel_id = ?",
		)
		.bind(nowIso, channelId)
		.run();
}

interface CursorUpdate {
	lastMessageId?: string;
	backfillBeforeId?: string;
	backfillDone?: boolean;
}

/** `COALESCE`s every field so a partial update never clobbers the others — always also refreshes `updated_at` (the round-robin's sort key). */
function cursorUpdateStatement(
	db: D1Database,
	channelId: string,
	update: CursorUpdate,
	nowIso: string,
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE archive_channels
				SET last_message_id = COALESCE(?, last_message_id),
					backfill_before_id = COALESCE(?, backfill_before_id),
					backfill_done = COALESCE(?, backfill_done),
					updated_at = ?
			 WHERE channel_id = ?`,
		)
		.bind(
			update.lastMessageId ?? null,
			update.backfillBeforeId ?? null,
			update.backfillDone === undefined ? null : update.backfillDone ? 1 : 0,
			nowIso,
			channelId,
		);
}

async function commitCursors(
	db: D1Database,
	channelId: string,
	nowIso: string,
	update: CursorUpdate,
): Promise<void> {
	await cursorUpdateStatement(db, channelId, update, nowIso).run();
}

function messageInsertStatement(
	db: D1Database,
	row: ArchiveMessageRow,
): D1PreparedStatement {
	// `bot` rows always win — the crawler is the freshest source of truth, so
	// a plain REPLACE is fine (the import script is the one that must defer,
	// via INSERT OR IGNORE, to whatever a 'bot' row already claims).
	return db
		.prepare(
			`INSERT OR REPLACE INTO archive_messages
				(id, channel_id, guild_id, author_id, author_name, author_bot, type, content, created_at, edited_at, reply_to_id, attachments, reactions, raw, source, archived_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.channel_id,
			row.guild_id,
			row.author_id,
			row.author_name,
			row.author_bot,
			row.type,
			row.content,
			row.created_at,
			row.edited_at,
			row.reply_to_id,
			row.attachments,
			row.reactions,
			row.raw,
			row.source,
			row.archived_at,
		);
}

/**
 * Commits a page of messages and its cursor advance in one `db.batch()` —
 * D1 runs a batch as a single transaction, so a cursor is only ever visible
 * after the messages behind it are, and a mid-batch failure leaves both the
 * old messages and the old cursor in place (never a half-applied page).
 */
async function commitMessagesAndCursors(
	db: D1Database,
	channel: ArchiveChannelRow,
	messages: readonly DiscordMessage[],
	nowIso: string,
	update: CursorUpdate,
): Promise<void> {
	const statements = messages.map((m) =>
		messageInsertStatement(
			db,
			messageToRow(m, channel.channel_id, channel.guild_id, nowIso),
		),
	);
	statements.push(
		cursorUpdateStatement(db, channel.channel_id, update, nowIso),
	);
	await db.batch(statements);
}

async function sweepArchivedThreads(
	rest: DiscordRest,
	db: D1Database,
	channelId: string,
	guildId: string,
	nowIso: string,
): Promise<void> {
	const data = (await rest.get(
		`/channels/${channelId}/threads/archived/public?limit=100`,
	)) as { threads?: DiscordChannel[] };
	const candidates = (data.threads ?? []).map((t) =>
		mapThreadCandidate(t, guildId),
	);
	await upsertChannels(db, candidates, nowIso);
}

async function refreshChannels(
	rest: DiscordRest,
	db: D1Database,
	guildId: string,
	nowIso: string,
): Promise<void> {
	const channels = (await rest.get(
		`/guilds/${guildId}/channels`,
	)) as DiscordChannel[];
	const channelCandidates = channels
		.map((ch) => mapChannelCandidate(ch, guildId))
		.filter((ch): ch is ChannelCandidate => ch !== undefined);

	const activeThreads = (await rest.get(
		`/guilds/${guildId}/threads/active`,
	)) as {
		threads?: DiscordChannel[];
	};
	const threadCandidates = (activeThreads.threads ?? []).map((t) =>
		mapThreadCandidate(t, guildId),
	);

	await upsertChannels(db, [...channelCandidates, ...threadCandidates], nowIso);
}

/**
 * Processes one channel's turn in the round robin: an incremental catch-up
 * pass, then a backfill pass — each independently gated on remaining REST
 * budget, so a run that runs out mid-channel simply leaves whichever cursors
 * it already committed and picks the rest up next run.
 */
async function processChannel(
	rest: DiscordRest,
	db: D1Database,
	channel: ArchiveChannelRow,
	nowIso: string,
): Promise<void> {
	// Forum/media containers never have messages of their own — their posts
	// are threads, discovered via /threads/active + this occasional sweep
	// (naturally throttled by the round robin, same as everything else here).
	if (isContainerType(channel.type)) {
		if (!rest.exhausted()) {
			await sweepArchivedThreads(
				rest,
				db,
				channel.channel_id,
				channel.guild_id,
				nowIso,
			);
		}
		await commitCursors(db, channel.channel_id, nowIso, {});
		return;
	}

	let backfillBeforeId = channel.backfill_before_id ?? undefined;
	let justFinishedBackfill = false;

	if (channel.last_message_id === null) {
		// Never seen before: seed both cursors from one fetch of the newest page.
		if (rest.exhausted()) return;
		const messages = await rest.getMessages(channel.channel_id, {});
		if (messages.length === 0) {
			await commitCursors(db, channel.channel_id, nowIso, {
				backfillDone: true,
			});
			return;
		}
		const ids = messages.map((m) => m.id);
		const lastMessageId = maxSnowflake(ids);
		backfillBeforeId = minSnowflake(ids);
		await commitMessagesAndCursors(db, channel, messages, nowIso, {
			lastMessageId,
			backfillBeforeId,
		});
	} else if (!rest.exhausted()) {
		// Incremental catch-up.
		const messages = await rest.getMessages(channel.channel_id, {
			after: channel.last_message_id,
		});
		if (messages.length > 0) {
			const lastMessageId = maxSnowflake([
				channel.last_message_id,
				...messages.map((m) => m.id),
			]);
			await commitMessagesAndCursors(db, channel, messages, nowIso, {
				lastMessageId,
			});
		} else {
			await commitCursors(db, channel.channel_id, nowIso, {});
		}
	}

	if (channel.backfill_done === 1) return;

	if (backfillBeforeId === undefined) {
		// Defensive: the seed step above always sets both cursors together, so
		// this shouldn't happen — but never fetch with an undefined boundary.
		// Falls back to last_message_id and picks up the real backfill fetch
		// next run rather than skipping it silently forever.
		if (channel.last_message_id !== null) {
			await commitCursors(db, channel.channel_id, nowIso, {
				backfillBeforeId: channel.last_message_id,
			});
		}
		return;
	}
	if (rest.exhausted()) return;

	const backfillMessages = await rest.getMessages(channel.channel_id, {
		before: backfillBeforeId,
	});
	if (backfillMessages.length === 0) {
		await commitCursors(db, channel.channel_id, nowIso, { backfillDone: true });
		justFinishedBackfill = true;
	} else {
		const newBefore = minSnowflake(backfillMessages.map((m) => m.id));
		await commitMessagesAndCursors(db, channel, backfillMessages, nowIso, {
			backfillBeforeId: newBefore,
		});
	}

	if (justFinishedBackfill && channel.is_thread === 0 && !rest.exhausted()) {
		await sweepArchivedThreads(
			rest,
			db,
			channel.channel_id,
			channel.guild_id,
			nowIso,
		);
	}
}

/**
 * `DISCORD_TOKEN` is a secret set via `wrangler secret put` (never a
 * wrangler.jsonc `vars` entry), so it never lands in the generated `Env`
 * type — same cast test/wotd-cron.test.ts already uses for the same reason.
 */
function discordToken(env: Env): string {
	return (env as unknown as { DISCORD_TOKEN?: string }).DISCORD_TOKEN ?? "";
}

/**
 * The cron handler. `now` defaults to the real clock (tests inject a fixed
 * `Date`); `budget` defaults to the real per-run REST cap (tests inject a
 * small one to exercise "exhausted mid-run" without 35 fixture channels).
 *
 * Any error is caught per-scope (refresh, per-channel) and logged — never
 * left to crash the scheduled event — except a 429, which ends the whole run
 * immediately (Discord's own back-off signal), and a 403/404 on a channel,
 * which flips that channel's `archivable` to 0 and moves on. Cursors only
 * ever advance after the page behind them is committed, so a run that fails,
 * gets rate-limited, or exhausts its budget always leaves consistent state.
 */
export async function runArchive(
	c: CronContext<AppEnv>,
	now: Date = new Date(),
	budget: number = ARCHIVE_REST_BUDGET,
): Promise<void> {
	const guildId = c.env.ARCHIVE_GUILD_ID;
	if (!guildId) {
		console.warn("[archive] ARCHIVE_GUILD_ID is empty — skipping (safe no-op)");
		return;
	}

	const db = c.env.DB;
	const rest = createDiscordRest(discordToken(c.env), budget);
	const nowIso = now.toISOString();

	try {
		await refreshChannels(rest, db, guildId, nowIso);
	} catch (err) {
		if (err instanceof RateLimitedError) {
			console.error(
				`[archive] rate limited during channel refresh (retry_after=${err.retryAfterSeconds}s) — ending run`,
			);
			return;
		}
		console.error(
			"[archive] channel/thread refresh failed — continuing with previously known channels",
			err,
		);
	}

	let channels: ArchiveChannelRow[];
	try {
		channels = await stalestChannels(db, guildId);
	} catch (err) {
		console.error(
			"[archive] failed to load channel cursors — aborting run",
			err,
		);
		return;
	}

	for (const channel of channels) {
		if (rest.exhausted()) {
			console.log(`[archive] REST budget (${budget}) exhausted — stopping run`);
			break;
		}
		try {
			await processChannel(rest, db, channel, nowIso);
		} catch (err) {
			if (err instanceof RateLimitedError) {
				console.error(
					`[archive] rate limited (retry_after=${err.retryAfterSeconds}s) — ending run early`,
				);
				return;
			}
			if (err instanceof ChannelUnavailableError) {
				await markUnarchivable(db, channel.channel_id, nowIso);
				console.error(
					`[archive] channel ${channel.channel_id} unavailable (HTTP ${err.status}) — marked archivable=0`,
				);
				continue;
			}
			console.error(`[archive] channel ${channel.channel_id} failed`, err);
		}
	}
}
