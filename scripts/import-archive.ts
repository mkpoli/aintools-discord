/**
 * One-time import of the legacy DiscordChatExporter archive
 * (a separate, unrelated project's messages.jsonl — READ-ONLY reference,
 * never written to) into this repo's own `archive_messages` table
 * (migrations/0003_archive.sql). Rows are written with `source='import'`
 * via `INSERT OR IGNORE`, so once the live crawler (src/services/archive.ts)
 * rediscovers the same message it always wins — never the reverse.
 *
 * The exporter has no per-message API `type` integer (Discord's REST
 * `MessageType` enum) — only a string label (`"Default"`, `"Reply"`, `"20"`,
 * …) — so imported rows leave `type` NULL and keep that label in
 * `raw = {"dce_type": "<label>"}` instead of fabricating a type or leaving
 * `raw` NULL. Likewise the exporter's `attachments` are bare URLs (no
 * filename/content_type/size) and `reactions` is a single total count (no
 * per-emoji breakdown) — both are stored as the closest honest compact-JSON
 * shape (`[{url}]` / `[{name: null, count}]`) rather than invented detail.
 *
 * Usage:
 *   bun run migrate:local              # once, if 0003_archive.sql isn't applied yet
 *   bun run import-archive             # imports into LOCAL D1 only
 *
 * Env (all optional, defaults shown):
 *   ARCHIVE_JSONL=/home/mkpoli/projects/Ainu/ainu-discord-archive/messages.jsonl
 *   ARCHIVE_GUILD_ID=1181228576989794324   (must match wrangler.jsonc's var)
 *   D1_TARGET=local                        (local|remote — NEVER pass remote
 *                                            casually; see README)
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_JSONL_PATH =
	"/home/mkpoli/projects/Ainu/ainu-discord-archive/messages.jsonl";
const DEFAULT_GUILD_ID = "1181228576989794324";
const D1_DATABASE_NAME = "aintools-discord";
const ROWS_PER_STATEMENT = 200;

// --- exporter line → row (pure; unit-tested in test/import-archive.test.ts) --

export interface ExporterLine {
	channelId: string;
	msgId: string;
	type: string;
	author: string | null;
	authorId: string | null;
	timestamp: string;
	content: string | null;
	replyToId: string | null;
	attachments: string[];
	reactions: number;
}

export interface ArchiveMessageImportRow {
	id: string;
	channel_id: string;
	guild_id: string;
	author_id: string | null;
	author_name: string | null;
	author_bot: number;
	type: null;
	content: string | null;
	created_at: string;
	edited_at: null;
	reply_to_id: string | null;
	attachments: string | null;
	reactions: string | null;
	raw: string;
	source: "import";
	archived_at: string;
}

/** One exporter JSONL line → one `archive_messages` row (`source='import'`). */
export function mapLineToRow(
	line: ExporterLine,
	guildId: string,
	archivedAt: string,
): ArchiveMessageImportRow {
	return {
		id: line.msgId,
		channel_id: line.channelId,
		guild_id: guildId,
		author_id: line.authorId ?? null,
		author_name: line.author ?? null,
		author_bot: 0, // not captured by the exporter — never fabricated
		type: null, // see file header: exporter type kept in `raw` instead
		content: line.content ?? null,
		created_at: line.timestamp,
		edited_at: null, // not captured by the exporter
		reply_to_id: line.replyToId ?? null,
		attachments:
			line.attachments.length > 0
				? JSON.stringify(line.attachments.map((url) => ({ url })))
				: null,
		reactions:
			line.reactions > 0
				? JSON.stringify([{ name: null, count: line.reactions }])
				: null,
		raw: JSON.stringify({ dce_type: line.type }),
		source: "import",
		archived_at: archivedAt,
	};
}

/** SQLite string-literal escaping (doubled single quotes); `null` → the `NULL` keyword. */
export function sqlValue(value: string | number | null): string {
	if (value === null) return "NULL";
	if (typeof value === "number") return String(value);
	return `'${value.replace(/'/g, "''")}'`;
}

const ROW_COLUMNS = [
	"id",
	"channel_id",
	"guild_id",
	"author_id",
	"author_name",
	"author_bot",
	"type",
	"content",
	"created_at",
	"edited_at",
	"reply_to_id",
	"attachments",
	"reactions",
	"raw",
	"source",
	"archived_at",
] as const;

function rowTuple(row: ArchiveMessageImportRow): string {
	const values = ROW_COLUMNS.map((col) =>
		sqlValue(row[col] as string | number | null),
	);
	return `(${values.join(", ")})`;
}

/** Batches rows into `INSERT OR IGNORE` statements of up to `rowsPerStatement` rows each. */
export function buildInsertStatements(
	rows: readonly ArchiveMessageImportRow[],
	rowsPerStatement: number = ROWS_PER_STATEMENT,
): string[] {
	const statements: string[] = [];
	for (let i = 0; i < rows.length; i += rowsPerStatement) {
		const chunk = rows.slice(i, i + rowsPerStatement);
		const tuples = chunk.map(rowTuple).join(",\n\t");
		statements.push(
			`INSERT OR IGNORE INTO archive_messages (${ROW_COLUMNS.join(", ")})\nVALUES\n\t${tuples};`,
		);
	}
	return statements;
}

/** Parses one JSONL line, or `undefined` for a blank line / one missing required ids. */
export function parseLine(raw: string): ExporterLine | undefined {
	if (raw.trim() === "") return undefined;
	const obj = JSON.parse(raw) as Record<string, unknown>;
	if (typeof obj.msgId !== "string" || typeof obj.channelId !== "string") {
		console.warn("[import-archive] skipping line missing msgId/channelId");
		return undefined;
	}
	return {
		channelId: obj.channelId,
		msgId: obj.msgId,
		type: String(obj.type ?? ""),
		author: typeof obj.author === "string" ? obj.author : null,
		authorId: typeof obj.authorId === "string" ? obj.authorId : null,
		timestamp: String(obj.timestamp ?? ""),
		content: typeof obj.content === "string" ? obj.content : null,
		replyToId: typeof obj.replyToId === "string" ? obj.replyToId : null,
		attachments: Array.isArray(obj.attachments)
			? obj.attachments.filter((a): a is string => typeof a === "string")
			: [],
		reactions: typeof obj.reactions === "number" ? obj.reactions : 0,
	};
}

// ---------------------------------------------------------------- I/O ----

async function main(): Promise<void> {
	const jsonlPath = process.env.ARCHIVE_JSONL ?? DEFAULT_JSONL_PATH;
	const guildId = process.env.ARCHIVE_GUILD_ID ?? DEFAULT_GUILD_ID;
	const target = process.env.D1_TARGET === "remote" ? "remote" : "local";

	if (target === "remote") {
		console.warn(
			"[import-archive] D1_TARGET=remote — this writes to the PRODUCTION database.",
		);
	}

	const text = await readFile(jsonlPath, "utf8");
	const archivedAt = new Date().toISOString();
	const rows: ArchiveMessageImportRow[] = [];
	for (const raw of text.split("\n")) {
		const line = parseLine(raw);
		if (line) rows.push(mapLineToRow(line, guildId, archivedAt));
	}
	console.log(`[import-archive] mapped ${rows.length} rows from ${jsonlPath}`);

	const statements = buildInsertStatements(rows);
	const dir = await mkdtemp(join(tmpdir(), "aintools-import-archive-"));
	const sqlPath = join(dir, "import.sql");
	await writeFile(sqlPath, statements.join("\n\n"));
	console.log(
		`[import-archive] wrote ${statements.length} batched statements to ${sqlPath}`,
	);

	console.log(`[import-archive] executing against D1_TARGET=${target}...`);
	const result = spawnSync(
		"bunx",
		[
			"wrangler",
			"d1",
			"execute",
			D1_DATABASE_NAME,
			`--${target}`,
			`--file=${sqlPath}`,
		],
		{ stdio: "inherit" },
	);
	if (result.status !== 0) {
		throw new Error(`wrangler d1 execute exited with status ${result.status}`);
	}
	console.log("[import-archive] done.");
}

if (import.meta.main) {
	await main();
}
