import { Command, Option } from "discord-hono";

// Single source of truth for both dispatch (src/index.ts) and registration
// (scripts/register.ts). Only ever lists commands that are actually wired up.
export const commands = [
	new Command("ping", "Health check"),
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
