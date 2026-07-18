import type { AutocompleteContext, CommandContext, Embed } from "discord-hono";
import { Autocomplete } from "discord-hono";
import { baseEmbed } from "../lib/embeds.js";
import type { AppEnv } from "../lib/errors.js";
import { userMessage } from "../lib/errors.js";
import { truncate } from "../lib/truncate.js";
import {
	type CorpusLang,
	type CorpusRow,
	type DialectChoice,
	type KwicLine,
	kwic,
	listDialects,
	searchCorpus,
} from "../services/corpus.js";

const DEFAULT_LIMIT = 5;
const KWIC_CTX = 6;
const KWIC_LEFT_WIDTH = 30;
const FIELD_NAME_LIMIT = 256;
const FIELD_VALUE_LIMIT = 1024;

/** Left-pad (with a leading ellipsis if too long) so every node token lines
 * up in a fixed-width code block, matching a classic KWIC concordance view. */
function padLeftCol(text: string, width: number): string {
	const flat = text.trim().replace(/\s+/g, " ");
	if (flat.length > width) return `…${flat.slice(-(width - 1))}`;
	return flat.padStart(width);
}

/** Pure formatter — exported for offline unit testing with fixture JSON. */
export function formatKwicLines(lines: KwicLine[]): string {
	return lines
		.map(
			(line) =>
				`${padLeftCol(line.left_text, KWIC_LEFT_WIDTH)} [${line.node_text}] ${line.right_text.trim().replace(/\s+/g, " ")}`,
		)
		.join("\n");
}

function zeroResultsEmbed(query: string): Embed {
	return baseEmbed("corpus.aynu.org")
		.title("No matches")
		.description(
			`No corpus matches for **${truncate(query, 200)}**.\n-# Try \`lang:any\` to search both Ainu and Japanese text.`,
		);
}

function sentencesEmbed(query: string, rows: CorpusRow[]): Embed {
	return baseEmbed("corpus.aynu.org")
		.title(`Corpus search: ${truncate(query, 200)}`)
		.fields(
			...rows.map((row) => ({
				name: `**${truncate(row.text, FIELD_NAME_LIMIT - 4)}**`,
				value: truncate(
					`${row.translation ?? "—"}\n-# ${[row.dialect, row.author, row.document].filter(Boolean).join(" · ") || "—"}`,
					FIELD_VALUE_LIMIT,
				),
			})),
		);
}

function kwicEmbed(query: string, lines: KwicLine[], total: number): Embed {
	const block = truncate(formatKwicLines(lines), 3800);
	return baseEmbed("corpus.aynu.org")
		.title(`KWIC: ${truncate(query, 200)}`)
		.url(`https://corpus.aynu.org/?q=${encodeURIComponent(query)}`)
		.description(
			`\`\`\`\n${block}\n\`\`\`\nShowing ${lines.length} of ${total} matches.`,
		);
}

/**
 * `/corpus` — aligned corpus search + KWIC concordance. Deferred: both
 * `/v1/search` and `/v1/kwic` are network I/O and must not risk the 3s ack
 * deadline. Zero rows is a friendly embed (never an error); upstream
 * failures are caught inside the deferred callback and reported via a
 * followup, never left silent.
 */
export function corpusHandler(c: CommandContext<AppEnv>): Response {
	const query = c.var.query as string;
	const lang = (c.var.lang as CorpusLang | undefined) ?? "any";
	const mode = (c.var.mode as "sentences" | "kwic" | undefined) ?? "sentences";
	const dialect = c.var.dialect as string | undefined;
	const limit = (c.var.limit as number | undefined) ?? DEFAULT_LIMIT;

	return c.resDefer(async (c) => {
		try {
			if (mode === "kwic") {
				const { lines, meta } = await kwic(c.env, {
					q: query,
					ctx: KWIC_CTX,
					limit,
				});
				await c.followup({
					embeds: [
						lines.length === 0
							? zeroResultsEmbed(query)
							: kwicEmbed(query, lines, meta.total),
					],
				});
				return;
			}

			const rows = await searchCorpus(c.env, {
				q: query,
				lang,
				dialect,
				limit,
			});
			await c.followup({
				embeds: [
					rows.length === 0
						? zeroResultsEmbed(query)
						: sentencesEmbed(query, rows),
				],
			});
		} catch (err) {
			await c.followup(`⚠️ ${userMessage(err)}`);
		}
	});
}

const AUTOCOMPLETE_BUDGET_MS = 2000;
const AUTOCOMPLETE_CHOICE_COUNT = 25;

function autocompleteTimeout(ms: number): Promise<never> {
	return new Promise((_, reject) => {
		setTimeout(() => reject(new Error("autocomplete budget exceeded")), ms);
	});
}

/** Pure filter — case-insensitive substring over dialect names, count order kept. */
export function filterDialectChoices(
	choices: readonly DialectChoice[],
	query: string,
	limit: number = AUTOCOMPLETE_CHOICE_COUNT,
): DialectChoice[] {
	const q = query.trim().toLowerCase();
	return choices
		.filter((c) => q === "" || c.name.toLowerCase().includes(q))
		.slice(0, limit);
}

/**
 * Autocomplete for the `dialect` option. Hard 2s budget and empty-list-on-
 * any-failure — autocomplete must never error back to Discord.
 */
export async function corpusDialectAutocomplete(
	c: AutocompleteContext<AppEnv>,
) {
	try {
		if (c.focused?.name !== "dialect") {
			return c.resAutocomplete(new Autocomplete("").choices());
		}
		const choices = await Promise.race([
			listDialects(c.env),
			autocompleteTimeout(AUTOCOMPLETE_BUDGET_MS),
		]);
		const matches = filterDialectChoices(
			choices,
			String(c.focused?.value ?? ""),
		);
		return c.resAutocomplete(
			new Autocomplete("").choices(
				...matches.map((d) => ({
					name: `${d.name}（${d.count.toLocaleString("en-US")}文）`.slice(
						0,
						100,
					),
					value: d.name.slice(0, 100),
				})),
			),
		);
	} catch {
		return c.resAutocomplete(new Autocomplete("").choices());
	}
}
