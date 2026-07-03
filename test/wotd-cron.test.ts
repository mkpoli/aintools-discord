import { afterEach, describe, expect, test } from "bun:test";
import type { CronContext } from "discord-hono";
import { createRest } from "discord-hono";
import { runWotd } from "../src/cron/wotd.js";
import type { AppEnv } from "../src/lib/errors.js";

const CORPUS_URL = "https://corpus.aynu.org";
const GLOSSARY_URL = "https://itak.aynu.org/api/gdoc";
const CHANNEL_ID = "channel-123";
const NOW = new Date("2026-07-03T10:00:00Z"); // 2026-07-03 JST

// --- Minimal in-memory D1 stub, mirroring the wotd_history schema. --------

interface HistoryRow {
	date: string;
	token: string;
	posted: number;
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

	async first<T>(): Promise<T | null> {
		if (
			this.#query.includes("SELECT posted FROM wotd_history WHERE date = ?")
		) {
			const [date] = this.#args as [string];
			const row = this.#db.rows.get(date);
			return (row ? { posted: row.posted } : null) as T | null;
		}
		throw new Error(`FakeStatement.first: unsupported query: ${this.#query}`);
	}

	async all<T>(): Promise<{ results: T[] }> {
		if (
			this.#query.includes("SELECT token FROM wotd_history WHERE date >= ?")
		) {
			const [since] = this.#args as [string];
			const results = [...this.#db.rows.values()]
				.filter((r) => r.date >= since)
				.map((r) => ({ token: r.token }));
			return { results: results as T[] };
		}
		throw new Error(`FakeStatement.all: unsupported query: ${this.#query}`);
	}

	async run() {
		if (this.#query.includes("INSERT INTO wotd_history")) {
			const [date, token] = this.#args as [string, string];
			this.#db.rows.set(date, { date, token, posted: 1 });
			return { success: true, meta: {} };
		}
		throw new Error(`FakeStatement.run: unsupported query: ${this.#query}`);
	}
}

class FakeD1 {
	rows = new Map<string, HistoryRow>();
	prepare(query: string) {
		return new FakeStatement(query, this);
	}
}

class MemoryKV {
	#store = new Map<string, string>();
	async get(key: string, type?: "json" | "text"): Promise<unknown> {
		const raw = this.#store.get(key);
		if (raw === undefined) return null;
		return type === "json" ? JSON.parse(raw) : raw;
	}
	async put(key: string, value: string): Promise<void> {
		this.#store.set(key, value);
	}
}

function makeEnv(db: FakeD1, kv: MemoryKV, channelId = CHANNEL_ID): Env {
	return {
		DB: db,
		KV: kv,
		CORPUS_API_URL: CORPUS_URL,
		GLOSSARY_API_URL: GLOSSARY_URL,
		WOTD_CHANNEL_ID: channelId,
	} as unknown as Env;
}

function makeExecutionCtx() {
	const tasks: Promise<unknown>[] = [];
	return {
		waitUntil(p: Promise<unknown>) {
			tasks.push(p);
		},
		passThroughOnException() {},
		settle: () => Promise.allSettled(tasks),
	};
}

function makeContext(env: Env): {
	c: CronContext<AppEnv>;
	settle: () => Promise<unknown>;
} {
	const { settle, ...ctx } = makeExecutionCtx();
	// DISCORD_TOKEN is a secret (not part of the generated `Env` vars type) —
	// its value is irrelevant here since `globalThis.fetch` is stubbed below.
	const c = {
		env,
		executionCtx: ctx,
		rest: createRest("test-token"),
	} as unknown as CronContext<AppEnv>;
	return { c, settle };
}

const freqRow = (token: string, count: number) => ({
	token,
	count,
	is_stopword: 0,
});

const FREQ_ROWS = [
	freqRow("e", 900), // filtered: too short
	freqRow("kamuy", 500),
	freqRow("utar", 400),
	freqRow("sinep", 300),
];

const GLOSSARY_TABLE = [
	{ Aynu: "utar", 日本語: "人々", English: "people", sheetName: "core" },
];

let discordPosts: unknown[] = [];
let discordShouldFail = false;
const originalFetch = globalThis.fetch;

function stubFetch() {
	discordPosts = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.startsWith(`${CORPUS_URL}/v1/freq/list`)) {
			return new Response(
				JSON.stringify({ api_version: "1", data: FREQ_ROWS }),
			);
		}
		if (url.startsWith(`${CORPUS_URL}/v1/search`)) {
			return new Response(
				JSON.stringify({
					api_version: "1",
					data: [
						{
							id: "s1",
							text: "utar okay.",
							translation: "people are there.",
							dialect: "沙流",
							author: null,
							collection: null,
							document: "doc1",
							uri: null,
						},
					],
				}),
			);
		}
		if (url === GLOSSARY_URL) {
			return new Response(
				JSON.stringify({ table: GLOSSARY_TABLE, sheets: [] }),
			);
		}
		if (url.startsWith("https://discord.com/api")) {
			discordPosts.push(init?.body ? JSON.parse(String(init.body)) : undefined);
			return discordShouldFail
				? new Response("forbidden", { status: 403 })
				: new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
		}
		throw new Error(`unexpected fetch to ${url}`);
	}) as unknown as typeof fetch;
}

describe("runWotd", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
		discordShouldFail = false;
	});

	test("empty WOTD_CHANNEL_ID: safe no-op, no upstream calls at all", async () => {
		stubFetch();
		const db = new FakeD1();
		const { c, settle } = makeContext(makeEnv(db, new MemoryKV(), ""));

		await runWotd(c, NOW);
		await settle();

		expect(discordPosts).toHaveLength(0);
		expect(db.rows.size).toBe(0);
	});

	test("happy path: picks a candidate, posts once, and writes a posted=1 history row", async () => {
		stubFetch();
		const db = new FakeD1();
		const { c, settle } = makeContext(makeEnv(db, new MemoryKV()));

		await runWotd(c, NOW);
		await settle();

		expect(discordPosts).toHaveLength(1);
		const embed = (discordPosts[0] as { embeds: { title: string }[] })
			.embeds[0];
		expect(embed.title).toContain("Word of the day");

		expect(db.rows.size).toBe(1);
		const row = [...db.rows.values()][0];
		expect(row.posted).toBe(1);
		expect(["kamuy", "utar", "sinep"]).toContain(row.token);
	});

	test("rerun on the same JST day is a no-op (idempotent)", async () => {
		stubFetch();
		const db = new FakeD1();
		const kv = new MemoryKV();

		const first = makeContext(makeEnv(db, kv));
		await runWotd(first.c, NOW);
		await first.settle();
		expect(discordPosts).toHaveLength(1);

		const second = makeContext(makeEnv(db, kv));
		await runWotd(second.c, NOW);
		await second.settle();

		// No additional Discord post on the second run.
		expect(discordPosts).toHaveLength(1);
		expect(db.rows.size).toBe(1);
	});

	test("upstream freq/list failure: caught, logged, no history row written", async () => {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.startsWith(`${CORPUS_URL}/v1/freq/list`)) {
				return new Response("boom", { status: 500 });
			}
			throw new Error(`unexpected fetch to ${url}`);
		}) as unknown as typeof fetch;

		const db = new FakeD1();
		const { c, settle } = makeContext(makeEnv(db, new MemoryKV()));

		await runWotd(c, NOW);
		await settle();

		expect(db.rows.size).toBe(0);
	});

	test("Discord post failure (non-2xx): no history row written, safe to retry", async () => {
		discordShouldFail = true;
		stubFetch(); // resets discordPosts only — discordShouldFail stays true
		const db = new FakeD1();
		const { c, settle } = makeContext(makeEnv(db, new MemoryKV()));

		await runWotd(c, NOW);
		await settle();

		expect(discordPosts).toHaveLength(1); // attempted
		expect(db.rows.size).toBe(0); // but never recorded as posted
	});
});
