import { describe, expect, it } from "bun:test";
import course from "../src/data/course.json" with { type: "json" };
import type { CourseData, Sentence, Vocab } from "../src/data/types.js";
import {
	describeAnswer,
	encodePayload,
	generateQuestion,
	parsePayload,
	type QuizKind,
} from "../src/services/quiz.js";
import {
	accuracyPercent,
	getUser,
	nextAnswerStreak,
	nextBestStreak,
	nextDailyStreak,
	nextUserState,
	type QuizUserRow,
	recordAttempt,
	todayUTC,
} from "../src/services/quizdb.js";

const realCourse = course as CourseData;

/** Deterministic mulberry32 PRNG — same `() => number` contract as `Math.random`. */
function seededRng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function vocab(partial: Partial<Vocab> & Pick<Vocab, "id" | "latin">): Vocab {
	return {
		gloss: { ja: `${partial.id}ja`, en: `${partial.id}en` },
		...partial,
	};
}

describe("generateQuestion — vocab", () => {
	it("prefers same-category distractors when there are exactly enough", () => {
		const target = vocab({
			id: "target",
			latin: "target-latin",
			category: "A",
		});
		const sameCategory = [
			vocab({ id: "a1", latin: "a1-latin", category: "A" }),
			vocab({ id: "a2", latin: "a2-latin", category: "A" }),
			vocab({ id: "a3", latin: "a3-latin", category: "A" }),
		];
		const otherCategory = [
			vocab({ id: "b1", latin: "b1-latin", category: "B" }),
			vocab({ id: "b2", latin: "b2-latin", category: "B" }),
		];
		const data: CourseData = {
			vocab: [target, ...sameCategory, ...otherCategory],
			sentences: [],
		};

		// generateQuestion also picks the target itself at random, so only check
		// the invariant on seeds where "target" (category A, 3 A-siblings) was
		// actually the item under test.
		let checked = 0;
		for (let seed = 0; seed < 200; seed++) {
			const question = generateQuestion(data, "vocab", seededRng(seed));
			if (question.itemId !== "target") continue;
			checked++;
			// 4 choices: target + 3 distractors, all drawn from category A since
			// that pool has exactly 3 members — B items must never appear.
			expect(question.choices).toHaveLength(4);
			const usesB =
				question.kind === "vocab-l2g"
					? question.choices.some(
							(c) => c === "b1ja (b1en)" || c === "b2ja (b2en)",
						)
					: question.choices.some((c) => c === "b1-latin" || c === "b2-latin");
			expect(usesB).toBe(false);
		}
		expect(checked).toBeGreaterThan(0);
	});

	it("falls back to the rest of the pool when same-category has too few", () => {
		const target = vocab({
			id: "target",
			latin: "target-latin",
			category: "C",
		}); // unique category
		const pool = Array.from({ length: 5 }, (_, i) =>
			vocab({ id: `p${i}`, latin: `p${i}-latin`, category: "other" }),
		);
		const data: CourseData = { vocab: [target, ...pool], sentences: [] };

		const question = generateQuestion(data, "vocab", seededRng(7));
		expect(question.choices).toHaveLength(4);
		expect(question.correctIndex).toBeGreaterThanOrEqual(0);
		expect(question.correctIndex).toBeLessThan(4);
	});

	it("has no category on the target => no crash, distractors come from the whole pool", () => {
		const target = vocab({ id: "target", latin: "target-latin" }); // no category
		const pool = Array.from({ length: 5 }, (_, i) =>
			vocab({
				id: `p${i}`,
				latin: `p${i}-latin`,
				category: i % 2 === 0 ? "x" : "y",
			}),
		);
		const data: CourseData = { vocab: [target, ...pool], sentences: [] };

		const question = generateQuestion(data, "vocab", seededRng(3));
		expect(question.choices).toHaveLength(4);
	});

	it("choice shuffling is deterministic for a given seed", () => {
		const data: CourseData = {
			vocab: Array.from({ length: 8 }, (_, i) =>
				vocab({
					id: `v${i}`,
					latin: `v${i}-latin`,
					category: i < 4 ? "a" : "b",
				}),
			),
			sentences: [],
		};
		const q1 = generateQuestion(data, "vocab", seededRng(123));
		const q2 = generateQuestion(data, "vocab", seededRng(123));
		expect(q1).toEqual(q2);
	});

	it("only ever picks vocab kinds when mode is 'vocab'", () => {
		for (let seed = 0; seed < 15; seed++) {
			const question = generateQuestion(realCourse, "vocab", seededRng(seed));
			expect(["vocab-l2g", "vocab-g2l"]).toContain(question.kind);
		}
	});
});

describe("generateQuestion — sentence scaffold selection", () => {
	const blankOnly: Sentence = {
		id: "s_blank",
		latin: "aynu ku=ne.",
		translation: { ja: "私は人間です。", en: "I am a person." },
		blank: { answer: "aynu", options: ["aynu", "menoko", "seta", "cikap"] },
	};
	const convoOnly: Sentence = {
		id: "s_convo",
		latin: "irankarapte.",
		translation: { ja: "こんにちは。", en: "Hello." },
		convo: {
			prompt: "greeting cue",
			options: ["irankarapte.", "iyairaykere.", "pirka.", "hioy'oy."],
		},
	};
	const neither: Sentence = {
		id: "s_plain",
		latin: "menoko ku=ne.",
		translation: { ja: "私は女です。", en: "I am a woman." },
	};

	it("uses the blank scaffold and substitutes '___' for the answer token", () => {
		const data: CourseData = { vocab: [], sentences: [blankOnly] };
		const question = generateQuestion(data, "sentence", seededRng(1));
		expect(question.kind).toBe("sentence-blank");
		expect(question.prompt).toBe("___ ku=ne.");
		expect(question.choices).toHaveLength(4);
		expect(question.choices[question.correctIndex]).toBe("aynu");
	});

	it("uses the convo scaffold and its options", () => {
		const data: CourseData = { vocab: [], sentences: [convoOnly] };
		const question = generateQuestion(data, "sentence", seededRng(2));
		expect(question.kind).toBe("sentence-convo");
		expect(question.prompt).toBe("irankarapte.");
		expect(question.context).toBe("greeting cue");
		expect(question.choices[question.correctIndex]).toBe("irankarapte.");
	});

	it("falls back to translation multiple-choice when neither scaffold is present", () => {
		const sentences = [
			neither,
			{ ...blankOnly, id: "distractor1" },
			{ ...convoOnly, id: "distractor2" },
			{ ...neither, id: "distractor3", translation: { ja: "d3", en: "d3" } },
		];
		const data: CourseData = { vocab: [], sentences };
		// Only "neither" and "distractor3" lack a scaffold — generateQuestion
		// picks its target at random, so check whichever of those two it hits.
		let checked = 0;
		for (let seed = 0; seed < 40; seed++) {
			const question = generateQuestion(data, "sentence", seededRng(seed));
			if (question.kind !== "sentence-mc") continue;
			checked++;
			const target = sentences.find((s) => s.id === question.itemId);
			expect(target).toBeDefined();
			expect(question.choices).toHaveLength(4);
			expect(question.choices[question.correctIndex]).toBe(
				`${target?.translation.ja} (${target?.translation.en})`,
			);
		}
		expect(checked).toBeGreaterThan(0);
	});

	it("mixed mode picks both vocab and sentence questions over many seeds", () => {
		const kinds = new Set<QuizKind>();
		for (let seed = 0; seed < 40; seed++) {
			kinds.add(generateQuestion(realCourse, "mixed", seededRng(seed)).kind);
		}
		const hasVocab = [...kinds].some((k) => k.startsWith("vocab"));
		const hasSentence = [...kinds].some((k) => k.startsWith("sentence"));
		expect(hasVocab).toBe(true);
		expect(hasSentence).toBe(true);
	});
});

describe("generateQuestion — sanity over the real vendored course", () => {
	it("every generated question has a valid correctIndex into its choices", () => {
		for (let seed = 0; seed < 60; seed++) {
			const question = generateQuestion(realCourse, "mixed", seededRng(seed));
			expect(question.correctIndex).toBeGreaterThanOrEqual(0);
			expect(question.correctIndex).toBeLessThan(question.choices.length);
		}
	});

	it("describeAnswer resolves the correct text for every generated question", () => {
		for (let seed = 0; seed < 60; seed++) {
			const question = generateQuestion(realCourse, "mixed", seededRng(seed));
			const reveal = describeAnswer(realCourse, question.kind, question.itemId);
			expect(reveal).toBeDefined();
			if (question.kind === "sentence-blank") {
				// The button shows just the blank token; the reveal shows the
				// full sentence for context — they're deliberately different.
				const sentence = realCourse.sentences.find(
					(s) => s.id === question.itemId,
				);
				expect(sentence?.blank).toBeDefined();
				expect(reveal?.correctAnswerText).toBe(sentence?.latin ?? "");
				expect(question.choices[question.correctIndex]).toBe(
					sentence?.blank?.answer ?? "",
				);
			} else {
				expect(reveal?.correctAnswerText).toBe(
					question.choices[question.correctIndex],
				);
			}
		}
	});
});

describe("payload codec", () => {
	it("round-trips through encode/parse", () => {
		const payload = encodePayload("vocab-l2g", "v_irankarapte", 2, 0);
		expect(parsePayload(payload)).toEqual({
			kind: "vocab-l2g",
			itemId: "v_irankarapte",
			chosenIndex: 2,
			correctIndex: 0,
		});
	});

	it("never contains ';' — discord-hono's CUSTOM_ID_SEPARATOR", () => {
		const payload = encodePayload("sentence-blank", "s_001", 3, 1);
		expect(payload.includes(";")).toBe(false);
	});

	it("rejects a payload containing ';'", () => {
		expect(() => parsePayload("vocab-l2g:v_x:0;0")).toThrow();
	});

	it("rejects malformed payloads (wrong field count, unknown kind, non-integer indices)", () => {
		expect(() => parsePayload("vocab-l2g:v_x:0")).toThrow();
		expect(() => parsePayload("vocab-l2g:v_x:0:0:0")).toThrow();
		expect(() => parsePayload("not-a-kind:v_x:0:0")).toThrow();
		expect(() => parsePayload("vocab-l2g:v_x:a:0")).toThrow();
	});

	it("encodePayload refuses fields containing the field separator", () => {
		expect(() => encodePayload("vocab-l2g", "v:x", 0, 0)).toThrow();
	});
});

describe("streak/date helpers", () => {
	it("nextAnswerStreak resets to 0 on a wrong answer, +1 on correct", () => {
		expect(nextAnswerStreak(5, true)).toBe(6);
		expect(nextAnswerStreak(5, false)).toBe(0);
		expect(nextAnswerStreak(0, true)).toBe(1);
	});

	it("nextBestStreak never decreases", () => {
		expect(nextBestStreak(3, 5)).toBe(5);
		expect(nextBestStreak(5, 3)).toBe(5);
		expect(nextBestStreak(0, 0)).toBe(0);
	});

	it("nextDailyStreak: same day is unchanged", () => {
		expect(nextDailyStreak("2026-07-03", "2026-07-03", 4)).toBe(4);
	});

	it("nextDailyStreak: exactly yesterday increments", () => {
		expect(nextDailyStreak("2026-07-02", "2026-07-03", 4)).toBe(5);
	});

	it("nextDailyStreak: a gap of 2+ days resets to 1", () => {
		expect(nextDailyStreak("2026-06-30", "2026-07-03", 10)).toBe(1);
	});

	it("nextDailyStreak: never played before starts at 1", () => {
		expect(nextDailyStreak(null, "2026-07-03", 0)).toBe(1);
	});

	it("nextDailyStreak: 'yesterday' correctly crosses a month boundary", () => {
		expect(nextDailyStreak("2026-06-30", "2026-07-01", 2)).toBe(3);
	});

	it("nextDailyStreak: 'yesterday' correctly crosses a year boundary", () => {
		expect(nextDailyStreak("2025-12-31", "2026-01-01", 9)).toBe(10);
	});

	it("todayUTC formats as YYYY-MM-DD in UTC", () => {
		expect(todayUTC(new Date("2026-07-03T23:59:00Z"))).toBe("2026-07-03");
		expect(todayUTC(new Date("2026-07-03T00:00:00Z"))).toBe("2026-07-03");
	});

	it("accuracyPercent rounds and handles zero answers", () => {
		expect(accuracyPercent(0, 0)).toBe(0);
		expect(accuracyPercent(1, 3)).toBe(33);
		expect(accuracyPercent(2, 3)).toBe(67);
	});

	it("nextUserState composes the pure helpers for a brand-new user", () => {
		const today = "2026-07-03";
		const next = nextUserState(undefined, true, today);
		expect(next).toEqual({
			totalAnswered: 1,
			totalCorrect: 1,
			streak: 1,
			bestStreak: 1,
			dailyStreak: 1,
		});
	});

	it("nextUserState carries forward counters and applies a wrong answer", () => {
		const prior: QuizUserRow = {
			user_id: "u1",
			total_answered: 10,
			total_correct: 7,
			streak: 4,
			best_streak: 6,
			daily_streak: 3,
			last_played_date: "2026-07-02",
			updated_at: "2026-07-02T00:00:00.000Z",
		};
		const next = nextUserState(prior, false, "2026-07-03");
		expect(next).toEqual({
			totalAnswered: 11,
			totalCorrect: 7,
			streak: 0,
			bestStreak: 6,
			dailyStreak: 4,
		});
	});
});

// --- Minimal in-memory D1 stub -------------------------------------------
// Only implements what quizdb.ts actually calls: prepare().bind().first()/run(),
// and batch(). Dispatches on a substring of the query text rather than a real
// SQL parser — deliberately minimal per the PR-6 spec.

class FakeStatement {
	#query: string;
	#db: FakeD1;
	#args: unknown[] = [];

	constructor(query: string, db: FakeD1) {
		this.#query = query;
		this.#db = db;
	}

	bind(...values: unknown[]) {
		this.#args = values;
		return this;
	}

	async first<T>(): Promise<T | null> {
		if (this.#query.includes("SELECT * FROM quiz_users")) {
			const [userId] = this.#args as [string];
			return (this.#db.users.get(userId) ?? null) as T | null;
		}
		throw new Error(`FakeStatement.first: unsupported query: ${this.#query}`);
	}

	async run() {
		if (this.#query.includes("INSERT INTO quiz_attempts")) {
			const [userId, itemId, kind, correct, answeredAt] = this.#args as [
				string,
				string,
				string,
				number,
				string,
			];
			this.#db.attempts.push({ userId, itemId, kind, correct, answeredAt });
			return { success: true, meta: {} };
		}
		if (this.#query.includes("INSERT INTO quiz_users")) {
			const [
				userId,
				totalAnswered,
				totalCorrect,
				streak,
				bestStreak,
				dailyStreak,
				lastPlayedDate,
				updatedAt,
			] = this.#args as [
				string,
				number,
				number,
				number,
				number,
				number,
				string,
				string,
			];
			this.#db.users.set(userId, {
				user_id: userId,
				total_answered: totalAnswered,
				total_correct: totalCorrect,
				streak,
				best_streak: bestStreak,
				daily_streak: dailyStreak,
				last_played_date: lastPlayedDate,
				updated_at: updatedAt,
			});
			return { success: true, meta: {} };
		}
		throw new Error(`FakeStatement.run: unsupported query: ${this.#query}`);
	}
}

class FakeD1 {
	users = new Map<string, QuizUserRow>();
	attempts: Array<{
		userId: string;
		itemId: string;
		kind: string;
		correct: number;
		answeredAt: string;
	}> = [];

	prepare(query: string) {
		return new FakeStatement(query, this);
	}

	async batch(statements: FakeStatement[]) {
		const results = [];
		for (const stmt of statements) results.push(await stmt.run());
		return results;
	}
}

describe("recordAttempt (stubbed D1)", () => {
	it("persists an attempt row and upserts the user's counters", async () => {
		const db = new FakeD1();
		await recordAttempt(
			db as unknown as D1Database,
			"user-1",
			"v_irankarapte",
			"vocab-l2g",
			true,
			new Date("2026-07-03T12:00:00Z"),
		);

		expect(db.attempts).toHaveLength(1);
		expect(db.attempts[0]).toMatchObject({
			userId: "user-1",
			itemId: "v_irankarapte",
			kind: "vocab-l2g",
			correct: 1,
		});

		const row = await getUser(db as unknown as D1Database, "user-1");
		expect(row).toMatchObject({
			user_id: "user-1",
			total_answered: 1,
			total_correct: 1,
			streak: 1,
			best_streak: 1,
			daily_streak: 1,
			last_played_date: "2026-07-03",
		});
	});

	it("accumulates across multiple attempts, resetting the answer streak on a miss", async () => {
		const db = new FakeD1();
		await recordAttempt(
			db as unknown as D1Database,
			"user-2",
			"v_a",
			"vocab-l2g",
			true,
			new Date("2026-07-01T00:00:00Z"),
		);
		await recordAttempt(
			db as unknown as D1Database,
			"user-2",
			"v_b",
			"vocab-g2l",
			true,
			new Date("2026-07-02T00:00:00Z"),
		);
		await recordAttempt(
			db as unknown as D1Database,
			"user-2",
			"v_c",
			"vocab-l2g",
			false,
			new Date("2026-07-03T00:00:00Z"),
		);

		const row = await getUser(db as unknown as D1Database, "user-2");
		expect(row).toMatchObject({
			total_answered: 3,
			total_correct: 2,
			streak: 0,
			best_streak: 2,
			daily_streak: 3,
			last_played_date: "2026-07-03",
		});
	});
});
