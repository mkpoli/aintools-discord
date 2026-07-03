import type { CommandContext } from "discord-hono";
import { baseEmbed } from "../lib/embeds.js";
import type { AppEnv } from "../lib/errors.js";
import {
	allScripts,
	convertText,
	MixedScriptError,
	resolveScript,
	SCRIPT_LABELS,
	SCRIPTS,
	type ScriptName,
	UnknownScriptError,
} from "../services/script.js";

const MAX_CONTEXT_MENU_LENGTH = 500;

const NO_SCRIPT_DETECTED =
	"アイヌ語の文字が検出できませんでした。 / No Ainu script detected.";
const MIXED_SCRIPT_NEEDS_FROM =
	"複数の文字種が混在しています。`from` を指定してください。 / Mixed scripts detected — please specify `from`.";
const NO_MESSAGE_CONTENT =
	"対象のメッセージにテキストがありませんでした。 / That message has no text content.";

type ConvertOptions = {
	text: string;
	to?: ScriptName;
	from?: ScriptName;
};

function ephemeral(c: CommandContext<AppEnv>, content: string) {
	return c.flags("EPHEMERAL").res(content);
}

/** Maps our own typed script errors to the exact bilingual copy the spec asks for. */
function handleScriptError(c: CommandContext<AppEnv>, err: unknown) {
	if (err instanceof UnknownScriptError)
		return ephemeral(c, NO_SCRIPT_DETECTED);
	if (err instanceof MixedScriptError)
		return ephemeral(c, MIXED_SCRIPT_NEEDS_FROM);
	throw err; // anything else bubbles up to safeHandler()'s generic fallback
}

function buildScriptsEmbed(
	text: string,
	source: ScriptName,
	scripts: Record<ScriptName, string>,
	truncated = false,
) {
	const description = truncated
		? `\`${text}…\`\n-# 500文字で切り詰めました。 / Truncated to 500 characters.`
		: `\`${text}\``;
	return baseEmbed()
		.title("🔤 Script conversion")
		.description(description)
		.fields(
			...SCRIPTS.map((script) => ({
				name:
					script === source
						? `${SCRIPT_LABELS[script]} (detected)`
						: SCRIPT_LABELS[script],
				value: scripts[script],
				inline: true,
			})),
		);
}

/**
 * `/convert` — pure CPU, always a direct `c.res`, public response.
 * With `to`: single conversion. Without: all-scripts embed.
 */
export function convert(c: CommandContext<AppEnv>) {
	const { text, to, from } = c.var as unknown as ConvertOptions;

	try {
		const source = resolveScript(text, from);

		if (to) {
			const result = convertText(text, source, to);
			return c.res(
				`**${SCRIPT_LABELS[source]} → ${SCRIPT_LABELS[to]}**\n${text} → ${result}`,
			);
		}

		const { scripts } = allScripts(text, source);
		return c.res({ embeds: [buildScriptsEmbed(text, source, scripts)] });
	} catch (err) {
		return handleScriptError(c, err);
	}
}

/**
 * "Convert script" message context-menu command — always ephemeral, reads
 * the target message's content, truncates at 500 chars.
 */
export function convertScriptContextMenu(c: CommandContext<AppEnv>) {
	const targetId = c.ref.target_id;
	const content = targetId ? c.ref.messages?.[targetId]?.content : undefined;
	if (!content?.trim()) return ephemeral(c, NO_MESSAGE_CONTENT);

	const truncated = content.length > MAX_CONTEXT_MENU_LENGTH;
	const text = truncated ? content.slice(0, MAX_CONTEXT_MENU_LENGTH) : content;

	try {
		const source = resolveScript(text);
		const { scripts } = allScripts(text, source);
		return c
			.flags("EPHEMERAL")
			.res({ embeds: [buildScriptsEmbed(text, source, scripts, truncated)] });
	} catch (err) {
		return handleScriptError(c, err);
	}
}
