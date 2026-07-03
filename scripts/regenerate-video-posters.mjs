import { access } from "node:fs/promises";
import { extractVideoPosterDataURL, loadScene, saveScene } from "../lib/canvasScene.mjs";

const args = { projectDir: process.argv[2] || process.cwd() };
const scene = await loadScene(args);
let updated = 0;
let skipped = 0;

for (const element of scene.elements) {
  if (element?.isDeleted || element?.customData?.codexMediaKind !== "video" || !element.fileId) continue;
  const assetPath = element.customData?.codexAssetPath;
  const oldFileId = element.fileId;
  if (!assetPath || !scene.files?.[oldFileId]) {
    skipped += 1;
    continue;
  }
  try {
    await access(assetPath);
  } catch {
    skipped += 1;
    continue;
  }
  const posterDataURL = await extractVideoPosterDataURL({ path: assetPath });
  if (!posterDataURL) {
    console.warn(`poster extraction failed: ${assetPath}`);
    skipped += 1;
    continue;
  }
  // Excalidraw caches rendered images per fileId, so replace the fileId to
  // force connected browsers to re-render the new poster.
  const newFileId = `${oldFileId.replace(/_poster\d+$/, "")}_poster${Date.now() % 100000}`;
  delete scene.files[oldFileId];
  scene.files[newFileId] = {
    id: newFileId,
    mimeType: "image/jpeg",
    dataURL: posterDataURL,
    created: Date.now(),
    lastRetrieved: Date.now(),
  };
  element.fileId = newFileId;
  element.version = (Number(element.version) || 1) + 1;
  element.versionNonce = Math.floor(Math.random() * 2 ** 31);
  element.updated = Date.now();
  updated += 1;
  console.log(`updated poster for ${element.id} (${assetPath.split("/").pop()}) -> ${newFileId}`);
}

if (updated > 0) await saveScene(args, scene);
console.log(`done: ${updated} updated, ${skipped} skipped`);
