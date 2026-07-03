import { describe, expect, test } from "bun:test";
import {
	decompositionToSurfaces,
	MAX_TOKENS,
	tokenField,
	tokenize,
} from "../src/handlers/analyze.js";
import type {
	MdbDecomposeCanonical,
	MdbDecomposeFallback,
	MdbDecomposeResult,
	MdbDecompositionNode,
} from "../src/services/mdb.js";

describe("tokenize", () => {
	test("splits on whitespace", () => {
		expect(tokenize("irankarapte aeywanke")).toEqual([
			"irankarapte",
			"aeywanke",
		]);
	});

	test("NFC-normalises before splitting", () => {
		// combining acute accent (e + U+0301) vs precomposed é (U+00E9)
		const decomposed = "éani";
		const [token] = tokenize(decomposed);
		expect(token).toBe("éani".normalize("NFC"));
		expect(token.normalize("NFC")).toBe(token);
	});

	test("strips surrounding punctuation", () => {
		expect(tokenize("“kamuy,” pirka.")).toEqual(["kamuy", "pirka"]);
	});

	test("keeps a leading or trailing '=' affix marker", () => {
		expect(tokenize("e= =an ku=e")).toEqual(["e=", "=an", "ku=e"]);
	});

	test("keeps internal punctuation (e.g. glottal-stop apostrophe)", () => {
		expect(tokenize("ku'ani.")).toEqual(["ku'ani"]);
	});

	test("drops tokens that are pure punctuation", () => {
		expect(tokenize("kamuy ... pirka")).toEqual(["kamuy", "pirka"]);
	});

	test("collapses repeated whitespace and trims", () => {
		expect(tokenize("  kamuy   pirka  ")).toEqual(["kamuy", "pirka"]);
	});

	test("returns an empty array for whitespace/punctuation-only input", () => {
		expect(tokenize("   ...  ")).toEqual([]);
	});

	test("MAX_TOKENS is 8 and a 9-token input tokenizes past it", () => {
		expect(MAX_TOKENS).toBe(8);
		const nine = "a b c d e f g h i";
		expect(tokenize(nine).length).toBe(9);
	});
});

describe("decompositionToSurfaces", () => {
	function leaf(surface: string): MdbDecompositionNode {
		return { surface, kind: "head", isLeaf: true, arity: 0, morpheme: null };
	}

	test("flat/first arrays: pass through each node's own surface", () => {
		expect(decompositionToSurfaces([leaf("e"), leaf("wan")])).toEqual([
			"e",
			"wan",
		]);
	});

	test("nested single root with no children: one surface", () => {
		expect(decompositionToSurfaces(leaf("irankarapte"))).toEqual([
			"irankarapte",
		]);
	});

	test("nested root with children: recurses to the leaves", () => {
		const root: MdbDecompositionNode = {
			surface: "nonsense",
			kind: "incorporation",
			isLeaf: false,
			arity: 2,
			morpheme: null,
			children: [leaf("non"), leaf("se"), leaf("n"), leaf("se")],
		};
		expect(decompositionToSurfaces(root)).toEqual(["non", "se", "n", "se"]);
	});
});

describe("tokenField", () => {
	function fulfilled(
		value: MdbDecomposeResult,
	): PromiseFulfilledResult<MdbDecomposeResult> {
		return { status: "fulfilled", value };
	}

	test("canonical result: surface_parts joined, with a source/confidence line", () => {
		const canonical: MdbDecomposeCanonical = {
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
		const field = tokenField("kamuy", fulfilled(canonical));
		expect(field.name).toBe("**kamuy**");
		expect(field.value).toContain("kamuy");
		expect(field.value).toContain("curated");
		expect(field.value).toContain("1.00");
		expect(field.value).not.toContain("heuristic");
	});

	test("fallback result: joined decomposition + heuristic marker + unresolved", () => {
		const fallback: MdbDecomposeFallback = {
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
		const field = tokenField("aeywanke", fulfilled(fallback));
		expect(field.name).toBe("**aeywanke**");
		expect(field.value).toContain("e-wan");
		expect(field.value).toContain("⚠ heuristic");
		expect(field.value).toContain("unresolved: ayke");
	});

	test("fallback result with warnings renders them too", () => {
		const fallback: MdbDecomposeFallback = {
			form: "x",
			fallback_used: true,
			mode: "flat",
			source: "dp",
			unseen: true,
			arity: 0,
			tokens: ["x"],
			unresolved: [],
			warnings: ["low-confidence segmentation"],
			decomposition: [
				{ surface: "x", kind: "head", isLeaf: true, arity: 0, morpheme: null },
			],
		};
		const field = tokenField("x", fulfilled(fallback));
		expect(field.value).toContain("low-confidence segmentation");
	});

	test("rejected promise: renders '(unavailable)', never throws", () => {
		const field = tokenField("brokentoken", {
			status: "rejected",
			reason: new Error("upstream down"),
		});
		expect(field.name).toBe("**brokentoken**");
		expect(field.value).toBe("(unavailable)");
	});
});
