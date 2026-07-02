import { DiscordHono } from "discord-hono";
import { commands } from "./commands.js";
import { quiz, quizAnswer, quizNext } from "./handlers/quiz.js";
import { safeHandler } from "./lib/errors.js";

const app = new DiscordHono<{ Bindings: Env }>();

// Temporary smoke command — replaced by real feature commands PR-1 onward,
// removed at cutover (PR-9).
const [ping, quizCommand] = commands;
app.command(
	ping.toJSON().name,
	safeHandler((c) => c.res("Pong!")),
);

app.command(quizCommand.toJSON().name, safeHandler(quiz));
// quizAnswer/quizNext are components (not commands) — already wrapped with
// their own error handler in handlers/quiz.ts, since errors.ts's safeHandler
// is typed for CommandContext only.
app.component("quiz", quizAnswer);
app.component("quiz-next", quizNext);

export default app;
