import {
	Client,
	GatewayIntentBits,
	Events,
	Collection,
	type SlashCommandBuilder,
	type CommandInteraction,
} from "discord.js";
import ping from "./commands/utility/ping.js";
import user from "./commands/utility/user.js";
import server from "./commands/utility/server.js";
const TOKEN = process.env.DISCORD_TOKEN;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
	console.log(`Ready! Logged in as ${c.user.tag}`);
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
	if (!interaction.isCommand()) return;

	const command = commands.get(interaction.commandName);

	if (!command) return;

	try {
		await command.execute(interaction);
	} catch (error) {
		console.error(error);
	}
});
