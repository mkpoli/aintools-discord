import type {
	CommandInteraction,
	SlashCommandOptionsOnlyBuilder,
} from "discord.js";

import cyrl from "./conversion/cyrl.js";
import kana from "./conversion/kana.js";
import latn from "./conversion/latn.js";

import ping from "./utility/ping.js";
import server from "./utility/server.js";
import user from "./utility/user.js";

export type Command = {
	data: SlashCommandOptionsOnlyBuilder;
	execute: (interaction: CommandInteraction) => Promise<void>;
};

export default new Map<string, Command>(
	[ping, user, server, kana, latn, cyrl].map((command) => [
		command.data.name,
		command,
	]),
);
