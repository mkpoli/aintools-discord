import { DiscordHono } from "discord-hono";
import { commands } from "./commands.js";
import { safeHandler } from "./lib/errors.js";

const app = new DiscordHono<{ Bindings: Env }>();

// Temporary smoke command — replaced by real feature commands PR-1 onward.
const [ping] = commands;
app.command(
	ping.toJSON().name,
	safeHandler((c) => c.res("Pong!")),
);

export default app;
