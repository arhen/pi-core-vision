/**
 * pi-vision core — pure logic, no pi imports. Runs under plain `bun` for self-checks.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";

export const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // guard for the raw fallback path

export const DEFAULT_PROMPT = `Describe this image as text for a text-only LLM that must act on it. Compact but complete:
- What it is (screenshot, photo, diagram, chart, UI, terminal output)
- ALL visible text verbatim (error messages, code, labels, values, button names)
- Layout: sections, order, highlighted/selected/clickable elements, states (on/off, empty/full, enabled/disabled)
- Numbers, colors, icons, and anything that changes meaning if omitted
Plain text with markdown structure, no preamble.`;

export interface VisionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  maxTokens: number;
}

export let configPath = join(homedir(), ".pi", "pi-vision.json");
let cfgCache: VisionConfig | null = null;

export function setConfigPath(path: string | null) {
  configPath = path ?? join(homedir(), ".pi", "pi-vision.json");
  resetConfigCache();
}

export function resetConfigCache() {
  cfgCache = null;
}

/** Merge partial config into the config file. Returns merged config. */
export function saveConfig(partial: Partial<VisionConfig>): VisionConfig {
  let existing: Partial<VisionConfig> = {};
  try {
    existing = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    // no file yet
  }
  const merged = { ...existing, ...partial } as VisionConfig;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(configPath, 0o600);
  } catch {
    // mode may already be restrictive
  }
  resetConfigCache();
  return loadConfig();
}

export function loadConfig(): VisionConfig {
  if (cfgCache) return cfgCache;
  let file: Partial<VisionConfig> = {};
  try {
    file = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    // no config file — env vars only
  }
  const env = process.env;
  cfgCache = {
    baseUrl: file.baseUrl ?? env.PI_VISION_BASE_URL ?? "",
    apiKey: file.apiKey ?? env.PI_VISION_API_KEY ?? "",
    model: file.model ?? env.PI_VISION_MODEL ?? "",
    prompt: file.prompt ?? DEFAULT_PROMPT,
    maxTokens: file.maxTokens ?? 1500,
  };
  return cfgCache;
}

export function modelSupportsImages(model?: { input?: string[] }): boolean {
  return !!model?.input?.includes("image");
}

/**
 * Send already-encoded base64 image to the vision API.
 * Used with pi's own resized output from the built-in read tool.
 */
export async function describeBase64(
  data: string,
  mimeType: string,
  cfg: VisionConfig,
  signal?: AbortSignal,
): Promise<{ text: string; usage?: { input: number; output: number } }> {
  const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      stream: false, // some gateways (kitchen) stream SSE by default — force JSON
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: cfg.prompt },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`pi-vision: vision API ${res.status}: ${body.slice(0, 300)}`);
  }
  const dataJson = (await res.json()) as {
    choices?: { message?: { content?: unknown } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = dataJson?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("pi-vision: unexpected or empty API response");
  }
  return {
    text,
    usage:
      dataJson.usage && typeof dataJson.usage.prompt_tokens === "number"
        ? { input: dataJson.usage.prompt_tokens, output: dataJson.usage.completion_tokens ?? 0 }
        : undefined,
  };
}

/** Raw fallback (no pi resize): read file, guard size, describe. Used when pi's image processing failed. */
export async function describeRawFile(
  path: string,
  cfg: VisionConfig,
  signal?: AbortSignal,
): Promise<{ text: string; usage?: { input: number; output: number } }> {
  const mimeType = MIME[extname(path).toLowerCase()];
  if (!mimeType) throw new Error(`pi-vision: unsupported image type "${extname(path)}"`);
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `pi-vision: image too large (${(bytes.byteLength / 1048576).toFixed(1)}MB > 20MB). Downscale it first.`,
    );
  }
  return describeBase64(Buffer.from(bytes).toString("base64"), mimeType, cfg, signal);
}

export function maskKey(key: string): string {
  if (!key) return "(not set)";
  return key.length <= 8 ? "***" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Tokenize args, respecting double quotes (key="a b c" = one token). */
function tokenize(args: string): string[] {
  const out: string[] = [];
  const re = /([^\s=]+)="([^"]*)"|"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args))) {
    if (m[1]) out.push(`${m[1]}=${m[2]}`);
    else out.push(m[3] ?? m[4]);
  }
  return out;
}

/** Parse "k=v k2=v2" args into a partial config. Throws on unknown keys. */
export function parseArgs(args: string): { action: "set" | "show" | "reset"; values: Partial<VisionConfig> } {
  const tokens = tokenize(args);
  if (tokens.length === 0 || tokens[0] === "show" || tokens[0] === "status") return { action: "show", values: {} };
  if (tokens[0] === "reset") return { action: "reset", values: {} };
  if (tokens[0] !== "set") {
    throw new Error(`Unknown action "${tokens[0]}". Usage: /pi-vision [set key=value ...| show | reset]`);
  }
  const values: Partial<VisionConfig> = {};
  for (const tok of tokens.slice(1)) {
    const eq = tok.indexOf("=");
    if (eq <= 0) throw new Error(`Expected key=value, got "${tok}"`);
    const key = tok.slice(0, eq) as keyof VisionConfig;
    let value = tok.slice(eq + 1);
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!["baseUrl", "apiKey", "model", "prompt", "maxTokens"].includes(key)) {
      throw new Error(`Unknown setting "${key}". Known: baseUrl, apiKey, model, prompt, maxTokens`);
    }
    values[key] = key === "maxTokens" ? Number(value) : value;
  }
  return { action: "set", values };
}

export function isConfigComplete(cfg: VisionConfig): boolean {
  return !!cfg.baseUrl && !!cfg.apiKey && !!cfg.model;
}
