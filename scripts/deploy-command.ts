import { REST, Routes } from "discord.js";

import { logger } from "../utils/logging";

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
	throw new Error(
		"DISCORD_TOKEN, DISCORD_CLIENT_ID and DISCORD_GUILD_ID are required",
	);
}

import commands from "../commands";

const commandsData = [...commands.values()].map((command) =>
	command.data.toJSON(),
);

const rest = new REST().setToken(TOKEN);

interface Command {
	id: string;
	application_id: string;
	version: string;
	default_member_permissions: string | null;
	type: number;
	name: string;
	name_localizations: string | null;
	description: string;
	description_localizations: string | null;
	guild_id: string;
	nsfw: boolean;
}

(async () => {
	try {
		logger.info`Started refreshing ${commands.size} application (/) commands.`;

		// const result = await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commandsData });
		const result = (await rest.put(
			Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
			{
				body: commandsData,
			},
		)) as Command[];
		logger.info`Successfully reloaded ${result.length} application (/) commands.`;
	} catch (error: unknown) {
		logger.error(error instanceof Error ? error.message : "Unknown error");
	}
})();
