import test from "node:test";
import assert from "node:assert/strict";
import { reconcileElements } from "../lib/remoteCanvasRelayClient.mjs";

const el = (id, version, extra = {}) => ({ id, version, versionNonce: 1, ...extra });

test("higher incoming version wins (mobile moved an element)", () => {
  const local = [el("a", 3, { x: 0 }), el("b", 5)];
  const incoming = [el("a", 4, { x: 200 })];
  const merged = reconcileElements(local, incoming);
  const a = merged.find((e) => e.id === "a");
  assert.equal(a.version, 4);
  assert.equal(a.x, 200);
  assert.ok(merged.find((e) => e.id === "b"), "local-only element is preserved");
});

test("lower/equal incoming version does not clobber a newer local edit", () => {
  const local = [el("a", 9, { x: 1 })];
  const incoming = [el("a", 4, { x: 999 })];
  const merged = reconcileElements(local, incoming);
  assert.equal(merged.find((e) => e.id === "a").x, 1, "desktop's newer version wins");
});

test("equal version breaks ties by the larger versionNonce", () => {
  const local = [{ id: "a", version: 7, versionNonce: 10, x: 1 }];
  const incoming = [{ id: "a", version: 7, versionNonce: 20, x: 2 }];
  const merged = reconcileElements(local, incoming);
  assert.equal(merged.find((e) => e.id === "a").x, 2);
});

test("new incoming elements are added", () => {
  const merged = reconcileElements([el("a", 1)], [el("z", 1)]);
  assert.deepEqual(merged.map((e) => e.id).sort(), ["a", "z"]);
});

test("deletion travels as an isDeleted element with a bumped version", () => {
  const local = [el("a", 2, { isDeleted: false })];
  const incoming = [el("a", 3, { isDeleted: true })];
  const merged = reconcileElements(local, incoming);
  assert.equal(merged.find((e) => e.id === "a").isDeleted, true);
});

test("malformed inputs are ignored safely", () => {
  assert.deepEqual(reconcileElements(null, null), []);
  assert.deepEqual(reconcileElements([el("a", 1)], [{ noId: true }, null]).map((e) => e.id), ["a"]);
});
