import { describe, expect, test } from "bun:test";
import {
	buildSources,
	capSources,
	extractAinuTokens,
	type RetrievedSource,
} from "../src/handlers/ask.js";
import type { CorpusRow } from "../src/services/corpus.js";
import type { GlossaryEntry } from "../src/services/glossary.js";
import type { MdbDecomposeResult } from "../src/services/mdb.js";

describe("extractAinuTokens", () => {
	test("extracts Latin-script Ainu-looking tokens, lowercased", () => {
		expect(extractAinuTokens("What does Kamuy mean?", 2)).toEqual(["kamuy"]);
	});

	test("filters obvious English stopwords", () => {
		const tokens = extractAinuTokens("What is the meaning of pirka", 5);
		expect(tokens).toEqual(["pirka"]);
	});

	test("filters obvious romanized-Japanese particles", () => {
		const tokens = extractAinuTokens("kamuy wa pirka desu ka", 5);
		expect(tokens).toEqual(["kamuy", "pirka"]);
	});

	test("caps at `max` tokens even when more candidates are present", () => {
		const tokens = extractAinuTokens("kamuy pirka sinep tu re", 2);
		expect(tokens).toHaveLength(2);
		expect(tokens).toEqual(["kamuy", "pirka"]);
	});

	test("dedupes repeated tokens", () => {
		const tokens = extractAinuTokens("kamuy kamuy pirka", 2);
		expect(tokens).toEqual(["kamuy", "pirka"]);
	});

	test("ignores non-Latin (kana/kanji) text entirely", () => {
		expect(extractAinuTokens("カムイとは何ですか", 5)).toEqual([]);
	});

	test("keeps the glottal-stop apostrophe, '=' affix marker, and '-'", () => {
		const tokens = extractAinuTokens("e=asuretasnukar and hemesu-an ru'ur", 5);
		expect(tokens).toContain("e=asuretasnukar");
		expect(tokens).toContain("hemesu-an");
		expect(tokens).toContain("ru'ur");
	});
});

describe("buildSources", () => {
	const entry = (aynu: string, en: string): GlossaryEntry => ({
		Aynu: aynu,
		English: en,
		sheetName: "test",
	});

	const canonical = (form: string): MdbDecomposeResult => ({
		form,
		fallback_used: false,
		analysis: {
			id: "a1",
			surface: form,
			target_kind: "lexeme",
			target_id: null,
			parts: [form],
			surface_parts: [form],
			source: "curated",
			confidence: 1,
			has_head: true,
			bracketing: [],
			note: "",
		},
	});

	const corpusRow = (text: string): CorpusRow => ({
		id: "r1",
		text,
		translation: "translated",
		dialect: "沙流",
		author: null,
		collection: null,
		document: "doc-1",
		uri: null,
	});

	test("numbers glossary results sequentially across tokens (continuing, not resetting per token)", () => {
		const sources = buildSources(
			["kamuy", "pirka"],
			[
				[entry("kamuy", "god")],
				[entry("pirka", "good"), entry("pirka2", "nice")],
			],
			[null, null],
			[],
		);
		expect(sources.map((s) => s.id)).toEqual(["G1", "G2", "G3"]);
	});

	test("mdb tag numbering skips gaps left by a missing/failed token result", () => {
		const sources = buildSources(
			["kamuy", "pirka"],
			[[], []],
			[null, canonical("pirka")],
			[],
		);
		expect(sources).toHaveLength(1);
		expect(sources[0]).toMatchObject({ id: "M1", ref: "pirka" });
	});

	test("corpus rows are tagged C1.. in order", () => {
		const sources = buildSources([], [], [], [corpusRow("a"), corpusRow("b")]);
		expect(sources.map((s) => s.id)).toEqual(["C1", "C2"]);
	});

	test("refs: glossary uses the Aynu term, corpus uses document · dialect, mdb uses the token", () => {
		const sources = buildSources(
			["kamuy"],
			[[entry("kamuy", "god")]],
			[canonical("kamuy")],
			[corpusRow("kamuy anak ...")],
		);
		const byId = Object.fromEntries(sources.map((s) => [s.id, s]));
		expect(byId.G1.ref).toBe("kamuy");
		expect(byId.M1.ref).toBe("kamuy");
		expect(byId.C1.ref).toBe("doc-1 · 沙流");
	});

	test("combines all three kinds in glossary → mdb → corpus order", () => {
		const sources = buildSources(
			["kamuy"],
			[[entry("kamuy", "god")]],
			[canonical("kamuy")],
			[corpusRow("kamuy anak ...")],
		);
		expect(sources.map((s) => s.id)).toEqual(["G1", "M1", "C1"]);
	});
});

describe("capSources", () => {
	function source(id: string, textLength: number): RetrievedSource {
		return { id, ref: id, text: "x".repeat(textLength) };
	}

	test("keeps every source when the total is under the cap", () => {
		const sources = [source("G1", 10), source("C1", 10)];
		expect(capSources(sources, 4000)).toEqual(sources);
	});

	test("drops later sources once the running total would exceed the cap", () => {
		const sources = [source("G1", 100), source("C1", 100), source("C2", 100)];
		const capped = capSources(sources, 150);
		expect(capped.map((s) => s.id)).toEqual(["G1"]);
	});

	test("always keeps the first source even if it alone exceeds the cap", () => {
		const sources = [source("C1", 5000), source("C2", 10)];
		const capped = capSources(sources, 4000);
		expect(capped.map((s) => s.id)).toEqual(["C1"]);
	});

	test("empty input yields empty output", () => {
		expect(capSources([], 4000)).toEqual([]);
	});
});
