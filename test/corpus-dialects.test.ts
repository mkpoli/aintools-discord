import { describe, expect, test } from "bun:test";
import { filterDialectChoices } from "../src/handlers/corpus.js";
import { type DialectNode, flattenDialects } from "../src/services/corpus.js";

const TREE: DialectNode[] = [
	{
		path: "北海道",
		name: "北海道",
		count: 167952,
		areas: [
			{
				path: "北海道/南西",
				name: "南西",
				count: 107549,
				dialects: [
					{ path: "北海道/南西/沙流", name: "沙流", count: 81626 },
					{ path: "北海道/南西/鵡川", name: "鵡川", count: 13544 },
				],
			},
			{
				path: "北海道/南東",
				name: "南東",
				count: 1550,
				dialects: [{ path: "北海道/南東/十勝", name: "十勝", count: 1550 }],
			},
		],
	},
	{
		path: "樺太",
		name: "樺太",
		count: 3910,
		dialects: [{ path: "樺太/小田洲", name: "小田洲", count: 3910 }],
	},
	{ path: "(unknown)", name: "(unknown)", count: 35977 },
];

describe("flattenDialects", () => {
	test("collects leaf dialects across regions, most-attested first", () => {
		expect(flattenDialects(TREE).map((d) => d.name)).toEqual([
			"沙流",
			"鵡川",
			"小田洲",
			"十勝",
		]);
	});

	test("drops the (unknown) bucket", () => {
		expect(flattenDialects(TREE).some((d) => d.name === "(unknown)")).toBe(
			false,
		);
	});
});

describe("filterDialectChoices", () => {
	const choices = flattenDialects(TREE);

	test("empty query returns everything up to the limit", () => {
		expect(filterDialectChoices(choices, "")).toHaveLength(4);
		expect(filterDialectChoices(choices, "", 2)).toHaveLength(2);
	});

	test("substring match keeps count order", () => {
		expect(filterDialectChoices(choices, "沙").map((d) => d.name)).toEqual([
			"沙流",
		]);
	});

	test("no match returns []", () => {
		expect(filterDialectChoices(choices, "静内")).toEqual([]);
	});
});
