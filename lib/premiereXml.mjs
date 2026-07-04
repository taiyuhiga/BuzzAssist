// Minimal FCP7 xmeml (Premiere Pro interchange) reader/writer for jet-cut
// timelines. Scope: single-sequence files with one video track (plus audio
// tracks that reference the same media), which is what a rough talk-video
// cut looks like. Nested sequences, transitions, and effects are out of
// scope and rejected with a clear error.
import { fileURLToPath, pathToFileURL } from "node:url";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function decodeXmlEntities(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function encodeXmlEntities(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function pathUrlToFilePath(pathurl) {
  const raw = nonEmptyString(pathurl);
  if (!raw) return "";
  try {
    // Premiere writes file://localhost/Users/... — strip the localhost host.
    const normalized = raw.replace(/^file:\/\/localhost\//i, "file:///");
    return fileURLToPath(normalized);
  } catch {
    return "";
  }
}

export function filePathToPathUrl(filePath) {
  return pathToFileURL(filePath).href.replace(/^file:\/\/\//i, "file://localhost/");
}

// Standard NLE frame rates: map a probed fps to timebase + ntsc flag.
export function fpsToTimebase(fps) {
  const value = Number(fps);
  if (!Number.isFinite(value) || value <= 0) return { timebase: 30, ntsc: true };
  const candidates = [
    { timebase: 24, ntsc: true, fps: 24000 / 1001 },
    { timebase: 24, ntsc: false, fps: 24 },
    { timebase: 25, ntsc: false, fps: 25 },
    { timebase: 30, ntsc: true, fps: 30000 / 1001 },
    { timebase: 30, ntsc: false, fps: 30 },
    { timebase: 50, ntsc: false, fps: 50 },
    { timebase: 60, ntsc: true, fps: 60000 / 1001 },
    { timebase: 60, ntsc: false, fps: 60 },
  ];
  let best = candidates[0];
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate.fps - value);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return { timebase: best.timebase, ntsc: best.ntsc };
}

export function effectiveFps(timebase, ntsc) {
  return ntsc ? (timebase * 1000) / 1001 : timebase;
}

function matchTag(source, tag) {
  const match = source.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1] : "";
}

// xmeml nests same-named tags (<file> contains <media><video>…), so the
// sequence-level <video>/<audio> blocks need depth-aware extraction.
function balancedTagRange(source, tag) {
  const pattern = new RegExp(`<${tag}(?=[\\s>])[^>]*>|<\\/${tag}>`, "gi");
  let depth = 0;
  let contentStart = -1;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const isClose = match[0].startsWith("</");
    if (!isClose) {
      if (depth === 0) contentStart = match.index + match[0].length;
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0 && contentStart >= 0) {
        return { content: source.slice(contentStart, match.index), endIndex: match.index + match[0].length };
      }
    }
  }
  return { content: "", endIndex: -1 };
}

function balancedTagContent(source, tag) {
  return balancedTagRange(source, tag).content;
}

function matchAllTags(source, tag) {
  return [...source.matchAll(new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi"))];
}

function readNumberTag(source, tag, fallback = 0) {
  const value = Number.parseFloat(matchTag(source, tag));
  return Number.isFinite(value) ? value : fallback;
}

// Parse the subset of xmeml we support. Throws user-readable errors for
// out-of-scope structures.
export function parseXmeml(xmlText) {
  const text = String(xmlText ?? "");
  if (!/<xmeml/i.test(text)) {
    throw new Error("Premiere XML (xmeml) ではないファイルです。Premiere Proの「Final Cut Pro XML書き出し」形式を使ってください。");
  }
  const sequences = matchAllTags(text, "sequence");
  if (sequences.length === 0) {
    throw new Error("XML内にシーケンスが見つかりませんでした。");
  }
  const sequence = sequences[0][2];
  const name = decodeXmlEntities(matchTag(sequence, "name")) || "Sequence";
  const rateBlock = matchTag(sequence, "rate");
  const timebase = readNumberTag(rateBlock, "timebase", 30) || 30;
  const ntsc = /<ntsc>\s*TRUE\s*<\/ntsc>/i.test(rateBlock);
  const fps = effectiveFps(timebase, ntsc);

  const mediaBlock = balancedTagContent(sequence, "media");
  const videoRange = balancedTagRange(mediaBlock, "video");
  const videoBlock = videoRange.content;
  // The sequence-level <audio> comes AFTER the video block; earlier <audio>
  // occurrences belong to nested <file><media> definitions.
  const audioBlock = videoRange.endIndex >= 0
    ? balancedTagContent(mediaBlock.slice(videoRange.endIndex), "audio")
    : balancedTagContent(mediaBlock, "audio");
  const formatBlock = matchTag(videoBlock, "format");
  const width = readNumberTag(formatBlock, "width", 1920) || 1920;
  const height = readNumberTag(formatBlock, "height", 1080) || 1080;

  // file elements may be defined once and referenced by id afterwards
  const filesById = new Map();
  const parseClipItems = (trackBlock) => {
    const clips = [];
    for (const [, , clipBlock] of matchAllTags(trackBlock, "clipitem")) {
      const fileMatch = clipBlock.match(/<file\s+id="([^"]+)"\s*(\/>|>([\s\S]*?)<\/file>)/i);
      let fileId = "";
      let filePath = "";
      let fileDurationFrames = 0;
      if (fileMatch) {
        fileId = fileMatch[1];
        const fileBody = fileMatch[3] || "";
        if (fileBody) {
          const pathurl = matchTag(fileBody, "pathurl");
          filePath = pathUrlToFilePath(decodeXmlEntities(pathurl));
          fileDurationFrames = readNumberTag(fileBody, "duration", 0);
          filesById.set(fileId, { path: filePath, durationFrames: fileDurationFrames });
        } else if (filesById.has(fileId)) {
          const known = filesById.get(fileId);
          filePath = known.path;
          fileDurationFrames = known.durationFrames;
        }
      }
      const inFrames = readNumberTag(clipBlock, "in", 0);
      const outFrames = readNumberTag(clipBlock, "out", 0);
      const startFrames = readNumberTag(clipBlock, "start", 0);
      const endFrames = readNumberTag(clipBlock, "end", 0);
      if (outFrames <= inFrames) continue;
      clips.push({
        name: decodeXmlEntities(matchTag(clipBlock, "name")) || "clip",
        fileId,
        filePath,
        fileDurationFrames,
        inSeconds: inFrames / fps,
        outSeconds: outFrames / fps,
        startSeconds: startFrames / fps,
        endSeconds: endFrames / fps,
      });
    }
    return clips;
  };

  const videoTracks = matchAllTags(videoBlock, "track")
    .map(([, , trackBlock]) => parseClipItems(trackBlock))
    .filter((clips) => clips.length > 0);
  if (videoTracks.length === 0) {
    throw new Error("XML内にクリップの載った映像トラックが見つかりませんでした。");
  }
  if (videoTracks.length > 1) {
    throw new Error("映像トラックが複数あるXMLは初版では未対応です（1トラックのシーケンスで書き出してください）。");
  }
  const audioTracks = matchAllTags(audioBlock, "track")
    .map(([, , trackBlock]) => parseClipItems(trackBlock))
    .filter((clips) => clips.length > 0);

  const clips = videoTracks[0].slice().sort((a, b) => a.startSeconds - b.startSeconds);
  for (const clip of clips) {
    if (!clip.filePath) {
      throw new Error(`クリップ「${clip.name}」の参照メディアパス（pathurl）が読めませんでした。`);
    }
  }
  return { name, timebase, ntsc, fps, width, height, clips, audioTrackCount: audioTracks.length };
}

// Serialize a sequential jet-cut timeline: one video track + one stereo audio
// track, clips laid end to end. `clips`: [{ name, path, inSeconds,
// outSeconds, fileDurationSeconds }].
export function buildXmeml({ name, timebase, ntsc, width, height, clips }) {
  const fps = effectiveFps(timebase, ntsc);
  const toFrames = (seconds) => Math.max(0, Math.round(seconds * fps));
  const ntscText = ntsc ? "TRUE" : "FALSE";
  const rateXml = `<rate><timebase>${timebase}</timebase><ntsc>${ntscText}</ntsc></rate>`;

  const fileIdByPath = new Map();
  let cursorFrames = 0;
  const videoItems = [];
  const audioItems = [];
  const fileXmlEmitted = new Set();
  clips.forEach((clip, index) => {
    const inFrames = toFrames(clip.inSeconds);
    const outFrames = Math.max(inFrames + 1, toFrames(clip.outSeconds));
    const lengthFrames = outFrames - inFrames;
    const startFrames = cursorFrames;
    const endFrames = startFrames + lengthFrames;
    cursorFrames = endFrames;
    if (!fileIdByPath.has(clip.path)) fileIdByPath.set(clip.path, `file-${fileIdByPath.size + 1}`);
    const fileId = fileIdByPath.get(clip.path);
    const fileDurationFrames = toFrames(clip.fileDurationSeconds || clip.outSeconds);
    const clipName = encodeXmlEntities(clip.name || `clip-${index + 1}`);
    const fileXml = fileXmlEmitted.has(fileId)
      ? `<file id="${fileId}"/>`
      : `<file id="${fileId}"><name>${clipName}</name><pathurl>${encodeXmlEntities(filePathToPathUrl(clip.path))}</pathurl>${rateXml}<duration>${fileDurationFrames}</duration><media><video><samplecharacteristics><width>${width}</width><height>${height}</height></samplecharacteristics></video><audio><channelcount>2</channelcount></audio></media></file>`;
    fileXmlEmitted.add(fileId);
    const common = `<duration>${fileDurationFrames}</duration>${rateXml}<start>${startFrames}</start><end>${endFrames}</end><in>${inFrames}</in><out>${outFrames}</out>`;
    videoItems.push(
      `<clipitem id="clipitem-v-${index + 1}"><name>${clipName}</name><enabled>TRUE</enabled>${common}${fileXml}</clipitem>`,
    );
    audioItems.push(
      `<clipitem id="clipitem-a-${index + 1}"><name>${clipName}</name><enabled>TRUE</enabled>${common}<file id="${fileId}"/><sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack></clipitem>`,
    );
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!DOCTYPE xmeml>",
    '<xmeml version="4">',
    `<sequence id="sequence-1"><name>${encodeXmlEntities(name)}</name><duration>${cursorFrames}</duration>${rateXml}<media>`,
    `<video><format><samplecharacteristics><width>${width}</width><height>${height}</height>${rateXml}</samplecharacteristics></format><track>${videoItems.join("")}</track></video>`,
    `<audio><track>${audioItems.join("")}</track></audio>`,
    "</media></sequence>",
    "</xmeml>",
    "",
  ].join("\n");
}

// Subtract source-time cut ranges from each timeline clip, preserving clip
// order. Returns the new sequential clip list for buildXmeml.
export function applyCutRangesToClips(clips, cutRangesByPath, minClipSeconds = 0.08) {
  const kept = [];
  for (const clip of clips) {
    const cuts = (cutRangesByPath.get(clip.filePath) || [])
      .filter((range) => range.end > clip.inSeconds && range.start < clip.outSeconds)
      .sort((a, b) => a.start - b.start);
    let cursor = clip.inSeconds;
    for (const cut of cuts) {
      const cutStart = Math.max(clip.inSeconds, cut.start);
      const cutEnd = Math.min(clip.outSeconds, cut.end);
      if (cutStart - cursor >= minClipSeconds) {
        kept.push({ ...clip, inSeconds: cursor, outSeconds: cutStart });
      }
      cursor = Math.max(cursor, cutEnd);
    }
    if (clip.outSeconds - cursor >= minClipSeconds) {
      kept.push({ ...clip, inSeconds: cursor, outSeconds: clip.outSeconds });
    }
  }
  return kept;
}
