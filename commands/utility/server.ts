import { type CommandInteraction, SlashCommandBuilder } from "discord.js";

export default {
	data: new SlashCommandBuilder()
		.setName("server")
		.setDescription("Replies with server info"),
	async execute(interaction: CommandInteraction) {
		await interaction.reply(`Server name: ${interaction.guild?.name}`);
	},
};
