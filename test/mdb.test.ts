import { afterEach, describe, expect, test } from "bun:test";
import { decompose, forms } from "../src/services/mdb.js";

function fakeEnv(): Env {
	return {
		CORPUS_API_URL: "https://corpus.aynu.org",
		MDB_API_URL: "https://mdb.aynu.org",
	} as unknown as Env;
}

const originalFetch = globalThis.fetch;

function stubFetch(body: unknown, status = 200) {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("mdb service — decompose()", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	// Synthetic canonical shape mirroring `analysisView()` in
	// ainu-morpheme-database/web/src/routes/api/decompose/+server.ts — live mdb
	// currently returns `fallback_used: true` for every probed form (verified
	// 2026-07-03), so this exercises the `fallback_used: false` branch offline.
	test("parses a canonical (fallback_used: false) response", async () => {
		stubFetch({
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
		});
		const result = await decompose(fakeEnv(), "kamuy", "flat");
		expect(result.fallback_used).toBe(false);
		if (result.fallback_used) throw new Error("expected canonical result");
		expect(result.analysis.surface_parts).toEqual(["kamuy"]);
		expect(result.analysis.source).toBe("curated");
		expect(result.analysis.confidence).toBe(1);
	});

	// Fixture mirrors a trimmed live response from
	// `curl "https://mdb.aynu.org/api/decompose?form=aeywanke&mode=flat"`
	// (verified 2026-07-03).
	test("parses a fallback (fallback_used: true) response, flat mode", async () => {
		stubFetch({
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
				{
					surface: "e",
					kind: "head",
					isLeaf: true,
					arity: 2,
					morpheme: {
						id: "e-eat",
						lemma: "e",
						allomorphs: [],
						category: "vt",
						morph_type: "root",
						glosses_en: ["eat"],
						glosses_jp: ["～を食べる"],
						bound: false,
						verified: true,
						frequency: 3732,
					},
				},
				{
					surface: "wan",
					kind: "standalone",
					isLeaf: true,
					arity: 0,
					morpheme: {
						id: "wan",
						lemma: "wan",
						allomorphs: [],
						category: "num",
						morph_type: "root",
						glosses_en: ["ten", "10"],
						glosses_jp: ["十", "十の", "10"],
						bound: false,
						verified: true,
						frequency: 235,
					},
				},
			],
		});
		const result = await decompose(fakeEnv(), "aeywanke", "flat");
		expect(result.fallback_used).toBe(true);
		if (!result.fallback_used) throw new Error("expected fallback result");
		expect(result.source).toBe("segmented");
		expect(result.unresolved).toEqual(["ayke"]);
		expect(Array.isArray(result.decomposition)).toBe(true);
		expect((result.decomposition as unknown[]).length).toBe(2);
	});

	// Fixture mirrors a trimmed live response from
	// `curl "https://mdb.aynu.org/api/decompose?form=irankarapte&mode=nested"`
	// (verified 2026-07-03) — nested mode returns a single root node, not an array.
	test("parses a fallback response, nested mode (single root node)", async () => {
		stubFetch({
			form: "irankarapte",
			fallback_used: true,
			mode: "nested",
			source: "direct",
			unseen: false,
			arity: 0,
			tokens: ["irankarapte"],
			unresolved: [],
			warnings: [],
			decomposition: {
				surface: "irankarapte",
				kind: "head",
				isLeaf: true,
				arity: 0,
				morpheme: {
					id: "irankarapte",
					lemma: "irankarapte",
					allomorphs: [],
					category: "intj",
					morph_type: "root",
					glosses_en: ["hello"],
					glosses_jp: ["ご挨拶申し上げます"],
					bound: false,
					verified: false,
					frequency: 48,
				},
			},
		});
		const result = await decompose(fakeEnv(), "irankarapte", "nested");
		expect(result.fallback_used).toBe(true);
		if (!result.fallback_used) throw new Error("expected fallback result");
		expect(Array.isArray(result.decomposition)).toBe(false);
	});
});

describe("mdb service — forms()", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("parses the query/total/returned/results envelope", async () => {
		stubFetch({
			query: "kotan",
			total: 1,
			returned: 1,
			results: [
				{
					id: "f1",
					lemma_id: "kotan",
					lexeme_id: "",
					surface: "kotanihi",
					analysis: "kotan + 3SG.POSS",
					feature_bundle: { domain: "nominal", relation: "possessed" },
					source: "attested",
					confidence: 0.9,
					rule_id: "",
					attested_ref: "kayano",
				},
			],
		});
		const result = await forms(fakeEnv(), "kotan", 3);
		expect(result.total).toBe(1);
		expect(result.results[0].source).toBe("attested");
		expect(result.results[0].surface).toBe("kotanihi");
	});

	test("empty results (query with no matching forms)", async () => {
		stubFetch({ query: "zzz", total: 0, returned: 0, results: [] });
		const result = await forms(fakeEnv(), "zzz", 3);
		expect(result.results).toEqual([]);
	});
});
