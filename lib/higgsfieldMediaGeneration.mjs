// Higgsfield official CLI client (github.com/higgsfield-ai/cli).
// Auth lives in the CLI session (`higgsfield auth login`), same pattern as the
// Hermes route: this module resolves the binary, runs
// `higgsfield generate create <model> --prompt ... --wait --json`, and
// downloads the resulting asset URL.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const GENERATE_TIMEOUT_MS = 15 * 60 * 1000;

export const HIGGSFIELD_IMAGE_MODELS = [
  { id: "higgsfield-nano-banana-2", label: "Nano Banana 2 (Higgsfield)", provider: "nano-banana", apiModel: "nano_banana_2" },
  { id: "higgsfield-gpt-image-2", label: "GPT Image 2 (Higgsfield)", provider: "openai", apiModel: "gpt_image_2" },
  { id: "higgsfield-soul-2", label: "Soul 2.0 (Higgsfield)", provider: "higgsfield", apiModel: "text2image_soul_v2" },
  { id: "higgsfield-recraft-4-1", label: "Recraft 4.1 (Higgsfield)", provider: "recraft", apiModel: "recraft_v4_1" },
  { id: "higgsfield-flux-2", label: "Flux.2 (Higgsfield)", provider: "flux", apiModel: "flux_2" },
];

export const HIGGSFIELD_VIDEO_MODELS = [
  { id: "higgsfield-kling-3", label: "Kling 3.0 (Higgsfield)", provider: "kling", apiModel: "kling3_0" },
  { id: "higgsfield-seedance-2", label: "Seedance 2.0 (Higgsfield)", provider: "seedance", apiModel: "seedance_2_0" },
  { id: "higgsfield-veo-3-1", label: "Veo 3.1 (Higgsfield)", provider: "veo", apiModel: "veo3_1" },
];

export function isHiggsfieldImageModel(model) {
  return HIGGSFIELD_IMAGE_MODELS.some((entry) => entry.id === model);
}

export function isHiggsfieldVideoModel(model) {
  return HIGGSFIELD_VIDEO_MODELS.some((entry) => entry.id === model);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function runProcess(command, args = [], { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out: ${command} ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
    });
  });
}

let cachedCommand = null;

export async function resolveHiggsfieldCommand() {
  if (cachedCommand) return cachedCommand;
  const candidates = [
    nonEmptyString(process.env.HIGGSFIELD_PATH),
    "higgsfield",
    join(homedir(), ".local", "bin", "higgsfield"),
    "/opt/homebrew/bin/higgsfield",
    "/usr/local/bin/higgsfield",
  ].filter(Boolean);
  const failures = [];
  for (const candidate of candidates) {
    try {
      await runProcess(candidate, ["--version"], { timeoutMs: 15_000 });
      cachedCommand = candidate;
      return candidate;
    } catch (error) {
      failures.push(`${candidate}: ${error.message.split("\n")[0]}`);
    }
  }
  throw new Error(
    "Higgsfield CLI が見つかりません。`brew install higgsfield-ai/tap/higgsfield` " +
      "または `npm install -g @higgsfield/cli` でインストールし、`higgsfield auth login` でログインしてください。\n" +
      `Checked:\n${failures.join("\n")}`,
  );
}

export async function getHiggsfieldAuthStatus() {
  try {
    const command = await resolveHiggsfieldCommand();
    let session = "unknown";
    try {
      const result = await runProcess(command, ["auth", "status"], { timeoutMs: 15_000 });
      session = /logged in|authenticated/i.test(result.stdout + result.stderr) ? "logged-in" : "unknown";
    } catch {
      // Older CLI versions may not have `auth status`; generation will surface it.
    }
    return { installed: true, command, session };
  } catch (error) {
    return { installed: false, error: error.message.split("\n")[0] };
  }
}

function mapHiggsfieldError(message) {
  if (/session expired|not logged in|unauthorized|401|auth/i.test(message)) {
    return `Higgsfield にログインしていません。ターミナルで \`higgsfield auth login\` を実行してから再試行してください。(${message.split("\n")[0]})`;
  }
  return message;
}

function extractResultUrls(stdout) {
  const urls = [];
  try {
    const parsed = JSON.parse(stdout);
    const walk = (value) => {
      if (typeof value === "string") {
        if (/^https?:\/\//.test(value)) urls.push(value);
        return;
      }
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(parsed);
  } catch {
    for (const match of stdout.matchAll(/https?:\/\/[^\s"']+/g)) urls.push(match[0]);
  }
  const media = urls.filter((url) => /\.(png|jpe?g|webp|gif|mp4|mov|webm)(\?|$)/i.test(url));
  return media.length > 0 ? media : urls;
}

async function downloadHiggsfieldOutput(url, fallbackMime) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download Higgsfield output (${response.status}).`);
  const mimeType = response.headers.get("content-type")?.split(";")[0] || fallbackMime;
  return { buffer: Buffer.from(await response.arrayBuffer()), mimeType, source: url };
}

// The CLI schema varies per model, so aspect/duration ride along as prompt
// hints (the same prompt-driven approach as the Lovart route).
function buildHiggsfieldPrompt(input, kind) {
  const parts = [nonEmptyString(input.prompt)];
  const aspect = nonEmptyString(input.aspectRatio);
  if (aspect && aspect !== "auto") parts.push(`aspect ratio ${aspect}`);
  if (kind === "video") {
    const duration = Number.parseInt(String(input.duration ?? ""), 10);
    if (Number.isFinite(duration) && duration > 0) parts.push(`${duration} seconds`);
  }
  return parts.filter(Boolean).join(", ");
}

async function generateHiggsfieldMedia(input, kind) {
  const registry = kind === "video" ? HIGGSFIELD_VIDEO_MODELS : HIGGSFIELD_IMAGE_MODELS;
  const entry = registry.find((model) => model.id === input.model) ?? registry[0];
  const prompt = buildHiggsfieldPrompt(input, kind);
  if (!prompt) throw new Error("Higgsfield generation requires a prompt.");

  const command = await resolveHiggsfieldCommand();
  let result;
  try {
    result = await runProcess(
      command,
      ["generate", "create", entry.apiModel, "--prompt", prompt, "--wait", "--json"],
      { timeoutMs: GENERATE_TIMEOUT_MS },
    );
  } catch (error) {
    throw new Error(mapHiggsfieldError(error.message));
  }
  const urls = extractResultUrls(result.stdout);
  if (urls.length === 0) {
    throw new Error(`Higgsfield returned no result URL. Output: ${result.stdout.slice(0, 300)}`);
  }
  const media = await downloadHiggsfieldOutput(urls[0], kind === "video" ? "video/mp4" : "image/png");
  return {
    kind,
    model: entry.id,
    mimeType: media.mimeType,
    buffer: media.buffer,
    fileName: input.fileName || `higgsfield-${Date.now()}${kind === "video" ? ".mp4" : ".png"}`,
    source: media.source,
  };
}

export async function generateHiggsfieldImageMedia(input = {}) {
  return generateHiggsfieldMedia(input, "image");
}

export async function generateHiggsfieldVideoMedia(input = {}) {
  return generateHiggsfieldMedia(input, "video");
}
