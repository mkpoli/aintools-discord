/**
 * `/ask` model call — Workers AI via `env.AI.run`.
 *
 * Input schema: `@cf/openai/gpt-oss-120b` is one of Workers AI's "reasoning"
 * (OpenAI open-weight) models, which speak the OpenAI **Responses API**
 * shape — `input` (+ `instructions`, `reasoning`, `max_output_tokens`) — NOT
 * the Chat Completions `messages` array. Confirmed three ways:
 *  1. The model's own docs page shows `env.AI.run('@cf/openai/gpt-oss-120b',
 *     { instructions: '...', input: '...' })` verbatim:
 *     https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/
 *  2. Its downloadable batch-input schema (linked from the same page, at
 *     `/workers-ai/models/gpt-oss-120b/batch-input.json`) documents the
 *     per-request fields as `input: string | array` (required) and
 *     `reasoning: { effort: low|medium|high, summary: auto|concise|detailed }`.
 *  3. `wrangler types` generates this model's binding overload as
 *     `inputs: XOR<ResponsesInput, ChatCompletionsMessagesInput>` in
 *     worker-configuration.d.ts, where `ResponsesInput` has exactly
 *     `input`/`instructions`/`max_output_tokens`/`reasoning`/... — this is
 *     the ambient type actually used to typecheck the call below.
 * (The rendered sync-input.json schema table on the docs page itself only
 * lists the older Prompt/Messages oneOf — it hasn't been updated for the
 * Responses variant — so (2) and (3) are what settle `max_output_tokens`
 * over `max_tokens` here.)
 *
 * Gateway binding shape confirmed against
 * https://developers.cloudflare.com/ai-gateway/integrations/aig-workers-ai-binding/
 * (`env.AI.run(model, inputs, { gateway: { id } })`). `AI_GATEWAY_ID` empty
 * ⇒ the third argument is omitted entirely — the gateway is optional
 * observability, never a hard dependency of `/ask`.
 *
 * No retries: exactly one `env.AI.run` call per `/ask` invocation.
 */

export const SYSTEM_PROMPT = `You are a careful research assistant for the Ainu language learning community.
Answer ONLY using the numbered sources provided below — never from outside/background knowledge.
Cite every claim inline with its source tag, e.g. [G1], [C2], [M1].
If the sources do not answer the question, say so plainly, in both Japanese and English.
NEVER invent Ainu words, forms, or translations that are not present in the sources.
Answer in the same language the user asked in.
Keep the answer to 250 words or fewer.`;

import { ApiError } from "../lib/errors.js";

const MAX_OUTPUT_TOKENS = 800;
const AI_TIMEOUT_MS = 60_000;

export interface AskSource {
	id: string;
	text: string;
}

/** Pure — exported for offline unit testing of the model input serialization. */
export function buildInput(question: string, sources: AskSource[]): string {
	const numbered = sources.map((s) => `[${s.id}] ${s.text}`).join("\n\n");
	return `Sources:\n${numbered}\n\nQuestion: ${question}`;
}

/**
 * `postProcessedOutputs` for this model is `XOR<ResponsesOutput,
 * ChatCompletionsOutput>`; since we only ever send the Responses-style
 * `input` shape, `output_text` is the expected field. `response` is a
 * defensive fallback for the plainer `{ response, usage, tool_calls }` shape
 * documented on the model's sync-output.json (the docs and the generated
 * binding types disagree slightly on this model's output shape — see the
 * module doc comment above). Pure — exported for offline unit testing.
 */
export function extractAnswerText(result: unknown): string {
	if (result && typeof result === "object") {
		const r = result as { output_text?: unknown; response?: unknown };
		if (typeof r.output_text === "string" && r.output_text.trim().length > 0) {
			return r.output_text;
		}
		if (typeof r.response === "string" && r.response.trim().length > 0) {
			return r.response;
		}
	}
	throw new Error("Workers AI returned an empty response");
}

/**
 * Single, non-retried call to the configured model (`env.ASK_MODEL`,
 * `@cf/openai/gpt-oss-120b` by default) with the numbered sources serialized
 * into the prompt and the grounding rules in `SYSTEM_PROMPT` as
 * `instructions`.
 */
export async function runAsk(
	env: Env,
	question: string,
	sources: AskSource[],
): Promise<string> {
	const inputs = {
		instructions: SYSTEM_PROMPT,
		input: buildInput(question, sources),
		max_output_tokens: MAX_OUTPUT_TOKENS,
	};

	const run = env.AI_GATEWAY_ID
		? env.AI.run(env.ASK_MODEL, inputs, {
				gateway: { id: env.AI_GATEWAY_ID },
			})
		: env.AI.run(env.ASK_MODEL, inputs);

	// `AI.run` accepts no AbortSignal, so race it against a hard deadline: a
	// stalled inference must fail fast into the normal error path instead of
	// holding the deferred interaction open indefinitely.
	const result = await Promise.race([
		run,
		new Promise<never>((_, reject) => {
			setTimeout(
				() => reject(new ApiError("timeout", "Workers AI call timed out")),
				AI_TIMEOUT_MS,
			);
		}),
	]);

	return extractAnswerText(result);
}
