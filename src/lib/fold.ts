/** Ainu text folding shared by the WOTD cron and the WOTD quiz. */

/** NFC-normalize, casefold, and strip combining accents — mirrors glossary.ts's internal `fold`. */
export function normalizeAynu(s: string): string {
	return s
		.normalize("NFC")
		.toLowerCase()
		.normalize("NFD")
		.replace(/\p{M}/gu, "");
}

/** Folded token used for exact sense matching; removes accents, case, and glottal apostrophes. */
export function wotdKey(s: string): string {
	return normalizeAynu(s)
		.replace(/[¹²³⁴⁵⁶⁷⁸⁹⁰0-9]+$/u, "")
		.replace(/['’]/g, "")
		.replace(/\s+/g, "");
}

/**
 * Splits text into word parts on NFC text, keeping combining marks (\p{M})
 * and glottal apostrophes word-internal — NFD-stored corpus rows would
 * otherwise break at every accent (sí → s|i).
 */
export function splitAynuWords(text: string): string[] {
	return text.normalize("NFC").split(/[^\p{L}\p{M}'’]+/u);
}

/** Whether `token` appears in `text` as a whole (folded) word. */
export function textContainsToken(text: string, token: string): boolean {
	const target = wotdKey(token);
	// An all-punctuation token folds to "" and would match the empty parts the
	// splitter yields around punctuation — never treat that as a hit.
	if (target === "") return false;
	return splitAynuWords(text).some((part) => wotdKey(part) === target);
}

/** Replaces every whole-word occurrence of `token` (folded match) with `blank`. */
export function blankToken(
	text: string,
	token: string,
	blank = "____",
): string {
	const target = wotdKey(token);
	if (target === "") return text;
	return text
		.normalize("NFC")
		.split(/([^\p{L}\p{M}'’]+)/u)
		.map((part, i) => (i % 2 === 0 && wotdKey(part) === target ? blank : part))
		.join("");
}
