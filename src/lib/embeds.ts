import { Embed } from "discord-hono";

/** Ainu-tools brand indigo (matches ainu-quiz's `--c-primary`). */
export const BRAND_COLOR = 0x1d3461;

/**
 * Base embed with brand color and, when the data came from one of the
 * aynu.org APIs, a footer attributing the source domain.
 */
export function baseEmbed(source?: string): Embed {
	const embed = new Embed().color(BRAND_COLOR);
	return source ? embed.footer({ text: source }) : embed;
}
