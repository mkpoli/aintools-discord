import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	DiscordHono,
	testCommandRequestInit,
	testVerifyTrue,
} from "discord-hono";
import { commands } from "../src/commands.js";
import {
	glossaryAutocomplete,
	glossaryHandler,
} from "../src/handlers/glossary.js";
import { safeHandler } from "../src/lib/errors.js";

const GLOSSARY_URL = "https://itak.aynu.org/api/gdoc";
const glossaryCommand = commands.find(
	(command) => command.toJSON().name === "glossary",
);
if (!glossaryCommand) throw new Error("glossary command not registered");

interface InteractionResponseBody {
	type: number;
	data?: { choices?: { name: string; value: string }[] };
}

async function json(res: Response): Promise<InteractionResponseBody> {
	return (await res.json()) as InteractionResponseBody;
}

const fixtureResponse = {
	table: [
		{ Aynu: "sínep", 日本語: "一つ", English: "one", sheetName: "numbers" },
		{ Aynu: "tu", 日本語: "二つ", English: "two", sheetName: "numbers" },
	],
	sheets: [],
};

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

function makeEnv(kv: MemoryKV): Env {
	return {
		KV: kv,
		CORPUS_API_URL: "https://corpus.aynu.org",
		MDB_API_URL: "https://mdb.aynu.org",
		GLOSSARY_API_URL: GLOSSARY_URL,
		WOTD_CHANNEL_ID: "",
		AI_GATEWAY_ID: "test",
		ASK_MODEL: "test",
		ASK_COOLDOWN_SECONDS: "300",
		DISCORD_APPLICATION_ID: "test-app-id",
		// Must be valid Ed25519-key-shaped hex (32 bytes) for `crypto.subtle.importKey`
		// to accept it — `testVerifyTrue` still runs the real import/verify call and
		// only discards its result, it doesn't skip parsing the key.
		DISCORD_PUBLIC_KEY: "11".repeat(32),
		DISCORD_TOKEN: "test-token",
	} as unknown as Env;
}

/** Collects everything passed to `executionCtx.waitUntil` so tests can await it. */
function makeExecutionCtx() {
	const tasks: Promise<unknown>[] = [];
	const ctx = {
		waitUntil(p: Promise<unknown>) {
			tasks.push(p);
		},
		passThroughOnException() {},
	} as unknown as ExecutionContext;
	return { ctx, settle: () => Promise.allSettled(tasks) };
}

function testApp() {
	// `verify: testVerifyTrue` bypasses real Ed25519 signature checking.
	const app = new DiscordHono<{ Bindings: Env }>({ verify: testVerifyTrue });
	app.autocomplete(
		glossaryCommand.toJSON().name,
		glossaryAutocomplete,
		safeHandler(glossaryHandler),
	);
	return app;
}

/** discord-hono's `testCommandRequestInit` only builds type=2 (command)
 * interactions; autocomplete (type=4) has no built-in helper, so this mirrors
 * its shape for the one option we care about. */
function autocompleteRequestInit(query: string): RequestInit {
	const cmd = glossaryCommand.toJSON();
	const interaction = {
		type: 4,
		data: {
			name: cmd.name,
			id: "0".repeat(32),
			type: 1,
			options: [{ name: "query", type: 3, value: query, focused: true }],
		},
	};
	return {
		method: "POST",
		headers: {
			"x-signature-ed25519": "f".repeat(128),
			"x-signature-timestamp": "1",
			"content-type": "application/json",
		},
		body: JSON.stringify(interaction),
	};
}

describe("/glossary command (in-process, fetch + KV mocked)", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.startsWith(GLOSSARY_URL)) {
				return new Response(JSON.stringify(fixtureResponse), { status: 200 });
			}
			// Any Discord REST call (followup, etc.) — accept unconditionally.
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		}) as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("defers, fetches the glossary, and follows up with a match embed", async () => {
		const app = testApp();
		const env = makeEnv(new MemoryKV());
		const { ctx, settle } = makeExecutionCtx();

		const init = testCommandRequestInit(glossaryCommand.toJSON(), {
			query: "sinep",
			limit: 5,
		});
		const res = await app.fetch(
			new Request("http://localhost/interactions", init),
			env,
			ctx,
		);
		expect(res.status).toBe(200);
		expect((await json(res)).type).toBe(5); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE

		await settle();

		const fetchMock = globalThis.fetch as unknown as {
			mock: { calls: unknown[][] };
		};
		const followupCall = fetchMock.mock.calls.find(([, reqInit]) => {
			const body = (reqInit as RequestInit | undefined)?.body;
			return typeof body === "string" && body.includes('"embeds"');
		});
		expect(followupCall).toBeDefined();
		const body = JSON.parse((followupCall?.[1] as RequestInit).body as string);
		expect(body.embeds[0].fields[0].name).toBe("sínep");
	});

	test("follows up with a not-found embed on zero results", async () => {
		const app = testApp();
		const env = makeEnv(new MemoryKV());
		const { ctx, settle } = makeExecutionCtx();

		const init = testCommandRequestInit(glossaryCommand.toJSON(), {
			query: "zzzznomatchzzzz",
			limit: 5,
		});
		await app.fetch(
			new Request("http://localhost/interactions", init),
			env,
			ctx,
		);
		await settle();

		const fetchMock = globalThis.fetch as unknown as {
			mock: { calls: unknown[][] };
		};
		const followupCall = fetchMock.mock.calls.find(([, reqInit]) => {
			const body = (reqInit as RequestInit | undefined)?.body;
			return typeof body === "string" && body.includes('"embeds"');
		});
		const body = JSON.parse((followupCall?.[1] as RequestInit).body as string);
		expect(body.embeds[0].description).toContain("見つかりませんでした");
	});

	test("autocomplete returns ranked Aynu choices", async () => {
		const app = testApp();
		const env = makeEnv(new MemoryKV());
		const { ctx } = makeExecutionCtx();

		const res = await app.fetch(
			new Request(
				"http://localhost/interactions",
				autocompleteRequestInit("sinep"),
			),
			env,
			ctx,
		);
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body.type).toBe(8); // APPLICATION_COMMAND_AUTOCOMPLETE_RESULT
		expect(body.data?.choices?.[0]?.value).toBe("sínep");
	});

	test("autocomplete returns an empty list when the upstream fetch fails", async () => {
		globalThis.fetch = mock(
			async () => new Response("boom", { status: 500 }),
		) as unknown as typeof fetch;
		const app = testApp();
		const env = makeEnv(new MemoryKV());
		const { ctx } = makeExecutionCtx();

		const res = await app.fetch(
			new Request(
				"http://localhost/interactions",
				autocompleteRequestInit("sinep"),
			),
			env,
			ctx,
		);
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body.data?.choices).toEqual([]);
	});
});
