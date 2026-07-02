import { afterEach, describe, expect, test } from "bun:test";
import {
	DiscordHono,
	testCommandRequestInit,
	testVerifyTrue,
} from "discord-hono";
import { commands } from "../src/commands.js";
import { corpusHandler } from "../src/handlers/corpus.js";
import { type AppEnv, safeHandler } from "../src/lib/errors.js";

// Full in-process interaction round trip: signs (via testVerifyTrue, discord-hono's
// bundled test bypass) → dispatches → resDefer ack → deferred followup, all offline
// (fetch is stubbed for both corpus.aynu.org and the Discord webhook followup call).
const corpusCommand = commands.find((c) => c.toJSON().name === "corpus");
if (!corpusCommand)
	throw new Error("corpus command missing from src/commands.ts");

function testApp() {
	const app = new DiscordHono<AppEnv>({ verify: testVerifyTrue });
	app.command("corpus", safeHandler(corpusHandler));
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

function stubFetch(corpusResponse: () => Response) {
	lastFollowupBody = undefined;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.startsWith("https://corpus.aynu.org")) return corpusResponse();
		if (url.startsWith("https://discord.com/api")) {
			lastFollowupBody = init?.body ? JSON.parse(String(init.body)) : undefined;
			return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
		}
		throw new Error(`unexpected fetch to ${url}`);
	}) as unknown as typeof fetch;
}

describe("/corpus handler (in-process, discord-hono test helpers)", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("sentences mode: acks deferred, then follows up with a search-results embed", async () => {
		stubFetch(
			() =>
				new Response(
					JSON.stringify({
						api_version: "1",
						data: [
							{
								id: "a#1",
								text: "kamuy",
								translation: "god",
								dialect: "沙流",
								author: "someone",
								collection: null,
								document: "doc",
								uri: null,
							},
						],
					}),
				),
		);

		const init = testCommandRequestInit(corpusCommand, {
			query: "kamuy",
			limit: 3,
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
		expect(body.embeds[0].title).toContain("kamuy");
		expect(body.embeds[0].fields[0].name).toBe("**kamuy**");
		expect(body.embeds[0].fields[0].value).toContain("god");
	});

	test("zero results: friendly embed, not an error", async () => {
		stubFetch(
			() => new Response(JSON.stringify({ api_version: "1", data: [] })),
		);

		const init = testCommandRequestInit(corpusCommand, {
			query: "zzznonexistent",
			limit: 3,
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
		expect(body.embeds[0].title).toBe("No matches");
		expect(body.embeds[0].description).toContain("lang:any");
	});

	test("upstream API error: followup carries the short bilingual error text, never silence", async () => {
		stubFetch(
			() =>
				new Response(
					JSON.stringify({
						api_version: "1",
						error: { code: "bad_lang", message: "lang must be ain|jpn|any" },
					}),
					{
						status: 400,
					},
				),
		);

		const init = testCommandRequestInit(corpusCommand, {
			query: "kamuy",
			limit: 3,
		});
		const { ctx, settle } = capturingExecutionCtx();
		await testApp().fetch(
			new Request("https://bot.test/", init),
			testEnv(),
			ctx,
		);
		await settle();

		const body = lastFollowupBody as { content: string };
		expect(body.content).toContain("⚠️");
	});

	test("kwic mode: acks deferred, then follows up with an aligned code-block embed", async () => {
		stubFetch(
			() =>
				new Response(
					JSON.stringify({
						api_version: "1",
						data: [
							{
								sentence_id: "s1",
								left_text: "a b c",
								node_text: "kamuy",
								right_text: "d e f",
								translation: null,
								dialect: null,
								author: null,
								uri: null,
							},
						],
						meta: { total: 42, offset: 0, limit: 3 },
					}),
				),
		);

		const init = testCommandRequestInit(corpusCommand, {
			query: "kamuy",
			mode: "kwic",
			limit: 3,
		});
		const { ctx, settle } = capturingExecutionCtx();
		await testApp().fetch(
			new Request("https://bot.test/", init),
			testEnv(),
			ctx,
		);
		await settle();

		const body = lastFollowupBody as {
			embeds: { description: string; url: string }[];
		};
		expect(body.embeds[0].description).toContain("[kamuy]");
		expect(body.embeds[0].description).toContain("42");
		expect(body.embeds[0].url).toBe("https://corpus.aynu.org/?q=kamuy");
	});
});
