import type { CommandContext } from "discord-hono";
import { baseEmbed } from "../lib/embeds.js";
import type { AppEnv } from "../lib/errors.js";
import { userMessage } from "../lib/errors.js";
import {
	type DecomposeMode,
	decompose,
	forms,
	type MdbDecomposeCanonical,
	type MdbDecomposeFallback,
	type MdbDecomposeResult,
	type MdbDecompositionNode,
} from "../services/mdb.js";

export const MAX_TOKENS = 8;

const FIELD_NAME_LIMIT = 256;
const FIELD_VALUE_LIMIT = 1024;

interface EmbedField {
	name: string;
	value: string;
}

function truncate(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * Whitespace-split tokenizer: NFC-normalises, then strips leading/trailing
 * punctuation from each token while keeping `=` (Ainu affix-boundary marker,
 * e.g. `e=` / `=an`) and any internal characters (e.g. the glottal-stop `'`).
 * Pure — exported for offline unit testing.
 */
export function tokenize(text: string): string[] {
	return text
		.normalize("NFC")
		.split(/\s+/)
		.map((token) => token.replace(/^[^\p{L}\p{N}=]+|[^\p{L}\p{N}=]+$/gu, ""))
		.filter((token) => token.length > 0);
}

/**
 * Flattens a decomposition (single `nested` root or a `flat`/`first` leaf
 * array) down to its leaf surface forms, in order. `flat` nodes have no
 * `children` so this is a no-op pass-through for them; `nested` recurses to
 * the same leaves. Pure — exported for offline unit testing.
 */
export function decompositionToSurfaces(
	decomposition: MdbDecompositionNode | MdbDecompositionNode[],
): string[] {
	const flattenNode = (node: MdbDecompositionNode): string[] =>
		node.children && node.children.length > 0
			? node.children.flatMap(flattenNode)
			: [node.surface];
	const nodes = Array.isArray(decomposition) ? decomposition : [decomposition];
	return nodes.flatMap(flattenNode);
}

function canonicalField(
	token: string,
	result: MdbDecomposeCanonical,
): EmbedField {
	const { analysis } = result;
	const value = `${analysis.surface_parts.join("-")}\n-# ${analysis.source} · confidence ${analysis.confidence.toFixed(2)}`;
	return {
		name: `**${truncate(token, FIELD_NAME_LIMIT - 4)}**`,
		value: truncate(value, FIELD_VALUE_LIMIT),
	};
}

function fallbackField(
	token: string,
	result: MdbDecomposeFallback,
): EmbedField {
	const surfaces = decompositionToSurfaces(result.decomposition);
	const lines = [
		surfaces.join("-"),
		`-# ⚠ heuristic · source: ${result.source}`,
	];
	if (result.unresolved.length > 0)
		lines.push(`-# unresolved: ${result.unresolved.join(", ")}`);
	if (result.warnings.length > 0)
		lines.push(`-# ${result.warnings.join("; ")}`);
	return {
		name: `**${truncate(token, FIELD_NAME_LIMIT - 4)}**`,
		value: truncate(lines.join("\n"), FIELD_VALUE_LIMIT),
	};
}

/**
 * Renders one `/analyze` embed field for a single token's settled decompose
 * call — canonical, heuristic-fallback, or `(unavailable)` on rejection. A
 * failed token never fails the whole command. Pure — exported for offline
 * unit testing of the per-field rendering decisions.
 */
export function tokenField(
	token: string,
	settled: PromiseSettledResult<MdbDecomposeResult>,
): EmbedField {
	if (settled.status === "rejected") {
		return {
			name: `**${truncate(token, FIELD_NAME_LIMIT - 4)}**`,
			value: "(unavailable)",
		};
	}
	return settled.value.fallback_used
		? fallbackField(token, settled.value)
		: canonicalField(token, settled.value);
}

/**
 * Bonus for single-token input: up to 3 related generated forms, each tagged
 * with its provenance. Best-effort — any failure (network, empty result)
 * just omits the field rather than failing the command.
 */
async function relatedFormsField(
	env: Env,
	token: string,
): Promise<EmbedField | null> {
	try {
		const result = await forms(env, token, 3);
		if (result.results.length === 0) return null;
		const lines = result.results.map(
			(row) => `**${row.surface}** — ${row.analysis || "—"} -# ${row.source}`,
		);
		return {
			name: "Related forms",
			value: truncate(lines.join("\n"), FIELD_VALUE_LIMIT),
		};
	} catch {
		return null;
	}
}

/**
 * `/analyze` — per-token morpheme decomposition via mdb.aynu.org. Deferred:
 * `/api/decompose` is network I/O and must not risk the 3s ack deadline. The
 * token cap is enforced BEFORE deferring so an over-long request gets an
 * immediate ephemeral reply instead of burning a followup. Each token is
 * decomposed independently via `Promise.allSettled` so one upstream failure
 * never takes down the whole embed.
 */
export function analyzeHandler(c: CommandContext<AppEnv>): Response {
	const text = c.var.text as string;
	const mode = (c.var.mode as DecomposeMode | undefined) ?? "flat";
	const tokens = tokenize(text);

	if (tokens.length === 0) {
		return c
			.flags("EPHEMERAL")
			.res("⚠️ 分析するテキストがありません。 / No text to analyze.");
	}
	if (tokens.length > MAX_TOKENS) {
		return c
			.flags("EPHEMERAL")
			.res(
				`⚠️ 一度に分析できるのは最大${MAX_TOKENS}語までです（${tokens.length}語を検出）。 / At most ${MAX_TOKENS} words per request (found ${tokens.length}).`,
			);
	}

	return c.resDefer(async (c) => {
		try {
			const settled = await Promise.allSettled(
				tokens.map((token) => decompose(c.env, token, mode)),
			);
			const fields = tokens.map((token, i) => tokenField(token, settled[i]));

			if (tokens.length === 1) {
				const related = await relatedFormsField(c.env, tokens[0]);
				if (related) fields.push(related);
			}

			const embed = baseEmbed("mdb.aynu.org")
				.title(`Morpheme analysis: ${truncate(tokens.join(" "), 200)}`)
				.fields(...fields);
			await c.followup({ embeds: [embed] });
		} catch (err) {
			await c.followup(`⚠️ ${userMessage(err)}`);
		}
	});
}
