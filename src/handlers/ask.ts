import type { CommandContext } from "discord-hono";
import { checkAndSetCooldown } from "../lib/cooldown.js";
import { baseEmbed } from "../lib/embeds.js";
import type { AppEnv } from "../lib/errors.js";
import { userMessage } from "../lib/errors.js";
import type { AskSource } from "../services/ai.js";
import { runAsk } from "../services/ai.js";
import type { CorpusRow } from "../services/corpus.js";
import { searchCorpus } from "../services/corpus.js";
import type { GlossaryEntry, WaitUntilCtx } from "../services/glossary.js";
import { getGlossary, searchGlossary } from "../services/glossary.js";
import type { MdbDecomposeResult } from "../services/mdb.js";
import { decompose } from "../services/mdb.js";
import { decompositionToSurfaces } from "./analyze.js";

export const MAX_QUESTION_LENGTH = 300;
const DEFAULT_COOLDOWN_SECONDS = 300;
const TOKEN_COUNT = 2;
const GLOSSARY_PER_TOKEN = 3;
const CORPUS_LIMIT = 5;
const CONTEXT_CHAR_CAP = 4000;
const ANSWER_CHAR_CAP = 1500;

const DRAFT_DISCLAIMER =
	"🤖 機械生成の下書きです — 出典を確認してください / Machine-generated draft — verify against sources";

/**
 * Loose Ainu-token scanner: any run of ≥2 Latin letters (incl. macron vowels,
 * the glottal-stop apostrophe, `=` affix-boundary marker, and `-`). Pure
 * heuristic — over-matches romanized Japanese/English, so `STOPWORDS` below
 * strips the "obvious" cases; anything left over is still just a best-effort
 * lookup key, never treated as authoritative.
 */
const AINU_TOKEN_RE = /[a-zāēīōū'=-]{2,}/gi;

/** "Obvious" English/romanized-Japanese function words — not exhaustive. */
const STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"is",
	"are",
	"was",
	"were",
	"am",
	"be",
	"been",
	"being",
	"what",
	"whats",
	"how",
	"why",
	"when",
	"where",
	"who",
	"whom",
	"whose",
	"which",
	"does",
	"did",
	"do",
	"doing",
	"done",
	"can",
	"could",
	"will",
	"would",
	"shall",
	"should",
	"may",
	"might",
	"must",
	"of",
	"in",
	"on",
	"at",
	"to",
	"for",
	"and",
	"or",
	"but",
	"not",
	"no",
	"yes",
	"this",
	"that",
	"these",
	"those",
	"it",
	"its",
	"with",
	"about",
	"from",
	"as",
	"by",
	"you",
	"your",
	"i",
	"me",
	"my",
	"we",
	"our",
	"they",
	"their",
	"he",
	"she",
	"him",
	"her",
	"please",
	"thanks",
	"thank",
	"word",
	"words",
	"mean",
	"means",
	"meaning",
	"translate",
	"translation",
	"say",
	"tell",
	"know",
	// Common romanized-Japanese particles/fillers.
	"wa",
	"ka",
	"no",
	"ga",
	"wo",
	"ni",
	"de",
	"to",
	"mo",
	"yo",
	"ne",
	"desu",
	"masu",
	"kudasai",
	"onegai",
	"arigatou",
	"sumimasen",
	"hai",
	"iie",
	"nan",
	"nani",
	"dore",
	"dou",
	"doko",
	"itsu",
	"dare",
]);

/** Pure — exported for offline unit testing. */
export function extractAinuTokens(question: string, max: number): string[] {
	const matches = question.match(AINU_TOKEN_RE) ?? [];
	const seen = new Set<string>();
	const tokens: string[] = [];
	for (const raw of matches) {
		const token = raw.toLowerCase();
		if (STOPWORDS.has(token) || seen.has(token)) continue;
		seen.add(token);
		tokens.push(token);
		if (tokens.length >= max) break;
	}
	return tokens;
}

export interface RetrievedSource {
	id: string;
	/** Human-readable reference shown in the "Sources" embed field. */
	ref: string;
	/** Content fed to the model, prefixed with `[id]`. */
	text: string;
}

function glossaryEntryText(entry: GlossaryEntry): string {
	const glosses = [entry.日本語, entry.English, entry.中文]
		.filter(Boolean)
		.join(" / ");
	return `${entry.Aynu ?? "?"} — ${glosses || "—"}`;
}

function mdbResultText(token: string, result: MdbDecomposeResult): string {
	const surfaces = result.fallback_used
		? decompositionToSurfaces(result.decomposition)
		: result.analysis.surface_parts;
	return `${token} → ${surfaces.join("-")}`;
}

function corpusSourceText(row: CorpusRow): string {
	return `${row.text} — ${row.translation ?? "—"}`;
}

function corpusSourceRef(row: CorpusRow): string {
	return (
		[row.document, row.dialect].filter(Boolean).join(" · ") || "corpus.aynu.org"
	);
}

/**
 * Assigns G-, M-, and C-prefixed tags and assembles the model-facing text +
 * human-readable ref for every retrieved item. Pure — exported for offline
 * unit testing with fixture data (no network). Each source kind is numbered
 * sequentially from 1 over only the items actually present (a failed/empty
 * lookup leaves a gap in the input arrays, not a gap in the tag numbering).
 */
export function buildSources(
	tokens: string[],
	glossaryPerToken: GlossaryEntry[][],
	mdbPerToken: (MdbDecomposeResult | null)[],
	corpusRows: CorpusRow[],
): RetrievedSource[] {
	const sources: RetrievedSource[] = [];

	let g = 1;
	for (const entries of glossaryPerToken) {
		for (const entry of entries) {
			sources.push({
				id: `G${g++}`,
				ref: entry.Aynu ?? "?",
				text: glossaryEntryText(entry),
			});
		}
	}

	let m = 1;
	tokens.forEach((token, i) => {
		const result = mdbPerToken[i];
		if (result) {
			sources.push({
				id: `M${m++}`,
				ref: token,
				text: mdbResultText(token, result),
			});
		}
	});

	let c = 1;
	for (const row of corpusRows) {
		sources.push({
			id: `C${c++}`,
			ref: corpusSourceRef(row),
			text: corpusSourceText(row),
		});
	}

	return sources;
}

/**
 * Caps the total serialized `[id] text` size to roughly `capChars`. The
 * first source is always kept even if it alone exceeds the cap (so one long
 * result never collapses retrieval to zero and falls into the "no sources"
 * path); every source after that is only kept while the running total stays
 * under the cap. Pure — exported for offline unit testing.
 */
export function capSources(
	sources: RetrievedSource[],
	capChars: number,
): RetrievedSource[] {
	const kept: RetrievedSource[] = [];
	let total = 0;
	for (const source of sources) {
		const size = `[${source.id}] ${source.text}\n\n`.length;
		if (kept.length > 0 && total + size > capChars) break;
		kept.push(source);
		total += size;
	}
	return kept;
}

/**
 * Parallel, best-effort retrieval: glossary (per token) + mdb decompose (per
 * token) + corpus search (whole question) all run via a single outer
 * `Promise.allSettled` (mirroring `/analyze`'s per-token pattern), so an
 * upstream outage in one source never blocks the others.
 */
async function retrieve(
	env: Env,
	executionCtx: WaitUntilCtx,
	question: string,
): Promise<RetrievedSource[]> {
	const tokens = extractAinuTokens(question, TOKEN_COUNT);

	const [glossarySettled, mdbOuterSettled, corpusSettled] =
		await Promise.allSettled([
			getGlossary(env, executionCtx),
			Promise.allSettled(tokens.map((token) => decompose(env, token, "flat"))),
			searchCorpus(env, { q: question, lang: "any", limit: CORPUS_LIMIT }),
		]);

	const glossaryPerToken: GlossaryEntry[][] =
		glossarySettled.status === "fulfilled"
			? tokens.map((token) =>
					searchGlossary(glossarySettled.value, token, GLOSSARY_PER_TOKEN),
				)
			: tokens.map(() => []);

	const mdbPerToken: (MdbDecomposeResult | null)[] =
		mdbOuterSettled.status === "fulfilled"
			? mdbOuterSettled.value.map((r) =>
					r.status === "fulfilled" ? r.value : null,
				)
			: tokens.map(() => null);

	const corpusRows: CorpusRow[] =
		corpusSettled.status === "fulfilled" ? corpusSettled.value : [];

	return buildSources(tokens, glossaryPerToken, mdbPerToken, corpusRows);
}

function truncate(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function noSourcesEmbed(question: string) {
	return baseEmbed()
		.title(DRAFT_DISCLAIMER)
		.description(
			`「${truncate(question, 200)}」に関する出典が見つかりませんでした。 / No grounded sources found for this question.\n` +
				"-# `/corpus`・`/glossary`・`/analyze` で直接調べることもできます。 / Try `/corpus`, `/glossary`, or `/analyze` directly.",
		);
}

function sourcesFieldValue(sources: RetrievedSource[]): string {
	if (sources.length === 0) return "—";
	return sources.map((s) => `**[${s.id}]** ${s.ref}`).join("\n");
}

function answerEmbed(answer: string, sources: RetrievedSource[]) {
	return baseEmbed()
		.title(DRAFT_DISCLAIMER)
		.description(truncate(answer, ANSWER_CHAR_CAP))
		.fields({
			name: "Sources",
			value: truncate(sourcesFieldValue(sources), 1024),
		})
		.footer({ text: DRAFT_DISCLAIMER });
}

type InteractionActor = {
	member?: { user?: { id?: string } };
	user?: { id?: string };
};

/** The user who performed an interaction (guild `member.user` or DM `user`). */
function actorId(interaction: InteractionActor): string | undefined {
	return interaction.member?.user?.id ?? interaction.user?.id;
}

/**
 * `/ask question*:String(max_length 300)` — grounded Q&A over the glossary,
 * corpus, and morpheme-database services via Workers AI.
 *
 * Cooldown is checked (and, if not cooling, set) BEFORE deferring: a plain
 * synchronous-looking KV read/write ahead of `resDefer`, the same risk
 * tolerance `/quiz stats:true` already takes with a D1 read. Retrieval with
 * zero sources short-circuits before the model is ever called — cheaper and
 * safer than asking the model to answer from nothing.
 */
export async function askHandler(c: CommandContext<AppEnv>): Promise<Response> {
	const question = (c.var.question as string | undefined)?.trim() ?? "";

	if (!question) {
		return c
			.flags("EPHEMERAL")
			.res("⚠️ 質問を入力してください。 / Please enter a question.");
	}
	if (question.length > MAX_QUESTION_LENGTH) {
		return c
			.flags("EPHEMERAL")
			.res(
				`⚠️ 質問は${MAX_QUESTION_LENGTH}文字までです（${question.length}文字）。 / Questions are limited to ${MAX_QUESTION_LENGTH} characters (got ${question.length}).`,
			);
	}

	const userId = actorId(c.interaction) ?? "unknown";
	// `"0"` is a deliberate operator choice (cooldown off) — only fall back to
	// the default when the var is unset/garbage/negative.
	const parsedCooldown = Number(c.env.ASK_COOLDOWN_SECONDS);
	const cooldownSeconds =
		Number.isFinite(parsedCooldown) && parsedCooldown >= 0
			? parsedCooldown
			: DEFAULT_COOLDOWN_SECONDS;
	if (cooldownSeconds > 0) {
		const remaining = await checkAndSetCooldown(
			c.env.KV,
			`ask:cooldown:${userId}`,
			cooldownSeconds,
		);
		if (remaining > 0) {
			return c
				.flags("EPHEMERAL")
				.res(
					`⏳ ${remaining}秒後にもう一度お試しください。 / Try again in ${remaining}s.`,
				);
		}
	}

	return c.resDefer(async (c) => {
		try {
			const sources = capSources(
				await retrieve(c.env, c.executionCtx, question),
				CONTEXT_CHAR_CAP,
			);

			if (sources.length === 0) {
				await c.followup({ embeds: [noSourcesEmbed(question)] });
				return;
			}

			const askSources: AskSource[] = sources.map((s) => ({
				id: s.id,
				text: s.text,
			}));
			const answer = await runAsk(c.env, question, askSources);
			await c.followup({ embeds: [answerEmbed(answer, sources)] });
		} catch (err) {
			await c.followup(`⚠️ ${userMessage(err)}`);
		}
	});
}
