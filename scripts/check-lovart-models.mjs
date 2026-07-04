#!/usr/bin/env node
// Lovart has no live tools/models endpoint; the authoritative model list is
// the tool table in the official skill repo. This script diffs that list
// against ours so new Lovart models are caught early.
//
//   node scripts/check-lovart-models.mjs
import { LOVART_IMAGE_MODELS, LOVART_VIDEO_MODELS } from "../lib/lovartMediaGeneration.mjs";

const SKILL_URL = "https://raw.githubusercontent.com/lovartai/lovart-skill/main/skills/lovart-skill/SKILL.md";

const response = await fetch(SKILL_URL);
if (!response.ok) {
  console.error(`Failed to fetch SKILL.md (${response.status})`);
  process.exit(1);
}
const text = await response.text();
// Only trust the tool TABLE rows — prose examples sometimes use stale ids.
const documented = new Set(
  text
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|"))
    .flatMap((line) => [...line.matchAll(/generate_(?:image|video)_[a-z0-9_]+/g)].map((match) => match[0])),
);

const ours = new Set([...LOVART_IMAGE_MODELS, ...LOVART_VIDEO_MODELS].map((model) => model.tool));

const missingFromUs = [...documented].filter((tool) => !ours.has(tool)).sort();
const removedUpstream = [...ours].filter((tool) => !documented.has(tool)).sort();

console.log(`documented generate tools: ${documented.size}`);
console.log(`registered in this repo:   ${ours.size}`);
if (missingFromUs.length === 0 && removedUpstream.length === 0) {
  console.log("OK — model catalog matches the official Lovart skill docs.");
  process.exit(0);
}
if (missingFromUs.length > 0) {
  console.log(`\nNEW upstream tools not in our catalog (${missingFromUs.length}):`);
  for (const tool of missingFromUs) console.log(`  + ${tool}`);
}
if (removedUpstream.length > 0) {
  console.log(`\nOur tools no longer documented upstream (${removedUpstream.length}):`);
  for (const tool of removedUpstream) console.log(`  - ${tool}`);
}
process.exit(2);
