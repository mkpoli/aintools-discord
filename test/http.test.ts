import { afterEach, describe, expect, test } from "bun:test";
import { ApiError } from "../src/lib/errors.js";
import { getJson, getJsonWithMeta } from "../src/services/http.js";

function envelopeResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function fakeEnv(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		CORPUS_API_URL: "https://corpus.aynu.org",
		MDB_API_URL: "https://mdb.aynu.org",
		...overrides,
	} as unknown as Env;
}

const originalFetch = globalThis.fetch;

describe("getJson — service binding path (CORPUS)", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("unwraps the envelope's data on success", async () => {
		const env = fakeEnv({
			CORPUS: {
				fetch: async () =>
					envelopeResponse({ api_version: "1", data: [{ id: "a" }] }),
			},
		});
		const rows = await getJson<{ id: string }[]>(
			env,
			"CORPUS",
			"/v1/search?q=kamuy",
		);
		expect(rows).toEqual([{ id: "a" }]);
	});

	test("throws ApiError with the upstream error code on an error envelope", async () => {
		const env = fakeEnv({
			CORPUS: {
				fetch: async () =>
					envelopeResponse(
						{
							api_version: "1",
							error: { code: "bad_lang", message: "lang must be ain|jpn|any" },
						},
						400,
					),
			},
		});
		await expect(
			getJson(env, "CORPUS", "/v1/search?lang=bogus"),
		).rejects.toThrow(ApiError);
		try {
			await getJson(env, "CORPUS", "/v1/search?lang=bogus");
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).code).toBe("bad_lang");
		}
	});

	test("throws a generic http_error ApiError on non-2xx with no error envelope", async () => {
		const env = fakeEnv({
			CORPUS: {
				fetch: async () =>
					envelopeResponse({ api_version: "1", data: null }, 503),
			},
		});
		await expect(getJson(env, "CORPUS", "/v1/search")).rejects.toThrow(
			ApiError,
		);
		try {
			await getJson(env, "CORPUS", "/v1/search");
			expect.unreachable();
		} catch (err) {
			expect((err as ApiError).code).toBe("http_error");
		}
	});

	test("throws bad_response ApiError on malformed JSON", async () => {
		const env = fakeEnv({
			CORPUS: { fetch: async () => new Response("not json", { status: 200 }) },
		});
		try {
			await getJson(env, "CORPUS", "/v1/search");
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).code).toBe("bad_response");
		}
	});

	test("getJsonWithMeta surfaces the envelope's meta alongside data", async () => {
		const env = fakeEnv({
			CORPUS: {
				fetch: async () =>
					envelopeResponse({
						api_version: "1",
						data: [{ node_text: "kamuy" }],
						meta: { total: 10486, offset: 0, limit: 1 },
					}),
			},
		});
		const { data, meta } = await getJsonWithMeta<
			{ node_text: string }[],
			{ total: number }
		>(env, "CORPUS", "/v1/kwic?q=kamuy");
		expect(data).toEqual([{ node_text: "kamuy" }]);
		expect(meta?.total).toBe(10486);
	});
});

describe("getJson — local-dev fallback path (no service binding)", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("plain-fetches the base URL + path and unwraps the envelope", async () => {
		let requestedUrl = "";
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			requestedUrl = String(input);
			return envelopeResponse({ api_version: "1", data: { ok: true } });
		}) as unknown as typeof fetch;

		const env = fakeEnv();
		const result = await getJson<{ ok: boolean }>(
			env,
			"CORPUS",
			"/v1/search?q=kamuy",
		);
		expect(result).toEqual({ ok: true });
		expect(requestedUrl).toBe("https://corpus.aynu.org/v1/search?q=kamuy");
	});

	test("maps a network failure to an ApiError with code 'unreachable'", async () => {
		globalThis.fetch = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;

		const env = fakeEnv();
		try {
			await getJson(env, "CORPUS", "/v1/search");
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).code).toBe("unreachable");
		}
	});

	test("maps an AbortSignal.timeout() rejection to an ApiError with code 'timeout'", async () => {
		globalThis.fetch = (async () => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		}) as unknown as typeof fetch;

		const env = fakeEnv();
		try {
			await getJson(env, "CORPUS", "/v1/search");
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).code).toBe("timeout");
		}
	});
});

describe("getJson — MDB (plain JSON, no envelope)", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("returns the parsed body directly (no envelope unwrap)", async () => {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({ form: "kamuy", fallback_used: false }),
			)) as unknown as typeof fetch;
		const env = fakeEnv();
		const result = await getJson<{ form: string; fallback_used: boolean }>(
			env,
			"MDB",
			"/api/decompose?form=kamuy",
		);
		expect(result).toEqual({ form: "kamuy", fallback_used: false });
	});

	test("throws http_error ApiError on non-2xx", async () => {
		globalThis.fetch = (async () =>
			new Response("Not Found", { status: 404 })) as unknown as typeof fetch;
		const env = fakeEnv();
		try {
			await getJson(env, "MDB", "/api/decompose?form=x");
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).code).toBe("http_error");
		}
	});
});
