// Runway developer API client (https://docs.dev.runwayml.com).
// Auth: Bearer API secret from RUNWAYML_API_SECRET / RUNWAY_API_KEY or
// ~/.runway/credentials.json ({"api_secret": "..."}, 0600).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const RUNWAY_API_BASE = "https://api.dev.runwayml.com/v1";
const RUNWAY_VERSION_HEADER = "2024-11-06";
const RUNWAY_CREDENTIALS_FILE = join(homedir(), ".runway", "credentials.json");
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

export const RUNWAY_IMAGE_MODELS = [
  { id: "runway-gen4-image", label: "Runway Gen-4 Image", provider: "runway", apiModel: "gen4_image" },
];

export const RUNWAY_VIDEO_MODELS = [
  { id: "runway-gen4-5", label: "Runway Gen-4.5", provider: "runway", apiModel: "gen4.5" },
];

export function isRunwayImageModel(model) {
  return RUNWAY_IMAGE_MODELS.some((entry) => entry.id === model);
}

export function isRunwayVideoModel(model) {
  return RUNWAY_VIDEO_MODELS.some((entry) => entry.id === model);
}

// Runway takes exact pixel-pair ratios, not aspect labels.
const RUNWAY_IMAGE_RATIOS = {
  "16:9": "1920:1080",
  "9:16": "1080:1920",
  "1:1": "1024:1024",
  "4:3": "1440:1080",
  "3:4": "1080:1440",
  "21:9": "1808:768",
};

const RUNWAY_VIDEO_RATIOS = {
  "16:9": "1280:720",
  "9:16": "720:1280",
  "1:1": "960:960",
  "4:3": "1104:832",
  "3:4": "832:1104",
  "21:9": "1584:672",
};

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

async function readStoredApiSecret() {
  try {
    const parsed = JSON.parse(await readFile(RUNWAY_CREDENTIALS_FILE, "utf8"));
    return nonEmptyString(parsed.api_secret) || nonEmptyString(parsed.apiSecret);
  } catch {
    return "";
  }
}

async function resolveApiSecret() {
  return (
    nonEmptyString(process.env.RUNWAYML_API_SECRET) ||
    nonEmptyString(process.env.RUNWAY_API_KEY) ||
    (await readStoredApiSecret())
  );
}

export async function getRunwayAuthStatus() {
  const secret = await resolveApiSecret();
  return {
    configured: Boolean(secret),
    keyPreview: secret ? `${secret.slice(0, 6)}…${secret.slice(-4)}` : null,
    credentialsFile: RUNWAY_CREDENTIALS_FILE,
  };
}

export async function saveRunwayCredentials({ apiSecret }) {
  const secret = nonEmptyString(apiSecret);
  if (!secret) throw new Error("Runway API secret is required.");
  await mkdir(dirname(RUNWAY_CREDENTIALS_FILE), { recursive: true });
  await writeFile(RUNWAY_CREDENTIALS_FILE, `${JSON.stringify({ api_secret: secret }, null, 2)}\n`, { mode: 0o600 });
  return getRunwayAuthStatus();
}

async function runwayFetch(path, { method = "GET", body } = {}) {
  const secret = await resolveApiSecret();
  if (!secret) {
    throw new Error(
      "Runway APIキーが未設定です。実行先メニューのRunwayキー入力か、RUNWAYML_API_SECRET 環境変数で設定してください。",
    );
  }
  const response = await fetch(`${RUNWAY_API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${secret}`,
      "x-runway-version": RUNWAY_VERSION_HEADER,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Runway APIキーが無効です (401)。dev.runwayml.com で発行したシークレットを設定し直してください。");
    }
    const detail = payload.error || payload.message || text || `HTTP ${response.status}`;
    throw new Error(`Runway API error (${response.status}): ${String(detail).slice(0, 300)}`);
  }
  return payload;
}

async function pollRunwayTask(taskId) {
  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      throw new Error(`Runway task ${taskId} timed out after ${Math.round(POLL_TIMEOUT_MS / 60000)} minutes.`);
    }
    const task = await runwayFetch(`/tasks/${taskId}`);
    const status = String(task.status || "").toUpperCase();
    if (status === "SUCCEEDED") {
      const output = Array.isArray(task.output) ? task.output.find((item) => typeof item === "string") : null;
      if (!output) throw new Error("Runway task succeeded but returned no output URL.");
      return output;
    }
    if (status === "FAILED" || status === "CANCELLED") {
      const reason = task.failure || task.failureCode || task.error || "unknown reason";
      throw new Error(`Runway task ${status.toLowerCase()}: ${String(reason).slice(0, 300)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function downloadRunwayOutput(url, fallbackMime) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download Runway output (${response.status}).`);
  const mimeType = response.headers.get("content-type")?.split(";")[0] || fallbackMime;
  return { buffer: Buffer.from(await response.arrayBuffer()), mimeType, source: url };
}

async function toDataUri(input) {
  if (!input) return "";
  if (typeof input !== "string") return "";
  if (input.startsWith("data:") || input.startsWith("http")) return input;
  // treat as a local file path
  const buffer = await readFile(input);
  const ext = input.toLowerCase();
  const mime = ext.endsWith(".png") ? "image/png" : ext.endsWith(".webp") ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

export async function generateRunwayImageMedia(input = {}) {
  const entry = RUNWAY_IMAGE_MODELS.find((model) => model.id === input.model) ?? RUNWAY_IMAGE_MODELS[0];
  const prompt = nonEmptyString(input.prompt);
  if (!prompt) throw new Error("Runway image generation requires a prompt.");

  const referenceSources = [
    ...(Array.isArray(input.referenceImagePaths) ? input.referenceImagePaths : []),
    ...(Array.isArray(input.referenceImages) ? input.referenceImages : []),
  ].slice(0, 3);
  const referenceImages = [];
  for (const [index, source] of referenceSources.entries()) {
    const uri = await toDataUri(source);
    if (uri) referenceImages.push({ uri, tag: `ref${index + 1}` });
  }

  const body = {
    model: entry.apiModel,
    promptText: prompt,
    ratio: RUNWAY_IMAGE_RATIOS[input.aspectRatio] ?? RUNWAY_IMAGE_RATIOS["1:1"],
    ...(referenceImages.length > 0 ? { referenceImages } : {}),
  };
  const task = await runwayFetch("/text_to_image", { method: "POST", body });
  const outputUrl = await pollRunwayTask(task.id);
  const media = await downloadRunwayOutput(outputUrl, "image/png");
  return {
    kind: "image",
    model: entry.id,
    mimeType: media.mimeType,
    buffer: media.buffer,
    fileName: input.fileName || `runway-${Date.now()}.png`,
    source: media.source,
  };
}

export async function generateRunwayVideoMedia(input = {}) {
  const entry = RUNWAY_VIDEO_MODELS.find((model) => model.id === input.model) ?? RUNWAY_VIDEO_MODELS[0];
  const prompt = nonEmptyString(input.prompt);
  if (!prompt) throw new Error("Runway video generation requires a prompt.");

  const parsedDuration = Number.parseInt(String(input.duration ?? "5"), 10);
  const duration = Number.isFinite(parsedDuration) && parsedDuration > 7 ? 10 : 5;
  const promptImage = await toDataUri(input.startFramePath || input.imageUrl);
  const body = {
    model: entry.apiModel,
    promptText: prompt,
    ratio: RUNWAY_VIDEO_RATIOS[input.aspectRatio] ?? RUNWAY_VIDEO_RATIOS["16:9"],
    duration,
    ...(promptImage ? { promptImage } : {}),
  };
  // Image-to-video when a start frame exists; text-to-video otherwise.
  const path = promptImage ? "/image_to_video" : "/text_to_video";
  const task = await runwayFetch(path, { method: "POST", body });
  const outputUrl = await pollRunwayTask(task.id);
  const media = await downloadRunwayOutput(outputUrl, "video/mp4");
  return {
    kind: "video",
    model: entry.id,
    mimeType: media.mimeType,
    buffer: media.buffer,
    fileName: input.fileName || `runway-${Date.now()}.mp4`,
    source: media.source,
  };
}
