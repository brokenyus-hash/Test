# 🎭 Tavern — AI Roleplay Studio

A self-hosted roleplay app that treats a story like a living world. Create characters with real personalities, build worlds with keyword-triggered lore, and play with an AI (Claude or Grok) that **remembers everything**: time of day, where you are, who's in the room, how people feel about you, what you're carrying, and which plot threads are still open.

No build step, no external database. Node 22, Express, the official Anthropic SDK and Node's built-in SQLite.

## Quick start

```bash
npm install
npm start                   # http://localhost:3000
```

Then open **Settings**, pick a provider (**Anthropic / Claude** or **xAI / Grok**) and paste the matching API key. Keys can also come from the environment: `ANTHROPIC_API_KEY` or `XAI_API_KEY` (see `.env.example`).

Try it without an API key (canned responses from a local mock of the Messages API):

```bash
npm run mock   # terminal 1: mock Anthropic API on :3999
npm run demo   # terminal 2: app pointed at the mock
```

Run the test-suite (starts the app against the mock, exercises every endpoint, and asserts on the exact prompt sent to the API):

```bash
npm test
```

## What it does

### Accounts
Every person signs up with a username and password (scrypt-hashed, cookie sessions). Roleplays, characters, worlds, personas, API keys and settings are private to the account. The first account becomes admin; set `ALLOW_SIGNUP=false` to close registration after your friends have joined. Server-wide keys in the environment act as a fallback for users who haven't added their own.

### Roleplays with a cast
A roleplay is its own thing: a premise, a world, your persona, and a **cast** of one or more characters. With one character it's a classic chat. With several, a **director** step runs before every AI turn and decides, from the premise, the world state and the last few lines, **who responds** (one to three speakers, or the Narrator), **who enters or leaves** (present / nearby / away / gone), and occasionally **who new walks in**: a newcomer gets a short brief on the spot, joins the cast, and can later be promoted to a full character card in your library with one tap. Each speaker writes only for themselves, sees what the others said this turn, and is attributed in the transcript. You can always override: tap a cast member to make them speak, change where they are, add someone from your library, or invent a bystander.

### Characters
- Full character cards: description, personality, appearance, backstory, speech style, likes / dislikes, goals, **secrets that surface through play**, relationships, scenario, greeting + alternative openings, example dialogue, tags, avatar (emoji, URL or uploaded image), accent colour.
- **✨ AI character creator** – describe a concept, get a complete playable card (structured output, validated against a schema). **Fill in the blanks** completes only what you left empty. Every field has its own **✨ AI** button to rewrite that field with optional guidance.
- Duplicate, export as JSON, import our JSON or SillyTavern `chara_card_v2/v3` cards.

### Personas
- Who *you* are in the story. The AI is explicitly forbidden from writing your persona's actions, thoughts or dialogue.

### Worlds & lorebooks
- Description plus lore entries with **keywords, priority and always-on flags**. Always-on entries live in the (cached) system prompt; keyword entries are injected only when their keywords appear in the recent conversation, with a token budget – so a 100-entry world stays cheap.
- **✨ AI worldbuilder** generates a whole lorebook from a paragraph.

### The roleplay screen
- Streaming replies with a live typing cursor, optional visible thinking summary.
- **Regenerate** (keeps every alternative, swipe ‹ › between them), **Continue** an unfinished reply, **Edit**, **Delete** (one or cascade), **Hide** from context, **Bookmark**, **Branch** the story from any message, **Copy**.
- **💡 Suggest** – 4 genuinely different next moves, each with a tone label. **🪄 Write for me** – the AI drafts your next message in your persona's voice; you edit before sending.
- Narrator controls: **⏱ Time skip**, **🎲 Twist** (unexpected complication), **🎬 Scene** change, **📣 Narrate** (direct instruction), **🎯 Steer** (one-off instruction attached to your next message), **▶ Continue** the scene without writing anything. `(OOC: …)` notes are answered briefly and the scene continues.
- **Character chat** mode (the AI *is* the character) or **Narrator / Game Master** mode (the AI runs the whole world and every NPC).
- Per-chat overrides for persona, world, mode, model, reply length, realism, effort, a **director's standing note** and scenario.
- Auto-titles, pinning, full-text search across every message, export as JSON or a Markdown transcript.

### The living world (right panel)
After every reply a second, cheaper structured call updates the world state:

| Tab | Tracks |
|---|---|
| 🌍 World | in-world date/time, location, weather, the character's mood, status and current goals, a **relationship meter** (−100…100 with a label and note), NPCs present and their disposition, your inventory, open/progressing/resolved/failed plot threads |
| 🧠 Memory | durable facts extracted automatically; pin the important ones, delete mistakes, add your own |
| 📜 Timeline | a running log of what happened, click to jump to the message |
| 📚 Story | the rolling summary (editable) and the director's note |

All of it is fed back into the prompt, so the character never forgets that you owe her money or that it was raining when you left.

### Context management (how it stays coherent for hundreds of messages)
1. **Stable system prompt** – character, persona, always-on lore, simulation rules and format rules. Byte-identical between turns, marked with `cache_control`, so Anthropic's prompt cache serves it at ~10 % cost.
2. **Verbatim history** – recent messages, with a cache breakpoint on the last user turn so the whole prefix is reused next turn.
3. **Rolling summary** – when raw history exceeds the context budget (default 24k tokens), the oldest messages are folded into a continuity summary; the last *N* messages are always kept verbatim. Summaries preserve names, numbers, promises, injuries, items and unresolved threads.
4. **Dynamic context** – summary, long-term memory, current world state, triggered lore, director's note and any one-off steering instruction are appended *after* the cached prefix as a mid-conversation `system` message (or a tagged text block on models that don't support it), so per-turn changes never invalidate the cache.
5. Budgets and estimates are shown live under the composer (system / history / summarized / lore triggered).

### Providers & model settings
- **Anthropic (Claude)** – Opus 5 by default; Fable 5.1, Sonnet 5, Opus 4.8, Haiku 4.5. Adaptive thinking, prompt caching, server-side refusal fallbacks, structured outputs.
- **xAI (Grok)** – Grok 4.6 by default; the model list is fetched live from your account. Uses the OpenAI-compatible chat API with streamed reasoning, strict JSON-schema structured outputs and `reasoning_effort`.
- Effort level, a separate cheaper utility model/effort for state tracking and summaries, max tokens, thinking display, reply length, realism (cinematic / grounded / brutal), point of view and tense.

## Putting it online

The app needs a small Node server (it keeps your chats in SQLite and talks to the AI provider on your behalf), so it can't run as a static page. Any host that runs Docker or Node works; the repo ships ready-made configs:

**Render (free, one tap):** open <https://render.com/deploy?repo=https://github.com/brokenyus-hash/Test>, sign in, fill in `XAI_API_KEY` and/or `ANTHROPIC_API_KEY` plus an `APP_PASSWORD`, and Render builds it from `render.yaml` and gives you a public URL. The free plan sleeps after 15 minutes idle (first request then takes ~1 minute) and has no persistent disk, so chats reset when it restarts. For a permanent setup switch `plan` to `starter` and add a `disk` (mount `/var/data`, set `DATA_DIR=/var/data`).

**Your own server with Kubernetes (k3s, microk8s, kubeadm), e.g. a Hetzner box:** one command, run on the server as root. It needs no registry and no image build: an init container clones this repo and installs packages onto `/var/lib/tavern/app`, and `node:22-alpine` runs it. Chats persist in `/var/lib/tavern/data`.

```bash
curl -fsSL https://raw.githubusercontent.com/brokenyus-hash/Test/claude/ai-roleplay-app-characters-w0a4bb/deploy/hetzner-k8s.sh \
  | XAI_API_KEY=xai-... APP_PASSWORD=choose-a-password bash
```

It finds `kubectl` (plain, `k3s kubectl` or `microk8s kubectl`), applies `deploy/k8s/tavern.yaml`, stores the keys in a Secret, and exposes the app through the cluster's Ingress at `http://tavern.<server-ip>.nip.io` (or on NodePort `30080` if there is no ingress controller). It also installs `deploy/k8s/autodeploy.yaml`: a CronJob that checks the branch on GitHub every two minutes and rolls out any new commit, so **pushing to the branch is deploying**. See `deploy/` for the manifests.

**Let Claude (or CI) operate the cluster.** `.github/workflows/ops.yml` runs on a self-hosted GitHub Actions runner installed on the server and exposes `status`, `logs`, `deploy`, `restart`, `events`, `describe` and raw `kubectl` actions; it also deploys on every push. Install the runner once on the server (GitHub → repo *Settings → Actions → Runners → New self-hosted runner* shows a registration token):

```bash
mkdir -p /opt/actions-runner && cd /opt/actions-runner
curl -o runner.tar.gz -L https://github.com/actions/runner/releases/download/v2.328.0/actions-runner-linux-x64-2.328.0.tar.gz
tar xzf runner.tar.gz
RUNNER_ALLOW_RUNASROOT=1 ./config.sh --url https://github.com/brokenyus-hash/Test --token <REGISTRATION_TOKEN> --labels tavern --unattended --name hetzner
RUNNER_ALLOW_RUNASROOT=1 ./svc.sh install root && ./svc.sh start
```

Anyone with write access to the repo can then trigger the workflow from the Actions tab, and a Claude session can trigger it and read the logs through the GitHub API.

**Railway / Fly.io / any Docker host:**

```bash
docker build -t tavern .
docker run -p 3000:3000 -e XAI_API_KEY=xai-... -e APP_PASSWORD=choose-one -v tavern-data:/app/data tavern
```

or `docker compose up` (reads keys from `.env`).

**Protect it.** Set `APP_PASSWORD` (and optionally `APP_USER`, default `tavern`) whenever the app is reachable from the internet. The browser will ask for the password once; without it anyone with the URL could spend your API credits and read your stories.

**Environment variables:** `PORT`, `DATA_DIR`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `XAI_BASE_URL`, `PROVIDER` (`anthropic` or `xai`; defaults to whichever key is set), `APP_PASSWORD`, `APP_USER`, `ANTHROPIC_BASE_URL`.

## Layout

```
server/
  index.js      entry (listens)        app.js       express app
  db.js         SQLite persistence     claude.js    SDK client, model params, structured calls
  prompt.js     prompt assembly + context management
  ai.js         streaming replies, state extraction, summaries, generators
  routes/       api.js (REST)  ai.js (SSE streaming + generation)
public/         vanilla ES-module SPA (app, chat, editors, ui, api) + CSS
test/           mock Anthropic/xAI API + end-to-end test-suite
deploy/         Kubernetes manifests + one-command server deploy script
data/           tavern.sqlite (created on first run; git-ignored)
```

`server/providers/xai.js` holds the Grok client; `server/provider.js` dispatches between providers.
