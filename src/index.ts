import { DiscordHono } from "discord-hono";
import { analyzeHandler } from "./handlers/analyze.js";
import { askHandler } from "./handlers/ask.js";
import { convert, convertScriptContextMenu } from "./handlers/convert.js";
import { corpusHandler } from "./handlers/corpus.js";
import { glossaryAutocomplete, glossaryHandler } from "./handlers/glossary.js";
import { quiz, quizAnswer, quizNext } from "./handlers/quiz.js";
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
app.autocomplete(
	"glossary",
	glossaryAutocomplete,
	safeHandler(glossaryHandler),
);
app.command("quiz", safeHandler(quiz));
// quizAnswer/quizNext are components (not commands) — already wrapped with
// their own error handler in handlers/quiz.ts, since errors.ts's safeHandler
// is typed for CommandContext only.
app.component("quiz", quizAnswer);
app.component("quiz-next", quizNext);
app.command("ask", safeHandler(askHandler));

export default app;
