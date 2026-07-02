import { Command, Option } from "discord-hono";

// Single source of truth for both dispatch (src/index.ts) and registration
// (scripts/register.ts). Only ever lists commands that are actually wired up.
export const commands = [
	new Command("ping", "Health check"),
	new Command("quiz", "Practice Ainu vocab & sentences.").options(
		new Option("mode", "Question type — omit for a mix of both").choices(
			{ name: "Vocab", value: "vocab" },
			{ name: "Sentence", value: "sentence" },
			{ name: "Mixed", value: "mixed" },
		),
		new Option(
			"stats",
			"Show your quiz stats instead of a new question",
			"Boolean",
		),
	),
];
