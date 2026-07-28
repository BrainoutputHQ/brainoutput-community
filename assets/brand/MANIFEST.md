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
