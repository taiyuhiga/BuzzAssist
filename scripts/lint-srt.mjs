#!/usr/bin/env node
// SRT quality linter: run the same validations as the generator (line length,
// line count, cue duration, overlap, reading speed) plus Japanese 禁則 checks
// against any .srt file — including hand-edited or externally produced ones.
// Usage: node scripts/lint-srt.mjs <file.srt> [--max-chars 30] [--line-count 2]
import { readFile } from "node:fs/promises";
import { validateSubtitleLines } from "../lib/subtitleGeneration.mjs";

const args = process.argv.slice(2);
const filePath = args.find((arg) => !arg.startsWith("--"));
if (!filePath) {
  console.error("Usage: node scripts/lint-srt.mjs <file.srt> [--max-chars 30] [--line-count 2]");
  process.exit(2);
}
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? Number(args[index + 1]) : NaN;
  return Number.isFinite(value) ? value : fallback;
};
const maxChars = flag("max-chars", 30);
const lineCount = flag("line-count", 2);

function parseTimestamp(value) {
  const match = String(value).trim().match(/^(\d+):(\d\d):(\d\d)[,.](\d{1,3})$/);
  if (!match) return NaN;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, "0")) / 1000;
}

function parseSrt(text) {
  const cues = [];
  for (const block of text.replace(/\r\n?/g, "\n").split(/\n\n+/)) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    if (lines.length < 2) continue;
    const timeLineIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeLineIndex < 0) continue;
    const [startRaw, endRaw] = lines[timeLineIndex].split("-->");
    const start = parseTimestamp(startRaw);
    const end = parseTimestamp(endRaw);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    cues.push({ start, end, text: lines.slice(timeLineIndex + 1).join("\n") });
  }
  return cues;
}

// 行頭に来てはいけない文字（小書き・長音・閉じ括弧・句読点）と、行末に来て
// はいけない文字（開き括弧）。
const FORBIDDEN_LINE_START = /^[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮー々、。，．！？!?）」』】］〕〉》\)\]]/;
const FORBIDDEN_LINE_END = /[「『（(［【〔〈《\(\[]$/;

const srtText = await readFile(filePath, "utf8");
const cues = parseSrt(srtText);
if (cues.length === 0) {
  console.error("No cues parsed — is this a valid SRT file?");
  process.exit(2);
}

const issues = validateSubtitleLines(cues, { maxChars, lineCount });
cues.forEach((cue, index) => {
  cue.text.split("\n").forEach((line) => {
    if (FORBIDDEN_LINE_START.test(line)) {
      issues.push({ index, type: "kinsoku_line_start", detail: JSON.stringify(line.slice(0, 6)) });
    }
    if (FORBIDDEN_LINE_END.test(line)) {
      issues.push({ index, type: "kinsoku_line_end", detail: JSON.stringify(line.slice(-6)) });
    }
  });
  const next = cues[index + 1];
  if (next && next.start - cue.end > 0 && next.start - cue.end < 0.05) {
    issues.push({ index, type: "gap_too_small", detail: `${Math.round((next.start - cue.end) * 1000)}ms` });
  }
});

console.log(`${filePath}: ${cues.length} cues, maxChars=${maxChars}, lineCount=${lineCount}`);
if (issues.length === 0) {
  console.log("no issues found");
  process.exit(0);
}
issues.sort((a, b) => a.index - b.index);
for (const issue of issues) {
  const cue = cues[issue.index];
  const at = cue ? `${cue.start.toFixed(2)}s` : "-";
  const preview = cue ? cue.text.replace(/\n/g, "｜").slice(0, 28) : "";
  console.log(`#${issue.index + 1} ${at} ${issue.type} (${issue.detail}) ${preview}`);
}
console.log(`${issues.length} issue(s)`);
process.exit(1);
