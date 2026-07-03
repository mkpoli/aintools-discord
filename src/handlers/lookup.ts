import type { CommandContext, Embed } from "discord-hono";
import { baseEmbed } from "../lib/embeds.js";
import type { AppEnv } from "../lib/errors.js";
import { userMessage } from "../lib/errors.js";
import { type CorpusRow, searchCorpus } from "../services/corpus.js";
import {
	type GlossaryEntry,
	getGlossary,
	searchGlossary,
} from "../services/glossary.js";
import { decompose, type MdbDecomposeResult } from "../services/mdb.js";
import {
	type AllScripts,
	allScripts,
	convertText,
	SCRIPT_LABELS,
	SCRIPTS,
} from "../services/script.js";
import { decompositionToSurfaces } from "./analyze.js";

const FIELD_VALUE_LIMIT = 1024;
const GLOSSARY_LIMIT = 3;
const CORPUS_LIMIT = 3;

const UNAVAILABLE = "(unavailable)";
const NONE = "(none)";

function truncate(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * One embed field, plus whether it actually has content — used both to
 * render the field value and to detect the "nothing found at all" and
 * "which sources were actually used" aggregate cases below.
 *
 * The plan's extension-point sketch (`{ name; render(): string | null }`)
 * collapses "rejected" and "empty" into one `null`; this keeps them
 * distinguishable ("(unavailable)" vs "(none)") without adding a second
 * abstraction layer.
 */
export interface Section {
	name: string;
	hasContent: boolean;
	render(): string;
}

/**
 * Best-effort normalization of the raw input to Latn for use as the query
 * text against every downstream API. Never throws: an Unknown/Mixed script
 * (no `from` to disambiguate) falls back to the raw input rather than
 * hard-failing the whole lookup — the scripts section then degrades on its
 * own via the same failure inside `Promise.allSettled`.
 */
export function toLatnQuery(word: string): string {
	try {
		return convertText(word, undefined, "Latn");
	} catch {
		return word;
	}
}

/** 📖 Glossary — top glossary hits as `**Aynu** — 日本語 · English` lines. */
export function glossarySection(
	settled: PromiseSettledResult<GlossaryEntry[]>,
): Section {
	const name = "📖 Glossary";
	if (settled.status === "rejected")
		return { name, hasContent: false, render: () => UNAVAILABLE };
	if (settled.value.length === 0)
		return { name, hasContent: false, render: () => NONE };
	const lines = settled.value.map((entry) => {
		const gloss = [entry.日本語, entry.English].filter(Boolean).join(" · ");
		return `**${entry.Aynu ?? "?"}** — ${gloss || "—"}`;
	});
	return {
		name,
		hasContent: true,
		render: () => truncate(lines.join("\n"), FIELD_VALUE_LIMIT),
	};
}

/**
 * 🧩 Morphemes — joined surface parts; heuristic (DP-fallback) results get
 * the same `⚠` marker as `/analyze` so the two commands read consistently.
 */
export function morphemesSection(
	settled: PromiseSettledResult<MdbDecomposeResult>,
): Section {
	const name = "🧩 Morphemes";
	if (settled.status === "rejected")
		return { name, hasContent: false, render: () => UNAVAILABLE };

	const result = settled.value;
	const surfaces = result.fallback_used
		? decompositionToSurfaces(result.decomposition)
		: result.analysis.surface_parts;
	if (surfaces.length === 0)
		return { name, hasContent: false, render: () => NONE };

	const text = result.fallback_used
		? `${surfaces.join("-")}\n-# ⚠ heuristic`
		: surfaces.join("-");
	return {
		name,
		hasContent: true,
		render: () => truncate(text, FIELD_VALUE_LIMIT),
	};
}

/** 📚 Corpus examples — up to a few aligned sentences with their dialect. */
export function corpusSection(
	settled: PromiseSettledResult<CorpusRow[]>,
): Section {
	const name = "📚 Corpus examples";
	if (settled.status === "rejected")
		return { name, hasContent: false, render: () => UNAVAILABLE };
	if (settled.value.length === 0)
		return { name, hasContent: false, render: () => NONE };
	const lines = settled.value.map(
		(row) =>
			`**${row.text}**\n${row.translation ?? "—"}\n-# ${row.dialect ?? "—"}`,
	);
	return {
		name,
		hasContent: true,
		render: () => truncate(lines.join("\n\n"), FIELD_VALUE_LIMIT),
	};
}

/** 🔤 Scripts — the same word rendered in all four scripts, one per line. */
export function scriptsSection(
	settled: PromiseSettledResult<AllScripts>,
): Section {
	const name = "🔤 Scripts";
	if (settled.status === "rejected")
		return { name, hasContent: false, render: () => UNAVAILABLE };
	const { scripts } = settled.value;
	const text = SCRIPTS.map((s) => `${SCRIPT_LABELS[s]}: ${scripts[s]}`).join(
		"\n",
	);
	return {
		name,
		hasContent: true,
		render: () => truncate(text, FIELD_VALUE_LIMIT),
	};
}

function nothingFoundEmbed(word: string): Embed {
	return baseEmbed()
		.title("No results")
		.description(
			`「${truncate(word, 200)}」の情報が見つかりませんでした。 / No information found for "${truncate(word, 200)}".\n` +
				"-# `/corpus lang:any` で日本語からも探せます。 / Try `/corpus lang:any` to search Japanese too.",
		);
}

/**
 * `/lookup` — one-stop composed research embed: glossary + morphemes +
 * corpus examples + all-scripts view, gathered in parallel and rendered as
 * 4 independently-degrading fields. Deferred: every source is network I/O
 * (or, for scripts, can throw on odd input) and must not risk the 3s ack
 * deadline. Never hard-fails on a single source going down — only a bug
 * inside the deferred callback itself (caught below) produces an error reply.
 */
export function lookupHandler(c: CommandContext<AppEnv>): Response {
	const word = c.var.word as string;

	return c.resDefer(async (c) => {
		try {
			const latn = toLatnQuery(word);

			const [glossarySettled, morphemesSettled, corpusSettled, scriptsSettled] =
				await Promise.allSettled([
					(async () => {
						const table = await getGlossary(c.env, c.executionCtx);
						return searchGlossary(table, latn, GLOSSARY_LIMIT);
					})(),
					decompose(c.env, latn, "flat"),
					searchCorpus(c.env, { q: latn, lang: "ain", limit: CORPUS_LIMIT }),
					(async () => allScripts(latn))(),
				]);

			const sections: Section[] = [
				glossarySection(glossarySettled),
				morphemesSection(morphemesSettled),
				corpusSection(corpusSettled),
				scriptsSection(scriptsSettled),
				// Extension point (plan §"Out of v1"): a rights-gated `dictionaries`
				// section, sourced from the OAuth'd mcp.aynu.org dictionary tools,
				// will be appended here once dictionary licensing is cleared.
			];

			if (sections.every((section) => !section.hasContent)) {
				await c.followup({ embeds: [nothingFoundEmbed(word)] });
				return;
			}

			const sourcesUsed = [
				sections[0].hasContent && "itak.aynu.org",
				sections[1].hasContent && "mdb.aynu.org",
				sections[2].hasContent && "corpus.aynu.org",
			].filter((source): source is string => Boolean(source));

			const embed = baseEmbed(sourcesUsed.join(" · ") || undefined)
				.title(`Lookup: ${truncate(word, 200)}`)
				.fields(
					...sections.map((section) => ({
						name: section.name,
						value: section.render(),
					})),
				);

			await c.followup({ embeds: [embed] });
		} catch (err) {
			await c.followup(`⚠️ ${userMessage(err)}`);
		}
	});
}
