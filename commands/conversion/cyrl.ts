import { convert } from "ainconv";
import { type CommandInteraction, SlashCommandBuilder } from "discord.js";
import { logger } from "../../utils/logging";

export default {
	data: new SlashCommandBuilder()
		.setName("cyrl")
		.setDescription("Convert Katakana to Cyrillic script")
		.addStringOption((option) =>
			option
				.setName("message")
				.setDescription("The message to convert")
				.setRequired(true),
		),
	async execute(interaction: CommandInteraction) {
		const message = interaction.options.get("message");
		const before = message?.value?.toString();
		const result = convert(before ?? "", undefined, "Cyrl");

		logger.info("[Command : {name}] {before} -> {after}", {
			name: interaction.commandName,
			before,
			after: result,
		});
		await interaction.reply(result);
	},
};
