import { describe, expect, it } from "bun:test";
import {
	allScripts,
	convertText,
	detectScript,
	MixedScriptError,
	SCRIPTS,
	UnknownScriptError,
} from "../src/services/script.js";

// All expected outputs below were captured by running the real ainconv@0.5.1
// against these inputs — they pin the contract, not an assumption.

describe("detectScript", () => {
	it("detects each of the four scripts", () => {
		expect(detectScript("irankarapte")).toBe("Latn");
		expect(detectScript("イランカラㇷ゚テ")).toBe("Kana");
		expect(detectScript("иранкараптэ")).toBe("Cyrl");
		expect(detectScript("이란가랍더")).toBe("Hang");
	});

	it("reports Unknown for text with no Ainu-script characters, including empty", () => {
		expect(detectScript("")).toBe("Unknown");
		expect(detectScript("123")).toBe("Unknown");
	});

	it("reports Mixed for Latin+Kana or Latin+Cyrillic combinations", () => {
		expect(detectScript("aynuイランカラ")).toBe("Mixed");
		expect(detectScript("aynuайну")).toBe("Mixed");
	});

	it("never reports Mixed for Hangul — Hangul masks a co-occurring Latin run", () => {
		// ainconv's detect() excludes Hangul from the Mixed check entirely, so
		// Latin+Hangul text resolves to plain "Hang", not "Mixed".
		expect(detectScript("aynu이란")).toBe("Hang");
	});
});

describe("convertText — round-trips", () => {
	it("round-trips 'irankarapte' through Kana", () => {
		const kana = convertText("irankarapte", "Latn", "Kana");
		expect(kana).toBe("イランカラㇷ゚テ");
		expect(convertText(kana, "Kana", "Latn")).toBe("irankarapte");
	});

	it("converts the sentence 'aynu itak' to Kana, Cyrl, and Hang", () => {
		expect(convertText("aynu itak", "Latn", "Kana")).toBe("アイヌ イタㇰ");
		expect(convertText("aynu itak", "Latn", "Cyrl")).toBe("айну итак");
		expect(convertText("aynu itak", "Latn", "Hang")).toBe("애누 이닥");
	});

	it("Kana round-trip of 'aynu itak' is lossy (documents ainconv's own ambiguity, not a bug)", () => {
		// Kana can't distinguish "ay" from "ai" (both アイ), so the round-trip
		// normalizes "aynu" -> "ainu". This is ainconv's documented behavior.
		const kana = convertText("aynu itak", "Latn", "Kana");
		expect(convertText(kana, "Kana", "Latn")).toBe("ainu itak");
	});

	it("round-trips 'irankarapte' through Cyrl and through Hang", () => {
		const cyrl = convertText("irankarapte", "Latn", "Cyrl");
		expect(cyrl).toBe("иранкараптэ");
		expect(convertText(cyrl, "Cyrl", "Latn")).toBe("irankarapte");

		const hang = convertText("irankarapte", "Latn", "Hang");
		expect(hang).toBe("이란가랍더");
		expect(convertText(hang, "Hang", "Latn")).toBe("irankarapte");
	});

	it("auto-detects `from` when omitted", () => {
		expect(convertText("irankarapte", undefined, "Kana")).toBe(
			"イランカラㇷ゚テ",
		);
	});

	it("same-script conversion is an identity, not an error", () => {
		expect(convertText("irankarapte", "Latn", "Latn")).toBe("irankarapte");
	});
});

describe("convertText — error paths (must throw, never swallow)", () => {
	it("throws UnknownScriptError for text with no detectable script", () => {
		expect(() => convertText("123", undefined, "Latn")).toThrow(
			UnknownScriptError,
		);
		expect(() => convertText("", undefined, "Latn")).toThrow(
			UnknownScriptError,
		);
	});

	it("throws MixedScriptError for mixed-script text with no explicit `from`", () => {
		expect(() => convertText("aynuイランカラ", undefined, "Latn")).toThrow(
			MixedScriptError,
		);
	});

	it("does not throw Mixed/Unknown errors when `from` is given explicitly", () => {
		// The caller's `from` always wins over detection.
		expect(convertText("aynuイランカラ", "Latn", "Kana")).toBeTypeOf("string");
		expect(convertText("123", "Latn", "Kana")).toBeTypeOf("string");
	});
});

describe("allScripts", () => {
	it("returns all 4 scripts with the detected source marked, source unchanged", () => {
		const { source, scripts } = allScripts("irankarapte");
		expect(source).toBe("Latn");
		expect(scripts.Latn).toBe("irankarapte");
		expect(scripts.Kana).toBe("イランカラㇷ゚テ");
		expect(scripts.Cyrl).toBe("иранкараптэ");
		expect(scripts.Hang).toBe("이란가랍더");
		expect(Object.keys(scripts).sort()).toEqual([...SCRIPTS].sort());
	});

	it("honors an explicit `from` override even over a different detected script", () => {
		const { source, scripts } = allScripts("иранкараптэ", "Latn");
		expect(source).toBe("Latn");
		// Treated as if it were Latin input — garbage in, garbage out, but it
		// must not silently ignore the override and use the detected Cyrl.
		expect(scripts.Latn).toBe("иранкараптэ");
	});

	it("throws UnknownScriptError / MixedScriptError instead of returning partial results", () => {
		expect(() => allScripts("")).toThrow(UnknownScriptError);
		expect(() => allScripts("aynuайну")).toThrow(MixedScriptError);
	});
});
