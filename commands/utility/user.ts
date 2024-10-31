import { type CommandInteraction, SlashCommandBuilder } from "discord.js";

export default {
	data: new SlashCommandBuilder()
		.setName("user")
		.setDescription("Replies with user info"),
	async execute(interaction: CommandInteraction) {
		await interaction.reply(
			`This command was run by ${interaction.user.username}, who joined on ${interaction.member?.joinedAt}`,
		);
	},
};
