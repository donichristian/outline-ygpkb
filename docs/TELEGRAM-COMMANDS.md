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
