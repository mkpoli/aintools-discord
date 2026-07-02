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
];
