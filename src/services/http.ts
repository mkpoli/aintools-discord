import { ApiError } from "../lib/errors.js";

export type ApiService = "CORPUS" | "MDB";

/**
 * Fetcher-shaped service bindings this module knows how to dispatch to.
 * Declared locally rather than read off the generated `Env` because the
 * CORPUS binding lands in this PR and MDB in a later one (PR-4) — casting
 * through this type keeps `getJson` usable for both without a compile error
 * for the not-yet-declared binding.
 */
type ServiceBindings = Partial<Record<ApiService, Fetcher>>;

const API_URL_VAR: Record<ApiService, "CORPUS_API_URL" | "MDB_API_URL"> = {
	CORPUS: "CORPUS_API_URL",
	MDB: "MDB_API_URL",
};

/** Corpus wraps every response in `{ api_version, data | error }`; MDB responses are plain JSON. */
const ENVELOPE: Record<ApiService, boolean> = {
	CORPUS: true,
	MDB: false,
};

interface ApiEnvelope<T> {
	api_version: string;
	data?: T;
	error?: { code: string; message: string };
	meta?: Record<string, unknown>;
}

interface JsonResult<T> {
	data: T;
	meta?: Record<string, unknown>;
}

async function fetchUpstream(
	env: Env,
	service: ApiService,
	path: string,
): Promise<Response> {
	const baseUrl = env[API_URL_VAR[service]];
	const binding = (env as unknown as ServiceBindings)[service];
	const url = baseUrl + path;
	try {
		return binding
			? await binding.fetch(new Request(url))
			: await fetch(url, { signal: AbortSignal.timeout(8000) });
	} catch (err) {
		if (err instanceof Error && err.name === "TimeoutError") {
			throw new ApiError("timeout", `${service} ${path}: timed out`);
		}
		throw new ApiError(
			"unreachable",
			`${service} ${path}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

async function readJsonResult<T>(
	env: Env,
	service: ApiService,
	path: string,
): Promise<JsonResult<T>> {
	const res = await fetchUpstream(env, service, path);

	if (!ENVELOPE[service]) {
		if (!res.ok)
			throw new ApiError(
				"http_error",
				`${service} ${path} → HTTP ${res.status}`,
			);
		try {
			return { data: (await res.json()) as T };
		} catch {
			throw new ApiError(
				"bad_response",
				`${service} ${path}: response was not valid JSON`,
			);
		}
	}

	let body: ApiEnvelope<T>;
	try {
		body = await res.json();
	} catch {
		throw new ApiError(
			"bad_response",
			`${service} ${path}: response was not valid JSON`,
		);
	}
	if (body.error)
		throw new ApiError(
			body.error.code,
			`${service} ${path}: ${body.error.message}`,
		);
	if (!res.ok)
		throw new ApiError("http_error", `${service} ${path} → HTTP ${res.status}`);
	return { data: body.data as T, meta: body.meta };
}

/**
 * Shared upstream fetcher for the aynu.org API fleet (corpus.aynu.org today,
 * mdb.aynu.org from PR-4). Uses the service binding when the Worker has one
 * bound (Worker-to-Worker, no public hop); otherwise a plain fetch with an
 * 8s timeout — the path every local `wrangler dev` run takes, since service
 * bindings only resolve with `--remote`.
 *
 * Corpus responses unwrap the `{ api_version, data | error }` envelope; MDB
 * responses are already plain JSON. Any non-2xx, envelope error, network
 * failure, or malformed body becomes a typed `ApiError`.
 */
export async function getJson<T>(
	env: Env,
	service: ApiService,
	path: string,
): Promise<T> {
	return (await readJsonResult<T>(env, service, path)).data;
}

/**
 * Like `getJson`, but also surfaces the envelope's `meta` (e.g. `/v1/kwic`'s
 * `{ total, offset, limit }`) for endpoints where the caller needs it.
 */
export async function getJsonWithMeta<T, M = Record<string, unknown>>(
	env: Env,
	service: ApiService,
	path: string,
): Promise<{ data: T; meta: M | undefined }> {
	const result = await readJsonResult<T>(env, service, path);
	return { data: result.data, meta: result.meta as M | undefined };
}
