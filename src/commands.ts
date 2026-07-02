import { Command, Option } from "discord-hono";

// Single source of truth for both dispatch (src/index.ts) and registration
// (scripts/register.ts). Only ever lists commands that are actually wired up.
export const commands = [
	new Command("ping", "Health check"),
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
];
