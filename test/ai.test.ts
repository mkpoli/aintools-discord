import { describe, expect, mock, test } from "bun:test";
import {
	type AskSource,
	buildInput,
	extractAnswerText,
	runAsk,
	SYSTEM_PROMPT,
} from "../src/services/ai.js";

describe("buildInput", () => {
	test("serializes the question with every source tagged and blank-line separated", () => {
		const sources: AskSource[] = [
			{ id: "G1", text: "sínep — 一つ / one" },
			{ id: "C1", text: "kamuy — god" },
		];
		const input = buildInput("What does sínep mean?", sources);
		expect(input).toContain("[G1] sínep — 一つ / one");
		expect(input).toContain("[C1] kamuy — god");
		expect(input).toContain("Question: What does sínep mean?");
		// Sources come before the question, in order.
		expect(input.indexOf("[G1]")).toBeLessThan(input.indexOf("[C1]"));
		expect(input.indexOf("[C1]")).toBeLessThan(input.indexOf("Question:"));
	});

	test("empty sources still produce a well-formed input", () => {
		const input = buildInput("hello", []);
		expect(input).toContain("Question: hello");
	});
});

describe("extractAnswerText", () => {
	test("prefers output_text (Responses API shape)", () => {
		expect(extractAnswerText({ output_text: "the answer" })).toBe("the answer");
	});

	test("falls back to response when output_text is missing", () => {
		expect(extractAnswerText({ response: "the answer" })).toBe("the answer");
	});

	test("falls back to response when output_text is an empty string", () => {
		expect(extractAnswerText({ output_text: "", response: "fallback" })).toBe(
			"fallback",
		);
	});

	test("throws on a result with neither field", () => {
		expect(() => extractAnswerText({ usage: {} })).toThrow();
	});

	test("throws on a non-object result", () => {
		expect(() => extractAnswerText(null)).toThrow();
		expect(() => extractAnswerText(undefined)).toThrow();
	});
});

describe("runAsk", () => {
	function mockRun() {
		return mock(
			async (
				_model?: string,
				_inputs?: Record<string, unknown>,
				_options?: unknown,
			) => ({ output_text: "answer" }),
		);
	}

	function makeEnv(run: ReturnType<typeof mockRun>, gatewayId = "") {
		return {
			ASK_MODEL: "@cf/openai/gpt-oss-120b",
			AI_GATEWAY_ID: gatewayId,
			AI: { run },
		} as unknown as Env;
	}

	test("calls env.AI.run with the Responses-style input/instructions shape, no gateway option when AI_GATEWAY_ID is empty", async () => {
		const run = mockRun();
		const env = makeEnv(run, "");

		const answer = await runAsk(env, "What is kamuy?", [
			{ id: "G1", text: "kamuy — god" },
		]);

		expect(answer).toBe("answer");
		expect(run).toHaveBeenCalledTimes(1);
		const [model, inputs, options] = run.mock.calls[0];
		expect(model).toBe("@cf/openai/gpt-oss-120b");
		expect(inputs?.instructions).toBe(SYSTEM_PROMPT);
		expect(inputs?.input).toContain("[G1] kamuy — god");
		expect(inputs?.max_output_tokens).toBe(800);
		expect(options).toBeUndefined();
	});

	test("includes { gateway: { id } } as the third argument when AI_GATEWAY_ID is set", async () => {
		const run = mockRun();
		const env = makeEnv(run, "ainu-discord-bot");

		await runAsk(env, "question", []);

		expect(run).toHaveBeenCalledTimes(1);
		const [, , options] = run.mock.calls[0];
		expect(options).toEqual({ gateway: { id: "ainu-discord-bot" } });
	});
});
