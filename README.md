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

```text
Discord ── HTTPS interactions ──> Worker "aintools-discord" (bot.aynu.org)
                                    ├─ ainconv (in-process)          /convert
                                    ├─ corpus.aynu.org (fetch/SB)    /corpus /lookup
                                    ├─ mdb.aynu.org (fetch/SB)       /analyze /lookup
                                    ├─ itak.aynu.org/api/gdoc        /glossary
                                    ├─ Workers AI + AI Gateway       /ask
                                    └─ Cron (word-of-the-day)
```

## Commands

| Command | What it does |
|---|---|
| `/convert text [to] [from]` | Convert Ainu text between Latin, Katakana, Cyrillic, and Hangul (`ainconv`) |
| `Convert script` (right-click a message → Apps) | Ephemeral all-scripts view of any message |
| `/corpus query [lang] [mode] [dialect] [limit]` | Aligned AIN⇄JP corpus search or KWIC concordance |
| `/glossary query [limit]` | Search the itak.aynu.org glossary (with autocomplete) |
| `/analyze text [mode]` | Morpheme decomposition per word via mdb.aynu.org |
| `/lookup word` | One-stop research: glossary + morphemes + corpus examples + scripts |
| `/quiz [mode] [stats]` | Vocab/sentence quiz with D1-backed scores and streaks |
| `/ask question` | Draft-labeled Q&A grounded in glossary/corpus/morpheme sources (Workers AI) |

A word-of-the-day embed is posted daily at 07:00 JST to `WOTD_CHANNEL_ID`
(cron `0 22 * * *` UTC); leave the var empty to disable.

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

## Cutover checklist

The `routes` block in `wrangler.jsonc` is live (`bot.aynu.org`). Remaining
steps, in order — items marked **owner** are performed only by the owner:

1. Verify every command end to end in staging (second Discord app + test
   guild, `bun run register`, tunnel or workers.dev endpoint).
2. Set the three production secrets: `wrangler secret put DISCORD_TOKEN` /
   `DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID` (values from the
   production application `1301574269704081568`).
3. `bun run deploy` — creates the `bot.aynu.org` custom domain on first
   deploy; then `wrangler d1 migrations apply aintools-discord --remote`.
4. Create `.env.prod` (production app id + token) and `bun run register:prod`
   to register the commands globally. Clean the leftover guild-scoped
   commands from the old bot:
   `REGISTER_SCOPE=clean-guild DISCORD_TEST_GUILD_ID=<old guild> bun run register`.
5. **Owner:** in the Discord developer portal, set the production app's
   Interactions Endpoint URL to `https://bot.aynu.org` (Discord verifies with
   a PING — do this only after step 3 succeeds).
6. **Owner:** retire the old docker-compose gateway bot.
7. Optional: set `WOTD_CHANNEL_ID` (word-of-the-day channel) and create an
   AI Gateway named per `AI_GATEWAY_ID` for `/ask` observability; both are
   safe no-ops while unset.
