import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getGlossary } from "../src/services/glossary.js";

const GLOSSARY_URL = "https://itak.aynu.org/api/gdoc";
const STALE_AFTER_MS = 86400 * 1000;
const KV_KEY = "glossary:v1";

class MemoryKV {
	#store = new Map<string, string>();
	get(key: string, type?: "text"): Promise<string | null>;
	get<T = unknown>(key: string, type: "json"): Promise<T | null>;
	async get(key: string, type?: "json" | "text"): Promise<unknown> {
		const raw = this.#store.get(key);
		if (raw === undefined) return null;
		return type === "json" ? JSON.parse(raw) : raw;
	}
	async put(key: string, value: string): Promise<void> {
		this.#store.set(key, value);
	}
}

function makeEnv(kv: MemoryKV): Env {
	return {
		KV: kv,
		GLOSSARY_API_URL: GLOSSARY_URL,
	} as unknown as Env;
}

function makeExecutionCtx() {
	const tasks: Promise<unknown>[] = [];
	const ctx = {
		waitUntil(p: Promise<unknown>) {
			tasks.push(p);
		},
		passThroughOnException() {},
	};
	return { ctx, settle: () => Promise.allSettled(tasks) };
}

function seed(kv: MemoryKV, fetchedAt: number, table: unknown) {
	return kv.put(KV_KEY, JSON.stringify({ fetchedAt, table }));
}

function fetchReturning(table: unknown) {
	return mock(
		async () =>
			new Response(JSON.stringify({ table, sheets: [] }), { status: 200 }),
	);
}

describe("getGlossary (KV stale-while-revalidate)", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("cold miss: fetches, stores in KV, and serves the table", async () => {
		const fetchMock = fetchReturning([{ Aynu: "sinep", sheetName: "x" }]);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const kv = new MemoryKV();
		const { ctx } = makeExecutionCtx();
		const table = await getGlossary(makeEnv(kv), ctx);

		expect(table).toEqual([{ Aynu: "sinep", sheetName: "x" }]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(await kv.get(KV_KEY, "json")).not.toBeNull();
	});

	test("fresh cache hit: serves from KV without refetching", async () => {
		const fetchMock = fetchReturning([
			{ Aynu: "should-not-be-served", sheetName: "x" },
		]);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const kv = new MemoryKV();
		await seed(kv, Date.now(), [{ Aynu: "cached", sheetName: "x" }]);

		const { ctx, settle } = makeExecutionCtx();
		const table = await getGlossary(makeEnv(kv), ctx);
		await settle();

		expect(table).toEqual([{ Aynu: "cached", sheetName: "x" }]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("stale cache: resolves with the stale copy before the background refresh's fetch settles", async () => {
		let resolveFetch!: (res: Response) => void;
		const pending = new Promise<Response>((resolve) => {
			resolveFetch = resolve;
		});
		const fetchMock = mock(() => pending);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const kv = new MemoryKV();
		await seed(kv, Date.now() - STALE_AFTER_MS - 1000, [
			{ Aynu: "stale", sheetName: "x" },
		]);

		const { ctx, settle } = makeExecutionCtx();

		// getGlossary() must resolve here even though `pending` (the refresh's
		// own fetch) has not been resolved yet — proving the refresh runs via
		// executionCtx.waitUntil() rather than blocking the response.
		const table = await getGlossary(makeEnv(kv), ctx);
		expect(table).toEqual([{ Aynu: "stale", sheetName: "x" }]);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const midway = await kv.get<{ table: unknown }>(KV_KEY, "json");
		expect(midway?.table).toEqual([{ Aynu: "stale", sheetName: "x" }]);

		resolveFetch(
			new Response(
				JSON.stringify({
					table: [{ Aynu: "refreshed", sheetName: "x" }],
					sheets: [],
				}),
				{ status: 200 },
			),
		);
		await settle();

		const updated = await kv.get<{ table: unknown }>(KV_KEY, "json");
		expect(updated?.table).toEqual([{ Aynu: "refreshed", sheetName: "x" }]);
	});

	test("an itak.aynu.org outage during background refresh never throws and never disturbs the stale copy", async () => {
		globalThis.fetch = mock(
			async () => new Response("boom", { status: 500 }),
		) as unknown as typeof fetch;

		const kv = new MemoryKV();
		await seed(kv, Date.now() - STALE_AFTER_MS - 1000, [
			{ Aynu: "stale", sheetName: "x" },
		]);

		const { ctx, settle } = makeExecutionCtx();
		const table = await getGlossary(makeEnv(kv), ctx);
		expect(table).toEqual([{ Aynu: "stale", sheetName: "x" }]);

		await expect(settle()).resolves.toBeDefined();

		const afterFailedRefresh = await kv.get<{ table: unknown }>(KV_KEY, "json");
		expect(afterFailedRefresh?.table).toEqual([
			{ Aynu: "stale", sheetName: "x" },
		]);
	});
});
