import { DiscordHono } from "discord-hono";
import { commands } from "./commands.js";
import { convert, convertScriptContextMenu } from "./handlers/convert.js";
import { safeHandler } from "./lib/errors.js";

const app = new DiscordHono<{ Bindings: Env }>();

// Temporary smoke command — replaced by real feature commands PR-1 onward,
// removed at cutover (PR-9).
const [ping, convertCommand, convertContextMenu] = commands;
app.command(
	ping.toJSON().name,
	safeHandler((c) => c.res("Pong!")),
);

app.command(convertCommand.toJSON().name, safeHandler(convert));
app.command(
	convertContextMenu.toJSON().name,
	safeHandler(convertScriptContextMenu),
);

export default app;
