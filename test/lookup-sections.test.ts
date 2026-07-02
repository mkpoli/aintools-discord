import { describe, expect, test } from "bun:test";
import {
	corpusSection,
	glossarySection,
	morphemesSection,
	scriptsSection,
	toLatnQuery,
} from "../src/handlers/lookup.js";
import type { CorpusRow } from "../src/services/corpus.js";
import type { GlossaryEntry } from "../src/services/glossary.js";
import type { MdbDecomposeResult } from "../src/services/mdb.js";
import type { AllScripts } from "../src/services/script.js";

function rejected<T>(reason: unknown): PromiseSettledResult<T> {
	return { status: "rejected", reason };
}

function fulfilled<T>(value: T): PromiseSettledResult<T> {
	return { status: "fulfilled", value };
}

describe("toLatnQuery", () => {
	test("passes through text already in Latn", () => {
		expect(toLatnQuery("kamuy")).toBe("kamuy");
	});

	test("converts a detectable non-Latn script to Latn", () => {
		expect(toLatnQuery("カムイ")).toBe("kamui");
	});

	test("falls back to the raw input on Unknown script rather than throwing", () => {
		expect(toLatnQuery("123")).toBe("123");
	});
});

describe("glossarySection", () => {
	test("rejected source renders (unavailable) and has no content", () => {
		const section = glossarySection(rejected(new Error("boom")));
		expect(section.render()).toBe("(unavailable)");
		expect(section.hasContent).toBe(false);
	});

	test("fulfilled but empty renders (none) and has no content", () => {
		const section = glossarySection(fulfilled<GlossaryEntry[]>([]));
		expect(section.render()).toBe("(none)");
		expect(section.hasContent).toBe(false);
	});

	test("happy path renders Aynu — 日本語 · English lines", () => {
		const entries: GlossaryEntry[] = [
			{ Aynu: "kamuy", 日本語: "神", English: "god", sheetName: "nouns" },
			{ Aynu: "kamuynup", sheetName: "nouns" },
		];
		const section = glossarySection(fulfilled(entries));
		expect(section.hasContent).toBe(true);
		expect(section.render()).toBe("**kamuy** — 神 · god\n**kamuynup** — —");
	});
});

describe("morphemesSection", () => {
	test("rejected source renders (unavailable)", () => {
		const section = morphemesSection(rejected(new Error("boom")));
		expect(section.render()).toBe("(unavailable)");
		expect(section.hasContent).toBe(false);
	});

	test("canonical result: joined surface parts, no heuristic marker", () => {
		const result: MdbDecomposeResult = {
			form: "kamuy",
			fallback_used: false,
			analysis: {
				id: "an:kamuy",
				surface: "kamuy",
				target_kind: "lexeme",
				target_id: "kamuy-n",
				parts: ["kamuy"],
				surface_parts: ["kamuy"],
				source: "curated",
				confidence: 1,
				has_head: true,
				bracketing: [],
				note: "",
			},
		};
		const section = morphemesSection(fulfilled(result));
		expect(section.hasContent).toBe(true);
		expect(section.render()).toBe("kamuy");
		expect(section.render()).not.toContain("heuristic");
	});

	test("fallback result: joined leaf surfaces with a ⚠ heuristic marker", () => {
		const result: MdbDecomposeResult = {
			form: "aeywanke",
			fallback_used: true,
			mode: "flat",
			source: "segmented",
			unseen: false,
			arity: 2,
			tokens: ["e", "wan"],
			unresolved: ["ayke"],
			warnings: [],
			decomposition: [
				{ surface: "e", kind: "head", isLeaf: true, arity: 2, morpheme: null },
				{
					surface: "wan",
					kind: "standalone",
					isLeaf: true,
					arity: 0,
					morpheme: null,
				},
			],
		};
		const section = morphemesSection(fulfilled(result));
		expect(section.hasContent).toBe(true);
		expect(section.render()).toBe("e-wan\n-# ⚠ heuristic");
	});
});

describe("corpusSection", () => {
	test("rejected source renders (unavailable)", () => {
		const section = corpusSection(rejected(new Error("boom")));
		expect(section.render()).toBe("(unavailable)");
		expect(section.hasContent).toBe(false);
	});

	test("fulfilled but empty renders (none)", () => {
		const section = corpusSection(fulfilled<CorpusRow[]>([]));
		expect(section.render()).toBe("(none)");
		expect(section.hasContent).toBe(false);
	});

	test("happy path renders text + translation + dialect per row", () => {
		const rows: CorpusRow[] = [
			{
				id: "a#1",
				text: "kamuy",
				translation: "god",
				dialect: "沙流",
				author: null,
				collection: null,
				document: null,
				uri: null,
			},
		];
		const section = corpusSection(fulfilled(rows));
		expect(section.hasContent).toBe(true);
		expect(section.render()).toBe("**kamuy**\ngod\n-# 沙流");
	});
});

describe("scriptsSection", () => {
	test("rejected source (e.g. Unknown/Mixed script) renders (unavailable)", () => {
		const section = scriptsSection(rejected(new Error("boom")));
		expect(section.render()).toBe("(unavailable)");
		expect(section.hasContent).toBe(false);
	});

	test("happy path renders one line per script", () => {
		const result: AllScripts = {
			source: "Latn",
			scripts: {
				Latn: "kamuy",
				Kana: "カムイ",
				Cyrl: "камуй",
				Hang: "카무이",
			},
		};
		const section = scriptsSection(fulfilled(result));
		expect(section.hasContent).toBe(true);
		expect(section.render()).toContain("kamuy");
		expect(section.render()).toContain("カムイ");
		expect(section.render()).toContain("камуй");
		expect(section.render()).toContain("카무이");
	});
});
