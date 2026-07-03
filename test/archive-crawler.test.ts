import { afterEach, describe, expect, test } from "bun:test";
import type { CronContext } from "discord-hono";
import type { AppEnv } from "../src/lib/errors.js";
import {
	ChannelUnavailableError,
	createDiscordRest,
	type DiscordMessage,
	RateLimitedError,
	runArchive,
} from "../src/services/archive.js";

// --- Minimal in-memory D1 stub, mirroring archive_channels/archive_messages. -

interface ChannelRow {
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

class FakeStatement {
	#query: string;
	#db: FakeD1;
	#args: unknown[] = [];

	constructor(query: string, db: FakeD1) {
		this.#query = query;
		this.#db = db;
	}

	bind(...values: unknown[]) {
		this.#args = values;
		return this;
	}

	async run() {
		this.#db.exec(this.#query, this.#args);
		return { success: true, meta: {} };
	}

	async all<T>(): Promise<{ results: T[] }> {
		return { results: this.#db.execAll(this.#query, this.#args) as T[] };
	}

	async first<T>(): Promise<T | null> {
		const [row] = this.#db.execAll(this.#query, this.#args);
		return (row ?? null) as T | null;
	}
}

class FakeD1 {
	channels = new Map<string, ChannelRow>();
	messages = new Map<string, Record<string, unknown>>();

	prepare(query: string) {
		return new FakeStatement(query, this);
	}

	async batch(statements: FakeStatement[]) {
		const out = [];
		for (const s of statements) out.push(await s.run());
		return out;
	}

	exec(query: string, args: unknown[]): void {
		if (query.includes("INSERT INTO archive_channels")) {
			const [
				channelId,
				guildId,
				name,
				type,
				parentId,
				isThread,
				backfillDone,
				updatedAt,
			] = args as [
				string,
				string,
				string | null,
				number,
				string | null,
				number,
				number,
				string,
			];
			const existing = this.channels.get(channelId);
			if (existing) {
				this.channels.set(channelId, {
					...existing,
					name,
					type,
					parent_id: parentId,
					updated_at: updatedAt,
				});
			} else {
				this.channels.set(channelId, {
					channel_id: channelId,
					guild_id: guildId,
					name,
					type,
					parent_id: parentId,
					is_thread: isThread,
					last_message_id: null,
					backfill_before_id: null,
					backfill_done: backfillDone,
					archivable: 1,
					updated_at: updatedAt,
				});
			}
			return;
		}
		if (query.includes("last_message_id = COALESCE")) {
			const [
				lastMessageId,
				backfillBeforeId,
				backfillDone,
				updatedAt,
				channelId,
			] = args as [string | null, string | null, number | null, string, string];
			const ch = this.channels.get(channelId);
			if (!ch) throw new Error(`FakeD1: no channel ${channelId}`);
			this.channels.set(channelId, {
				...ch,
				last_message_id: lastMessageId ?? ch.last_message_id,
				backfill_before_id: backfillBeforeId ?? ch.backfill_before_id,
				backfill_done: backfillDone ?? ch.backfill_done,
				updated_at: updatedAt,
			});
			return;
		}
		if (query.includes("UPDATE archive_channels SET archivable = 0")) {
			const [updatedAt, channelId] = args as [string, string];
			const ch = this.channels.get(channelId);
			if (ch)
				this.channels.set(channelId, {
					...ch,
					archivable: 0,
					updated_at: updatedAt,
				});
			return;
		}
		if (query.includes("INSERT OR REPLACE INTO archive_messages")) {
			const [
				id,
				channelId,
				guildId,
				authorId,
				authorName,
				authorBot,
				type,
				content,
				createdAt,
				editedAt,
				replyToId,
				attachments,
				reactions,
				raw,
				source,
				archivedAt,
			] = args as [
				string,
				string,
				string,
				string | null,
				string | null,
				number,
				number | null,
				string | null,
				string,
				string | null,
				string | null,
				string | null,
				string | null,
				string,
				string,
				string,
			];
			this.messages.set(id, {
				id,
				channel_id: channelId,
				guild_id: guildId,
				author_id: authorId,
				author_name: authorName,
				author_bot: authorBot,
				type,
				content,
				created_at: createdAt,
				edited_at: editedAt,
				reply_to_id: replyToId,
				attachments,
				reactions,
				raw,
				source,
				archived_at: archivedAt,
			});
			return;
		}
		throw new Error(`FakeD1.exec: unsupported query: ${query}`);
	}

	execAll(query: string, args: unknown[]): unknown[] {
		if (query.includes("SELECT * FROM archive_channels WHERE guild_id")) {
			const [guildId] = args as [string];
			// Mirrors the real query's `ORDER BY updated_at ASC` (NULL first),
			// with a stable sort so same-timestamp ties keep insertion order —
			// same tie-breaking SQLite gives in practice.
			return [...this.channels.values()]
				.filter((c) => c.guild_id === guildId && c.archivable === 1)
				.sort((a, b) => {
					if (a.updated_at === b.updated_at) return 0;
					if (a.updated_at === null) return -1;
					if (b.updated_at === null) return 1;
					return a.updated_at < b.updated_at ? -1 : 1;
				});
		}
		throw new Error(`FakeD1.execAll: unsupported query: ${query}`);
	}
}

function makeContext(
	db: FakeD1,
	guildId = "g1",
	token = "t",
): CronContext<AppEnv> {
	return {
		env: {
			DB: db,
			ARCHIVE_GUILD_ID: guildId,
			DISCORD_TOKEN: token,
		},
	} as unknown as CronContext<AppEnv>;
}

// --- Scripted fetch: a strict, ordered queue of expected requests. ---------

interface Step {
	match: (url: URL) => boolean;
	respond: () => Response;
	label: string;
}

const originalFetch = globalThis.fetch;

function scriptedFetch(steps: Step[]) {
	let i = 0;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		if (i >= steps.length) {
			throw new Error(`unexpected extra fetch (#${i}): ${url}`);
		}
		const step = steps[i];
		if (!step.match(url)) {
			throw new Error(`fetch #${i} (${step.label}) did not match url: ${url}`);
		}
		i++;
		return step.respond();
	}) as unknown as typeof fetch;
	return () => i; // number of calls actually consumed
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function channelsStep(guildId: string, channels: unknown[]): Step {
	return {
		label: "channels list",
		match: (u) => u.pathname === `/api/v10/guilds/${guildId}/channels`,
		respond: () => json(channels),
	};
}

function activeThreadsStep(guildId: string, threads: unknown[] = []): Step {
	return {
		label: "active threads",
		match: (u) => u.pathname === `/api/v10/guilds/${guildId}/threads/active`,
		respond: () => json({ threads }),
	};
}

function messagesStep(
	channelId: string,
	cursor: { after?: string; before?: string },
	messages: DiscordMessage[],
	status = 200,
): Step {
	return {
		label: `messages(${channelId}, ${JSON.stringify(cursor)})`,
		match: (u) => {
			if (u.pathname !== `/api/v10/channels/${channelId}/messages`)
				return false;
			if (cursor.after !== undefined)
				return u.searchParams.get("after") === cursor.after;
			if (cursor.before !== undefined)
				return u.searchParams.get("before") === cursor.before;
			return !u.searchParams.has("after") && !u.searchParams.has("before");
		},
		respond: () =>
			json(status === 200 ? messages : { message: "error" }, status),
	};
}

function archivedThreadsStep(channelId: string, threads: unknown[] = []): Step {
	return {
		label: `archived threads(${channelId})`,
		match: (u) =>
			u.pathname === `/api/v10/channels/${channelId}/threads/archived/public`,
		respond: () => json({ threads }),
	};
}

function msg(id: string): DiscordMessage {
	return {
		id,
		type: 0,
		content: `content ${id}`,
		timestamp: "2026-07-03T00:00:00.000Z",
		author: { id: "u1", username: "someone", bot: false },
	};
}

describe("runArchive", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("empty ARCHIVE_GUILD_ID: safe no-op, no fetch calls at all", async () => {
		scriptedFetch([]);
		const db = new FakeD1();
		await runArchive(makeContext(db, ""));
		expect(db.channels.size).toBe(0);
	});

	test("seed-from-first-page: a brand new channel seeds both cursors from one fetch, and (budget-permitting) starts backfilling from it", async () => {
		scriptedFetch([
			channelsStep("g1", [{ id: "c1", type: 0, name: "general" }]),
			activeThreadsStep("g1"),
			messagesStep("c1", {}, [msg("500"), msg("480")]), // seed page (unsorted)
			messagesStep("c1", { before: "480" }, []), // backfill pass: already at channel start
			archivedThreadsStep("c1"), // backfill just finished → one-time sweep
		]);
		const db = new FakeD1();

		await runArchive(makeContext(db), new Date("2026-07-03T00:00:00.000Z"));

		const c1 = db.channels.get("c1");
		expect(c1?.last_message_id).toBe("500");
		expect(c1?.backfill_before_id).toBe("480");
		expect(c1?.backfill_done).toBe(1);
		expect(db.messages.size).toBe(2);
	});

	test("after/before pagination converges over successive runs; an empty `before` page flips backfill_done", async () => {
		const db = new FakeD1();

		// Run 1: seed (500, 480), then backfill(before=480) → one more page (460).
		scriptedFetch([
			channelsStep("g1", [{ id: "c1", type: 0, name: "general" }]),
			activeThreadsStep("g1"),
			messagesStep("c1", {}, [msg("500"), msg("480")]),
			messagesStep("c1", { before: "480" }, [msg("460")]),
		]);
		await runArchive(makeContext(db), new Date("2026-07-03T00:00:00.000Z"));
		expect(db.channels.get("c1")).toMatchObject({
			last_message_id: "500",
			backfill_before_id: "460",
			backfill_done: 0,
		});

		// Run 2 (10 min later): incremental after=500 → (520, 510); backfill before=460 → (440).
		scriptedFetch([
			channelsStep("g1", [{ id: "c1", type: 0, name: "general" }]),
			activeThreadsStep("g1"),
			messagesStep("c1", { after: "500" }, [msg("520"), msg("510")]),
			messagesStep("c1", { before: "460" }, [msg("440")]),
		]);
		await runArchive(makeContext(db), new Date("2026-07-03T00:10:00.000Z"));
		expect(db.channels.get("c1")).toMatchObject({
			last_message_id: "520",
			backfill_before_id: "440",
			backfill_done: 0,
		});

		// Run 3: incremental after=520 → empty (caught up); backfill before=440 → empty
		// (reached channel start) → backfill_done flips, one-time archived-thread sweep fires.
		scriptedFetch([
			channelsStep("g1", [{ id: "c1", type: 0, name: "general" }]),
			activeThreadsStep("g1"),
			messagesStep("c1", { after: "520" }, []),
			messagesStep("c1", { before: "440" }, []),
			archivedThreadsStep("c1"),
		]);
		await runArchive(makeContext(db), new Date("2026-07-03T00:20:00.000Z"));
		expect(db.channels.get("c1")).toMatchObject({
			last_message_id: "520",
			backfill_before_id: "440",
			backfill_done: 1,
		});

		expect(db.messages.size).toBe(6);
		expect([...db.messages.keys()].sort()).toEqual(
			["440", "460", "480", "500", "510", "520"].sort(),
		);
	});

	test("budget exhaustion mid-run leaves every cursor consistent (never partially written)", async () => {
		scriptedFetch([
			channelsStep("g1", [
				{ id: "c1", type: 0, name: "first" },
				{ id: "c2", type: 0, name: "second" },
			]),
			activeThreadsStep("g1"),
			messagesStep("c1", {}, [msg("300"), msg("250")]), // seed
			messagesStep("c1", { before: "250" }, [msg("100")]), // backfill (not empty ⇒ not done)
			// budget is exhausted right here — c2 must never be fetched at all.
		]);
		const db = new FakeD1();

		// 2 (refresh) + 1 (c1 seed) + 1 (c1 backfill) = 4; c2 never gets a turn.
		await runArchive(makeContext(db), new Date("2026-07-03T00:00:00.000Z"), 4);

		expect(db.channels.get("c1")).toMatchObject({
			last_message_id: "300",
			backfill_before_id: "100",
			backfill_done: 0,
		});
		// c2 was upserted by refresh (descriptive columns only) but never
		// touched by the round robin — its cursors are still untouched nulls.
		expect(db.channels.get("c2")).toMatchObject({
			last_message_id: null,
			backfill_before_id: null,
			backfill_done: 0,
			archivable: 1,
		});
		expect(db.messages.size).toBe(3);
	});

	test("403 on a channel marks it archivable=0 and the run continues cleanly", async () => {
		scriptedFetch([
			channelsStep("g1", [{ id: "c1", type: 0, name: "general" }]),
			activeThreadsStep("g1"),
			messagesStep("c1", {}, [], 403),
		]);
		const db = new FakeD1();

		await runArchive(makeContext(db), new Date("2026-07-03T00:00:00.000Z"));

		expect(db.channels.get("c1")?.archivable).toBe(0);
		expect(db.messages.size).toBe(0);
	});

	test("a forum/media container channel never calls the messages endpoint — only the occasional thread sweep", async () => {
		scriptedFetch([
			channelsStep("g1", [{ id: "f1", type: 15, name: "qa-forum" }]),
			activeThreadsStep("g1"),
			archivedThreadsStep("f1", [
				{ id: "t1", type: 11, name: "post-1", parent_id: "f1" },
			]),
		]);
		const db = new FakeD1();

		await runArchive(makeContext(db), new Date("2026-07-03T00:00:00.000Z"));

		const forum = db.channels.get("f1");
		expect(forum?.backfill_done).toBe(1); // pre-set at insert — no messages of its own
		expect(forum?.last_message_id).toBeNull();
		const thread = db.channels.get("t1");
		expect(thread).toMatchObject({ is_thread: 1, parent_id: "f1" });
	});

	test("429 during a channel fetch ends the run immediately (no further calls)", async () => {
		const callsMade = scriptedFetch([
			channelsStep("g1", [{ id: "c1", type: 0, name: "general" }]),
			activeThreadsStep("g1"),
			{
				label: "rate limited",
				match: (u) => u.pathname === "/api/v10/channels/c1/messages",
				respond: () => json({ retry_after: 2.5 }, 429),
			},
		]);
		const db = new FakeD1();

		await runArchive(makeContext(db), new Date("2026-07-03T00:00:00.000Z"));

		expect(callsMade()).toBe(3); // never went on to fetch anything else
		expect(db.channels.get("c1")?.last_message_id).toBeNull();
		expect(db.channels.get("c1")?.archivable).toBe(1); // 429 isn't a 403 — stays archivable
	});
});

describe("createDiscordRest", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("counts calls and reports exhausted() once the limit is hit", async () => {
		globalThis.fetch = (async () => json([])) as unknown as typeof fetch;
		const rest = createDiscordRest("tok", 2);
		expect(rest.exhausted()).toBe(false);
		await rest.get("/a");
		expect(rest.exhausted()).toBe(false);
		await rest.get("/b");
		expect(rest.exhausted()).toBe(true);
		expect(rest.calls).toBe(2);
	});

	test("classifies 429 as RateLimitedError with retry_after, 403/404 as ChannelUnavailableError", async () => {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/rl")) return json({ retry_after: 7 }, 429);
			if (url.endsWith("/forbidden")) return json({}, 403);
			if (url.endsWith("/missing")) return json({}, 404);
			return json({ ok: true });
		}) as unknown as typeof fetch;
		const rest = createDiscordRest("tok", 10);

		await expect(rest.get("/rl")).rejects.toThrow(RateLimitedError);
		try {
			await rest.get("/rl");
		} catch (err) {
			expect((err as RateLimitedError).retryAfterSeconds).toBe(7);
		}
		await expect(rest.get("/forbidden")).rejects.toThrow(
			ChannelUnavailableError,
		);
		await expect(rest.get("/missing")).rejects.toThrow(ChannelUnavailableError);
	});
});
