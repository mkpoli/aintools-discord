import { getJson, getJsonWithMeta } from "./http.js";

export type CorpusLang = "ain" | "jpn" | "any";

export interface CorpusRow {
	id: string;
	text: string;
	translation: string | null;
	dialect: string | null;
	author: string | null;
	collection: string | null;
	document: string | null;
	uri: string | null;
}

export interface KwicLine {
	sentence_id: string;
	left_text: string;
	node_text: string;
	right_text: string;
	translation: string | null;
	dialect: string | null;
	author: string | null;
	uri: string | null;
}

export interface KwicResult {
	lines: KwicLine[];
	meta: { total: number };
}

export interface FreqRow {
	token: string;
	count: number;
	is_stopword: number;
}

function qs(params: Record<string, string | number | undefined>): string {
	const u = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== "") u.set(k, String(v));
	}
	return u.toString();
}

/** `GET /v1/search` — full-text corpus search (FTS5 trigram substring). */
export async function searchCorpus(
	env: Env,
	opts: { q: string; lang?: CorpusLang; dialect?: string; limit?: number },
): Promise<CorpusRow[]> {
	const query = qs({
		q: opts.q,
		lang: opts.lang,
		dialect: opts.dialect,
		limit: opts.limit,
	});
	return getJson<CorpusRow[]>(env, "CORPUS", `/v1/search?${query}`);
}

/**
 * `GET /v1/kwic` — annotated KWIC concordance. `match=fold` (accent-insensitive)
 * is always sent, matching the plan's fixed contract for `/corpus mode:kwic`.
 */
export async function kwic(
	env: Env,
	opts: { q: string; ctx?: number; limit?: number },
): Promise<KwicResult> {
	const query = qs({
		q: opts.q,
		ctx: opts.ctx,
		limit: opts.limit,
		match: "fold",
	});
	const { data, meta } = await getJsonWithMeta<
		KwicLine[],
		{ total: number; offset: number; limit: number }
	>(env, "CORPUS", `/v1/kwic?${query}`);
	return { lines: data, meta: { total: meta?.total ?? data.length } };
}

/**
 * `GET /v1/freq/list` — most-frequent already-normalized tokens, used by the
 * WOTD cron to source daily-word candidates. Contract verified against
 * `ainu-corpora-api/openapi.yaml` + a live `curl` (2026-07-03):
 * `{ token, count, is_stopword }[]` in `data`.
 */
export async function freqList(
	env: Env,
	opts: { limit?: number; includeStopwords?: boolean; minCount?: number },
): Promise<FreqRow[]> {
	const query = qs({
		limit: opts.limit,
		includeStopwords:
			opts.includeStopwords === undefined
				? undefined
				: String(opts.includeStopwords),
		minCount: opts.minCount,
	});
	return getJson<FreqRow[]>(env, "CORPUS", `/v1/freq/list?${query}`);
}
