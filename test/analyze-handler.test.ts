import { afterEach, describe, expect, test } from "bun:test";
import {
	DiscordHono,
	testCommandRequestInit,
	testVerifyTrue,
} from "discord-hono";
import { commands } from "../src/commands.js";
import { analyzeHandler } from "../src/handlers/analyze.js";
import { type AppEnv, safeHandler } from "../src/lib/errors.js";

// Full in-process interaction round trip: signs (via testVerifyTrue, discord-hono's
// bundled test bypass) → dispatches → resDefer ack → deferred followup, all offline
// (fetch is stubbed for mdb.aynu.org and the Discord webhook followup call).
const analyzeCommand = commands.find((c) => c.toJSON().name === "analyze");
if (!analyzeCommand)
	throw new Error("analyze command missing from src/commands.ts");

function testApp() {
	const app = new DiscordHono<AppEnv>({ verify: testVerifyTrue });
	app.command("analyze", safeHandler(analyzeHandler));
	return app;
}

function testEnv(): Env {
	return {
		DISCORD_APPLICATION_ID: "1",
		DISCORD_PUBLIC_KEY: "00".repeat(32),
		DISCORD_TOKEN: "test-token",
		CORPUS_API_URL: "https://corpus.aynu.org",
		MDB_API_URL: "https://mdb.aynu.org",
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
	return { ctx, settle: () => Promise.all(pending) };
}

const originalFetch = globalThis.fetch;
let lastFollowupBody: unknown;

/** Routes mdb.aynu.org GETs by form/word so multi-token requests can be
 * stubbed per-token, plus the Discord webhook followup call. */
function stubFetch(mdbResponse: (url: URL) => Response) {
	lastFollowupBody = undefined;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.startsWith("https://mdb.aynu.org"))
			return mdbResponse(new URL(url));
		if (url.startsWith("https://discord.com/api")) {
			lastFollowupBody = init?.body ? JSON.parse(String(init.body)) : undefined;
			return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
		}
		throw new Error(`unexpected fetch to ${url}`);
	}) as unknown as typeof fetch;
}

function decomposeResponse(form: string, opts?: { canonical?: boolean }) {
	if (opts?.canonical) {
		return {
			form,
			fallback_used: false,
			analysis: {
				id: `an:${form}`,
				surface: form,
				target_kind: "lexeme",
				target_id: `${form}-n`,
				parts: [form],
				surface_parts: [form],
				source: "curated",
				confidence: 1,
				has_head: true,
				bracketing: [],
				note: "",
			},
		};
	}
	return {
		form,
		fallback_used: true,
		mode: "flat",
		source: "segmented",
		unseen: false,
		arity: 0,
		tokens: [form],
		unresolved: [],
		warnings: [],
		decomposition: [
			{ surface: form, kind: "head", isLeaf: true, arity: 0, morpheme: null },
		],
	};
}

describe("/analyze handler (in-process, discord-hono test helpers)", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("multi-token: acks deferred, then follows up with one field per token", async () => {
		stubFetch((url) => {
			const form = url.searchParams.get("form") ?? "";
			return new Response(JSON.stringify(decomposeResponse(form)));
		});

		const init = testCommandRequestInit(analyzeCommand, {
			text: "kamuy pirka",
		});
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
			embeds: { title: string; fields: { name: string; value: string }[] }[];
		};
		expect(body.embeds[0].title).toContain("kamuy pirka");
		expect(body.embeds[0].fields).toHaveLength(2);
		expect(body.embeds[0].fields[0].name).toBe("**kamuy**");
		expect(body.embeds[0].fields[0].value).toContain("⚠ heuristic");
	});

	test("canonical token: renders source/confidence, no heuristic marker", async () => {
		stubFetch((url) => {
			const form = url.searchParams.get("form") ?? "";
			return new Response(
				JSON.stringify(decomposeResponse(form, { canonical: true })),
			);
		});

		const init = testCommandRequestInit(analyzeCommand, { text: "kamuy" });
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
		const [tokenField] = body.embeds[0].fields;
		expect(tokenField.value).toContain("curated");
		expect(tokenField.value).not.toContain("heuristic");
	});

	test("single token: bonus /api/forms call adds a Related forms field", async () => {
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = new URL(String(input));
			if (url.pathname === "/api/decompose") {
				return new Response(
					JSON.stringify(decomposeResponse(url.searchParams.get("form") ?? "")),
				);
			}
			if (url.pathname === "/api/forms") {
				return new Response(
					JSON.stringify({
						query: url.searchParams.get("q"),
						total: 1,
						returned: 1,
						results: [
							{
								id: "f1",
								lemma_id: "kamuy",
								lexeme_id: "",
								surface: "kamuyhu",
								analysis: "kamuy + 3SG.POSS",
								feature_bundle: { domain: "nominal", relation: "possessed" },
								source: "attested",
								confidence: 0.9,
								rule_id: "",
								attested_ref: "kayano",
							},
						],
					}),
				);
			}
			if (url.toString().startsWith("https://discord.com/api")) {
				lastFollowupBody = init?.body
					? JSON.parse(String(init.body))
					: undefined;
				return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
			}
			throw new Error(`unexpected fetch to ${url}`);
		}) as unknown as typeof fetch;

		const init = testCommandRequestInit(analyzeCommand, { text: "kamuy" });
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
		expect(body.embeds[0].fields).toHaveLength(2);
		const relatedField = body.embeds[0].fields[1];
		expect(relatedField.name).toBe("Related forms");
		expect(relatedField.value).toContain("kamuyhu");
		expect(relatedField.value).toContain("attested");
	});

	test("multi-token: two or more words never trigger the Related forms bonus", async () => {
		stubFetch((url) => {
			const form = url.searchParams.get("form") ?? "";
			return new Response(JSON.stringify(decomposeResponse(form)));
		});

		const init = testCommandRequestInit(analyzeCommand, {
			text: "kamuy pirka",
		});
		const { ctx, settle } = capturingExecutionCtx();
		await testApp().fetch(
			new Request("https://bot.test/", init),
			testEnv(),
			ctx,
		);
		await settle();

		const body = lastFollowupBody as {
			embeds: { fields: { name: string }[] }[];
		};
		expect(body.embeds[0].fields.map((f) => f.name)).not.toContain(
			"Related forms",
		);
	});

	test("one token's upstream call fails: embed still renders, failed token is '(unavailable)'", async () => {
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = new URL(String(input));
			if (url.pathname === "/api/decompose") {
				const form = url.searchParams.get("form") ?? "";
				if (form === "brokentoken") {
					return new Response("Internal Server Error", { status: 500 });
				}
				return new Response(JSON.stringify(decomposeResponse(form)));
			}
			if (url.toString().startsWith("https://discord.com/api")) {
				lastFollowupBody = init?.body
					? JSON.parse(String(init.body))
					: undefined;
				return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
			}
			throw new Error(`unexpected fetch to ${url}`);
		}) as unknown as typeof fetch;

		const init = testCommandRequestInit(analyzeCommand, {
			text: "kamuy brokentoken",
		});
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
		expect(body.embeds[0].fields).toHaveLength(2);
		const failed = body.embeds[0].fields.find(
			(f) => f.name === "**brokentoken**",
		);
		expect(failed?.value).toBe("(unavailable)");
	});

	test("more than 8 tokens: immediate ephemeral error, never defers, never calls mdb", async () => {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			throw new Error(
				`unexpected fetch to ${String(input)} — should never defer`,
			);
		}) as unknown as typeof fetch;

		const init = testCommandRequestInit(analyzeCommand, {
			text: "a b c d e f g h i",
		});
		const { ctx, settle } = capturingExecutionCtx();
		const res = await testApp().fetch(
			new Request("https://bot.test/", init),
			testEnv(),
			ctx,
		);
		const body = (await res.json()) as {
			type: number;
			data: { flags: number; content: string };
		};
		expect(body.type).toBe(4);
		expect(body.data.flags & 64).toBe(64);
		expect(body.data.content).toContain("8");
		await settle();
	});
});
