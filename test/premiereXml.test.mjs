import test from "node:test";
import assert from "node:assert/strict";
import { applyCutRangesToClips, buildXmeml, effectiveFps, fpsToTimebase, parseXmeml } from "../lib/premiereXml.mjs";

test("fpsToTimebase maps 29.97 to NTSC 30", () => {
  assert.deepEqual(fpsToTimebase(29.97), { timebase: 30, ntsc: true });
  assert.equal(Math.round(effectiveFps(30, true) * 1000) / 1000, 29.97);
});

test("buildXmeml and parseXmeml round trip a single clip", () => {
  const xml = buildXmeml({
    name: "Cut",
    timebase: 30,
    ntsc: false,
    width: 1920,
    height: 1080,
    clips: [
      {
        name: "clip",
        path: "/tmp/source.mp4",
        inSeconds: 0,
        outSeconds: 10,
        startSeconds: 0,
        endSeconds: 10,
      },
    ],
  });
  const parsed = parseXmeml(xml);
  assert.equal(parsed.name, "Cut");
  assert.equal(parsed.clips.length, 1);
  assert.equal(parsed.clips[0].outSeconds, 10);
});

test("applyCutRangesToClips removes cut ranges and preserves timeline order", () => {
  const clips = [
    {
      name: "clip",
      filePath: "/tmp/source.mp4",
      path: "/tmp/source.mp4",
      inSeconds: 0,
      outSeconds: 10,
      startSeconds: 0,
      endSeconds: 10,
    },
  ];
  const result = applyCutRangesToClips(clips, new Map([["/tmp/source.mp4", [{ start: 2, end: 4 }]]]));
  assert.equal(result.length, 2);
  assert.equal(result[0].inSeconds, 0);
  assert.equal(result[0].outSeconds, 2);
  assert.equal(result[1].inSeconds, 4);
  assert.equal(result[1].outSeconds, 10);
});
