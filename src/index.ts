import { DiscordHono } from "discord-hono";
import { commands } from "./commands.js";
import { glossaryAutocomplete, glossaryHandler } from "./handlers/glossary.js";
import { safeHandler } from "./lib/errors.js";

const app = new DiscordHono<{ Bindings: Env }>();

// Temporary smoke command — replaced by real feature commands PR-1 onward.
const [ping, glossary] = commands;
app.command(
	ping.toJSON().name,
	safeHandler((c) => c.res("Pong!")),
);

app.autocomplete(
	glossary.toJSON().name,
	glossaryAutocomplete,
	safeHandler(glossaryHandler),
);

export default app;
