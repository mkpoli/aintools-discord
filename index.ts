import { Client, Events, GatewayIntentBits, InteractionType } from "discord.js";

import commands from "./commands";

import { logger } from "./utils/logging";

const TOKEN = process.env.DISCORD_TOKEN;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
	logger.info`Ready! Logged in as ${c.user.tag}`;
});

client.login(TOKEN);

client.on(Events.InteractionCreate, async (interaction) => {
	if (!interaction.isCommand()) {
		logger.info("Interaction : {type}", {
			type: InteractionType[interaction.type],
		});
		return;
	}

	logger.info("Interaction : {type} : {detail}", {
		type: InteractionType[interaction.type],
		detail: interaction.commandName,
	});

	const command = commands.get(interaction.commandName);

	if (!command) return;

	try {
		await command.execute(interaction);
	} catch (error) {
		console.error(error);
	}
});
