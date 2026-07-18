/**
 * Truncates to `limit` chars with a trailing ellipsis, never ending on a lone
 * high surrogate (an astral char cut in half renders as U+FFFD).
 */
export function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	let sliced = text.slice(0, limit - 1);
	if (/[\uD800-\uDBFF]$/.test(sliced)) sliced = sliced.slice(0, -1);
	return `${sliced}…`;
}
