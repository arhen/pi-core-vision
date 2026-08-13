# pi-vision

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

## Development

```bash
bun src/self-check.ts    # logic self-checks (no pi needed, no API calls)
```

## License

MIT
