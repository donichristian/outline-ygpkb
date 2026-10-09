# Telegram bot commands (BotFather) — Matius

The **Telegram command menu** is owned by **@BotFather** (`/setcommands`), not by
Hermes at runtime. A BotFather-configured list is what users see in the menu. To
make a shortcut such as **`/sop`** appear, it must be present in that list.

Matius is a **KB bot**, so it deliberately exposes a **minimal** menu — the
Hermes default (60 commands: `/yolo`, `/egress`, `/codex_runtime`, …) is dev/
operator noise and is intentionally dropped.

## Menu (4 commands)

```
sop - List the SOP (Standar Prosedur Operasional) collections in the knowledge base
help - Show available commands
new - Start a new session
status - Show session, model, and context info
```

## How /sop works

`/sop` is a Hermes **skill** (`skills/sop/SKILL.md` in the matius profile). Skills
auto-register as slash commands, so typing `/sop` dispatches it, and the bot lists
the SOP collections from the KB. BotFather registration only controls whether it
appears in the tappable menu.

Because Telegram's menu is capped and skills sort after core commands, `/sop` can
fall off Hermes's own `set_my_commands` slice. Two things keep it visible:

1. **BotFather list** — include `sop` (above), so it is always in the menu.
2. **(Belt-and-braces) Hermes priority** — `platforms.telegram.extra.command_menu.priority`
   in the profile `config.yaml` pins `sop` before the cap.

## Apply the command list

1. In Telegram, open **@BotFather** → send `/setcommands` → choose **@SkiMatiusBot**.
2. Paste the 4-line block above.
3. BotFather replies "Success!".

> The menu shows only these 4 commands, but every Hermes command still *works* if
> typed (e.g. `/usage`). The list controls visibility, not availability. Keep it
> minimal on purpose — add a command only if KB users genuinely need it.

## Adding more KB shortcuts later

1. Create the skill: `<profile home>/skills/<name>/SKILL.md` with frontmatter
   `name: <name>` and a `description`.
2. Add `<name> - <description>` to the BotFather `/setcommands` list.
3. Optionally add it to `platforms.telegram.extra.command_menu.priority`.

## Lean skill set (KB bot)

Matius only needs the KB; the bundled skills (code, media, dev tooling) are
disabled via `skills.disabled` in the matius `config.yaml`, keeping just:

- `sop` — the KB shortcut
- `hermes-agent` — mandatory agent manual (never disableable)

Result: **2 enabled / 54 disabled** (`hermes -p matius skills list`). The list is
non-destructive — skill files stay on disk, `hermes update` is unaffected, and a
name is re-enabled by removing it from `skills.disabled`.

## Answer-only replies (no reasoning / tool narration)

By default Hermes streams mid-turn **reasoning and tool-call narration** into the
chat ("Let me fetch…", raw tool args, a reasoning box). For a KB Q&A bot this is
noise. The matius config sets, under `display.platforms.telegram`:

```yaml
display:
  platforms:
    telegram:
      streaming: false                 # don't stream partial tokens
      tool_progress: off               # no per-tool breadcrumbs
      interim_assistant_messages: false # no mid-turn "Let me fetch…" narration
      show_reasoning: false            # no reasoning box
```

Result: the bot posts **only the final answer**. Scoped to Telegram so the CLI/
TUI are unaffected. `hermes gateway restart` applies it.

> The leaked narration is `interim_assistant_messages` (mid-turn assistant
> messages) plus `tool_progress` (tool breadcrumbs). Both must be off for a
> clean answer-only surface.

## Citations and the reachable-URL requirement

Matius is instructed to end every answer with a `Sumber:` citation in the form
`[Judul Dokumen](url)`. For that citation to be **tappable from Telegram**, the
KB's `URL` must be reachable from the user's device — **not** `localhost`.

Currently Outline's `URL` is `http://localhost:3050` (`.env.local`), so citations
render as links that only work on the machine running Outline; on a phone the
link is dead. Nothing in the agent or prompt can fix this — it is a deployment
detail.

To make citations usable:

1. Set Outline's `URL` to a device-reachable address, e.g. a LAN address
   (`http://192.168.x.x:3050`) or a public host/tunnel, in `.env.local`.
2. Restart the Outline server so `URL` (and `Document.path` output) update.

> Interim mitigation: the bot also names the document **title** in plain text, so
> even with a dead link the user knows which document a answer came from. The
> clickable link becomes useful only once `URL` is reachable.
