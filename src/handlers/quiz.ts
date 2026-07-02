import type { CommandContext, ComponentContext } from "discord-hono";
import { Button, Components } from "discord-hono";
import courseJson from "../data/course.json" with { type: "json" };
import type { CourseData } from "../data/types.js";
import { baseEmbed } from "../lib/embeds.js";
import { type AppEnv, userMessage } from "../lib/errors.js";
import {
	describeAnswer,
	encodePayload,
	generateQuestion,
	isQuizMode,
	parsePayload,
	type QuizKind,
	type QuizMode,
	type QuizQuestion,
} from "../services/quiz.js";
import {
	getStats,
	getUser,
	nextUserState,
	type QuizStats,
	recordAttempt,
	todayUTC,
} from "../services/quizdb.js";

const course = courseJson as CourseData;

const MAX_BUTTON_LABEL = 80;

const NOT_YOUR_QUIZ =
	"これはあなたのクイズではありません。`/quiz` で自分のクイズを始めてください。 / This isn't your quiz — start your own with `/quiz`.";
const BROKEN_BUTTON =
	"このボタンは無効になりました。もう一度 `/quiz` を実行してください。 / This button is no longer valid — run `/quiz` again.";

type QuizCommandOptions = { mode?: QuizMode; stats?: boolean };

/** Discord truncates button labels at 80 chars anyway; do it ourselves so encode never throws on our own data. */
function truncateLabel(label: string): string {
	return label.length > MAX_BUTTON_LABEL
		? `${label.slice(0, MAX_BUTTON_LABEL - 1)}…`
		: label;
}

type InteractionActor = {
	member?: { user?: { id?: string } };
	user?: { id?: string };
};

/** The user who performed an interaction (guild `member.user` or DM `user`). */
function actorId(interaction: InteractionActor): string | undefined {
	return interaction.member?.user?.id ?? interaction.user?.id;
}

/** The user whose `/quiz` (or prior component click) produced the message being acted on. */
function messageInvokerId(message: {
	interaction_metadata?: { user?: { id?: string } };
}): string | undefined {
	return message.interaction_metadata?.user?.id;
}

const KIND_TITLES: Record<QuizKind, string> = {
	"vocab-l2g": "🧠 意味は？ / What does this mean?",
	"vocab-g2l": "🧠 単語は？ / Which word is this?",
	"sentence-blank": "📝 空欄を埋めよう / Fill in the blank",
	"sentence-convo": "💬 返事を選ぼう / Pick the reply",
	"sentence-mc": "📝 意味は？ / What does this mean?",
};

function questionEmbed(question: QuizQuestion) {
	const description = question.context
		? `${question.prompt}\n-# ${question.context}`
		: question.prompt;
	return baseEmbed().title(KIND_TITLES[question.kind]).description(description);
}

/** `mode` is the session mode, threaded through so "Next ▶" keeps a mixed session mixed. */
function questionComponents(question: QuizQuestion, mode: QuizMode) {
	return new Components().row(
		...question.choices.map((label, i) =>
			new Button("quiz", truncateLabel(label), "Secondary").custom_value(
				encodePayload(
					question.kind,
					question.itemId,
					i,
					question.correctIndex,
					mode,
				),
			),
		),
	);
}

function nextComponents(mode: QuizMode) {
	return new Components().row(
		new Button("quiz-next", "Next ▶", "Primary").custom_value(mode),
	);
}

/**
 * `errors.ts`'s `safeHandler` is typed for `CommandContext` only (its
 * signature predates components) and is intentionally left untouched here
 * to avoid conflicts at integration — this is its `ComponentContext`
 * counterpart, reusing the same `userMessage()` copy for the fallback error.
 */
function safeComponentHandler(
	fn: (c: ComponentContext<AppEnv>) => Promise<Response> | Response,
): (c: ComponentContext<AppEnv>) => Promise<Response> {
	return async (c) => {
		try {
			return await fn(c);
		} catch (err) {
			return c.flags("EPHEMERAL").res(`⚠️ ${userMessage(err)}`);
		}
	};
}

function statsEmbed(stats: QuizStats) {
	return baseEmbed()
		.title("📊 クイズ成績 / Your quiz stats")
		.fields(
			{
				name: "回答数 / Answered",
				value: String(stats.totalAnswered),
				inline: true,
			},
			{
				name: "正解数 / Correct",
				value: String(stats.totalCorrect),
				inline: true,
			},
			{
				name: "正答率 / Accuracy",
				value: `${stats.accuracyPercent}%`,
				inline: true,
			},
			{
				name: "連続正解 / Answer streak",
				value: String(stats.streak),
				inline: true,
			},
			{
				name: "最高連続正解 / Best streak",
				value: String(stats.bestStreak),
				inline: true,
			},
			{
				name: "連続日数 / Daily streak",
				value: String(stats.dailyStreak),
				inline: true,
			},
		);
}

/**
 * `/quiz mode? stats?` — direct `c.res`, never deferred: question generation
 * is pure/synchronous (local course.json), and `stats:true` is a single fast
 * D1 read well within the interaction deadline.
 */
export async function quiz(c: CommandContext<AppEnv>) {
	const { mode = "mixed", stats } = c.var as unknown as QuizCommandOptions;

	if (stats) {
		const userId = actorId(c.interaction);
		const summary = userId
			? await getStats(c.env.DB, userId)
			: {
					totalAnswered: 0,
					totalCorrect: 0,
					accuracyPercent: 0,
					streak: 0,
					bestStreak: 0,
					dailyStreak: 0,
				};
		return c.flags("EPHEMERAL").res({ embeds: [statsEmbed(summary)] });
	}

	const question = generateQuestion(course, mode, Math.random);
	return c.res({
		embeds: [questionEmbed(question)],
		components: questionComponents(question, mode),
	});
}

/**
 * Button click on a question. Only the original `/quiz` invoker may answer;
 * everyone else gets a private rejection. Grades the click, rewrites the
 * message with the reveal, and records the attempt in D1 via `waitUntil` —
 * the write never blocks this response (a separate, fast read is used to
 * compute the streak numbers shown here).
 */
async function handleQuizAnswer(c: ComponentContext<AppEnv>) {
	const invoker = messageInvokerId(c.interaction.message);
	const clicker = actorId(c.interaction);
	if (invoker && clicker !== invoker) {
		return c.flags("EPHEMERAL").res(NOT_YOUR_QUIZ);
	}

	let payload: ReturnType<typeof parsePayload>;
	try {
		payload = parsePayload(c.ref.custom_value ?? "");
	} catch {
		return c.flags("EPHEMERAL").res(BROKEN_BUTTON);
	}
	const { kind, itemId, chosenIndex, correctIndex, mode } = payload;
	const correct = chosenIndex === correctIndex;
	const reveal = describeAnswer(course, kind, itemId);

	const userId = clicker ?? "unknown";
	const db = c.env.DB;
	const prior = await getUser(db, userId);
	const today = todayUTC();
	const next = nextUserState(prior, correct, today);
	c.executionCtx.waitUntil(recordAttempt(db, userId, itemId, kind, correct));

	const embed = baseEmbed()
		.title(correct ? "✅ 正解！ / Correct!" : "❌ 不正解 / Incorrect")
		.description(
			reveal
				? `正解 / Answer: **${reveal.correctAnswerText}**`
				: "正解を読み込めませんでした。 / Couldn't load the answer.",
		)
		.fields(
			...(reveal?.detail
				? [{ name: "メモ / Note", value: reveal.detail, inline: false }]
				: []),
			{
				name: "連続正解 / Answer streak",
				value: `${next.streak} (best ${next.bestStreak})`,
				inline: true,
			},
			{
				name: "連続日数 / Daily streak",
				value: String(next.dailyStreak),
				inline: true,
			},
		);

	return c.update().res({
		embeds: [embed],
		// The payload carries the original /quiz session mode, so a mixed
		// session keeps generating mixed questions forever.
		components: nextComponents(mode),
	});
}

/** "Next ▶" — a fresh question in the original session mode, same invoker gate as the answer handler. */
function handleQuizNext(c: ComponentContext<AppEnv>) {
	const invoker = messageInvokerId(c.interaction.message);
	const clicker = actorId(c.interaction);
	if (invoker && clicker !== invoker) {
		return c.flags("EPHEMERAL").res(NOT_YOUR_QUIZ);
	}

	const raw = c.ref.custom_value ?? "";
	const mode: QuizMode = isQuizMode(raw) ? raw : "mixed";
	const question = generateQuestion(course, mode, Math.random);
	return c.update().res({
		embeds: [questionEmbed(question)],
		components: questionComponents(question, mode),
	});
}

export const quizAnswer = safeComponentHandler(handleQuizAnswer);
export const quizNext = safeComponentHandler(handleQuizNext);
