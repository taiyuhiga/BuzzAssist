import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  insertExcalidrawImage,
  insertExcalidrawMediaBatch,
  insertExcalidrawSubtitle,
  isSafeChildPath,
  normalizeScene,
  normalizeSubtitleCards,
  resolveCanvasDir,
  sanitizeFileName,
} from "../lib/canvasScene.mjs";

const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

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

test("SRT cards use the BuzzAssist portrait footprint instead of matching the anchor", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "excalidraw-srt-footprint-"));
  try {
    const canvasDir = join(projectDir, "canvas");
    await mkdir(canvasDir, { recursive: true });
    const scene = {
      type: "excalidraw",
      version: 2,
      source: "test",
      elements: [
        {
          id: "video-anchor",
          type: "image",
          x: 10,
          y: 20,
          width: 364,
          height: 205,
          isDeleted: false,
          customData: { codexMediaKind: "video" },
        },
      ],
      appState: { selectedElementIds: { "video-anchor": true } },
      files: {},
    };
    await writeFile(join(canvasDir, "excalidraw-selection.json"), JSON.stringify({ selectedElementIds: ["video-anchor"] }));
    await writeFile(join(canvasDir, "excalidraw-canvas.json"), JSON.stringify(scene));

    const result = await insertExcalidrawSubtitle({
      projectDir,
      srtText: "1\n00:00:00,000 --> 00:00:01,000\nテスト\n",
      fileName: "SRT1.srt",
    });

    assert.equal(result.bounds.width, 205);
    assert.equal(result.bounds.height, 364);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("generated images persist BuzzAssist-style numbered file names", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "excalidraw-image-name-"));
  try {
    const result = await insertExcalidrawImage({
      projectDir,
      mediaBuffer: ONE_BY_ONE_PNG,
      mimeType: "image/png",
    });
    const saved = JSON.parse(await readFile(join(projectDir, "canvas", "excalidraw-canvas.json"), "utf8"));
    const element = saved.elements.find((item) => item.id === result.elementId);

    assert.equal(result.fileName, "Image1.png");
    assert.equal(element.customData.codexMediaKind, "image");
    assert.equal(element.customData.codexFileName, "Image1.png");
    assert.equal(saved.files[result.fileId].name, "Image1.png");
    assert.equal(saved.files[result.fileId].dataURL, "/excalidraw-assets/Image1.png");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("batch images persist the same numbered file names in element and file metadata", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "excalidraw-batch-name-"));
  try {
    const [result] = await insertExcalidrawMediaBatch({
      projectDir,
      items: [{ kind: "image", mediaBuffer: ONE_BY_ONE_PNG, mimeType: "image/png" }],
    });
    const saved = JSON.parse(await readFile(join(projectDir, "canvas", "excalidraw-canvas.json"), "utf8"));
    const element = saved.elements.find((item) => item.id === result.elementId);

    assert.equal(result.fileName, "Image1.png");
    assert.equal(element.customData.codexMediaKind, "image");
    assert.equal(element.customData.codexFileName, "Image1.png");
    assert.equal(saved.files[result.fileId].name, "Image1.png");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("normalizeSubtitleCards fixes saved landscape and square SRT cards", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "excalidraw-srt-normalize-"));
  try {
    const canvasDir = join(projectDir, "canvas");
    await mkdir(canvasDir, { recursive: true });
    const scene = {
      type: "excalidraw",
      version: 2,
      source: "test",
      elements: [
        {
          id: "landscape-srt",
          type: "rectangle",
          x: 100,
          y: 200,
          width: 364,
          height: 205,
          isDeleted: false,
          customData: { codexGeneratedSubtitle: true, codexMediaKind: "subtitle" },
        },
        {
          id: "square-srt",
          type: "rectangle",
          x: 400,
          y: 600,
          width: 512,
          height: 512,
          isDeleted: false,
          customData: { codexGeneratedSubtitle: true, codexMediaKind: "subtitle" },
        },
      ],
      appState: {},
      files: {},
    };
    await writeFile(join(canvasDir, "excalidraw-canvas.json"), JSON.stringify(scene));

    const result = await normalizeSubtitleCards({ projectDir });
    const saved = JSON.parse(await readFile(join(canvasDir, "excalidraw-canvas.json"), "utf8"));

    assert.equal(result.normalized, 2);
    for (const element of saved.elements) {
      assert.equal(element.width, 205);
      assert.equal(element.height, 364);
      assert.equal(element.backgroundColor, "#faf8ff");
      assert.equal(element.strokeColor, "#d9d9d9");
    }
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
