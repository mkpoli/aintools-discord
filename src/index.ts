import { DiscordHono } from "discord-hono";
import { analyzeHandler } from "./handlers/analyze.js";
import { convert, convertScriptContextMenu } from "./handlers/convert.js";
import { corpusHandler } from "./handlers/corpus.js";
import { type AppEnv, safeHandler } from "./lib/errors.js";

const app = new DiscordHono<AppEnv>();

// Temporary smoke command — removed at cutover (PR-9).
app.command(
	"ping",
	safeHandler((c) => c.res("Pong!")),
);

app.command("convert", safeHandler(convert));
app.command("Convert script", safeHandler(convertScriptContextMenu));
app.command("corpus", safeHandler(corpusHandler));
app.command("analyze", safeHandler(analyzeHandler));

export default app;
