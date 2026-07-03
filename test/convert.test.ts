import { describe, expect, it } from "bun:test";
import {
	DiscordHono,
	testCommandRequestInit,
	testVerifyTrue,
} from "discord-hono";
import { commands } from "../src/commands.js";
import { convert, convertScriptContextMenu } from "../src/handlers/convert.js";
import { safeHandler } from "../src/lib/errors.js";

// In-process simulation of signed Discord interactions against the actual
// app wiring — mirrors discord-hono's own test suite (DiscordHono({ verify })
// + app.fetch()), following the pattern PR-0 established for /ping.

const [, convertCommand, convertContextMenu] = commands;

const env = {
	CORPUS_API_URL: "https://corpus.aynu.org",
	MDB_API_URL: "https://mdb.aynu.org",
	GLOSSARY_API_URL: "https://itak.aynu.org/api/gdoc",
	WOTD_CHANNEL_ID: "",
	AI_GATEWAY_ID: "test",
	ASK_MODEL: "test",
	ASK_COOLDOWN_SECONDS: "300",
	// testVerifyTrue still calls the real `verify()` (and discards its result),
	// so this must be a well-formed 32-byte hex Ed25519 key or WebCrypto's
	// `importKey` throws a DataError before the mock ever gets to ignore it.
	DISCORD_PUBLIC_KEY:
		"a16181a08e461f3711d45c367edf23e724e704f0b6f445b6b508b0ebfb5ae76c",
} as unknown as Env;

function buildApp() {
	const app = new DiscordHono<{ Bindings: Env }>({ verify: testVerifyTrue });
	app.command(convertCommand.toJSON().name, safeHandler(convert));
	app.command(
		convertContextMenu.toJSON().name,
		safeHandler(convertScriptContextMenu),
	);
	return app;
}

/**
 * `testCommandRequestInit` only fabricates STRING/INTEGER/BOOLEAN/NUMBER
 * options — MESSAGE context-menu commands carry no options at all, just a
 * `target_id` + `resolved.messages`, so we build that interaction body by
 * hand. Headers match `testCommandRequestInit`'s (ignored by `testVerifyTrue`).
 */
function messageCommandRequestInit(
	name: string,
	targetId: string,
	content: string,
) {
	return {
		method: "POST",
		headers: {
			"x-signature-ed25519": "f".repeat(128),
			"x-signature-timestamp": "1",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			type: 2,
			data: {
				name,
				id: "0".repeat(32),
				type: 3,
				target_id: targetId,
				resolved: { messages: { [targetId]: { id: targetId, content } } },
			},
		}),
	} satisfies RequestInit;
}

describe("/convert (in-process, signed interactions)", () => {
	it("single conversion: Latn -> Kana, public response", async () => {
		const app = buildApp();
		const req = new Request(
			"https://example.com",
			testCommandRequestInit(convertCommand, {
				text: "irankarapte",
				to: "Kana",
			}),
		);
		const res = await app.fetch(req, env);
		const body = (await res.json()) as {
			data: { content?: string; flags?: number };
		};
		expect(body.data.content).toContain("イランカラㇷ゚テ");
		expect(body.data.content).toContain("Latn → カタカナ Kana");
		expect(body.data.flags ?? 0).toBe(0); // public, not ephemeral
	});

	it("all-scripts embed when `to` is omitted, source marked as detected", async () => {
		const app = buildApp();
		const req = new Request(
			"https://example.com",
			testCommandRequestInit(convertCommand, { text: "irankarapte" }),
		);
		const res = await app.fetch(req, env);
		const body = (await res.json()) as {
			data: { embeds?: { fields?: { name: string; value: string }[] }[] };
		};
		const fields = body.data.embeds?.[0]?.fields ?? [];
		expect(fields).toHaveLength(4);
		const detected = fields.find((f) => f.name.includes("detected"));
		expect(detected?.name).toContain("Latn");
		expect(fields.find((f) => f.name.startsWith("カタカナ"))?.value).toBe(
			"イランカラㇷ゚テ",
		);
	});

	it("Unknown script -> ephemeral bilingual error, never silent", async () => {
		const app = buildApp();
		const req = new Request(
			"https://example.com",
			testCommandRequestInit(convertCommand, { text: "123" }),
		);
		const res = await app.fetch(req, env);
		const body = (await res.json()) as {
			data: { content?: string; flags?: number };
		};
		expect(body.data.flags).toBeGreaterThan(0); // EPHEMERAL
		expect(body.data.content).toContain("No Ainu script detected");
	});

	it("Mixed script without `from` -> ephemeral ask-for-from error", async () => {
		const app = buildApp();
		const req = new Request(
			"https://example.com",
			testCommandRequestInit(convertCommand, { text: "aynuイランカラ" }),
		);
		const res = await app.fetch(req, env);
		const body = (await res.json()) as {
			data: { content?: string; flags?: number };
		};
		expect(body.data.flags).toBeGreaterThan(0);
		expect(body.data.content).toContain("Mixed scripts detected");
	});

	it('"Convert script" context menu: ephemeral all-scripts embed from message content', async () => {
		const app = buildApp();
		const req = new Request(
			"https://example.com",
			messageCommandRequestInit(
				convertContextMenu.toJSON().name,
				"111",
				"irankarapte",
			),
		);
		const res = await app.fetch(req, env);
		const body = (await res.json()) as {
			data: {
				flags?: number;
				embeds?: { fields?: { name: string; value: string }[] }[];
			};
		};
		expect(body.data.flags).toBeGreaterThan(0); // always ephemeral
		expect(body.data.embeds?.[0]?.fields).toHaveLength(4);
	});

	it("context menu on a message with no content -> ephemeral error", async () => {
		const app = buildApp();
		const req = new Request(
			"https://example.com",
			messageCommandRequestInit(convertContextMenu.toJSON().name, "222", ""),
		);
		const res = await app.fetch(req, env);
		const body = (await res.json()) as {
			data: { content?: string; flags?: number };
		};
		expect(body.data.flags).toBeGreaterThan(0);
		expect(body.data.content).toContain("no text content");
	});
});
