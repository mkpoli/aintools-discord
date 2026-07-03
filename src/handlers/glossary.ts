import type { AutocompleteContext, CommandContext } from "discord-hono";
import { Autocomplete } from "discord-hono";
import { baseEmbed } from "../lib/embeds.js";
import type { AppEnv } from "../lib/errors.js";
import { userMessage } from "../lib/errors.js";
import type { GlossaryEntry } from "../services/glossary.js";
import { getGlossary, searchGlossary } from "../services/glossary.js";

const GLOSSARY_SITE_URL = "https://itak.aynu.org";
const NOTES_KEY = "註 / Notes" as const;
const DEFAULT_LIMIT = 5;
const AUTOCOMPLETE_CHOICE_COUNT = 10;
const AUTOCOMPLETE_BUDGET_MS = 2000;
const NOTES_PREVIEW_LENGTH = 80;

/**
 * `c.var` is typed against the empty `ContextVariableMap` under the plain
 * string-dispatch `app.command()`/`app.autocomplete()` API (the factory-typed
 * `createFactory().command(Command<V>, …)` form isn't used by this scaffold).
 * discord-hono still populates it at runtime from the interaction's options,
 * so this local shape documents what `commands.ts` actually declares.
 */
interface GlossaryVars {
	query: string;
	limit?: number;
}

function timeout(ms: number): Promise<never> {
	return new Promise((_, reject) => {
		setTimeout(() => reject(new Error("autocomplete budget exceeded")), ms);
	});
}

function entryFieldValue(entry: GlossaryEntry): string {
	const glosses = [entry.日本語, entry.English, entry.中文]
		.filter(Boolean)
		.join(" · ");
	const lines = [glosses || "—", `-# ${entry.sheetName}`];
	const notes = entry[NOTES_KEY];
	if (notes) {
		lines.push(
			notes.length > NOTES_PREVIEW_LENGTH
				? `${notes.slice(0, NOTES_PREVIEW_LENGTH)}…`
				: notes,
		);
	}
	return lines.join("\n");
}

function notFoundEmbed(query: string) {
	return baseEmbed("itak.aynu.org")
		.title("Itak — Ainu glossary")
		.url(GLOSSARY_SITE_URL)
		.description(
			`「${query}」に一致する語彙が見つかりませんでした。 / No glossary entries matched "${query}".\n` +
				"例文で探すなら `/corpus` もお試しください。 / Try `/corpus` to search example sentences instead.",
		)
		.toJSON();
}

/**
 * DEFERRED: `/glossary query:String(autocomplete) limit?:Integer(1..10)`.
 * The synchronous half only kicks off `resDefer` — any error past that point
 * must be caught and reported inside the deferred callback itself, since a
 * thrown rejection there would otherwise leave Discord's "thinking…" state
 * hanging forever instead of surfacing to the user.
 */
export function glossaryHandler(c: CommandContext<AppEnv>) {
	return c.resDefer(async (c) => {
		try {
			const vars = c.var as unknown as GlossaryVars;
			const query = String(vars.query);
			const limit = typeof vars.limit === "number" ? vars.limit : DEFAULT_LIMIT;

			const table = await getGlossary(c.env, c.executionCtx);
			const results = searchGlossary(table, query, limit);

			if (results.length === 0) {
				await c.followup({ embeds: [notFoundEmbed(query)] });
				return;
			}

			const embed = baseEmbed("itak.aynu.org")
				.title("Itak — Ainu glossary")
				.url(GLOSSARY_SITE_URL)
				.fields(
					...results.map((entry) => ({
						name: entry.Aynu ?? "?",
						value: entryFieldValue(entry),
					})),
				);

			await c.followup({ embeds: [embed.toJSON()] });
		} catch (err) {
			await c.followup({ content: `⚠️ ${userMessage(err)}` });
		}
	});
}

/**
 * Autocomplete for the `query` option. Hard 2s budget and empty-list-on-any-
 * failure — autocomplete must never error back to Discord.
 */
export async function glossaryAutocomplete(c: AutocompleteContext<AppEnv>) {
	try {
		const query = String(c.focused?.value ?? "");
		const table = await Promise.race([
			getGlossary(c.env, c.executionCtx),
			timeout(AUTOCOMPLETE_BUDGET_MS),
		]);
		const matches = searchGlossary(table, query, AUTOCOMPLETE_CHOICE_COUNT);

		return c.resAutocomplete(
			new Autocomplete("").choices(
				...matches.map((entry) => {
					const gloss = entry.日本語 ?? entry.English ?? entry.中文 ?? "";
					return {
						name: `${entry.Aynu} — ${gloss}`.slice(0, 100),
						value: (entry.Aynu ?? "").slice(0, 100),
					};
				}),
			),
		);
	} catch {
		return c.resAutocomplete(new Autocomplete("").choices());
	}
}
