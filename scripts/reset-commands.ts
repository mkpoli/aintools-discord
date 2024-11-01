import { REST, Routes } from "discord.js";

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
	throw new Error(
		"DISCORD_TOKEN, DISCORD_CLIENT_ID and DISCORD_GUILD_ID are required",
	);
}

import commands from "../commands";
import { logger } from "../utils/logging";

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
		logger.info(
			"[reset-commands] Started refreshing {count} application (/) commands.",
			{
				count: commands.size,
			},
		);

		rest
			.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: [] })
			.then(() =>
				logger.info(
					"[reset-commands] Successfully deleted all guild commands.",
				),
			)
			.catch((error) =>
				logger.error("[reset-commands] Failed to delete all guild commands.", {
					error: error instanceof Error ? error.message : error,
				}),
			);

		rest
			.put(Routes.applicationCommands(CLIENT_ID), { body: commandsData })
			.then(() =>
				logger.info(
					"[reset-commands] Successfully reloaded all application commands.",
				),
			)
			.catch((error) =>
				logger.error(
					"[reset-commands] Failed to reload all application commands.",
					{
						error: error instanceof Error ? error.message : error,
					},
				),
			);
	} catch (error) {
		logger.error("[reset-commands] Failed to reset commands.", {
			error: error instanceof Error ? error.message : error,
		});
	}
})();
