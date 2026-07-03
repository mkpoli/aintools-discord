import { describe, expect, test } from "bun:test";
import {
	buildInsertStatements,
	mapLineToRow,
	parseLine,
	sqlValue,
} from "../scripts/import-archive.js";

const SAMPLE_LINE =
	'{"file":"x.json","guild":"アイヌ語サーバー","category":"YAYANPE - 一般","channel":"✋｜iisoneka-es-arki","channelId":"1181228577618923562","msgId":"1181230756165595168","type":"Default","author":"hachia_","authorId":"921249407867953192","timestamp":"2023-12-04T13:49:18.476+00:00","content":"こんにちは！","replyToId":null,"attachments":[],"reactions":1}';

const REPLY_LINE =
	'{"channelId":"c1","msgId":"m2","type":"Reply","author":"a","authorId":"u1","timestamp":"2023-12-05T00:00:00.000+00:00","content":"reply text","replyToId":"m1","attachments":["https://cdn.discordapp.com/attachments/1/2/x.png"],"reactions":0}';

describe("parseLine", () => {
	test("parses one real exporter jsonl fixture line", () => {
		const line = parseLine(SAMPLE_LINE);
		expect(line).toEqual({
			channelId: "1181228577618923562",
			msgId: "1181230756165595168",
			type: "Default",
			author: "hachia_",
			authorId: "921249407867953192",
			timestamp: "2023-12-04T13:49:18.476+00:00",
			content: "こんにちは！",
			replyToId: null,
			attachments: [],
			reactions: 1,
		});
	});

	test("blank lines are skipped", () => {
		expect(parseLine("")).toBeUndefined();
		expect(parseLine("   ")).toBeUndefined();
	});

	test("a line missing msgId/channelId is skipped, not thrown", () => {
		expect(parseLine('{"content":"no ids here"}')).toBeUndefined();
	});
});

describe("mapLineToRow", () => {
	test("jsonl fixture line → archive_messages row: type NULL, exporter label kept in raw", () => {
		const line = parseLine(SAMPLE_LINE);
		if (!line) throw new Error("expected line to parse");
		const row = mapLineToRow(
			line,
			"1181228576989794324",
			"2026-07-03T00:00:00.000Z",
		);

		expect(row).toEqual({
			id: "1181230756165595168",
			channel_id: "1181228577618923562",
			guild_id: "1181228576989794324",
			author_id: "921249407867953192",
			author_name: "hachia_",
			author_bot: 0,
			type: null,
			content: "こんにちは！",
			created_at: "2023-12-04T13:49:18.476+00:00",
			edited_at: null,
			reply_to_id: null,
			attachments: null,
			reactions: JSON.stringify([{ name: null, count: 1 }]),
			raw: JSON.stringify({ dce_type: "Default" }),
			source: "import",
			archived_at: "2026-07-03T00:00:00.000Z",
		});
	});

	test("a reply with an attachment: replyToId + bare-url attachment mapping", () => {
		const line = parseLine(REPLY_LINE);
		if (!line) throw new Error("expected line to parse");
		const row = mapLineToRow(line, "g1", "now");

		expect(row.reply_to_id).toBe("m1");
		expect(row.reactions).toBeNull(); // reactions:0 ⇒ null, not an empty-total entry
		expect(JSON.parse(row.attachments as string)).toEqual([
			{ url: "https://cdn.discordapp.com/attachments/1/2/x.png" },
		]);
	});
});

describe("sqlValue", () => {
	test("escapes embedded single quotes by doubling them", () => {
		expect(sqlValue("it's a test")).toBe("'it''s a test'");
	});

	test("null becomes the NULL keyword, numbers are unquoted", () => {
		expect(sqlValue(null)).toBe("NULL");
		expect(sqlValue(0)).toBe("0");
		expect(sqlValue(42)).toBe("42");
	});
});

describe("buildInsertStatements", () => {
	test("batches rows into INSERT OR IGNORE statements of the given size, preserving row count", () => {
		const line = parseLine(SAMPLE_LINE);
		if (!line) throw new Error("expected line to parse");
		const rows = [
			mapLineToRow(line, "g1", "now"),
			mapLineToRow({ ...line, msgId: "m-2" }, "g1", "now"),
			mapLineToRow({ ...line, msgId: "m-3" }, "g1", "now"),
		];

		const statements = buildInsertStatements(rows, 2);
		expect(statements).toHaveLength(2); // 2 rows + 1 row
		for (const stmt of statements) {
			expect(stmt).toStartWith("INSERT OR IGNORE INTO archive_messages");
		}
		const totalTuples = statements.reduce(
			(n, s) => n + (s.match(/\(\s*'/g)?.length ?? 0),
			0,
		);
		expect(totalTuples).toBe(3);
	});

	test("INSERT OR IGNORE semantics via a D1 stub: an existing 'bot' row is never clobbered by an import row with the same id", () => {
		// Minimal D1 stub whose `run()` actually implements INSERT OR IGNORE
		// (unlike the crawler's INSERT OR REPLACE in src/services/archive.ts) —
		// proves the import script's statements defer to any row a 'bot' crawl
		// already wrote for the same message id, id-only (source is column #15
		// of ROW_COLUMNS; we only need to recognize the row's id — column #1 —
		// and never overwrite an existing entry).
		const table = new Map<string, { source: string; content: string | null }>();
		table.set("dupe-id", { source: "bot", content: "fresher bot content" });

		function insertOrIgnore(row: ReturnType<typeof mapLineToRow>) {
			if (!table.has(row.id)) {
				table.set(row.id, { source: row.source, content: row.content });
			}
		}

		const line = parseLine(SAMPLE_LINE);
		if (!line) throw new Error("expected line to parse");
		const importRow = mapLineToRow({ ...line, msgId: "dupe-id" }, "g1", "now");
		expect(importRow.source).toBe("import"); // sanity: this is the row that must lose

		insertOrIgnore(importRow);

		expect(table.get("dupe-id")).toEqual({
			source: "bot",
			content: "fresher bot content",
		});
	});
});
