/**
 * Vendors the curated Ainu course content from the sibling `ainu-quiz` repo
 * (READ-ONLY — this script only ever reads it) into this repo's own
 * committed src/data/course.json, projected down to the minimal shape
 * `/quiz` needs (see src/data/types.ts). Deliberately does NOT vendor
 * course-generated.ts / the `_gen` directory — those are machine-generated
 * pipeline breadth, not the hand-curated slice.
 *
 * Usage:   bun scripts/extract-course.ts
 * Override source path (default points at ainu-quiz on this machine):
 *   COURSE_PATH=/path/to/course.ts bun scripts/extract-course.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CourseData, Sentence, Vocab } from "../src/data/types.js";

const DEFAULT_COURSE_PATH =
	"/home/mkpoli/projects/Ainu/ainu-quiz/src/lib/content/course.ts";

// `coursePath` is a runtime variable (not a string literal), so TypeScript
// can't statically resolve the dynamic import below — this project's
// typecheck never depends on the sibling repo existing on disk.
const coursePath = resolve(process.env.COURSE_PATH ?? DEFAULT_COURSE_PATH);

// Loose mirror of ainu-quiz's src/lib/content/types.ts `ContentBundle`,
// `Vocab`, `Sentence`, `Localized` — kept local so we never statically
// import that file (it's a different project with its own tsconfig).
type SourceLocalized = { ja: string; en: string; zh?: string };
type SourceVocab = {
	id: string;
	latin: string;
	gloss: SourceLocalized;
	category?: string;
	pos?: string;
	note?: SourceLocalized;
};
type SourceSentence = {
	id: string;
	latin: string;
	translation: SourceLocalized;
	vocab?: string[];
	blank?: { answer: string; options: string[] };
	convo?: { prompt: string | SourceLocalized; options: string[] };
	dialect?: string;
	source?: string;
};
type SourceBundle = {
	vocab: Record<string, SourceVocab>;
	sentences: Record<string, SourceSentence>;
};

function pickLocalized(loc: SourceLocalized): { ja: string; en: string } {
	return { ja: loc.ja, en: loc.en };
}

function projectVocab(v: SourceVocab): Vocab {
	const out: Vocab = {
		id: v.id,
		latin: v.latin,
		gloss: pickLocalized(v.gloss),
	};
	if (v.category) out.category = v.category;
	if (v.pos) out.pos = v.pos;
	if (v.note) out.note = pickLocalized(v.note);
	return out;
}

function projectSentence(s: SourceSentence): Sentence {
	const out: Sentence = {
		id: s.id,
		latin: s.latin,
		translation: pickLocalized(s.translation),
	};
	if (s.vocab) out.vocab = [...s.vocab];
	if (s.blank)
		out.blank = { answer: s.blank.answer, options: [...s.blank.options] };
	if (s.convo) {
		out.convo = {
			prompt:
				typeof s.convo.prompt === "string"
					? s.convo.prompt
					: pickLocalized(s.convo.prompt),
			options: [...s.convo.options],
		};
	}
	if (s.dialect) out.dialect = s.dialect;
	if (s.source) out.source = s.source;
	return out;
}

const mod = (await import(coursePath)) as { bundle: SourceBundle };
const { bundle } = mod;

const data: CourseData = {
	vocab: Object.values(bundle.vocab).map(projectVocab),
	sentences: Object.values(bundle.sentences).map(projectSentence),
};

const outPath = resolve(import.meta.dirname, "../src/data/course.json");
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(data, null, "\t")}\n`);

console.log(
	`Wrote ${data.vocab.length} vocab + ${data.sentences.length} sentences to ${outPath}`,
);
