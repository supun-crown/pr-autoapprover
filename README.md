# pr-autoapprover

> A small, opinionated bot that reads your pull requests, leaves a sarcastic
> code review, and clicks Approve so you don't have to.

It runs on a schedule, polls every repo you tell it to watch, and uses your
local `claude` CLI (no API key required) to do the actual reading. If a PR
has no merge conflicts and no failing checks, the bot approves it. If it
spots an actual release-blocking bug, it leaves an inline review comment
with a one-click GitHub `suggestion` block. If it finds nothing wrong, it
files a one-line approval that sounds suspiciously like the engineer next to
you on a Friday afternoon.

It is, deliberately, not very serious.

---

## Why

Tiny PRs pile up. Most of them are fine. Going to GitHub, scrolling through
a 4-line diff, clicking Approve, typing "lgtm", and closing the tab is the
software-engineering equivalent of unloading the dishwasher: not hard, just
relentlessly there. This service handles the boring 95% so you can do the
interesting 5%.

It will not replace a human review on anything that matters. It is
configured to be **strict** about what counts as a bug worth flagging, and
**generous** about everything else.

---

## What it actually does

For every open PR in every watched repo, on every poll cycle:

```
┌──────────────────────────────────────────────┐
│ already approved by me?         → skip       │
│ written by me?                  → skip       │
│ already commented but blocked?  → wait       │
│ already commented and clean?    → APPROVE    │
│ never seen before:                           │
│   ├─ pull diff                               │
│   ├─ ask claude for a review                 │
│   ├─ validate any GIF it suggests            │
│   ├─ if clean → APPROVE with body + inline   │
│   └─ if blocked → COMMENT, approve later     │
└──────────────────────────────────────────────┘
```

Comments are **anchored to specific lines** with optional `suggestion`
blocks. The summary in the review body gets a sarcastic one-liner. About
half the time (configurable) it adds a celebration GIF, which gets
HEAD-checked against GitHub's image proxy rules before posting so you don't
end up with broken-image icons.

It will never:

- approve its own PRs (GitHub forbids it anyway),
- approve a PR with merge conflicts,
- approve a PR with failing CI checks,
- comment twice on the same PR,
- post a GIF GitHub can't actually render.

---

## Quick start

You need:

- Node.js **22.7+** (uses native TypeScript via `--experimental-strip-types`).
- The [Claude Code CLI](https://claude.ai/code), signed in.
- A GitHub PAT with `repo` scope (or fine-grained equivalent).
- Docker if you want it living forever in the background.

```bash
git clone git@github.com:supun-crown/pr-autoapprover.git
cd pr-autoapprover

cp .env.example .env
# fill in GITHUB_OWNER and GITHUB_TOKEN

cp src/repos.example.ts src/repos.ts
# edit with the repos you want watched

npm run dry      # rehearsal: prints what it WOULD do
npm start        # the real thing
```

Or with Docker (recommended for always-on):

```bash
docker compose up -d --build
docker compose logs -f
```

Add `restart: unless-stopped` is already set, so once Docker Desktop is
configured to start at login, this is a one-time setup.

---

## File layout

```
automater/
├── src/
│   ├── poller.ts            ← main loop. Don't usually need to touch.
│   ├── prompts.ts           ← edit this to change Claude's tone or strictness
│   ├── repos.example.ts     ← committed template
│   └── repos.ts             ← gitignored. Your real repo list.
├── Dockerfile
├── docker-compose.yml
├── package.json
├── .env.example
└── README.md
```

The two files you'll actually edit:

- **`src/repos.ts`** — the list of repos to watch. Gitignored so your
  service names stay private.
- **`src/prompts.ts`** — the prompt sent to Claude. Edit this to make the
  bot meaner, nicer, more verbose, less verbose, etc.

---

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `GITHUB_OWNER` | (required) | Org or user that owns the repos. |
| `GITHUB_TOKEN` | (required) | PAT for reading PRs and posting reviews. |
| `GITHUB_REPOS` | _(uses `repos.ts`)_ | Comma-separated override of the file list. |
| `POLL_INTERVAL_MS` | `60000` | How often to scan. 30000 is fine. |
| `DRY_RUN` | `false` | Don't post anything, just log intent. |
| `CLAUDE_BIN` | `claude` | Path to the CLI. |
| `CLAUDE_TIMEOUT_MS` | `90000` | Per-PR timeout for Claude. |
| `GIF_PROBABILITY` | `0.2` | 0.0 = boring, 1.0 = chaos. |
| `GIF_THEME` | `lgtm celebration ship-it` | What kind of GIF to look for. |
| `GIF_MAX_ROUNDS` | `3` | Retries before giving up on a GIF. |

---

## Tuning the personality

`src/prompts.ts` is one big string. Three sections worth knowing about:

- **`STYLE_RULES`** — kills em dashes, smart quotes, AI-tells like
  "Furthermore" and "It's worth noting", and the chatbot voice in general.
  Tweak to taste.
- **`ISSUES_SECTION`** — sets the bar for what counts as worth flagging.
  Currently: only release-blocking stuff (security, data loss, crashes,
  broken APIs, races, DoS). Loosen if you want it to be pickier about
  taste.
- **`SUMMARY_SECTION`** — controls the one-line summary at the top of
  every review. Currently mandates "sarcastic and humorous". Replace with
  "polite and professional" if your VP of Engineering reads PRs.

Change a line, restart the container, you've changed the bot's personality.

---

## State and idempotency

`state.json` (gitignored) tracks every PR the bot has acted on. It's a
plain JSON dictionary like:

```json
{
  "your-org/repo#42": {
    "reviewedAt": "2026-05-08T09:30:00.000Z",
    "approvedAt": "2026-05-08T09:35:12.000Z"
  }
}
```

Three layers stop the bot from acting twice on the same PR:

1. The state file.
2. A `getMyReviewState()` check against GitHub itself.
3. An in-flight `Set` that blocks overlapping ticks within a single run.

Delete `state.json` if you want; the GitHub check will still keep it from
double-approving anything.

---

## Logs

Per-PR logs are grouped into single blocks. Idle PRs emit nothing.

```
[2026-05-08T09:31:42.910Z] amp-frontend#452 (alice): fix VAT rounding
  approved https://github.com/your-org/amp-frontend/pull/452
```

```
[2026-05-08T09:33:15.012Z] amp-frontend#447 (bob): Upgrade to Nuxt 4
  waiting on https://github.com/your-org/amp-frontend/pull/447: conflict=false checksFailing=true
```

The "waiting" line only fires when the gate state changes, not every tick.
Tail logs with `docker compose logs -f` or `tail -f poller.log`.

---

## Caveats and known weirdness

- It polls. New PRs take up to `POLL_INTERVAL_MS` to be seen.
- Each Claude call is 10–30s. Bursts of PRs get processed in series.
- GIF URLs sometimes rot. Validator logs the rejection, approval still
  posts (just without a GIF).
- `claude -p` runs in your account. If you're worried about token cost or
  rate limits, lower `GIF_PROBABILITY` and raise `POLL_INTERVAL_MS`.
- It cannot approve its own PRs. GitHub forbids self-approval. If you want
  yours auto-approved too, run a separate bot account's PAT.

---

## License

MIT. Use it, fork it, make it ruder.

---

> Built because clicking Approve 40 times a week is not what I went into
> software for.
