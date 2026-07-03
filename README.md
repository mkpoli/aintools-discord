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
                                    ├─ Cron (word-of-the-day, daily)
                                    └─ Cron (message archive, every 10 min)
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

## Message archive

An HTTP-interactions bot never receives gateway `MESSAGE_CREATE` events, so
there is no way to log messages as they happen. Instead, a cron crawler
(`src/services/archive.ts`, `app.cron("*/10 * * * *", runArchive)`) walks
`ARCHIVE_GUILD_ID`'s channels and threads over REST every 10 minutes and
writes what it finds into D1 (`archive_channels` + `archive_messages`,
`migrations/0003_archive.sql`). This replaces the old manual
DiscordChatExporter workflow with something continuous and self-healing.

- **Cadence & budget**: capped at 35 Discord REST calls per run, so it always
  fits inside a Worker's subrequest limit. Each channel/thread gets a turn in
  round-robin order (stalest first); a run that runs out of budget mid-channel
  simply leaves that channel's cursors where they are and finishes the rest
  next run.
- **Cursors & backfill convergence**: every channel tracks two snowflake
  cursors — `last_message_id` (incremental catch-up, paginating `after`
  toward "now") and `backfill_before_id` (historical backfill, paginating
  `before` toward the channel's first message). Both are seeded from one
  fetch of the newest page the first time a channel is seen, then advance a
  page at a time on each of that channel's turns. `backfill_done` flips to
  `1` once a `before` page comes back empty — from then on the channel only
  needs the (much cheaper) incremental pass. Archived-thread listings are
  swept only occasionally (when a channel finishes backfill, or — for forum
  /media channels, which have no messages of their own — every time it's
  their turn) to keep the per-run REST budget in check.
- **Message Content intent**: the Discord application must have the
  privileged **Message Content** intent enabled (Developer Portal → Bot →
  Privileged Gateway Intents). Without it, `content` on every REST-fetched
  message comes back empty — the crawler will still run and record
  everything else (author, timestamps, attachments, reactions), just with
  blank text.
- **Legacy import**: `scripts/import-archive.ts` (`bun run import-archive`)
  one-time-imports the old DiscordChatExporter `messages.jsonl` export into
  the same `archive_messages` table, `source='import'` via `INSERT OR
  IGNORE`, so the live crawler's own `source='bot'` rows always win once it
  rediscovers the same message. See the script's header comment for the
  exact field mapping (the exporter has no numeric API message `type`, only a
  string label, kept in `raw.dce_type`; its `attachments` are bare URLs and
  `reactions` is a single total count, both stored as the closest honest
  shape rather than invented detail). Run it against **local** D1 only:
  ```bash
  bun run migrate:local     # once, if 0003_archive.sql isn't applied yet
  bun run import-archive
  ```
  `ARCHIVE_JSONL` (source file path) and `D1_TARGET` (`local`, default, or
  `remote`) are configurable via env — never run with `D1_TARGET=remote`
  without a deliberate, reviewed reason.
- **Privacy**: the archive contains real member conversations. It is for
  **private, offline use only** (research/moderation/data-loss recovery) —
  never expose it through a bot command, a public API, or any other
  user-facing surface.

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
8. **Owner:** enable the **Message Content** privileged intent on the
   production application (Developer Portal → Bot → Privileged Gateway
   Intents) — see "Message archive" above; without it, archived messages
   have empty `content`.
