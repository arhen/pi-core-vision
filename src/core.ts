/**
 * pi-vision core — pure logic, no pi imports. Runs under plain `bun` for self-checks.
 */
import { createHash } from "node:crypto";
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
 * `model` may be a comma-separated chain (try in order). Transient errors (5xx/429)
 * get one retry; per-model failures fall through to the next model.
 */
export async function describeBase64(
  data: string,
  mimeType: string,
  cfg: VisionConfig,
  signal?: AbortSignal,
): Promise<{ text: string; usage?: { input: number; output: number } }> {
  const models = cfg.model.split(",").map((m) => m.trim()).filter(Boolean);
  if (models.length === 0) throw new Error("pi-vision: no model configured");
  let lastErr: Error | null = null;
  for (const model of models) {
    try {
      return await describeOnce(data, mimeType, { ...cfg, model }, signal);
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw lastErr ?? new Error("pi-vision: vision call failed");
}

async function describeOnce(
  data: string,
  mimeType: string,
  cfg: VisionConfig,
  signal?: AbortSignal,
): Promise<{ text: string; usage?: { input: number; output: number } }> {
  // Cache hit → instant, zero tokens.
  const key = cacheKey(data, cfg);
  const cached = cacheGet(key);
  if (cached !== undefined) return { text: cached };

  const body = JSON.stringify({
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
  });
  const attempt = async (): Promise<Response> =>
    fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body,
    });

  let res = await attempt();
  // One retry on transient failures (5xx/429/upstream-wrapped errors); skip for auth/config (401/403).
  if (!res.ok && res.status !== 401 && res.status !== 403) {
    await new Promise((r) => setTimeout(r, 1500));
    if (signal?.aborted) throw new Error("pi-vision: aborted during retry");
    res = await attempt();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`pi-vision: vision API ${res.status}${cfg.model !== "" ? ` (${cfg.model})` : ""}: ${text.slice(0, 300)}`);
  }
  const dataJson = (await res.json()) as {
    choices?: { message?: { content?: unknown } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = dataJson?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("pi-vision: unexpected or empty API response");
  }
  cacheSet(key, text);
  return {
    text,
    usage: dataJson.usage && typeof dataJson.usage.prompt_tokens === "number"
      ? {
          input: dataJson.usage.prompt_tokens,
          output: dataJson.usage.completion_tokens ?? 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: (dataJson.usage.prompt_tokens ?? 0) + (dataJson.usage.completion_tokens ?? 0),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, // gateway pricing unknown
        }
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

// --- description cache -------------------------------------------------------
// Content-addressed (sha1 of image bytes + model + baseUrl), LRU in memory,
// lazily persisted to disk so repeat reads across sessions are instant.

const CACHE_MAX = 200;
export let cachePath = join(homedir(), ".pi", "pi-vision-cache.json");
let cache = new Map<string, string>();
let cacheLoaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

export function setCachePath(path: string | null) {
  cachePath = path ?? join(homedir(), ".pi", "pi-vision-cache.json");
  cacheLoaded = false;
}

export function clearCache() {
  cache.clear();
  cacheLoaded = false; // next access re-reads disk (may be empty — fine)
}

export function cacheSize(): number {
  return cache.size;
}

function loadCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, string>;
    const entries = Object.entries(raw);
    // keep the last CACHE_MAX (JSON object order = insertion order for string keys)
    for (const [k, v] of entries.slice(-CACHE_MAX)) cache.set(k, v);
  } catch {
    // no cache yet or corrupt — start empty
  }
}

function persistCache() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(Object.fromEntries(cache)), { mode: 0o600 });
    } catch {
      // cache is best-effort
    }
  }, 1000);
}

export function cacheKey(data: string, cfg: VisionConfig): string {
  return createHash("sha1").update(`${cfg.baseUrl}|${cfg.model}|${data}`).digest("hex");
}

export function cacheGet(key: string): string | undefined {
  loadCache();
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key); // LRU touch
    cache.set(key, hit);
  }
  return hit;
}

export function cacheSet(key: string, text: string) {
  loadCache();
  cache.delete(key);
  cache.set(key, text);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  persistCache();
}
