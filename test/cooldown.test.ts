import { describe, expect, test } from "bun:test";
import { checkAndSetCooldown } from "../src/lib/cooldown.js";

/** Minimal in-memory KV stub — mirrors the `MemoryKV` idiom used for the
 * glossary cache tests, but also honors `expirationTtl` so the "expired"
 * scenario can be exercised without waiting on a real clock. */
class MemoryKV {
	#store = new Map<string, { value: string; expiresAt: number | null }>();

	async get(key: string): Promise<string | null> {
		const entry = this.#store.get(key);
		if (!entry) return null;
		if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
			this.#store.delete(key);
			return null;
		}
		return entry.value;
	}

	async put(
		key: string,
		value: string,
		options?: { expirationTtl?: number },
	): Promise<void> {
		const expiresAt = options?.expirationTtl
			? Date.now() + options.expirationTtl * 1000
			: null;
		this.#store.set(key, { value, expiresAt });
	}
}

describe("checkAndSetCooldown", () => {
	test("short cooldowns clamp the KV TTL up to the 60s floor (put would throw below it)", async () => {
		const puts: { expirationTtl?: number }[] = [];
		const kv = {
			get: async () => null,
			put: async (
				_key: string,
				_value: string,
				options?: { expirationTtl?: number },
			) => {
				puts.push(options ?? {});
			},
		};
		const remaining = await checkAndSetCooldown(kv, "ask:cooldown:u1", 10);
		expect(remaining).toBe(0);
		expect(puts).toHaveLength(1);
		expect(puts[0]?.expirationTtl).toBe(60);
	});

	test("first call: not cooling, sets the cooldown, returns 0", async () => {
		const kv = new MemoryKV();
		const remaining = await checkAndSetCooldown(kv, "ask:cooldown:u1", 300);
		expect(remaining).toBe(0);
		expect(await kv.get("ask:cooldown:u1")).not.toBeNull();
	});

	test("second call while still cooling: returns remaining seconds, does not reset the timer", async () => {
		const kv = new MemoryKV();
		const setAt = Date.now() - 10_000; // 10s ago
		await kv.put("ask:cooldown:u1", String(setAt), { expirationTtl: 300 });

		const remaining = await checkAndSetCooldown(kv, "ask:cooldown:u1", 300);
		expect(remaining).toBeGreaterThan(0);
		expect(remaining).toBeLessThanOrEqual(290);

		// The stored timestamp must be untouched — a cooling call never resets the timer.
		expect(await kv.get("ask:cooldown:u1")).toBe(String(setAt));
	});

	test("expired cooldown (elapsed time past the window): treated as not cooling, resets", async () => {
		const kv = new MemoryKV();
		const longAgo = Date.now() - 301_000; // just past a 300s window
		await kv.put("ask:cooldown:u1", String(longAgo), { expirationTtl: 300 });

		const remaining = await checkAndSetCooldown(kv, "ask:cooldown:u1", 300);
		expect(remaining).toBe(0);

		const stored = await kv.get("ask:cooldown:u1");
		expect(stored).not.toBeNull();
		expect(stored).not.toBe(String(longAgo));
	});

	test("KV's own TTL eviction (key simply missing) is treated the same as a first call", async () => {
		const kv = new MemoryKV();
		// expirationTtl -1 produces a past expiresAt, simulating "already gone" —
		// the closest
		// in-memory stand-in for a key KV itself has already evicted.
		await kv.put("ask:cooldown:u1", String(Date.now()), { expirationTtl: -1 });

		const remaining = await checkAndSetCooldown(kv, "ask:cooldown:u1", 300);
		expect(remaining).toBe(0);
	});

	test("different keys (different users) never share a cooldown", async () => {
		const kv = new MemoryKV();
		await checkAndSetCooldown(kv, "ask:cooldown:u1", 300);
		const remainingOther = await checkAndSetCooldown(
			kv,
			"ask:cooldown:u2",
			300,
		);
		expect(remainingOther).toBe(0);
	});
});
