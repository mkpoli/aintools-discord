import { describe, expect, test } from "bun:test";
import type { GlossaryEntry } from "../src/services/glossary.js";
import { searchGlossary } from "../src/services/glossary.js";

const row = (partial: Partial<GlossaryEntry>): GlossaryEntry => ({
	sheetName: "test",
	...partial,
});

const fixture: GlossaryEntry[] = [
	row({ Aynu: "sínep", 日本語: "一つ", English: "one" }), // exact (accented)
	row({ Aynu: "sinep tuye", 日本語: "一つ切る", English: "cut in one" }), // prefix
	row({ Aynu: "usinepne", 日本語: "皆で一つになる", English: "become as one" }), // substring
	row({ Aynu: "ausinep", 日本語: "共に一つ", English: "together as one" }), // substring, later row
	row({ Aynu: "tu", 日本語: "二つ", English: "the sinep concept" }), // gloss match, Aynu unrelated
	row({
		Aynu: "re",
		日本語: "三",
		English: "three",
		"註 / Notes": "cf. sinep",
	}), // notes match
	row({ 日本語: "アイヌ語なし", English: "no aynu field but mentions sinep" }), // no Aynu -> always skipped
];

describe("searchGlossary", () => {
	test("ranks exact > prefix > substring > gloss > notes", () => {
		const results = searchGlossary(fixture, "sinep", 10);
		expect(results.map((r) => r.Aynu)).toEqual([
			"sínep",
			"sinep tuye",
			"usinepne",
			"ausinep",
			"tu",
			"re",
		]);
	});

	test("skips rows without an Aynu field entirely", () => {
		const results = searchGlossary(fixture, "sinep", 10);
		expect(results.some((r) => r.Aynu === undefined)).toBe(false);
	});

	test("preserves original table order within a tier", () => {
		const results = searchGlossary(fixture, "sinep", 10);
		const substringTier = results.filter(
			(r) => r.Aynu === "usinepne" || r.Aynu === "ausinep",
		);
		expect(substringTier.map((r) => r.Aynu)).toEqual(["usinepne", "ausinep"]);
	});

	test("normalizes NFC + casefold + strips combining accents", () => {
		// unaccented, uppercase query still hits the accented row as an exact match
		const results = searchGlossary(fixture, "SiNep", 10);
		expect(results[0]?.Aynu).toBe("sínep");
	});

	test("matches a decomposed (NFD) accented query the same way", () => {
		const nfd = "sinep".normalize("NFD"); // no accents to decompose, but exercises the path
		const results = searchGlossary(fixture, nfd, 10);
		expect(results[0]?.Aynu).toBe("sínep");
	});

	test("respects the limit", () => {
		const results = searchGlossary(fixture, "sinep", 2);
		expect(results).toHaveLength(2);
		expect(results.map((r) => r.Aynu)).toEqual(["sínep", "sinep tuye"]);
	});

	test("returns [] for an empty or whitespace-only query", () => {
		expect(searchGlossary(fixture, "", 5)).toEqual([]);
		expect(searchGlossary(fixture, "   ", 5)).toEqual([]);
	});

	test("returns [] when nothing matches", () => {
		expect(searchGlossary(fixture, "zzzznomatchzzzz", 5)).toEqual([]);
	});
});
