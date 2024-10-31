import { logger } from "./logging";

export function convertSentence(
	text: string,
	converter: (word: string) => string,
) {
	const words = text
		.toLowerCase()
		.split(/(\p{L}+)/u)
		.filter(Boolean);
	const convertedWords = words.map((word) => {
		if (word.match(/\s+/)) {
			return word;
		}
		try {
			return converter(word);
		} catch (e) {
			logger.error("[utils/ainu] {word} -> {error}", {
				word,
				error: e.message,
			});
			return word;
		}
	});
	return convertedWords.join("");
}
