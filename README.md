# pi-vision

[![npm version](https://img.shields.io/npm/v/pi-vision?color=cb3837&logo=npm&label=npm)](https://www.npmjs.com/package/pi-vision)
[![npm downloads](https://img.shields.io/npm/dm/pi-vision)](https://www.npmjs.com/package/pi-vision)
[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/github/license/arhen/pi-vision)](LICENSE)

Transparent vision fallback for text-only models in [pi](https://pi.dev).

Overrides the built-in `read` tool:

- **text file** → built-in behavior, untouched
- **image + active model sees images** → built-in behavior, untouched (pi's own resize + native attach)
- **image + text-only model** → pi resizes the image (Photon WASM), then the extension sends pi's resized output to a vision model and returns a compact text description

The model sees one result either way — no double reading, no new tool to learn. Text-only models (e.g. DeepSeek) can finally read screenshots, diagrams, and error messages.

## Install

```bash
pi install git:github.com/arhen/pi-vision
```

or try without installing:

```bash
pi -e git:github.com/arhen/pi-vision
```

## Configure

Set the vision model via `/pi-vision` command, env vars, or `~/.pi/pi-vision.json` (JSON wins over env).

```bash
/pi-vision set baseUrl=https://api.openai.com/v1 apiKey=sk-... model=gpt-4o-mini
/pi-vision show          # current config (apiKey masked)
/pi-vision reset         # clear config file
```

Env vars:

```bash
export PI_VISION_BASE_URL="https://api.openai.com/v1"
export PI_VISION_API_KEY="sk-..."
export PI_VISION_MODEL="gpt-4o-mini"
```

`~/.pi/pi-vision.json` (extra options: `prompt`, `maxTokens`):

```json
{
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "model": "gpt-4o-mini",
  "maxTokens": 1500
}
```

Any OpenAI-compatible endpoint works: OpenAI `/v1`, Google Gemini `/v1beta/openai`, Alibaba DashScope `/compatible-mode/v1`, Ollama `/v1`, LM Studio, vLLM. If your gateway streams SSE by default, the extension forces `stream: false`.

## How it works

- Delegates every read to pi's own `createReadToolDefinition` — byte-identical built-in behavior (Photon resize to 2000px / 4.5MB, magic-byte mime detection, truncation).
- Checks `ctx.model.input.includes("image")` at call time. Vision-capable model → built-in result untouched. Text-only model + image → vision model describes pi's already-resized base64.
- Nested vision usage is reported back, so pi session stats stay accurate.
- Raw-file fallback (with 20MB guard) covers the case where pi's image processing is unavailable (e.g. BMP).

## Benchmark

Single-run comparison vs community alternatives, text-only parent model (deepseek-v4-flash), same screenshot through the same kitchen gateway. See also [pi-vision-handoff](https://github.com/monotykamary/pi-vision-handoff) and [pi-sense](https://github.com/ssdiwu/pi-sense).

### Healthy vision model (gemma-4-26b via kitchen)

| tool | e2e | flow | precision |
|---|---|---|---|
| **pi-vision (this)** | **32s** | clean 1 read → description in result | **6/6 facts** (title, theme, tabs, chat, layout) |
| pi-vision-handoff | 44s | clean 1 read → context swap | 5/6 |
| pi-sense | 122s | description in result | ~5/6 |

### Vision API down (kitchen haiku 429 for the whole window)

| tool | result |
|---|---|
| **pi-vision (pre-fix)** | 200s+ hang — threw on 429 → parent retry-looped the read |
| **pi-vision (post-fix)** | **19s** — graceful `[image: description unavailable]` → model moves on |
| pi-vision-handoff | 42s — graceful placeholder → OCR fallback |
| pi-sense | 27s — graceful placeholder → OCR fallback |

Findings:
- Fastest end-to-end when vision is healthy, and the only tool that returns the full description inside the read result.
- Vision failures degrade gracefully (placeholder text, no hang) — shipped after the 429 incident above.
- Descriptions are framed as UNTRUSTED DATA (prompt-injection mitigation).

Caveats: single run per cell; gateway routing flakiness affects variance.

Caveats: single run per cell; gateway routing flakiness affects variance.

## Development

```bash
bun src/self-check.ts    # logic self-checks (no pi needed, no API calls)
```

## License

MIT
