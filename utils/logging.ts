import {
	ansiColorFormatter,
	configure,
	getConsoleSink,
	getLogger,
} from "@logtape/logtape";

configure({
	sinks: {
		console: getConsoleSink({
			formatter: ansiColorFormatter,
		}),
	},
	loggers: [
		{
			category: "discord",
			level: "debug",
			sinks: ["console"],
		},
	],
});

export const logger = getLogger("discord");
