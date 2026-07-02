/**
 * Minimal course-content shapes vendored from `ainu-quiz`'s curated course
 * (see scripts/extract-course.ts). This is a projection, not the full
 * upstream `ContentBundle` — no path/unit/story data, no `audio`, no `zh`.
 */

/** A string in each learner UI language the bot supports. */
export interface LocalizedText {
	ja: string;
	en: string;
}

/** A single vocabulary item. */
export interface Vocab {
	id: string;
	/** Canonical Ainu romanization. */
	latin: string;
	gloss: LocalizedText;
	/** Glossary category (food, colour, animal, …) — used to prefer distractors. */
	category?: string;
	/** Part of speech, e.g. "vt", "vi", "n", "adv". */
	pos?: string;
	/** Short usage note shown after an answer (pedagogical payoff). */
	note?: LocalizedText;
}

/** Fill-in-the-blank scaffold: which token is removed + distractor options. */
export interface SentenceBlank {
	answer: string;
	options: string[];
}

/** Conversation scaffold: a prompt this sentence is the best reply to. */
export interface SentenceConvo {
	prompt: string | LocalizedText;
	options: string[];
}

/** An example sentence, with optional exercise scaffolding. */
export interface Sentence {
	id: string;
	/** Canonical Ainu sentence (may include `=` affix markers and spaces). */
	latin: string;
	translation: LocalizedText;
	/** Vocab ids appearing here. */
	vocab?: string[];
	blank?: SentenceBlank;
	convo?: SentenceConvo;
	/** Provenance from the corpus. */
	dialect?: string;
	source?: string;
}

export interface CourseData {
	vocab: Vocab[];
	sentences: Sentence[];
}
