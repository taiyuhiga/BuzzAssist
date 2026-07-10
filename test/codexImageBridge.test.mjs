import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { resolveCodexCommand } from "../scripts/codex-image-bridge.mjs";

test("Codex image bridge auto-detects a usable Codex client", async () => {
  const command = await resolveCodexCommand();
  assert.equal(typeof command, "string");
  assert.ok(command === "codex" || /(?:ChatGPT|Codex)\.app/.test(command));
});

test("explicit CODEX_COMMAND remains the highest-priority override", async () => {
  const previous = process.env.CODEX_COMMAND;
  process.env.CODEX_COMMAND = "/custom/codex";
  try {
    assert.equal(await resolveCodexCommand(), "/custom/codex");
  } finally {
    if (previous === undefined) delete process.env.CODEX_COMMAND;
    else process.env.CODEX_COMMAND = previous;
  }
});

test("ChatGPT desktop bundled Codex works without a separately installed CLI on macOS", async (t) => {
  if (process.platform !== "darwin") return t.skip("macOS-only bundled app path");
  const previousCommand = process.env.CODEX_COMMAND;
  const previousPath = process.env.PATH;
  delete process.env.CODEX_COMMAND;
  process.env.PATH = "/usr/bin:/bin";
  try {
    const command = await resolveCodexCommand();
    assert.match(command, /ChatGPT\.app\/Contents\/Resources\/codex$/);
  } finally {
    if (previousCommand === undefined) delete process.env.CODEX_COMMAND;
    else process.env.CODEX_COMMAND = previousCommand;
    process.env.PATH = previousPath;
  }
});

test("agent setup reuses the same ChatGPT/Codex auto-detection", async () => {
  const source = await readFile(new URL("../scripts/setup-agents.mjs", import.meta.url), "utf8");
  assert.match(source, /import \{ resolveCodexCommand \} from "\.\/codex-image-bridge\.mjs"/);
  assert.match(source, /codex = dryRun \? commandName\("codex"\) : await resolveCodexCommand\(\)/);
  assert.doesNotMatch(source, /Codex CLI was not found/);
});
