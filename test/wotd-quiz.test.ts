import { describe, expect, test } from "bun:test";
import { blankToken, textContainsToken } from "../src/lib/fold.js";
import { generateWotdQuestion } from "../src/services/quiz.js";

function seededRng(seed = 42): () => number {
	let s = seed;
	return () => {
		s = (s * 1664525 + 1013904223) % 4294967296;
		return s / 4294967296;
	};
}

describe("blankToken", () => {
	test("blanks every whole-word occurrence, folded", () => {
		expect(blankToken("pet or ta pet an", "pet")).toBe("____ or ta ____ an");
		expect(blankToken("Pét or ta", "pet")).toBe("____ or ta");
	});

	test("never blanks a substring occurrence", () => {
		expect(blankToken("Yeepeta'usnaypo petpo", "pet")).toBe(
			"Yeepeta'usnaypo petpo",
		);
	});

	test("keeps punctuation and spacing intact", () => {
		expect(blankToken("pet, pet.", "pet")).toBe("____, ____.");
	});
});

describe("generateWotdQuestion", () => {
	const source = {
		token: "pet",
		examples: [
			{ text: "pet or ta san", translation: "川へ下りた" },
			{ text: "Yeepeta'usnaypo.", translation: "その名だ" }, // substring only — unusable
		],
		distractors: ["kamuy", "cise", "sinep", "utar"],
	};

	test("builds a blanked question with the token among 4 choices", () => {
		const q = generateWotdQuestion(source, seededRng());
		expect(q).toBeDefined();
		expect(q?.kind).toBe("wotd-blank");
		expect(q?.prompt).toBe("____ or ta san");
		expect(q?.context).toBe("川へ下りた");
		expect(q?.choices).toHaveLength(4);
		expect(q?.choices[q?.correctIndex ?? -1]).toBe("pet");
	});

	test("only whole-word sentences are usable", () => {
		const q = generateWotdQuestion(
			{
				...source,
				examples: [{ text: "Yeepeta'usnaypo.", translation: "その名だ" }],
			},
			seededRng(),
		);
		expect(q).toBeUndefined();
	});

	test("needs at least 3 distinct distractors (folded, token excluded)", () => {
		expect(
			generateWotdQuestion(
				{ ...source, distractors: ["pet", "Pét", "kamuy", "cise"] },
				seededRng(),
			),
		).toBeUndefined();
	});

	test("distractors never include the token in any folding", () => {
		for (let seed = 1; seed <= 20; seed++) {
			const q = generateWotdQuestion(
				{ ...source, distractors: ["Pét", "kamuy", "cise", "sinep", "utar"] },
				seededRng(seed),
			);
			expect(q?.choices.filter((c) => c === "pet")).toHaveLength(1);
			expect(q?.choices).not.toContain("Pét");
		}
	});
});

describe("textContainsToken", () => {
	test("NFD text still matches", () => {
		expect(textContainsToken("sínep ne", "sinep")).toBe(true);
	});
});
