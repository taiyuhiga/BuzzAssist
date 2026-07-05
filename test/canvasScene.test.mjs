import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isSafeChildPath, normalizeScene, resolveCanvasDir, sanitizeFileName } from "../lib/canvasScene.mjs";

test("resolveCanvasDir prefers explicit canvasDir", () => {
  assert.equal(resolveCanvasDir({ canvasDir: "/tmp/custom-canvas", projectDir: "/tmp/project" }), "/tmp/custom-canvas");
});

test("resolveCanvasDir maps projectDir to project canvas directory", () => {
  assert.equal(resolveCanvasDir({ projectDir: "/tmp/project" }), "/tmp/project/canvas");
});

test("sanitizeFileName preserves BuzzAssist-style display names", () => {
  assert.equal(sanitizeFileName("../bad name?.png", "fallback.png"), "bad name?.png");
  assert.equal(sanitizeFileName("2026年はPodcastの時代になる理由.mp4", "fallback.mp4"), "2026年はPodcastの時代になる理由.mp4");
  assert.equal(sanitizeFileName("folder\\clip.mp4", "fallback.mp4"), "folder_clip.mp4");
});

test("isSafeChildPath rejects parent traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "excalidraw-safe-"));
  try {
    assert.equal(isSafeChildPath(root, join(root, "assets", "image.png")), true);
    assert.equal(isSafeChildPath(root, join(root, "..", "image.png")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizeScene fills missing Excalidraw shape", () => {
  const scene = normalizeScene(null);
  assert.equal(scene.type, "excalidraw");
  assert.deepEqual(scene.elements, []);
  assert.deepEqual(scene.files, {});
});
