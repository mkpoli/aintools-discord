import {
	Client,
	Collection,
	type CommandInteraction,
	Events,
	GatewayIntentBits,
	InteractionType,
	type SlashCommandBuilder,
} from "discord.js";
import ping from "./commands/utility/ping.js";
import server from "./commands/utility/server.js";
import user from "./commands/utility/user.js";
import { logger } from "./utils/logging";

const TOKEN = process.env.DISCORD_TOKEN;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
	logger.info`Ready! Logged in as ${c.user.tag}`;
});

client.login(TOKEN);

const commands = new Collection<
	string,
	{
		data: SlashCommandBuilder;
		execute: (interaction: CommandInteraction) => Promise<void>;
	}
>();

commands.set(ping.data.name, ping);
commands.set(user.data.name, user);
commands.set(server.data.name, server);

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
