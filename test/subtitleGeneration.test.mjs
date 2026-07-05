import test from "node:test";
import assert from "node:assert/strict";
import { applySubtitleGlossary, formatSrtTimestamp, renderSrt, splitSubtitleLines } from "../lib/subtitleGeneration.mjs";

test("formatSrtTimestamp renders millisecond SRT timestamps", () => {
  assert.equal(formatSrtTimestamp(65.4321), "00:01:05,432");
});

test("renderSrt writes numbered cues", () => {
  const srt = renderSrt([{ start: 0, end: 1.2, text: "こんにちは" }]);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,200\nこんにちは/m);
});

test("splitSubtitleLines respects max chars", () => {
  const lines = splitSubtitleLines("これは長い、字幕テキストです", 2, 10).split("\n");
  assert.ok(lines.length <= 2);
  assert.ok(lines.every((line) => line.length <= 10));
});

test("applySubtitleGlossary updates text and word entries", () => {
  const result = applySubtitleGlossary("バズアシを使う", [{ text: "バズアシ", start: 0, end: 1 }], [{ from: "バズアシ", to: "BuzzAssist" }]);
  assert.equal(result.text, "BuzzAssistを使う");
  assert.equal(result.words[0].text, "BuzzAssist");
});
