import { ApiError } from "../lib/errors.js";

/**
 * A row from `GET itak.aynu.org/api/gdoc`. Columns vary per source sheet
 * (some rows carry example-sentence or category columns we don't use here),
 * so this only types the fields `/glossary` reads; unlisted keys are ignored.
 */
export interface GlossaryEntry {
	Aynu?: string;
	日本語?: string;
	English?: string;
	中文?: string;
	sheetName: string;
	"註 / Notes"?: string;
}

export type GlossaryTable = readonly GlossaryEntry[];

interface GlossaryApiResponse {
	table: GlossaryTable;
	// Sheet metadata (titles/descriptions/counts) — not needed for search.
	sheets: unknown;
}

interface CacheValue {
	fetchedAt: number;
	table: GlossaryTable;
}

const KV_KEY = "glossary:v1";
const STALE_AFTER_MS = 86400 * 1000;
const FETCH_TIMEOUT_MS = 8000;

/**
 * Structural subset of `ExecutionContext` — discord-hono's `Context#executionCtx`
 * getter is typed against its own local (non-exported) `ExecutionContext`
 * interface, which is narrower than the Wrangler-generated global ambient one.
 * Depending only on the single method we need keeps both callers assignable.
 */
export interface WaitUntilCtx {
	waitUntil(promise: Promise<unknown>): void;
}

async function fetchGlossaryTable(env: Env): Promise<GlossaryTable> {
	let res: Response;
	try {
		res = await fetch(env.GLOSSARY_API_URL, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch {
		throw new ApiError("unreachable", "Could not reach itak.aynu.org/api/gdoc");
	}
	if (!res.ok) {
		throw new ApiError(
			"unreachable",
			`itak.aynu.org/api/gdoc returned ${res.status}`,
		);
	}
	const data = (await res.json()) as GlossaryApiResponse;
	return data.table;
}

async function refreshGlossary(env: Env): Promise<void> {
	try {
		const table = await fetchGlossaryTable(env);
		const value: CacheValue = { fetchedAt: Date.now(), table };
		await env.KV.put(KV_KEY, JSON.stringify(value));
	} catch (err) {
		// Background refresh failure is never user-visible — the stale copy
		// (or next cold-start fetch) keeps serving the command.
		console.error("[glossary] background refresh failed", err);
	}
}

/**
 * Stale-while-revalidate glossary table. Cache key `glossary:v1`, no KV
 * expiration (we manage staleness ourselves via `fetchedAt`). An itak.aynu.org
 * outage never breaks `/glossary`: a stale cached copy is served immediately
 * while a refresh runs in the background via `executionCtx.waitUntil`.
 */
export async function getGlossary(
	env: Env,
	executionCtx: WaitUntilCtx,
): Promise<GlossaryTable> {
	const cached = await env.KV.get<CacheValue>(KV_KEY, "json");
	if (cached) {
		if (Date.now() - cached.fetchedAt > STALE_AFTER_MS) {
			executionCtx.waitUntil(refreshGlossary(env));
		}
		return cached.table;
	}

	// Cold miss — nothing to serve stale, so this fetch is on the request path.
	const table = await fetchGlossaryTable(env);
	const value: CacheValue = { fetchedAt: Date.now(), table };
	await env.KV.put(KV_KEY, JSON.stringify(value));
	return table;
}

const NOTES_KEY = "註 / Notes" as const;

/** NFC-normalize, casefold, and strip combining accents for fuzzy compare. */
function fold(input: string): string {
	return input
		.normalize("NFC")
		.toLowerCase()
		.normalize("NFD")
		.replace(/\p{M}/gu, "");
}

/**
 * Pure ranked search — no I/O, safe to unit test directly. Tiers (highest
 * first): exact Aynu match > Aynu prefix > Aynu substring > match in a gloss
 * (日本語/English/中文) > match in notes. Rows without `Aynu` are skipped.
 * Order within a tier follows the table's original row order.
 */
export function searchGlossary(
	table: GlossaryTable,
	query: string,
	limit: number,
): GlossaryEntry[] {
	const q = fold(query.trim());
	if (!q) return [];

	const exact: GlossaryEntry[] = [];
	const prefix: GlossaryEntry[] = [];
	const substring: GlossaryEntry[] = [];
	const gloss: GlossaryEntry[] = [];
	const notes: GlossaryEntry[] = [];

	for (const row of table) {
		if (!row.Aynu) continue;
		const aynu = fold(row.Aynu);

		if (aynu === q) {
			exact.push(row);
		} else if (aynu.startsWith(q)) {
			prefix.push(row);
		} else if (aynu.includes(q)) {
			substring.push(row);
		} else if (
			(row.日本語 && fold(row.日本語).includes(q)) ||
			(row.English && fold(row.English).includes(q)) ||
			(row.中文 && fold(row.中文).includes(q))
		) {
			gloss.push(row);
		} else if (row[NOTES_KEY] && fold(row[NOTES_KEY]).includes(q)) {
			notes.push(row);
		}
	}

	return [...exact, ...prefix, ...substring, ...gloss, ...notes].slice(
		0,
		limit,
	);
}
