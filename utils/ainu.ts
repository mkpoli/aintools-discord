import { logger } from "./logging";

export function convertSentence(
	text: string,
	converter: (word: string) => string,
) {
	try {
		return converter(text);
	} catch (e) {
		logger.error("[utils/ainu] {text} -> {error}", {
			text,
			error: e instanceof Error ? e.message : String(e),
		});
		return text;
	}
}
