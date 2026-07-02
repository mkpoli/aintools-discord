import type { CommandContext, Embed } from "discord-hono";
import { baseEmbed } from "../lib/embeds.js";
import type { AppEnv } from "../lib/errors.js";
import { userMessage } from "../lib/errors.js";
import {
	type CorpusLang,
	type CorpusRow,
	type KwicLine,
	kwic,
	searchCorpus,
} from "../services/corpus.js";

const DEFAULT_LIMIT = 5;
const KWIC_CTX = 6;
const KWIC_LEFT_WIDTH = 30;
const FIELD_NAME_LIMIT = 256;
const FIELD_VALUE_LIMIT = 1024;

function truncate(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

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
				name: truncate(`**${row.text}**`, FIELD_NAME_LIMIT),
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
