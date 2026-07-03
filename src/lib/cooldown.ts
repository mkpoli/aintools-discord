/**
 * Structural subset of `KVNamespace` — only the two methods this module
 * needs, so an in-memory stub can satisfy it directly in tests without an
 * `as unknown as Env` cast (mirrors `WaitUntilCtx` in services/glossary.ts).
 */
export interface CooldownKV {
	get(key: string): Promise<string | null>;
	put(
		key: string,
		value: string,
		options?: { expirationTtl?: number },
	): Promise<void>;
}

/** Workers KV rejects `expirationTtl` below 60 seconds. */
const KV_MIN_TTL_SECONDS = 60;

/**
 * Per-user KV cooldown gate (used by `/ask`, 300s by default). The cooldown
 * is set — not just checked — in the same call that finds no active
 * cooldown, and the caller is expected to invoke this BEFORE doing the
 * expensive work it's guarding (the model call). This is best-effort, not
 * atomic: KV has no check-and-set, so two truly concurrent requests can both
 * slip through. That's an accepted trade-off for a politeness rate-limit —
 * the early set still narrows the window to milliseconds, and a rare double
 * model call is harmless.
 *
 * Stored value is the epoch-ms timestamp the cooldown was set at, with a KV
 * `expirationTtl` of `seconds` (clamped up to KV's 60s floor so short
 * configs don't make `put` throw; the elapsed-time check below still honors
 * the shorter logical cooldown). An expired cooldown simply reads back as a
 * KV miss; the elapsed-time check is a second, redundant guard for the same
 * expiry (belt-and-suspenders against any clock skew between our timestamp
 * and KV's own TTL eviction).
 *
 * @returns the remaining cooldown in whole seconds (>0) if still cooling
 * down; otherwise 0, after having (re)set the cooldown.
 */
export async function checkAndSetCooldown(
	kv: CooldownKV,
	key: string,
	seconds: number,
): Promise<number> {
	const existing = await kv.get(key);
	if (existing !== null) {
		const setAt = Number(existing);
		if (Number.isFinite(setAt)) {
			const remaining = Math.ceil(seconds - (Date.now() - setAt) / 1000);
			if (remaining > 0) return remaining;
		}
	}

	await kv.put(key, String(Date.now()), {
		expirationTtl: Math.max(KV_MIN_TTL_SECONDS, seconds),
	});
	return 0;
}
