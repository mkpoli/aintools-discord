/**
 * Word-of-the-day cron: `app.cron("0 22 * * *", runWotd)` in src/index.ts,
 * triggered `0 22 * * *` (07:00 JST) per wrangler.jsonc, dispatched by
 * explicit cron key. (A second trigger — the message archive crawler — was
 * added alongside this one; a bare `app.cron("", handler)` catch-all would
 * have silently matched both, so both are now registered by their exact
 * cron string.) The whole pick/filter/probe algorithm is decomposed into
 * pure functions (unit-tested in test/wotd-pick.test.ts) around a thin I/O
 * shell (`runWotd`) that:
 *
 *  1. no-ops if `WOTD_CHANNEL_ID` is unset (safe until a post channel is chosen)
 *  2. no-ops if today (JST) already has a `posted=1` row in `wotd_history`
 *  3. sources candidates from `/v1/freq/list`, filters them, deterministically
 *     picks one by `fnv1a(date)`, probing forward for a glossary hit
 *  4. enriches with a glossary gloss, one corpus example, and all 4 scripts
 *  5. posts an embed via the cron context's REST helper, then upserts the
 *     history row — only on a confirmed-successful post, so a failure never
 *     leaves a false "posted" row behind (the next day's run would still
 *     skip ahead, but a *retried* run for the same date is safe either way).
 */
import type { CronContext } from "discord-hono";
import { $channels$_$messages } from "discord-hono";
import { baseEmbed } from "../lib/embeds.js";
import type { AppEnv } from "../lib/errors.js";
import { fnv1a } from "../lib/hash.js";
import { type CorpusRow, freqList, searchCorpus } from "../services/corpus.js";
import {
	type GlossaryEntry,
	type GlossaryTable,
	getGlossary,
	searchGlossary,
} from "../services/glossary.js";
import { allScripts, SCRIPT_LABELS, SCRIPTS } from "../services/script.js";

const CANDIDATE_LIMIT = 400;
const CANDIDATE_MIN_COUNT = 5;
const RECENT_WINDOW_DAYS = 180;
const MAX_PROBE = 20;
const EXAMPLE_LIMIT = 5;
const GLOSSARY_LOOKUP_LIMIT = 5;

// ---------------------------------------------------------------- pure ----

/** Today's date in JST (`Asia/Tokyo`, no DST) as `YYYY-MM-DD`. */
export function jstDateString(now: Date = new Date()): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Tokyo",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(now);
}

/** `dateStr` (`YYYY-MM-DD`) shifted by `days` (may be negative) — calendar-only, UTC-anchored. */
export function shiftDateString(dateStr: string, days: number): string {
	const d = new Date(`${dateStr}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

const VALID_TOKEN = /^[\p{L}']+$/u;

/**
 * A token is WOTD-eligible when it's at least 2 chars, carries no affix `=`
 * marker, no digits, and no punctuation other than the apostrophe (used for
 * the Ainu glottal stop, e.g. `ne'ampe`).
 */
export function isCandidateToken(token: string): boolean {
	if (token.length < 2) return false;
	if (token.includes("=")) return false;
	if (/[0-9]/.test(token)) return false;
	if (!VALID_TOKEN.test(token)) return false;
	return true;
}

/**
 * Filters `/v1/freq/list` rows down to eligible, deduplicated, order-preserving
 * candidate tokens, dropping any token posted within the last
 * `RECENT_WINDOW_DAYS` (via `excludeTokens`, a single D1 query result).
 */
export function filterCandidates(
	rows: readonly { token: string }[],
	excludeTokens: ReadonlySet<string>,
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const { token } of rows) {
		if (!isCandidateToken(token)) continue;
		if (excludeTokens.has(token)) continue;
		if (seen.has(token)) continue;
		seen.add(token);
		out.push(token);
	}
	return out;
}

/** Deterministic daily index into `candidates` — same date always picks the same slot. */
export function pickIndex(dateStr: string, candidateCount: number): number {
	if (candidateCount <= 0) {
		throw new Error("pickIndex: candidateCount must be > 0");
	}
	return fnv1a(dateStr) % candidateCount;
}

export interface ProbeResult {
	token: string;
	index: number;
	hasGloss: boolean;
}

/**
 * Starting at `startIndex`, probes forward (wrapping) through `candidates`
 * for the first token with a glossary hit, giving up after `maxProbe`
 * attempts (or the full candidate list, whichever is smaller). Falls back to
 * the original hash pick — with `hasGloss: false` — when none is found.
 * `hasGlossaryHit` is injected so this stays pure/fixture-testable.
 */
export function probeForGlossaryHit(
	candidates: readonly string[],
	startIndex: number,
	hasGlossaryHit: (token: string) => boolean,
	maxProbe: number = MAX_PROBE,
): ProbeResult {
	const n = candidates.length;
	const probes = Math.min(maxProbe, n);
	for (let step = 0; step < probes; step++) {
		const index = (startIndex + step) % n;
		const token = candidates[index];
		if (token !== undefined && hasGlossaryHit(token)) {
			return { token, index, hasGloss: true };
		}
	}
	const index = startIndex % n;
	// biome-ignore lint/style/noNonNullAssertion: index is derived from n = candidates.length > 0 (pickIndex throws otherwise)
	return { token: candidates[index]!, index, hasGloss: false };
}

/** Shortest (by Ainu text length) corpus row that carries a non-empty translation, or none. */
export function shortestTranslatedExample(
	rows: readonly CorpusRow[],
): CorpusRow | undefined {
	const translated = rows.filter(
		(row) => row.translation != null && row.translation.trim() !== "",
	);
	if (translated.length === 0) return undefined;
	return translated.reduce((shortest, row) =>
		row.text.length < shortest.text.length ? row : shortest,
	);
}

/** NFC-normalize, casefold, and strip combining accents — mirrors glossary.ts's internal `fold`. */
function normalizeAynu(s: string): string {
	return s
		.normalize("NFC")
		.toLowerCase()
		.normalize("NFD")
		.replace(/\p{M}/gu, "");
}

/** The glossary row whose `Aynu` field exactly matches `token` (accent/case-insensitive), if any. */
export function glossaryExactEntry(
	table: GlossaryTable,
	token: string,
): GlossaryEntry | undefined {
	const target = normalizeAynu(token);
	return searchGlossary(table, token, GLOSSARY_LOOKUP_LIMIT).find(
		(entry) => entry.Aynu !== undefined && normalizeAynu(entry.Aynu) === target,
	);
}

function scriptsFieldValue(token: string): string {
	const { scripts } = allScripts(token);
	return SCRIPTS.map((s) => `${SCRIPT_LABELS[s]}: ${scripts[s]}`).join("\n");
}

function exampleFieldValue(row: CorpusRow | undefined): string {
	if (!row) return "—";
	return `${row.text}\n${row.translation}\n-# ${[row.dialect, row.document].filter(Boolean).join(" · ") || "—"}`;
}

/** Pure embed builder — the only non-pure step left is `.toJSON()` at the call site (none here). */
export function wotdEmbed(
	token: string,
	entry: GlossaryEntry | undefined,
	example: CorpusRow | undefined,
) {
	const meaning = entry
		? [entry.日本語, entry.English].filter(Boolean).join(" · ") || "—"
		: "（辞書未登録 / not yet in the glossary）";
	return baseEmbed("corpus.aynu.org · itak.aynu.org")
		.title(`📅 今日のアイヌ語 / Word of the day: ${token}`)
		.fields(
			{ name: "意味 / Meaning", value: meaning },
			{ name: "表記 / Scripts", value: scriptsFieldValue(token) },
			{ name: "例文 / Example", value: exampleFieldValue(example) },
		);
}

// ---------------------------------------------------------------- I/O ----

async function alreadyPostedToday(
	db: D1Database,
	date: string,
): Promise<boolean> {
	const row = await db
		.prepare("SELECT posted FROM wotd_history WHERE date = ?")
		.bind(date)
		.first<{ posted: number }>();
	return row?.posted === 1;
}

async function recentTokens(
	db: D1Database,
	since: string,
): Promise<Set<string>> {
	const { results } = await db
		.prepare("SELECT token FROM wotd_history WHERE date >= ?")
		.bind(since)
		.all<{ token: string }>();
	return new Set(results.map((r) => r.token));
}

async function upsertPosted(
	db: D1Database,
	date: string,
	token: string,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO wotd_history (date, token, posted) VALUES (?, ?, 1)
			 ON CONFLICT(date) DO UPDATE SET token = excluded.token, posted = excluded.posted`,
		)
		.bind(date, token)
		.run();
}

/**
 * The cron handler itself. Any thrown error (upstream API down, Discord post
 * failed, …) is caught and logged — never rethrown — since there's no
 * interaction to reply to; the history row is only written after a confirmed
 * successful post, so a failed run always retries safely next time.
 *
 * `now` defaults to the real clock; tests inject a fixed `Date` so the JST
 * date (and therefore the deterministic hash pick) is reproducible.
 */
export async function runWotd(
	c: CronContext<AppEnv>,
	now: Date = new Date(),
): Promise<void> {
	const channelId = c.env.WOTD_CHANNEL_ID;
	if (!channelId) {
		console.warn("[wotd] WOTD_CHANNEL_ID is empty — skipping (safe no-op)");
		return;
	}

	const db = c.env.DB;
	const today = jstDateString(now);

	try {
		if (await alreadyPostedToday(db, today)) {
			console.log(`[wotd] ${today} already posted — no-op`);
			return;
		}

		const rows = await freqList(c.env, {
			limit: CANDIDATE_LIMIT,
			includeStopwords: false,
			minCount: CANDIDATE_MIN_COUNT,
		});
		const excluded = await recentTokens(
			db,
			shiftDateString(today, -RECENT_WINDOW_DAYS),
		);
		const candidates = filterCandidates(rows, excluded);
		if (candidates.length === 0) {
			console.error("[wotd] no eligible candidates after filtering — skipping");
			return;
		}

		const table = await getGlossary(c.env, c.executionCtx);
		const startIndex = pickIndex(today, candidates.length);
		const { token } = probeForGlossaryHit(
			candidates,
			startIndex,
			(t) => glossaryExactEntry(table, t) !== undefined,
		);
		const entry = glossaryExactEntry(table, token);

		const exampleRows = await searchCorpus(c.env, {
			q: token,
			lang: "ain",
			limit: EXAMPLE_LIMIT,
		});
		const example = shortestTranslatedExample(exampleRows);

		const res = await c.rest("POST", $channels$_$messages, [channelId], {
			embeds: [wotdEmbed(token, entry, example).toJSON()],
		});
		if (!res.ok) {
			throw new Error(`Discord post failed: HTTP ${res.status}`);
		}

		await upsertPosted(db, today, token);
	} catch (err) {
		console.error(
			"[wotd] run failed — no history row written, will retry",
			err,
		);
	}
}
