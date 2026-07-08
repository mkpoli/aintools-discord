import { describe, expect, test } from "bun:test";
import {
	exactLexemeRows,
	filterCandidates,
	glossaryExactEntry,
	isCandidateToken,
	jstDateString,
	pickIndex,
	probeForGlossaryHit,
	selectWotdLexeme,
	shiftDateString,
	shortestTranslatedExample,
} from "../src/cron/wotd.js";
import { fnv1a } from "../src/lib/hash.js";
import type { CorpusRow } from "../src/services/corpus.js";
import type { GlossaryEntry } from "../src/services/glossary.js";
import type { MdbLexemeSearchRow } from "../src/services/mdb.js";

describe("fnv1a — FNV-1a 32-bit", () => {
	// Canonical FNV-1a-32 test vectors (http://www.isthe.com/chongo/src/fnv/test_fnv.c).
	test("matches canonical test vectors", () => {
		expect(fnv1a("")).toBe(2166136261);
		expect(fnv1a("a")).toBe(3826002220);
		expect(fnv1a("b")).toBe(3876335077);
		expect(fnv1a("c")).toBe(3859557458);
		expect(fnv1a("foobar")).toBe(3214735720);
	});

	test("is deterministic — same input always yields the same hash", () => {
		expect(fnv1a("2026-07-03")).toBe(fnv1a("2026-07-03"));
	});

	test("different dates hash differently (no obvious collision for adjacent days)", () => {
		expect(fnv1a("2026-07-03")).not.toBe(fnv1a("2026-07-04"));
	});

	test("returns an unsigned 32-bit integer", () => {
		for (const s of ["", "x", "a long string with spaces", "アイヌ"]) {
			const h = fnv1a(s);
			expect(h).toBeGreaterThanOrEqual(0);
			expect(h).toBeLessThanOrEqual(0xffffffff);
			expect(Number.isInteger(h)).toBe(true);
		}
	});
});

describe("jstDateString / shiftDateString", () => {
	test("formats as YYYY-MM-DD in JST (UTC+9)", () => {
		// 2026-07-03T15:00:00Z = 2026-07-04T00:00:00+09:00
		expect(jstDateString(new Date("2026-07-03T15:00:00Z"))).toBe("2026-07-04");
		// 2026-07-03T14:59:00Z = 2026-07-03T23:59:00+09:00 (still the 3rd)
		expect(jstDateString(new Date("2026-07-03T14:59:00Z"))).toBe("2026-07-03");
	});

	test("shiftDateString moves forward and backward across month/year boundaries", () => {
		expect(shiftDateString("2026-07-03", -180)).toBe("2026-01-04");
		expect(shiftDateString("2026-01-01", -1)).toBe("2025-12-31");
		expect(shiftDateString("2026-07-03", 0)).toBe("2026-07-03");
		expect(shiftDateString("2026-07-03", 1)).toBe("2026-07-04");
	});
});

describe("isCandidateToken", () => {
	test("accepts plain lowercase Ainu tokens", () => {
		expect(isCandidateToken("kamuy")).toBe(true);
		expect(isCandidateToken("utar")).toBe(true);
	});

	test("accepts the apostrophe (glottal stop), e.g. ne'ampe", () => {
		expect(isCandidateToken("ne'ampe")).toBe(true);
	});

	test("accepts accented Latin letters (dialect orthographies), e.g. néno", () => {
		expect(isCandidateToken("néno")).toBe(true);
	});

	test("rejects tokens shorter than 2 chars", () => {
		expect(isCandidateToken("e")).toBe(false);
		expect(isCandidateToken("")).toBe(false);
	});

	test("rejects tokens containing an affix `=` marker", () => {
		expect(isCandidateToken("ku=oyra")).toBe(false);
	});

	test("rejects tokens containing digits", () => {
		expect(isCandidateToken("word2")).toBe(false);
		expect(isCandidateToken("2026")).toBe(false);
	});

	test("rejects tokens with other punctuation", () => {
		expect(isCandidateToken("foo-bar")).toBe(false);
		expect(isCandidateToken("foo.bar")).toBe(false);
		expect(isCandidateToken("foo,bar")).toBe(false);
	});
});

describe("filterCandidates", () => {
	test("drops ineligible tokens (short/=/digits/punctuation) and dedupes", () => {
		const rows = [
			{ token: "kamuy" },
			{ token: "e" }, // too short
			{ token: "ku=oyra" }, // affix marker
			{ token: "word2" }, // digit
			{ token: "kamuy" }, // duplicate
			{ token: "utar" },
		];
		expect(filterCandidates(rows, new Set())).toEqual(["kamuy", "utar"]);
	});

	test("excludes tokens posted within the recent window", () => {
		const rows = [{ token: "kamuy" }, { token: "utar" }, { token: "sinep" }];
		expect(filterCandidates(rows, new Set(["utar"]))).toEqual([
			"kamuy",
			"sinep",
		]);
	});

	test("preserves the input order of the surviving tokens", () => {
		const rows = [{ token: "c" }, { token: "aa" }, { token: "bb" }];
		expect(filterCandidates(rows, new Set())).toEqual(["aa", "bb"]);
	});

	test("returns [] when every row is filtered out", () => {
		const rows = [{ token: "e" }, { token: "1" }, { token: "a=b" }];
		expect(filterCandidates(rows, new Set())).toEqual([]);
	});
});

describe("pickIndex", () => {
	test("is deterministic for a fixed date and candidate count", () => {
		expect(pickIndex("2026-07-03", 37)).toBe(pickIndex("2026-07-03", 37));
	});

	test("always lands within [0, candidateCount)", () => {
		for (let n = 1; n <= 50; n++) {
			const idx = pickIndex("2026-07-03", n);
			expect(idx).toBeGreaterThanOrEqual(0);
			expect(idx).toBeLessThan(n);
		}
	});

	test("matches fnv1a(date) % candidateCount directly", () => {
		expect(pickIndex("2026-07-03", 400)).toBe(fnv1a("2026-07-03") % 400);
	});

	test("throws for a non-positive candidate count", () => {
		expect(() => pickIndex("2026-07-03", 0)).toThrow();
	});
});

describe("probeForGlossaryHit", () => {
	const candidates = ["aa", "bb", "cc", "dd", "ee"];

	test("returns the start candidate immediately when it already has a hit", () => {
		const result = probeForGlossaryHit(candidates, 0, (t) => t === "aa");
		expect(result).toEqual({ token: "aa", index: 0, hasGloss: true });
	});

	test("probes forward to the first token with a hit", () => {
		const result = probeForGlossaryHit(candidates, 1, (t) => t === "dd");
		expect(result).toEqual({ token: "dd", index: 3, hasGloss: true });
	});

	test("wraps around the end of the candidate list", () => {
		// start at "dd" (index 3); only "bb" (index 1) has a hit — must wrap.
		const result = probeForGlossaryHit(candidates, 3, (t) => t === "bb");
		expect(result).toEqual({ token: "bb", index: 1, hasGloss: true });
	});

	test("falls back to the original hash pick when no hit is found within maxProbe", () => {
		const result = probeForGlossaryHit(candidates, 2, () => false);
		expect(result).toEqual({ token: "cc", index: 2, hasGloss: false });
	});

	test("never probes further than maxProbe attempts", () => {
		const many = Array.from({ length: 100 }, (_, i) => `t${i}`);
		let calls = 0;
		const result = probeForGlossaryHit(
			many,
			0,
			(t) => {
				calls++;
				return t === "t50"; // outside the default 20-probe window from index 0
			},
			20,
		);
		expect(result.hasGloss).toBe(false);
		expect(calls).toBe(20);
	});

	test("never probes more times than the candidate list is long", () => {
		let calls = 0;
		probeForGlossaryHit(candidates, 0, () => {
			calls++;
			return false;
		});
		expect(calls).toBe(candidates.length);
	});
});

describe("glossaryExactEntry", () => {
	const table: GlossaryEntry[] = [
		{ Aynu: "sínep", 日本語: "一つ", English: "one", sheetName: "numbers" },
		{ Aynu: "sinep tuye", 日本語: "一つ切る", sheetName: "numbers" },
		{ 日本語: "アイヌ語なし", sheetName: "misc" },
	];

	test("finds an exact (accent/case-insensitive) Aynu match", () => {
		expect(glossaryExactEntry(table, "sinep")?.日本語).toBe("一つ");
		expect(glossaryExactEntry(table, "SINEP")?.日本語).toBe("一つ");
	});

	test("does not match a mere prefix/substring as 'exact'", () => {
		// searchGlossary would surface "sinep tuye" as a *prefix* match for the
		// query "sinep tuy" (missing the final "e") — glossaryExactEntry must
		// still reject it, since the folded strings aren't equal.
		expect(glossaryExactEntry(table, "sinep tuy")).toBeUndefined();
	});

	test("returns undefined when there is no glossary entry at all", () => {
		expect(glossaryExactEntry(table, "nonexistentword")).toBeUndefined();
	});
});

describe("MDB lexeme selection for WOTD", () => {
	const lexeme = (
		partial: Partial<MdbLexemeSearchRow> &
			Pick<MdbLexemeSearchRow, "id" | "lemma">,
	): MdbLexemeSearchRow => ({
		kana: "",
		pos: "n",
		gloss_en: [],
		gloss_jp: [],
		bound: false,
		dialects: [],
		variations: [],
		recordings: 0,
		morphemes: [],
		...partial,
	});

	const example = (text: string, translation: string): CorpusRow => ({
		id: "s1",
		text,
		translation,
		dialect: "沙流",
		author: null,
		collection: null,
		document: null,
		uri: null,
	});

	test("exact lexeme rows treat accented/numbered nina variants as one token key", () => {
		const rows = [
			lexeme({ id: "nina.vi", lemma: "nina¹" }),
			lexeme({ id: "nina.vt", lemma: "nina²" }),
			lexeme({ id: "ninasamampe.n", lemma: "ninasamampe" }),
		];
		expect(exactLexemeRows(rows, "nína").map((r) => r.id)).toEqual([
			"nina.vi",
			"nina.vt",
		]);
	});

	test("nina firewood example selects the firewood verb, not place/fish senses", () => {
		const rows = [
			lexeme({
				id: "nina.vi",
				lemma: "nina¹",
				pos: "vi",
				gloss_jp: ["薪を採る；日常生活においてはおもに女性の仕事である"],
				gloss_en: ["gather firewood"],
			}),
			lexeme({
				id: "nina.vt",
				lemma: "nina²",
				pos: "vt",
				gloss_jp: ["～をこねつぶす"],
			}),
			lexeme({
				id: "nina.n",
				lemma: "nina",
				pos: "n",
				gloss_jp: ["ヒラメ"],
			}),
			lexeme({
				id: "nina.propn",
				lemma: "Nina",
				pos: "propn",
				gloss_jp: ["荷菜"],
			}),
		];
		const selected = selectWotdLexeme(
			"nina",
			rows,
			example("semas nina poka suke poka", "粗末な薪でも料理でも"),
		);
		expect(selected.ambiguous).toBe(false);
		expect(selected.lexeme?.id).toBe("nina.vi");
	});

	test("nina mash-context example selects the mash verb (hiragana gloss こねつぶす)", () => {
		const rows = [
			lexeme({
				id: "nina.vi",
				lemma: "nina¹",
				pos: "vi",
				gloss_jp: ["薪を採る"],
			}),
			lexeme({
				id: "nina.vt",
				lemma: "nina²",
				pos: "vt",
				gloss_jp: ["～をこねつぶす"],
			}),
			lexeme({ id: "nina.n", lemma: "nina", pos: "n", gloss_jp: ["ヒラメ"] }),
			lexeme({
				id: "nina.propn",
				lemma: "Nina",
				pos: "propn",
				gloss_jp: ["荷菜"],
			}),
		];
		const selected = selectWotdLexeme(
			"nina",
			rows,
			example("kem nina", "筋子をこねつぶす"),
		);
		expect(selected.ambiguous).toBe(false);
		expect(selected.lexeme?.id).toBe("nina.vt");
	});

	test("lemma with a caseless first char (apostrophe) is NOT a proper name", () => {
		// A lemma like ’itak / 'itak starts with a caseless apostrophe; the old
		// toUpperCase() check wrongly treated it as a proper name and dropped it.
		const rows = [
			lexeme({
				id: "itak.vi",
				lemma: "’itak",
				pos: "vi",
				gloss_jp: ["話す"],
			}),
		];
		const selected = selectWotdLexeme("’itak", rows, example("’itak", "話す"));
		expect(selected.ambiguous).toBe(false);
		expect(selected.lexeme?.id).toBe("itak.vi");
	});

	test("ambiguous bare homograph is skipped when context cannot choose a sense", () => {
		const selected = selectWotdLexeme(
			"nina",
			[
				lexeme({
					id: "nina.vi",
					lemma: "nina¹",
					pos: "vi",
					gloss_jp: ["薪を採る"],
				}),
				lexeme({ id: "nina.n", lemma: "nina", pos: "n", gloss_jp: ["ヒラメ"] }),
			],
			example("nina ne.", "それである。"),
		);
		expect(selected).toEqual({ lexeme: undefined, ambiguous: true });
	});
});

describe("shortestTranslatedExample", () => {
	const row = (
		partial: Partial<CorpusRow> & Pick<CorpusRow, "text">,
	): CorpusRow => ({
		id: "id",
		translation: null,
		dialect: null,
		author: null,
		collection: null,
		document: null,
		uri: null,
		...partial,
	});

	test("picks the shortest row that has a translation", () => {
		const rows = [
			row({ text: "a long ainu sentence here", translation: "long" }),
			row({ text: "short", translation: "s" }),
			row({ text: "medium length", translation: "m" }),
		];
		expect(shortestTranslatedExample(rows)?.text).toBe("short");
	});

	test("ignores rows with a null or blank translation", () => {
		const rows = [
			row({ text: "aa", translation: null }),
			row({ text: "bbbb", translation: "  " }),
			row({ text: "cccccc", translation: "has one" }),
		];
		expect(shortestTranslatedExample(rows)?.text).toBe("cccccc");
	});

	test("returns undefined when no row has a translation", () => {
		const rows = [row({ text: "aa" }), row({ text: "b" })];
		expect(shortestTranslatedExample(rows)).toBeUndefined();
	});

	test("returns undefined for an empty list", () => {
		expect(shortestTranslatedExample([])).toBeUndefined();
	});
});
