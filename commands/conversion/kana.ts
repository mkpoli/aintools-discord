import { convert } from "ainconv";
import { type CommandInteraction, SlashCommandBuilder } from "discord.js";
import { convertSentence } from "../../utils/ainu";
import { logger } from "../../utils/logging";

export default {
	data: new SlashCommandBuilder()
		.setName("kana")
		.setDescription("Convert Latin script to Katakana")
		.addStringOption((option) =>
			option
				.setName("message")
				.setDescription("The message to convert")
				.setRequired(true),
		),
	async execute(interaction: CommandInteraction) {
		const message = interaction.options.get("message");
		const before = message?.value?.toString();
		const result = convertSentence(before ?? "", (word) =>
			convert(word, undefined, "Kana"),
		);

		logger.info("[Command : {name}] {before} -> {after}", {
			name: interaction.commandName,
			before,
			after: result,
		});
		await interaction.reply(result);
	},
};
