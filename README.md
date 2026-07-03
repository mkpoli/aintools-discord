# aintools-discord

A Discord bot that surfaces the [aynu.org](https://aynu.org) Ainu-language NLP
stack — script conversion, corpus search, the glossary, morpheme analysis, a
vocabulary quiz, and (soon) a sourced Q&A command — as slash commands. It runs
as a single Cloudflare Worker behind Discord's HTTP Interactions endpoint:
no gateway connection, no always-on process, no server to keep alive.

In July 2026 this replaced a Nov-2024 discord.js v14 gateway bot that ran via
docker-compose on a box that had to stay up 24/7. The new bot is built on
[`discord-hono`](https://discord-hono.luis.fun) instead, matching the Hono
idiom already used across the aynu.org Worker fleet.

## Architecture

```
Discord ── HTTPS interactions ──> Worker "aintools-discord" (bot.aynu.org)
                                    ├─ ainconv (in-process)          /convert
                                    ├─ corpus.aynu.org (fetch/SB)    /corpus /lookup
                                    ├─ mdb.aynu.org (fetch/SB)       /analyze /lookup
                                    ├─ itak.aynu.org/api/gdoc        /glossary
                                    ├─ Workers AI + AI Gateway       /ask
                                    └─ Cron (word-of-the-day)
```

Feature commands land one at a time in follow-up PRs (see "Status" below) —
this scaffold only wires up the Worker, a temporary `/ping` health check, and
command registration.

## Dev setup

```bash
bun install
cp .dev.vars.example .dev.vars   # fill in DISCORD_* below
bun run dev                      # wrangler dev on http://localhost:8787
```

Discord requires HTTPS for its Interactions Endpoint URL, so expose the local
dev server with a tunnel in a second terminal:

```bash
cloudflared tunnel --url http://localhost:8787
```

Use a **second, staging Discord application** ("AinTools Dev") + a private
test guild for all local/dev work — never the production app
(`1301574269704081568`). Create the staging app in the
[Developer Portal](https://discord.com/developers/applications), then:

1. Set its Interactions Endpoint URL to the `cloudflared` tunnel URL.
2. Fill `.dev.vars` with the staging app's `DISCORD_APPLICATION_ID`,
   `DISCORD_PUBLIC_KEY`, `DISCORD_TOKEN`, and the test guild's
   `DISCORD_TEST_GUILD_ID`.
3. Register commands to the test guild:

   ```bash
   bun run register
   ```

Guild-scoped registration propagates instantly, which is why staging always
registers to a single test guild rather than globally.

## Command registration scopes

`scripts/register.ts` reads the single `commands` array in `src/commands.ts`
(the same array `src/index.ts` dispatches against) and PUT-replaces the
command set, so re-running it is always idempotent.

| Command | Scope |
|---|---|
| `bun run register` | Guild-scoped to `DISCORD_TEST_GUILD_ID` (default, staging) |
| `REGISTER_SCOPE=global bun run register` (`bun run register:prod`) | Global (production) |
| `REGISTER_SCOPE=clean-guild bun run register` | Wipes guild-scoped commands (empty array) |

## Checks

```bash
bun run check      # biome check --write
bun run typecheck   # wrangler types && tsc --noEmit
bun test
```

## Cutover

Once a feature PR reaches parity with the old bot and staging has been
verified end to end:

1. Implementer uncomments the `routes` block in `wrangler.jsonc` (currently
   commented out — see the `// enable at cutover (PR-9)` note), deploys to
   production, sets the three secrets (`DISCORD_TOKEN`, `DISCORD_PUBLIC_KEY`,
   `DISCORD_APPLICATION_ID`) with `wrangler secret put`, runs
   `bun run register:prod`, and cleans the old guild-scoped commands
   (`REGISTER_SCOPE=clean-guild`, pointed at the *old* guild).
2. **Owner** sets the Interactions Endpoint URL on the production Discord
   application to `https://bot.aynu.org` and retires the old docker-compose
   bot. The implementer never shuts down the old bot — only the owner does.
