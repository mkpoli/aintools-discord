/**
 * Pure /quiz question generation + the button custom_value codec.
 *
 * Everything here is deterministic given an injected `rng: () => number`
 * (same contract as `Math.random`) — no I/O, no Discord types — so it's
 * fully unit-testable with a seeded generator.
 */
import type { CourseData, Sentence, Vocab } from "../data/types.js";

export type QuizMode = "vocab" | "sentence" | "mixed";

/**
 * Fine-grained question variant. This is deliberately more specific than
 * just "vocab" | "sentence" because the button payload (`kind:itemId:...`)
 * has no separate field for direction/scaffold — `kind` alone must be
 * enough to re-derive the correct answer's display text on click.
 */
export type QuizKind =
	| "vocab-l2g" // latin shown, gloss choices
	| "vocab-g2l" // gloss shown, latin choices
	| "sentence-blank" // fill-in-the-blank scaffold
	| "sentence-convo" // conversation-reply scaffold
	| "sentence-mc"; // no scaffold — translation multiple-choice

const QUIZ_KINDS: readonly QuizKind[] = [
	"vocab-l2g",
	"vocab-g2l",
	"sentence-blank",
	"sentence-convo",
	"sentence-mc",
];

function isQuizKind(value: string): value is QuizKind {
	return (QUIZ_KINDS as readonly string[]).includes(value);
}

export interface QuizQuestion {
	kind: QuizKind;
	itemId: string;
	/** Main question text (e.g. the Ainu latin form, or the gloss). */
	prompt: string;
	/** Optional one-line context shown under the prompt (a convo cue). */
	context?: string;
	/** Button labels, already shuffled — `correctIndex` points into this. */
	choices: string[];
	correctIndex: number;
}

/** Fisher-Yates shuffle using the injected rng — deterministic for a seeded rng. */
function shuffle<T>(rng: () => number, items: readonly T[]): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
}

function pickRandom<T>(rng: () => number, items: readonly T[]): T {
	const item = items[Math.floor(rng() * items.length)];
	if (item === undefined) throw new Error("pickRandom: empty pool");
	return item;
}

/**
 * Picks `count` distractors from `pool`, preferring items whose `category`
 * matches `target`'s (when `target` has one) before falling back to the
 * rest of the pool, chosen at random. `pool` must already exclude `target`.
 */
function pickDistractors(
	rng: () => number,
	pool: readonly Vocab[],
	target: Vocab,
	count: number,
): Vocab[] {
	const sameCategory = target.category
		? pool.filter((v) => v.category === target.category)
		: [];
	const sameCategoryIds = new Set(sameCategory.map((v) => v.id));
	const rest = pool.filter((v) => !sameCategoryIds.has(v.id));

	const chosen = shuffle(rng, sameCategory).slice(0, count);
	if (chosen.length < count) {
		chosen.push(...shuffle(rng, rest).slice(0, count - chosen.length));
	}
	return chosen;
}

function vocabGlossLabel(vocab: Vocab): string {
	return `${vocab.gloss.ja} (${vocab.gloss.en})`;
}

function buildVocabQuestion(
	rng: () => number,
	allVocab: readonly Vocab[],
	target: Vocab,
): QuizQuestion {
	const direction: "l2g" | "g2l" = rng() < 0.5 ? "l2g" : "g2l";
	const pool = allVocab.filter((v) => v.id !== target.id);
	const distractors = pickDistractors(rng, pool, target, 3);
	const items = shuffle(rng, [target, ...distractors]);
	const correctIndex = items.findIndex((v) => v.id === target.id);

	if (direction === "l2g") {
		return {
			kind: "vocab-l2g",
			itemId: target.id,
			prompt: target.pos ? `${target.latin} (${target.pos})` : target.latin,
			choices: items.map(vocabGlossLabel),
			correctIndex,
		};
	}
	return {
		kind: "vocab-g2l",
		itemId: target.id,
		prompt: vocabGlossLabel(target),
		choices: items.map((v) => v.latin),
		correctIndex,
	};
}

/** Shuffles `options` and reports the new index of `correctValue`. */
function shuffleOptions(
	rng: () => number,
	options: readonly string[],
	correctValue: string,
): { choices: string[]; correctIndex: number } {
	const choices = shuffle(rng, options);
	const correctIndex = choices.indexOf(correctValue);
	if (correctIndex < 0) {
		throw new Error(
			`shuffleOptions: correct value ${JSON.stringify(correctValue)} not present in options`,
		);
	}
	return { choices, correctIndex };
}

function blankPrompt(
	sentence: Sentence & { blank: NonNullable<Sentence["blank"]> },
): string {
	const idx = sentence.latin.indexOf(sentence.blank.answer);
	if (idx < 0) return sentence.latin;
	return (
		sentence.latin.slice(0, idx) +
		"___" +
		sentence.latin.slice(idx + sentence.blank.answer.length)
	);
}

function convoPromptText(
	sentence: Sentence & { convo: NonNullable<Sentence["convo"]> },
): string {
	const { prompt } = sentence.convo;
	return typeof prompt === "string" ? prompt : `${prompt.ja} / ${prompt.en}`;
}

function buildSentenceQuestion(
	rng: () => number,
	course: CourseData,
	target: Sentence,
): QuizQuestion {
	if (target.blank) {
		const { blank } = target;
		const { choices, correctIndex } = shuffleOptions(
			rng,
			blank.options,
			blank.answer,
		);
		return {
			kind: "sentence-blank",
			itemId: target.id,
			prompt: blankPrompt({ ...target, blank }),
			choices,
			correctIndex,
		};
	}

	if (target.convo) {
		const { convo } = target;
		const { choices, correctIndex } = shuffleOptions(
			rng,
			convo.options,
			target.latin,
		);
		return {
			kind: "sentence-convo",
			itemId: target.id,
			prompt: target.latin,
			context: convoPromptText({ ...target, convo }),
			choices,
			correctIndex,
		};
	}

	// No scaffold — translation multiple-choice, same shape as vocab l2g.
	const pool = course.sentences.filter((s) => s.id !== target.id);
	const distractors = shuffle(rng, pool).slice(0, 3);
	const items = shuffle(rng, [target, ...distractors]);
	const correctIndex = items.findIndex((s) => s.id === target.id);
	return {
		kind: "sentence-mc",
		itemId: target.id,
		prompt: target.latin,
		choices: items.map((s) => `${s.translation.ja} (${s.translation.en})`),
		correctIndex,
	};
}

/** Generates one question. `mode: "mixed"` picks vocab vs. sentence via `rng`. */
export function generateQuestion(
	course: CourseData,
	mode: QuizMode,
	rng: () => number,
): QuizQuestion {
	const resolved =
		mode === "mixed" ? (rng() < 0.5 ? "vocab" : "sentence") : mode;
	if (resolved === "vocab") {
		return buildVocabQuestion(rng, course.vocab, pickRandom(rng, course.vocab));
	}
	return buildSentenceQuestion(rng, course, pickRandom(rng, course.sentences));
}

export interface QuizAnswerReveal {
	/** The correct choice, rendered the same way it would appear as a button label. */
	correctAnswerText: string;
	/** Extra pedagogical detail: vocab `note`, or a sentence's translation. */
	detail?: string;
}

/** Re-derives the correct-answer display + detail from `kind` + `itemId` alone. */
export function describeAnswer(
	course: CourseData,
	kind: QuizKind,
	itemId: string,
): QuizAnswerReveal | undefined {
	if (kind === "vocab-l2g" || kind === "vocab-g2l") {
		const vocab = course.vocab.find((v) => v.id === itemId);
		if (!vocab) return undefined;
		return {
			correctAnswerText:
				kind === "vocab-l2g" ? vocabGlossLabel(vocab) : vocab.latin,
			detail: vocab.note ? `${vocab.note.ja} / ${vocab.note.en}` : undefined,
		};
	}

	const sentence = course.sentences.find((s) => s.id === itemId);
	if (!sentence) return undefined;
	if (kind === "sentence-mc") {
		return {
			correctAnswerText: `${sentence.translation.ja} (${sentence.translation.en})`,
			detail: sentence.latin,
		};
	}
	return {
		correctAnswerText: sentence.latin,
		detail: `${sentence.translation.ja} / ${sentence.translation.en}`,
	};
}

// --- Button custom_value codec -------------------------------------------
//
// Payload shape: `kind:itemId:chosenIndex:correctIndex`. Never contains
// ";" — discord-hono reserves that character to separate the component key
// from its custom_value (CUSTOM_ID_SEPARATOR).

const FIELD_SEP = ":";

export interface QuizPayload {
	kind: QuizKind;
	itemId: string;
	chosenIndex: number;
	correctIndex: number;
}

export function encodePayload(
	kind: QuizKind,
	itemId: string,
	chosenIndex: number,
	correctIndex: number,
): string {
	for (const field of [kind, itemId]) {
		if (field.includes(FIELD_SEP) || field.includes(";")) {
			throw new Error(
				`quiz payload field ${JSON.stringify(field)} must not contain "${FIELD_SEP}" or ";"`,
			);
		}
	}
	return [kind, itemId, String(chosenIndex), String(correctIndex)].join(
		FIELD_SEP,
	);
}

export function parsePayload(payload: string): QuizPayload {
	if (payload.includes(";")) {
		throw new Error("invalid quiz payload: must not contain ';'");
	}
	const parts = payload.split(FIELD_SEP);
	if (parts.length !== 4) {
		throw new Error(
			`invalid quiz payload: expected 4 fields, got ${parts.length}`,
		);
	}
	const [kind, itemId, chosenIndexStr, correctIndexStr] = parts as [
		string,
		string,
		string,
		string,
	];
	if (!isQuizKind(kind))
		throw new Error(`invalid quiz payload: unknown kind ${kind}`);
	if (!itemId) throw new Error("invalid quiz payload: empty itemId");

	const chosenIndex = Number(chosenIndexStr);
	const correctIndex = Number(correctIndexStr);
	if (!Number.isInteger(chosenIndex) || !Number.isInteger(correctIndex)) {
		throw new Error(
			"invalid quiz payload: chosenIndex/correctIndex must be integers",
		);
	}
	return { kind, itemId, chosenIndex, correctIndex };
}
