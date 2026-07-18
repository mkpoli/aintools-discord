import { describe, expect, test } from "bun:test";
import {
	compareSnowflakes,
	isContainerType,
	isMessageChannelType,
	mapChannelCandidate,
	mapThreadCandidate,
	maxSnowflake,
	messageToRow,
	minSnowflake,
	serializeAttachments,
	serializeReactions,
} from "../src/services/archive.js";

describe("channel type classification", () => {
	test("GUILD_TEXT (0) and GUILD_ANNOUNCEMENT (5) are message channel types", () => {
		expect(isMessageChannelType(0)).toBe(true);
		expect(isMessageChannelType(5)).toBe(true);
		expect(isMessageChannelType(2)).toBe(false); // voice
		expect(isMessageChannelType(4)).toBe(false); // category
	});

	test("GUILD_FORUM (15) and GUILD_MEDIA (16) are container types", () => {
		expect(isContainerType(15)).toBe(true);
		expect(isContainerType(16)).toBe(true);
		expect(isContainerType(0)).toBe(false);
		expect(isContainerType(null)).toBe(false);
	});
});

describe("mapChannelCandidate", () => {
	test("keeps a text channel, not a thread, backfill not pre-done", () => {
		const candidate = mapChannelCandidate(
			{ id: "c1", type: 0, name: "general", parent_id: "cat1" },
			"g1",
		);
		expect(candidate).toEqual({
			channel_id: "c1",
			guild_id: "g1",
			name: "general",
			type: 0,
			parent_id: "cat1",
			is_thread: false,
			initialBackfillDone: false,
		});
	});

	test("a forum container pre-marks backfill_done (it has no messages of its own)", () => {
		const candidate = mapChannelCandidate(
			{ id: "f1", type: 15, name: "qa" },
			"g1",
		);
		expect(candidate?.initialBackfillDone).toBe(true);
		expect(candidate?.type).toBe(15);
	});

	test("drops voice/category/stage channels entirely", () => {
		expect(mapChannelCandidate({ id: "v1", type: 2 }, "g1")).toBeUndefined();
		expect(mapChannelCandidate({ id: "cat1", type: 4 }, "g1")).toBeUndefined();
	});
});

describe("mapThreadCandidate", () => {
	test("always is_thread=true, backfill not pre-done", () => {
		const candidate = mapThreadCandidate(
			{ id: "t1", type: 11, name: "thread-1", parent_id: "c1" },
			"g1",
		);
		expect(candidate).toEqual({
			channel_id: "t1",
			guild_id: "g1",
			name: "thread-1",
			type: 11,
			parent_id: "c1",
			is_thread: true,
			initialBackfillDone: false,
		});
	});
});

describe("snowflake comparison (bigint, never string/number compare)", () => {
	test("compareSnowflakes orders numerically past Number.MAX_SAFE_INTEGER", () => {
		// Both are valid snowflakes; naive string comparison would get this
		// wrong precisely because the digit counts happen to match here too —
		// the point is these are real 18-19 digit ids, well past 2^53.
		const smaller = "1181228576989794324";
		const larger = "1181228576989794325";
		expect(compareSnowflakes(smaller, larger)).toBeLessThan(0);
		expect(compareSnowflakes(larger, smaller)).toBeGreaterThan(0);
		expect(compareSnowflakes(smaller, smaller)).toBe(0);
	});

	test("maxSnowflake/minSnowflake pick correctly out of order", () => {
		const ids = [
			"1181230655120625674",
			"1181230512975642684",
			"1181230756165595168",
		];
		expect(maxSnowflake(ids)).toBe("1181230756165595168");
		expect(minSnowflake(ids)).toBe("1181230512975642684");
	});

	test("maxSnowflake/minSnowflake of an empty list is undefined", () => {
		expect(maxSnowflake([])).toBeUndefined();
		expect(minSnowflake([])).toBeUndefined();
	});
});

describe("serializeAttachments / serializeReactions", () => {
	test("empty or missing → null", () => {
		expect(serializeAttachments(undefined)).toBeNull();
		expect(serializeAttachments([])).toBeNull();
		expect(serializeReactions(undefined)).toBeNull();
		expect(serializeReactions([])).toBeNull();
	});

	test("attachments serialize to the compact url/filename/content_type/size shape", () => {
		const json = serializeAttachments([
			{
				url: "https://cdn/x.png",
				filename: "x.png",
				content_type: "image/png",
				size: 123,
			},
		]);
		expect(JSON.parse(json as string)).toEqual([
			{
				url: "https://cdn/x.png",
				filename: "x.png",
				content_type: "image/png",
				size: 123,
			},
		]);
	});

	test("reactions serialize to the compact name/count shape, custom emoji falls back to id", () => {
		const json = serializeReactions([
			{ emoji: { id: null, name: "👍" }, count: 3 },
			{ emoji: { id: "999", name: null }, count: 1 },
		]);
		expect(JSON.parse(json as string)).toEqual([
			{ name: "👍", count: 3 },
			{ name: "999", count: 1 },
		]);
	});
});

describe("messageToRow", () => {
	test("maps every field, defaults missing author to null, source='bot'", () => {
		const row = messageToRow(
			{
				id: "m1",
				type: 0,
				content: "hello",
				timestamp: "2026-07-03T10:00:00.000Z",
				edited_timestamp: null,
				author: { id: "u1", username: "nukopoli", bot: false },
				message_reference: { message_id: "m0" },
				attachments: [],
				reactions: [],
			},
			"c1",
			"g1",
			"2026-07-03T10:05:00.000Z",
		);
		expect(row).toEqual({
			id: "m1",
			channel_id: "c1",
			guild_id: "g1",
			author_id: "u1",
			author_name: "nukopoli",
			author_bot: 0,
			type: 0,
			content: "hello",
			created_at: "2026-07-03T10:00:00.000Z",
			edited_at: null,
			reply_to_id: "m0",
			attachments: null,
			reactions: null,
			raw: JSON.stringify({
				id: "m1",
				type: 0,
				content: "hello",
				timestamp: "2026-07-03T10:00:00.000Z",
				edited_timestamp: null,
				author: { id: "u1", username: "nukopoli", bot: false },
				message_reference: { message_id: "m0" },
				attachments: [],
				reactions: [],
			}),
			source: "bot",
			archived_at: "2026-07-03T10:05:00.000Z",
		});
	});

	test("a webhook/system message with no author maps author fields to null/0", () => {
		const row = messageToRow(
			{ id: "m2", timestamp: "2026-07-03T10:00:00.000Z" },
			"c1",
			"g1",
			"now",
		);
		expect(row.author_id).toBeNull();
		expect(row.author_name).toBeNull();
		expect(row.author_bot).toBe(0);
		expect(row.reply_to_id).toBeNull();
	});

	test("a bot author sets author_bot=1", () => {
		const row = messageToRow(
			{
				id: "m3",
				timestamp: "2026-07-03T10:00:00.000Z",
				author: { id: "b1", username: "ainu-discord-bot", bot: true },
			},
			"c1",
			"g1",
			"now",
		);
		expect(row.author_bot).toBe(1);
	});
});
