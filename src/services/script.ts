/**
 * Script conversion for Ainu text — thin wrappers around `ainconv`.
 *
 * Ports ainu-mcp/worker/src/tools/script.ts to the real ainconv@0.5.1 API,
 * which differs from that (older) reference: script names are PascalCase
 * ("Latn"/"Kana"/"Cyrl"/"Hang"), Hangul is natively supported, and
 * `detect()` returns "Mixed"/"Unknown" as first-class outcomes rather than
 * always resolving to one of the four real scripts.
 */
import { convert, detect, type Script } from "ainconv";

export type ScriptName = Script; // "Latn" | "Kana" | "Cyrl" | "Hang"
export type Detected = ScriptName | "Mixed" | "Unknown";

export const SCRIPTS: readonly ScriptName[] = ["Latn", "Kana", "Cyrl", "Hang"];

/** Each script's own name, written in itself — shared by option choices and embeds. */
export const SCRIPT_LABELS: Record<ScriptName, string> = {
	Latn: "Latn",
	Kana: "カタカナ Kana",
	Cyrl: "Кириллица Cyrl",
	Hang: "한글 Hang",
};

/** Thrown by `convertText`/`allScripts` when no script is detectable in the input. */
export class UnknownScriptError extends Error {
	constructor(text: string) {
		super(`no Ainu script detected in: ${JSON.stringify(text)}`);
		this.name = "UnknownScriptError";
	}
}

/** Thrown when text mixes scripts and no explicit `from` was given to disambiguate. */
export class MixedScriptError extends Error {
	constructor(text: string) {
		super(
			`mixed scripts in: ${JSON.stringify(text)} — an explicit \`from\` is required`,
		);
		this.name = "MixedScriptError";
	}
}

// ainconv's own `detect()` never flags Hangul as part of a "Mixed" verdict —
// e.g. detect("aynu이란") => "Hang", not "Mixed" — Latin is masked whenever
// Hangul is present. Kana beats Cyrl beats Hang beats Latin in priority.
//
// Exported (not just an internal helper) so callers — e.g. the /convert
// handler — can pin down the source once, up front, and reuse it both for
// display ("Latn → Kana") and for the actual conversion, instead of calling
// `detect()` a second time.
export function resolveScript(text: string, from?: ScriptName): ScriptName {
	const source = from ?? detect(text);
	if (source === "Unknown") throw new UnknownScriptError(text);
	if (source === "Mixed") throw new MixedScriptError(text);
	return source;
}

/** Detect the script of `text`: one of the 4 scripts, "Mixed", or "Unknown". */
export function detectScript(text: string): Detected {
	return detect(text);
}

/**
 * Convert `text` from `from` (auto-detected when omitted) to `to`. Always
 * throws on failure — Mixed/Unknown source, or input ainconv can't parse —
 * never silently returns the input unchanged (the old bot's swallow bug).
 */
export function convertText(
	text: string,
	from: ScriptName | undefined,
	to: ScriptName,
): string {
	return convert(text, resolveScript(text, from), to);
}

export type AllScripts = {
	source: ScriptName;
	scripts: Record<ScriptName, string>;
};

/**
 * Convert `text` into all 4 scripts at once, resolving the source via
 * `detectScript` unless `from` overrides it.
 */
export function allScripts(text: string, from?: ScriptName): AllScripts {
	const source = resolveScript(text, from);
	const scripts = Object.fromEntries(
		SCRIPTS.map((target) => [
			target,
			target === source ? text : convert(text, source, target),
		]),
	) as Record<ScriptName, string>;
	return { source, scripts };
}
