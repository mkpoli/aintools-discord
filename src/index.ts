import { DiscordHono } from "discord-hono";
import { commands } from "./commands.js";
import { corpusHandler } from "./handlers/corpus.js";
import { type AppEnv, safeHandler } from "./lib/errors.js";

const app = new DiscordHono<AppEnv>();

// Temporary smoke command — replaced by real feature commands PR-1 onward.
const [ping] = commands;
app.command(
	ping.toJSON().name,
	safeHandler((c) => c.res("Pong!")),
);

app.command("corpus", safeHandler(corpusHandler));

export default app;
