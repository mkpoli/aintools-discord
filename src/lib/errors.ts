import type { CommandContext } from "discord-hono";

/** The shape every command handler runs against — see worker-configuration.d.ts. */
export type AppEnv = { Bindings: Env };

/**
 * Thrown by service-layer HTTP calls (corpus/mdb/glossary, added in later
 * PRs) on a non-2xx or unreachable upstream. `code` is a short machine key
 * for `userMessage()`; `message` is a plain English detail for logs.
 */
export class ApiError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

const API_ERROR_TEXT: Record<string, string> = {
	timeout:
		"外部APIの応答がありませんでした。 / The upstream API did not respond in time.",
	unreachable:
		"外部APIに接続できませんでした。 / Could not reach the upstream API.",
};

/** Every failure path renders through here — no raw stack traces, ever. */
export function userMessage(err: unknown): string {
	if (err instanceof ApiError) {
		return (
			API_ERROR_TEXT[err.code] ??
			`外部APIでエラーが発生しました（${err.code}）。 / Upstream API error (${err.code}).`
		);
	}
	console.error(err);
	return "予期しないエラーが発生しました。しばらくしてから再度お試しください。 / An unexpected error occurred — please try again later.";
}

/**
 * Wraps a command handler so a thrown error always becomes an ephemeral
 * reply — never the old bot's silent drop. Fixes are logged; the user only
 * ever sees the short bilingual message from `userMessage()`.
 */
export function safeHandler(
	fn: (c: CommandContext<AppEnv>) => Promise<Response> | Response,
): (c: CommandContext<AppEnv>) => Promise<Response> {
	return async (c) => {
		try {
			return await fn(c);
		} catch (err) {
			return c.flags("EPHEMERAL").res(`⚠️ ${userMessage(err)}`);
		}
	};
}
