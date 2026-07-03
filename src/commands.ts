import { Command } from "discord-hono";

// Single source of truth for both dispatch (src/index.ts) and registration
// (scripts/register.ts). Only ever lists commands that are actually wired up.
export const commands = [new Command("ping", "Health check")];
