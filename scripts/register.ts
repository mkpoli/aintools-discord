import { register } from "discord-hono";
import { commands } from "../src/commands.js";

const {
	DISCORD_APPLICATION_ID,
	DISCORD_TOKEN,
	DISCORD_TEST_GUILD_ID,
	REGISTER_SCOPE,
} = process.env;

if (!DISCORD_APPLICATION_ID || !DISCORD_TOKEN) {
	throw new Error(
		"DISCORD_APPLICATION_ID and DISCORD_TOKEN are required — copy .dev.vars.example to .dev.vars and fill them in.",
	);
}

// guild (default, staging) | global (prod, REGISTER_SCOPE=global) | clean-guild (wipe guild commands)
const scope = REGISTER_SCOPE ?? "guild";

if (scope !== "global" && !DISCORD_TEST_GUILD_ID) {
	throw new Error(
		"DISCORD_TEST_GUILD_ID is required for guild-scoped registration (set REGISTER_SCOPE=global to register globally instead).",
	);
}

await register(
	scope === "clean-guild" ? [] : commands,
	DISCORD_APPLICATION_ID,
	DISCORD_TOKEN,
	scope === "global" ? undefined : DISCORD_TEST_GUILD_ID,
);
