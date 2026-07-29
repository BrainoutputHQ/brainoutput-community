# Authorized brand assets — runtime "Works with" logos

BrainOutput uses third-party logos only to state **compatibility** ("Works with X"), under nominative
fair use. We do **not** imply partnership, sponsorship, or endorsement. Each logo below is used
unmodified, links to the vendor, and is dropped in as an official SVG from the source noted.

**Rendering contract:** the runtime cards render the SVG at `assets/brand/<key>.svg` if it exists;
otherwise they fall back to the text label **"Works with <name>"**. So a runtime is never blocked on a
missing asset — the official logo simply appears once its SVG is added here.

| key           | runtime                    | official source (drop the SVG in as `<key>.svg`)                     | usage terms |
|---------------|----------------------------|---------------------------------------------------------------------|-------------|
| `opencode`    | OpenCode                   | opencode.ai / its GitHub brand assets                               | open-source project mark; attribution, unmodified |
| `claude-code` | Claude Code (Anthropic)    | anthropic.com brand guidelines                                      | nominative use only; no endorsement implied |
| `codex`       | Codex (OpenAI)             | openai.com/brand                                                    | nominative use only; no endorsement implied |
| `ollama`      | Ollama (local runtime)     | ollama.com / github.com/ollama                                     | project mark; attribution, unmodified |
| `openai-api`  | Generic OpenAI-compatible  | generic — use a neutral "OpenAI-compatible" wordmark, not a vendor  | text only |

## Rules (do not relax)

1. **Official assets only.** Never recreate or trace a logo; use the vendor's published SVG verbatim.
2. **"Works with" language only.** Never "official", "partner", "powered by", "endorsed by".
3. **No lock-in styling.** Logos are monochrome-friendly and link to the vendor's site.
4. If a vendor's brand policy forbids the mark, drop to text — the card already falls back cleanly.

Add an SVG here → it is in the authorized list → it renders. Nothing renders a logo that is not in
this folder.

## Status (2026-07-29)

| key           | asset            | state |
|---------------|------------------|-------|
| `opencode`    | `opencode.svg`   | **present** — opencode.ai/favicon.svg, unmodified |
| `ollama`      | `ollama.png`     | **present** — github.com/ollama/ollama `docs/ollama.png`, MIT project, unmodified. No official SVG is published, so the PNG is the official asset. |
| `claude-code` | —                | **absent, deliberately.** anthropic.com brand pages returned 404 when this was attempted; neither the official file nor the published policy could be obtained. |
| `codex`       | —                | **absent, deliberately.** openai.com/brand returned 403 (bot-blocked); same reason. |
| `openai-api`  | — (text by design) | generic category, never a vendor mark |

Claude Code and Codex fall back to text, exactly as the rendering contract intends. Do NOT satisfy
them by tracing, redrawing or lifting a favicon: rule 1 exists because a recreated trademark
misrepresents someone else's mark, which is worse than showing their name in plain text. To add one,
download the SVG from the vendor's own brand page and drop it in — it renders with no code change.
