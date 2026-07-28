# BrainOutput Community Edition — Troubleshooting

Run `node bo-community.mjs doctor` first — it reports Node, detected local models, and BYOK keys.

**No models detected / tasks fail with "unconfigured".**
- Install ollama and pull a model: `ollama pull qwen3-30b-a3b`. Confirm it serves:
  `curl http://127.0.0.1:11434/api/tags`.
- Or add a free/BYOK connection (see `samples/`), then re-run `bo-community onboard` to detect it.
- A capability slot with no valid model stays **unconfigured** and offers free/BYOK/local/stop — by
  design it never picks a paid model. Assign one in the dashboard's *Assignments* page.

**A task is slow (20–40 s).** Local generation speed is model- and hardware-bound (a few tokens/sec
on CPU). Use a **smaller** model for routine work (e.g. `qwen3-30b-a3b`) or a **local GPU** endpoint;
assign faster models to `fast-cheap` / `multilingual` slots. The dashboard shows a running state.

**"BYOK connection refused" / 401.** Set the env var named in the connection's `apiKeyEnv` *before*
starting the app (`export USER_OWN_ANTHROPIC_KEY=…`), then restart `bo-community serve`.

**Web dashboard won't load.** Check the port isn't taken: `BO_CE_WEB_PORT=4188 bo-community serve`.
It binds `127.0.0.1` only (local).

**Company/history disappeared.** Data lives in `$BO_CE_DATA` (default `~/.local/share/bo-community`).
If you set `BO_CE_DATA` in one shell, set it in the shell you launch from too. `bo-community store
show` prints the active data dir.

**OpenCode coding task hangs / never finishes.** The agentic OpenCode path depends on the `opencode`
binary; if it stalls at startup, use a chat-capable model for the coding worker (the dashboard's
execution already does this), keep the working directory small, or update opencode
(`opencode upgrade`). Non-coding workflows are unaffected.

**Reset everything.** `rm -rf ~/.local/share/bo-community` then `bo-community setup`.

Still stuck? See `FEEDBACK.md`.
