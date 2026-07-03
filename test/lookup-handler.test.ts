import { afterEach, describe, expect, test } from "bun:test";
import {
	DiscordHono,
	testCommandRequestInit,
	testVerifyTrue,
} from "discord-hono";
import { commands } from "../src/commands.js";
import { lookupHandler } from "../src/handlers/lookup.js";
import { type AppEnv, safeHandler } from "../src/lib/errors.js";

// Full in-process interaction round trip (see corpus-handler.test.ts /
// analyze-handler.test.ts for the established pattern): signs (via
// testVerifyTrue) → dispatches → resDefer ack → deferred followup, all
// offline (fetch is stubbed for itak/mdb/corpus.aynu.org and the Discord
// webhook followup call; KV is an in-memory stand-in).
const lookupCommand = commands.find((c) => c.toJSON().name === "lookup");
if (!lookupCommand)
	throw new Error("lookup command missing from src/commands.ts");

/** Minimal in-memory stand-in for the KV binding used by getGlossary(). */
class MemoryKV {
	#store = new Map<string, string>();
	async get(key: string, type?: string) {
		const raw = this.#store.get(key);
		if (raw === undefined) return null;
		return type === "json" ? JSON.parse(raw) : raw;
	}
	async put(key: string, value: string) {
		this.#store.set(key, value);
	}
}

function testApp() {
	const app = new DiscordHono<AppEnv>({ verify: testVerifyTrue });
	app.command("lookup", safeHandler(lookupHandler));
	return app;
}

function testEnv(kv: MemoryKV = new MemoryKV()): Env {
	return {
		DISCORD_APPLICATION_ID: "1",
		DISCORD_PUBLIC_KEY: "00".repeat(32),
		DISCORD_TOKEN: "test-token",
		CORPUS_API_URL: "https://corpus.aynu.org",
		MDB_API_URL: "https://mdb.aynu.org",
		GLOSSARY_API_URL: "https://itak.aynu.org/api/gdoc",
		KV: kv,
	} as unknown as Env;
}

/** Captures every `waitUntil`-ed promise so the test can await the deferred work. */
function capturingExecutionCtx() {
	const pending: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: (p: Promise<unknown>) => {
			pending.push(p);
		},
		passThroughOnException: () => {},
	} as unknown as ExecutionContext;
	return { ctx, settle: () => Promise.allSettled(pending) };
}

const originalFetch = globalThis.fetch;
let lastFollowupBody: unknown;

const GLOSSARY_FIXTURE = {
	table: [{ Aynu: "kamuy", 日本語: "神", English: "god", sheetName: "nouns" }],
	sheets: [],
};

const DECOMPOSE_FIXTURE = {
	form: "kamuy",
	fallback_used: true,
	mode: "flat",
	source: "segmented",
	unseen: false,
	arity: 0,
	tokens: ["kamuy"],
	unresolved: [],
	warnings: [],
	decomposition: [
		{ surface: "kamuy", kind: "head", isLeaf: true, arity: 0, morpheme: null },
	],
};

const CORPUS_FIXTURE = [
	{
		id: "a#1",
		text: "kamuy",
		translation: "god",
		dialect: "沙流",
		author: null,
		collection: null,
		document: null,
		uri: null,
	},
];

type StubResponses = {
	glossary?: () => Response;
	mdb?: () => Response;
	corpus?: () => Response;
};

function stubFetch(responses: StubResponses) {
	lastFollowupBody = undefined;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.startsWith("https://itak.aynu.org")) {
			return responses.glossary
				? responses.glossary()
				: new Response(JSON.stringify(GLOSSARY_FIXTURE));
		}
		if (url.startsWith("https://mdb.aynu.org")) {
			return responses.mdb
				? responses.mdb()
				: new Response(JSON.stringify(DECOMPOSE_FIXTURE));
		}
		if (url.startsWith("https://corpus.aynu.org")) {
			return responses.corpus
				? responses.corpus()
				: new Response(
						JSON.stringify({ api_version: "1", data: CORPUS_FIXTURE }),
					);
		}
		if (url.startsWith("https://discord.com/api")) {
			lastFollowupBody = init?.body ? JSON.parse(String(init.body)) : undefined;
			return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
		}
		throw new Error(`unexpected fetch to ${url}`);
	}) as unknown as typeof fetch;
}

describe("/lookup handler (in-process, discord-hono test helpers)", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("happy path: all 4 sections render, footer attributes the sources used", async () => {
		stubFetch({});

		const init = testCommandRequestInit(lookupCommand, { word: "kamuy" });
		const { ctx, settle } = capturingExecutionCtx();
		const res = await testApp().fetch(
			new Request("https://bot.test/", init),
			testEnv(),
			ctx,
		);
		const ack = await res.json();
		expect(ack).toMatchObject({ type: 5 });

		await settle();
		expect(lastFollowupBody).toBeDefined();
		const body = lastFollowupBody as {
			embeds: {
				title: string;
				footer?: { text: string };
				fields: { name: string; value: string }[];
			}[];
		};
		expect(body.embeds[0].title).toContain("kamuy");
		expect(body.embeds[0].fields).toHaveLength(4);
		expect(body.embeds[0].fields[0].name).toBe("📖 Glossary");
		expect(body.embeds[0].fields[0].value).toContain("god");
		expect(body.embeds[0].fields[1].name).toBe("🧩 Morphemes");
		expect(body.embeds[0].fields[1].value).toContain("⚠ heuristic");
		expect(body.embeds[0].fields[2].name).toBe("📚 Corpus examples");
		expect(body.embeds[0].fields[2].value).toContain("god");
		expect(body.embeds[0].fields[3].name).toBe("🔤 Scripts");
		expect(body.embeds[0].footer?.text).toBe(
			"itak.aynu.org · mdb.aynu.org · corpus.aynu.org",
		);
	});

	test("one source down: its field reads (unavailable), the rest still render", async () => {
		stubFetch({
			corpus: () => new Response("boom", { status: 500 }),
		});

		const init = testCommandRequestInit(lookupCommand, { word: "kamuy" });
		const { ctx, settle } = capturingExecutionCtx();
		await testApp().fetch(
			new Request("https://bot.test/", init),
			testEnv(),
			ctx,
		);
		await settle();

		const body = lastFollowupBody as {
			embeds: { fields: { name: string; value: string }[] }[];
		};
		const corpusField = body.embeds[0].fields.find(
			(f) => f.name === "📚 Corpus examples",
		);
		expect(corpusField?.value).toBe("(unavailable)");
		const glossaryField = body.embeds[0].fields.find(
			(f) => f.name === "📖 Glossary",
		);
		expect(glossaryField?.value).toContain("god");
	});

	test("all sources empty: friendly nothing-found embed instead of 4 placeholder fields", async () => {
		stubFetch({
			glossary: () => new Response(JSON.stringify({ table: [], sheets: [] })),
			mdb: () => new Response("boom", { status: 500 }),
			corpus: () =>
				new Response(JSON.stringify({ api_version: "1", data: [] })),
		});

		const init = testCommandRequestInit(lookupCommand, {
			word: "zzznomatchzzz",
		});
		const { ctx, settle } = capturingExecutionCtx();
		await testApp().fetch(
			new Request("https://bot.test/", init),
			testEnv(),
			ctx,
		);
		await settle();

		const body = lastFollowupBody as {
			embeds: { title: string; description: string }[];
		};
		expect(body.embeds[0].title).toBe("No results");
		expect(body.embeds[0].description).toContain("/corpus lang:any");
	});

	test("odd input the script service can't detect: scripts section degrades, others still query it verbatim", async () => {
		stubFetch({});

		const init = testCommandRequestInit(lookupCommand, { word: "123" });
		const { ctx, settle } = capturingExecutionCtx();
		await testApp().fetch(
			new Request("https://bot.test/", init),
			testEnv(),
			ctx,
		);
		await settle();

		const body = lastFollowupBody as {
			embeds: { fields: { name: string; value: string }[] }[];
		};
		const scriptsField = body.embeds[0].fields.find(
			(f) => f.name === "🔤 Scripts",
		);
		expect(scriptsField?.value).toBe("(unavailable)");
	});
});
