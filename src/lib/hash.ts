/**
 * FNV-1a, 32-bit variant — pure, deterministic string hash. Used by the WOTD
 * cron to pick a stable daily index from the JST date string, so the same
 * date always yields the same pick across re-runs (retries, redeploys).
 * Constants and results match the canonical FNV-1a-32 test vectors.
 */
export function fnv1a(input: string): number {
	let hash = 0x811c9dc5; // FNV offset basis (32-bit)
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193); // FNV prime (32-bit)
	}
	return hash >>> 0; // unsigned 32-bit
}
