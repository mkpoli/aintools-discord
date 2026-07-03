import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	DiscordHono,
	testCommandRequestInit,
	testVerifyTrue,
} from "discord-hono";
import { commands } from "../src/commands.js";
import { askHandler } from "../src/handlers/ask.js";
import { type AppEnv, safeHandler } from "../src/lib/errors.js";

// Full in-process interaction round trip: signs (via testVerifyTrue, discord-hono's
// bundled test bypass) → dispatches → cooldown check → resDefer ack → retrieval →
// model call → deferred followup, all offline (fetch is stubbed for corpus.aynu.org,
// itak.aynu.org, mdb.aynu.org, and the Discord webhook followup call; env.AI.run is
// a mock — the real Workers AI binding is never called, per the PR's hard rule).
const askCommand = commands.find((c) => c.toJSON().name === "ask");
if (!askCommand) throw new Error("ask command missing from src/commands.ts");

function testApp() {
	const app = new DiscordHono<AppEnv>({ verify: testVerifyTrue });
	app.command("ask", safeHandler(askHandler));
	return app;
}

/** Minimal in-memory stand-in for the KV binding used by cooldown + glossary cache. */
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

function testEnv(opts: {
	kv?: MemoryKV;
	aiRun?: ReturnType<typeof mock>;
	gatewayId?: string;
}): Env {
	return {
		DISCORD_APPLICATION_ID: "1",
		DISCORD_PUBLIC_KEY: "00".repeat(32),
		DISCORD_TOKEN: "test-token",
		CORPUS_API_URL: "https://corpus.aynu.org",
		MDB_API_URL: "https://mdb.aynu.org",
		GLOSSARY_API_URL: "https://itak.aynu.org/api/gdoc",
		AI_GATEWAY_ID: opts.gatewayId ?? "",
		ASK_MODEL: "@cf/openai/gpt-oss-120b",
		ASK_COOLDOWN_SECONDS: "300",
		KV: opts.kv ?? new MemoryKV(),
		AI: {
			run: opts.aiRun ?? mock(async () => ({ output_text: "stub answer" })),
		},
	} as unknown as Env;
}

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

const emptyGlossary = { table: [], sheets: [] };

function stubFetch(routes: {
	corpus?: () => Response;
	glossary?: () => Response;
	mdb?: (url: URL) => Response;
}) {
	lastFollowupBody = undefined;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.startsWith("https://corpus.aynu.org")) {
			return (
				routes.corpus ??
				(() => new Response(JSON.stringify({ api_version: "1", data: [] })))
			)();
		}
		if (url.startsWith("https://itak.aynu.org")) {
			return (
				routes.glossary ?? (() => new Response(JSON.stringify(emptyGlossary)))
			)();
		}
		if (url.startsWith("https://mdb.aynu.org")) {
			return (
				routes.mdb ??
				(() =>
					new Response(
						JSON.stringify({
							form: "",
							fallback_used: true,
							mode: "flat",
							source: "segmented",
							unseen: true,
							arity: 0,
							tokens: [],
							unresolved: [],
							warnings: [],
							decomposition: [],
						}),
					))
			)(new URL(url));
		}
		if (url.startsWith("https://discord.com/api")) {
			lastFollowupBody = init?.body ? JSON.parse(String(init.body)) : undefined;
			return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
		}
		throw new Error(`unexpected fetch to ${url}`);
	}) as unknown as typeof fetch;
}

describe("/ask handler (in-process, discord-hono test helpers)", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("question over 300 characters: immediate ephemeral error, never defers, never calls fetch or the model", async () => {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			throw new Error(
				`unexpected fetch to ${String(input)} — should never defer`,
			);
		}) as unknown as typeof fetch;
		const aiRun = mock(async () => ({ output_text: "x" }));

		const init = testCommandRequestInit(askCommand, {
			question: "a".repeat(301),
		});
		const { ctx, settle } = capturingExecutionCtx();
		const res = await testApp().fetch(
			new Request("https://bot.test/", init),
			testEnv({ aiRun }),
			ctx,
		);
		const body = (await res.json()) as {
			type: number;
			data: { flags: number; content: string };
		};
		expect(body.type).toBe(4);
		expect(body.data.flags & 64).toBe(64);
		await settle();
		expect(aiRun).not.toHaveBeenCalled();
	});

	test("cooling down: immediate ephemeral wait message, never defers, never calls the model", async () => {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			throw new Error(
				`unexpected fetch to ${String(input)} — should never defer`,
			);
		}) as unknown as typeof fetch;
		const kv = new MemoryKV();
		await kv.put("ask:cooldown:unknown", String(Date.now()));
		const aiRun = mock(async () => ({ output_text: "x" }));

		const init = testCommandRequestInit(askCommand, { question: "kamuy?" });
		const { ctx, settle } = capturingExecutionCtx();
		const res = await testApp().fetch(
			new Request("https://bot.test/", init),
			testEnv({ kv, aiRun }),
			ctx,
		);
		const body = (await res.json()) as {
			type: number;
			data: { flags: number; content: string };
		};
		expect(body.type).toBe(4);
		expect(body.data.flags & 64).toBe(64);
		expect(body.data.content).toContain("⏳");
		await settle();
		expect(aiRun).not.toHaveBeenCalled();
	});

	test("empty retrieval (no extractable tokens, zero corpus rows): skips the model, follows up with a no-sources embed", async () => {
		stubFetch({}); // corpus/glossary/mdb all empty by default
		const aiRun = mock(async () => ({ output_text: "should not be called" }));

		// Pure Japanese kana — the Latin-only token regex extracts nothing, and
		// the stubbed corpus search returns zero rows.
		const init = testCommandRequestInit(askCommand, {
			question: "カムイってなんですか",
		});
		const { ctx, settle } = capturingExecutionCtx();
		const res = await testApp().fetch(
			new Request("https://bot.test/", init),
			testEnv({ aiRun }),
			ctx,
		);
		expect(((await res.json()) as { type: number }).type).toBe(5); // deferred

		await settle();
		expect(aiRun).not.toHaveBeenCalled();
		const body = lastFollowupBody as { embeds: { description: string }[] };
		expect(body.embeds[0].description).toContain("見つかりませんでした");
	});

	test("happy path: retrieves sources, calls the model once, follows up with a draft-labeled, sourced embed", async () => {
		stubFetch({
			corpus: () =>
				new Response(
					JSON.stringify({
						api_version: "1",
						data: [
							{
								id: "c1",
								text: "kamuy anak ...",
								translation: "the god ...",
								dialect: "沙流",
								author: null,
								collection: null,
								document: "doc-1",
								uri: null,
							},
						],
					}),
				),
			glossary: () =>
				new Response(
					JSON.stringify({
						table: [{ Aynu: "kamuy", English: "god", sheetName: "x" }],
						sheets: [],
					}),
				),
			mdb: () =>
				new Response(
					JSON.stringify({
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
							{
								surface: "kamuy",
								kind: "head",
								isLeaf: true,
								arity: 0,
								morpheme: null,
							},
						],
					}),
				),
		});
		const aiRun = mock(async () => ({
			output_text: "Kamuy means god. [G1][C1]",
		}));

		const init = testCommandRequestInit(askCommand, {
			question: "What does kamuy mean?",
		});
		const { ctx, settle } = capturingExecutionCtx();
		const res = await testApp().fetch(
			new Request("https://bot.test/", init),
			testEnv({ aiRun }),
			ctx,
		);
		expect(((await res.json()) as { type: number }).type).toBe(5); // deferred

		await settle();
		expect(aiRun).toHaveBeenCalledTimes(1);

		const body = lastFollowupBody as {
			embeds: {
				title: string;
				description: string;
				footer?: { text: string };
				fields: { name: string; value: string }[];
			}[];
		};
		const embed = body.embeds[0];
		expect(embed.title).toContain("機械生成の下書き");
		expect(embed.title).toContain("Machine-generated draft");
		expect(embed.description).toContain("Kamuy means god");
		expect(embed.footer?.text).toContain("Machine-generated draft");
		const sourcesField = embed.fields.find((f) => f.name === "Sources");
		expect(sourcesField?.value).toContain("G1");
		expect(sourcesField?.value).toContain("C1");
	});

	test("model failure: followup carries the short bilingual error text, never silence", async () => {
		stubFetch({
			corpus: () =>
				new Response(
					JSON.stringify({
						api_version: "1",
						data: [
							{
								id: "c1",
								text: "kamuy anak ...",
								translation: "the god ...",
								dialect: null,
								author: null,
								collection: null,
								document: null,
								uri: null,
							},
						],
					}),
				),
		});
		const aiRun = mock(async () => {
			throw new Error("upstream boom");
		});

		const init = testCommandRequestInit(askCommand, {
			question: "What does kamuy mean?",
		});
		const { ctx, settle } = capturingExecutionCtx();
		await testApp().fetch(
			new Request("https://bot.test/", init),
			testEnv({ aiRun }),
			ctx,
		);
		await settle();

		const body = lastFollowupBody as { content: string };
		expect(body.content).toContain("⚠️");
	});
});
