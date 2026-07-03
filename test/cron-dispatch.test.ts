import { afterEach, describe, expect, test } from "bun:test";
import app from "../src/index.js";

/**
 * src/index.ts dispatches "0 22 * * *" → runWotd and "*\/10 * * * *" →
 * runArchive by explicit key (replacing the old `app.cron("", runWotd)`
 * catch-all, which would have also matched the new archive trigger). This
 * doesn't re-test either handler's own logic (covered in
 * test/wotd-cron.test.ts / test/archive-crawler.test.ts) — just that each
 * cron string reaches its own handler and not the other one, with both
 * env vars empty so each handler's own no-op path is what proves it ran
 * (and that `fetch` — stubbed to throw — is never reached by either).
 */

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;

function makeEnv(): Env {
	return {
		DB: {} as D1Database,
		KV: {} as KVNamespace,
		WOTD_CHANNEL_ID: "",
		ARCHIVE_GUILD_ID: "",
	} as unknown as Env;
}

function makeExecutionCtx(): ExecutionContext {
	return {
		waitUntil() {},
		passThroughOnException() {},
	} as unknown as ExecutionContext;
}

describe("explicit cron-key dispatch", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
		console.warn = originalWarn;
	});

	test('"0 22 * * *" reaches runWotd (WOTD_CHANNEL_ID empty ⇒ its own no-op, no fetch)', async () => {
		globalThis.fetch = (async () => {
			throw new Error("no fetch should happen on this no-op path");
		}) as unknown as typeof fetch;
		const warnings: string[] = [];
		console.warn = (msg: string) => warnings.push(msg);

		await app.scheduled(
			{ cron: "0 22 * * *", type: "scheduled", scheduledTime: Date.now() },
			makeEnv(),
			makeExecutionCtx(),
		);

		expect(warnings.some((w) => w.includes("[wotd]"))).toBe(true);
		expect(warnings.some((w) => w.includes("[archive]"))).toBe(false);
	});

	test('"*/10 * * * *" reaches runArchive (ARCHIVE_GUILD_ID empty ⇒ its own no-op, no fetch)', async () => {
		globalThis.fetch = (async () => {
			throw new Error("no fetch should happen on this no-op path");
		}) as unknown as typeof fetch;
		const warnings: string[] = [];
		console.warn = (msg: string) => warnings.push(msg);

		await app.scheduled(
			{ cron: "*/10 * * * *", type: "scheduled", scheduledTime: Date.now() },
			makeEnv(),
			makeExecutionCtx(),
		);

		expect(warnings.some((w) => w.includes("[archive]"))).toBe(true);
		expect(warnings.some((w) => w.includes("[wotd]"))).toBe(false);
	});
});
