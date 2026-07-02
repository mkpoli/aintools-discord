import { Command, Option } from "discord-hono";
import { SCRIPT_LABELS, SCRIPTS } from "./services/script.js";

const scriptChoices = SCRIPTS.map((value) => ({
	name: SCRIPT_LABELS[value],
	value,
}));

// Single source of truth for both dispatch (src/index.ts) and registration
// (scripts/register.ts). Only ever lists commands that are actually wired up.
export const commands = [
	new Command("ping", "Health check"),
	new Command(
		"convert",
		"Convert Ainu text between Latin, Katakana, Cyrillic, and Hangul.",
	).options(
		new Option("text", "Text to convert").required(),
		new Option("to", "Target script — omit to see all four at once").choices(
			...scriptChoices,
		),
		new Option("from", "Source script — auto-detected if omitted").choices(
			...scriptChoices,
		),
	),
	// MESSAGE context-menu command: empty description, dispatched by name like any other.
	new Command("Convert script").type(3),
	new Command("corpus", "Search the aligned Ainu↔Japanese corpus").options(
		new Option("query", "Search text (Ainu or Japanese)", "String").required(),
		new Option(
			"lang",
			"Language to search in (default: any)",
			"String",
		).choices(
			{ name: "Ainu", value: "ain" },
			{ name: "日本語", value: "jpn" },
			{ name: "any", value: "any" },
		),
		new Option("mode", "Result display (default: sentences)", "String").choices(
			{ name: "sentences", value: "sentences" },
			{ name: "kwic", value: "kwic" },
		),
		new Option("dialect", "Filter by dialect (substring match)", "String"),
		new Option("limit", "Max results, 1-10 (default: 5)", "Integer")
			.min_value(1)
			.max_value(10),
	),
	new Command("analyze", "Decompose Ainu word(s) into morphemes").options(
		new Option(
			"text",
			"Word(s) to analyze, up to 8 (Ainu)",
			"String",
		).required(),
		new Option("mode", "Decomposition view (default: flat)", "String").choices(
			{ name: "flat", value: "flat" },
			{ name: "first", value: "first" },
			{ name: "nested", value: "nested" },
		),
	),
	new Command(
		"glossary",
		"Search the itak.aynu.org Ainu ⇄ Japanese/English/Chinese glossary",
	).options(
		new Option("query", "Word or phrase to search for", "String")
			.autocomplete()
			.required(),
		new Option("limit", "Max results, 1-10 (default 5)", "Integer")
			.min_value(1)
			.max_value(10),
	),
];
