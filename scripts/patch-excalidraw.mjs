// Port of Youtube-AGI's patch-excalidraw-bundle.sh selection-visual patches,
// applied to node_modules/@excalidraw/excalidraw dist (dev + prod builds):
// 1. selected-element border width 1px -> 3px
// 2. selection padding -> 0 (border touches the element edge)
// 3. transform-handle margin -> 0 (handles sit on the selection line)
// 4. explicit zero handle offset for the void-0 call sites
// 5. always omit side handles (four corner handles on every device)
import { readFile, readdir, writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(repoRoot, "node_modules", "@excalidraw", "excalidraw", "dist");

const PATCHES = [
  {
    name: "selection border 3px",
    apply(source) {
      return source
        .replace(/(lineWidth = \(activeEmbeddable \? 4 : )1(\) \/ appState\.zoom\.value)/g, "$13$2")
        .replace(/(lineWidth=\([A-Za-z_$][\w$]*\?4:)1(\)\/[A-Za-z_$][\w$]*\.zoom\.value)/g, "$13$2");
    },
    applied: (source) => /lineWidth = \(activeEmbeddable \? 4 : 3\)/.test(source) || /lineWidth=\([A-Za-z_$][\w$]*\?4:3\)/.test(source),
  },
  {
    name: "selection padding 0",
    apply(source) {
      return source
        .replace(/padding \?\? DEFAULT_TRANSFORM_HANDLE_SPACING \* 2/g, "padding ?? 0")
        .replace(/padding\?\?[A-Za-z_$][\w$]*\*2\)/g, "padding??0)");
    },
    applied: (source) => /padding \?\? 0/.test(source) || /padding\?\?0\)/.test(source),
  },
  {
    name: "handle margin 0",
    apply(source) {
      return source
        .replace(/\? 0 : DEFAULT_TRANSFORM_HANDLE_SPACING;/g, "? 0 : 0;")
        .replace(/\?0:[A-Za-z_$][\w$]*;return/g, "?0:0;return");
    },
    applied: (source) => /\? 0 : 0;/.test(source) || /\?0:0;return/.test(source),
  },
  {
    name: "handle explicit zero offset",
    apply(source) {
      return source
        .replace(/isImageElement\(element\) \? 0 : void 0/g, "0")
        .replace(/,[A-Za-z_$][\w$]*\(e\)\?0:void 0\)/g, ",0)");
    },
    applied: () => true,
  },
  {
    name: "corner-only handles",
    apply(source) {
      return source
        .replace(
          /var getOmitSidesForDevice = \(device\) => \{\s*if \(canResizeFromSides\(device\)\) \{\s*return DEFAULT_OMIT_SIDES;\s*\}\s*return \{\};\s*\};/g,
          "var getOmitSidesForDevice = (device) => DEFAULT_OMIT_SIDES;",
        )
        .replace(
          /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)=>([A-Za-z_$][\w$]*)\(\2\)\?([A-Za-z_$][\w$]*):\{\}/g,
          "$1=$2=>$4",
        );
    },
    applied: (source) => /getOmitSidesForDevice = \(device\) => DEFAULT_OMIT_SIDES;/.test(source),
  },
];

let patchedFiles = 0;
const patchCounts = new Map(PATCHES.map((patch) => [patch.name, 0]));

for (const build of ["dev", "prod"]) {
  const buildDir = join(distRoot, build);
  let entries;
  try {
    entries = await readdir(buildDir);
  } catch {
    continue;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".js") || entry.endsWith(".map")) continue;
    const filePath = join(buildDir, entry);
    const original = await readFile(filePath, "utf8");
    let source = original;
    for (const patch of PATCHES) {
      const next = patch.apply(source);
      if (next !== source) patchCounts.set(patch.name, patchCounts.get(patch.name) + 1);
      source = next;
    }
    if (source !== original) {
      await writeFile(filePath, source);
      patchedFiles += 1;
      console.log(`patched ${build}/${entry}`);
    }
  }
}

for (const [name, count] of patchCounts) {
  console.log(`${name}: ${count} file(s)`);
}

const combined = await Promise.all(
  ["dev", "prod"].map(async (build) => {
    try {
      const entries = await readdir(join(distRoot, build));
      const sources = await Promise.all(
        entries.filter((entry) => entry.endsWith(".js")).map((entry) => readFile(join(distRoot, build, entry), "utf8")),
      );
      return sources.join("\n");
    } catch {
      return "";
    }
  }),
).then((parts) => parts.join("\n"));

const missing = PATCHES.filter((patch) => !patch.applied(combined));
if (missing.length > 0) {
  console.error(`WARNING: patches not verified: ${missing.map((patch) => patch.name).join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(patchedFiles > 0 ? "all patches verified" : "already patched — nothing to do");
}

await rm(join(repoRoot, "node_modules", ".vite"), { recursive: true, force: true }).catch(() => {});
