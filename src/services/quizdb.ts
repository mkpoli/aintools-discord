/**
 * D1-backed quiz scores + streaks (migrations/0001_quiz.sql).
 *
 * All streak/date decisions live in small pure functions so they're
 * unit-testable without a database. The only I/O is: one read (`getUser`,
 * used to compute what to show the user *right now*) and one write
 * (`persistAttempt`, meant to be handed to `c.executionCtx.waitUntil` so it
 * never blocks the interaction response). `recordAttempt` performs a
 * read-modify-write — a second concurrent answer from the same user in the
 * same instant could race, but D1 requests from one Discord user answering
 * one quiz at a time make that vanishingly unlikely, and it keeps the write
 * a plain, easy-to-read INSERT/UPDATE with no cross-row locking.
 */

export interface QuizUserRow {
	user_id: string;
	total_answered: number;
	total_correct: number;
	streak: number;
	best_streak: number;
	daily_streak: number;
	last_played_date: string | null;
	updated_at: string;
}

/** UTC calendar date as `YYYY-MM-DD` — all streak dates are in UTC. */
export function todayUTC(now: Date = new Date()): string {
	const iso = now.toISOString();
	return iso.slice(0, 10);
}

function addDaysUTC(dateStr: string, days: number): string {
	const d = new Date(`${dateStr}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** The answer streak: resets to 0 on a wrong answer, else +1. */
export function nextAnswerStreak(
	currentStreak: number,
	correct: boolean,
): number {
	return correct ? currentStreak + 1 : 0;
}

/** Best streak is a high-water mark — never decreases. */
export function nextBestStreak(bestStreak: number, newStreak: number): number {
	return Math.max(bestStreak, newStreak);
}

/**
 * Daily (day-over-day) play streak: unchanged if already played today,
 * +1 if the last played day was exactly yesterday, else reset to 1
 * (covers both a multi-day gap and the very first play).
 */
export function nextDailyStreak(
	lastPlayedDate: string | null,
	today: string,
	currentDailyStreak: number,
): number {
	if (lastPlayedDate === today) return currentDailyStreak;
	if (lastPlayedDate && addDaysUTC(lastPlayedDate, 1) === today) {
		return currentDailyStreak + 1;
	}
	return 1;
}

export interface NextUserState {
	totalAnswered: number;
	totalCorrect: number;
	streak: number;
	bestStreak: number;
	dailyStreak: number;
}

/** Pure projection of the next `quiz_users` counters given the prior row (if any). */
export function nextUserState(
	prior: QuizUserRow | undefined,
	correct: boolean,
	today: string,
): NextUserState {
	const streak = nextAnswerStreak(prior?.streak ?? 0, correct);
	return {
		totalAnswered: (prior?.total_answered ?? 0) + 1,
		totalCorrect: (prior?.total_correct ?? 0) + (correct ? 1 : 0),
		streak,
		bestStreak: nextBestStreak(prior?.best_streak ?? 0, streak),
		dailyStreak: nextDailyStreak(
			prior?.last_played_date ?? null,
			today,
			prior?.daily_streak ?? 0,
		),
	};
}

export function accuracyPercent(
	totalCorrect: number,
	totalAnswered: number,
): number {
	if (totalAnswered <= 0) return 0;
	return Math.round((totalCorrect / totalAnswered) * 100);
}

/** Reads a user's current row, or `undefined` if they've never played. */
export async function getUser(
	db: D1Database,
	userId: string,
): Promise<QuizUserRow | undefined> {
	const row = await db
		.prepare("SELECT * FROM quiz_users WHERE user_id = ?")
		.bind(userId)
		.first<QuizUserRow>();
	return row ?? undefined;
}

/**
 * Records one answered question: reads the user's prior counters, computes
 * the next state with the pure helpers above, then persists an attempt row
 * + the updated `quiz_users` counters in a single `db.batch()`.
 *
 * Call this via `c.executionCtx.waitUntil(recordAttempt(...))` — never
 * await it in the response path. The component handler independently calls
 * `getUser` + `nextUserState` itself (a second, cheap read) to render the
 * streak it shows in the same response; the two reads racing is the only
 * downside of skipping a CASE-expression atomic upsert, and is an accepted
 * tradeoff for a single Discord user answering one quiz at a time.
 */
export async function recordAttempt(
	db: D1Database,
	userId: string,
	itemId: string,
	kind: string,
	correct: boolean,
	now: Date = new Date(),
): Promise<void> {
	const prior = await getUser(db, userId);
	const today = todayUTC(now);
	const next = nextUserState(prior, correct, today);
	const nowIso = now.toISOString();

	await db.batch([
		db
			.prepare(
				"INSERT INTO quiz_attempts (user_id, item_id, kind, correct, answered_at) VALUES (?, ?, ?, ?, ?)",
			)
			.bind(userId, itemId, kind, correct ? 1 : 0, nowIso),
		db
			.prepare(
				`INSERT INTO quiz_users
					(user_id, total_answered, total_correct, streak, best_streak, daily_streak, last_played_date, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(user_id) DO UPDATE SET
					total_answered = excluded.total_answered,
					total_correct = excluded.total_correct,
					streak = excluded.streak,
					best_streak = excluded.best_streak,
					daily_streak = excluded.daily_streak,
					last_played_date = excluded.last_played_date,
					updated_at = excluded.updated_at`,
			)
			.bind(
				userId,
				next.totalAnswered,
				next.totalCorrect,
				next.streak,
				next.bestStreak,
				next.dailyStreak,
				today,
				nowIso,
			),
	]);
}

export interface QuizStats {
	totalAnswered: number;
	totalCorrect: number;
	accuracyPercent: number;
	streak: number;
	bestStreak: number;
	dailyStreak: number;
}

export async function getStats(
	db: D1Database,
	userId: string,
): Promise<QuizStats> {
	const row = await getUser(db, userId);
	return {
		totalAnswered: row?.total_answered ?? 0,
		totalCorrect: row?.total_correct ?? 0,
		accuracyPercent: accuracyPercent(
			row?.total_correct ?? 0,
			row?.total_answered ?? 0,
		),
		streak: row?.streak ?? 0,
		bestStreak: row?.best_streak ?? 0,
		dailyStreak: row?.daily_streak ?? 0,
	};
}
