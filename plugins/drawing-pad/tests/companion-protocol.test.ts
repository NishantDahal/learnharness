import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyOp, cleanName, fromWire, isDocId, isId, isToken, LIMITS, parseClientMessage, parseDocSnapshot, parseOp,
  parseOpMessage, parseWireStroke, PROTOCOL_VERSION, toWire, validPoints, type DocSnapshot, type WireStroke,
} from "../src/companion/protocol.ts";
import {
  clampScale, companionCamera, fitScale, MAX_SCALE, MIN_SCALE, screenToWorld, worldToScreen, zoomPan, type Camera,
} from "../src/companion/camera.ts";
import type { Stroke } from "../src/strokes.ts";

const TOKEN = "abcdefghijklmnop_0123-XYZ";
const wire = (id = "s1", pts: number[] = [1, 2, 0.5, 3, 4, 1]): WireStroke => ({ id, tool: "pen", size: 1, pts });
const msg = (value: unknown) => parseClientMessage(JSON.stringify(value));
const snapshot = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "win-1:session.a:0", rev: 0, kind: "teaching", label: "Question", width: 500, height: 400,
  background: "data:image/png;base64,AAAA", backgroundColor: "#141414", mode: "dark", strokes: [wire()], redo: 0, ...over,
});

describe("id / token validators", () => {
  it("isId accepts 1..64 url-safe chars only", () => {
    assert.equal(isId("a"), true); assert.equal(isId("A_z-9"), true); assert.equal(isId("x".repeat(64)), true);
    for (const bad of ["", "x".repeat(65), "a b", "a.b", "a/b", "é", 5, null, undefined]) assert.equal(isId(bad), false, String(bad));
  });
  it("isDocId allows . and : up to 200 chars", () => {
    assert.equal(isDocId("win:1.sess-a_b"), true); assert.equal(isDocId("d".repeat(200)), true);
    for (const bad of ["", "d".repeat(201), "a b", "a/b", "a\nb", 1]) assert.equal(isDocId(bad), false, String(bad));
  });
  it("isToken requires 16..128 url-safe chars", () => {
    assert.equal(isToken("a".repeat(16)), true); assert.equal(isToken("a".repeat(128)), true);
    for (const bad of ["a".repeat(15), "a".repeat(129), "a".repeat(15) + ".", "a".repeat(16) + "=", 16]) assert.equal(isToken(bad), false);
  });
});

describe("validPoints", () => {
  it("accepts finite triples within bounds", () => {
    assert.equal(validPoints([0, 0, 0, -LIMITS.coordinate, LIMITS.coordinate, 1], 10), true);
  });
  it("rejects NaN, Infinity, non-numbers and bad lengths", () => {
    for (const pts of [[NaN, 0, 0.5], [Infinity, 0, 0.5], [0, -Infinity, 0.5], [0, 0, NaN], ["1", 0, 0.5], [0, 0], [0, 0, 0.5, 1], null, {}, "1,2,3"])
      assert.equal(validPoints(pts, 10), false, JSON.stringify(pts));
  });
  it("rejects out-of-range coordinates and pressure", () => {
    assert.equal(validPoints([LIMITS.coordinate + 1, 0, 0.5], 10), false);
    assert.equal(validPoints([0, -LIMITS.coordinate - 0.01, 0.5], 10), false);
    assert.equal(validPoints([0, 0, -0.001], 10), false);
    assert.equal(validPoints([0, 0, 1.001], 10), false);
  });
  it("enforces the max point count and empty rule", () => {
    assert.equal(validPoints([0, 0, 0, 1, 1, 1], 2), true);
    assert.equal(validPoints([0, 0, 0, 1, 1, 1, 2, 2, 1], 2), false);
    assert.equal(validPoints([], 2), false);
    assert.equal(validPoints([], 2, true), true);
  });
});

describe("parseWireStroke", () => {
  it("accepts a valid stroke and copies pts", () => {
    const input = { id: "abc", tool: "eraser", size: 4, pts: [1, 2, 0.5] };
    const parsed = parseWireStroke(input);
    assert.deepEqual(parsed, input); assert.notEqual(parsed.pts, input.pts);
  });
  it("accepts every brush size and rejects others", () => {
    for (const size of [0.5, 1, 2, 4]) assert.equal(parseWireStroke({ ...wire(), size }).size, size);
    for (const size of [0, 3, -1, NaN, "1", null]) assert.throws(() => parseWireStroke({ ...wire(), size }), /Invalid stroke/);
  });
  it("rejects extra/missing keys, wrong types, bad ids and tools", () => {
    const bad: unknown[] = [
      { ...wire(), extra: 1 }, { id: "a", tool: "pen", pts: [1, 2, 0.5] }, { ...wire(), id: "" }, { ...wire(), id: "a b" },
      { ...wire(), id: "x".repeat(65) }, { ...wire(), tool: "marker" }, { ...wire(), pts: [] }, { ...wire(), pts: [1, 2, NaN] },
      { ...wire(), pts: [1, 2, 2] }, null, [], "stroke", 7,
    ];
    for (const value of bad) assert.throws(() => parseWireStroke(value), /Invalid stroke/, JSON.stringify(value));
  });
  it("rejects oversize point arrays", () => {
    const max = new Array(LIMITS.pointsPerStroke * 3).fill(0.5);
    assert.equal(parseWireStroke(wire("big", max)).pts.length, max.length);
    assert.throws(() => parseWireStroke(wire("big", [...max, 0, 0, 0.5])), /Invalid stroke/);
  });
});

describe("parseClientMessage", () => {
  it("accepts hello variants and cleans names", () => {
    assert.deepEqual(msg({ t: "hello", v: PROTOCOL_VERSION }), { t: "hello", v: 1 });
    assert.deepEqual(msg({ t: "hello", v: 1, pair: TOKEN, device: TOKEN, name: "  My\u0007 iPad\n " }),
      { t: "hello", v: 1, pair: TOKEN, device: TOKEN, name: "My iPad" });
    assert.equal((msg({ t: "hello", v: 1, name: "\u0001 " }) as { name?: string }).name, "iPad");
  });
  it("rejects bad hello frames", () => {
    for (const value of [
      { t: "hello", v: 2 }, { t: "hello", v: "1" }, { t: "hello" }, { t: "hello", v: 1, pair: "short" },
      { t: "hello", v: 1, device: "bad token with spaces!!" }, { t: "hello", v: 1, name: 5 },
      { t: "hello", v: 1, name: "n".repeat(LIMITS.nameLength + 1) }, { t: "hello", v: 1, extra: true },
    ]) assert.throws(() => msg(value), /Invalid hello/, JSON.stringify(value));
  });
  it("accepts stroke, live, live-end, edits, sync, ping", () => {
    assert.deepEqual(msg({ t: "stroke", doc: "d:1", stroke: wire() }), { t: "stroke", doc: "d:1", stroke: wire() });
    const live = { t: "live", doc: "d", sid: "s", tool: "pen", size: 2, from: 0, pts: [1, 2, 0.3] };
    assert.deepEqual(msg(live), live);
    assert.deepEqual(msg({ t: "live-end", doc: "d", sid: "s" }), { t: "live-end", doc: "d", sid: "s" });
    for (const t of ["undo", "redo", "clear"] as const) assert.deepEqual(msg({ t, doc: "d" }), { t, doc: "d" });
    assert.deepEqual(msg({ t: "sync" }), { t: "sync" });
    assert.deepEqual(msg({ t: "ping" }), { t: "ping" });
  });
  it("rejects bad stroke/live/edit frames", () => {
    const live = { t: "live", doc: "d", sid: "s", tool: "pen", size: 1, from: 0, pts: [1, 2, 0.3] };
    const bad: unknown[] = [
      { t: "stroke", doc: "d", stroke: { ...wire(), pts: [Infinity, 0, 0] } }, { t: "stroke", doc: "a b", stroke: wire() },
      { t: "stroke", doc: "d", stroke: wire(), x: 1 },
      { ...live, from: -1 }, { ...live, from: 1.5 }, { ...live, from: LIMITS.pointsPerStroke }, { ...live, sid: "" },
      { ...live, size: 3 }, { ...live, tool: "brush" }, { ...live, pts: [] }, { ...live, extra: 1 },
      { ...live, pts: new Array((LIMITS.livePointsPerMessage + 1) * 3).fill(0) },
      { t: "live-end", doc: "d" }, { t: "undo", doc: "" }, { t: "redo", doc: "d", extra: 1 }, { t: "clear" },
      { t: "sync", doc: "d" }, { t: "ping", x: 1 },
    ];
    for (const value of bad) assert.throws(() => msg(value), /Invalid/, JSON.stringify(value).slice(0, 80));
  });
  it("rejects unknown types, non-objects, malformed JSON and oversize frames", () => {
    assert.throws(() => msg({ t: "welcome" }), /Unknown message/);
    assert.throws(() => msg({ t: 1 }), /Invalid message/);
    for (const value of [null, [], 5, "x"]) assert.throws(() => msg(value), /Invalid message/);
    assert.throws(() => parseClientMessage("{nope"), SyntaxError);
    assert.throws(() => parseClientMessage(" ".repeat(LIMITS.messageBytes + 1)), /too large/);
  });
  it("NaN/Infinity cannot be smuggled through JSON", () => {
    assert.throws(() => parseClientMessage('{"t":"live","doc":"d","sid":"s","tool":"pen","size":1,"from":0,"pts":[NaN,0,0]}'));
    assert.throws(() => msg({ t: "live", doc: "d", sid: "s", tool: "pen", size: 1, from: 0, pts: [Infinity, 0, 0] }));
  });
});

describe("cleanName", () => {
  it("strips control characters, trims, truncates and defaults", () => {
    assert.equal(cleanName("\tKid's\u007f iPad "), "Kid's iPad");
    assert.equal(cleanName("n".repeat(100)).length, LIMITS.nameLength);
    assert.equal(cleanName(""), "iPad");
  });
});

describe("toWire / fromWire", () => {
  it("rounds x/y to 0.01 and pressure to 0.001", () => {
    const stroke: Stroke = { tool: "pen", points: [{ x: 1.23456, y: -7.891, pressure: 0.12345 }] };
    assert.deepEqual(toWire(stroke, "s"), { id: "s", tool: "pen", size: 1, pts: [1.23, -7.89, 0.123] });
  });
  it("defaults size to 1 and omits size 1 on the way back", () => {
    const back = fromWire(toWire({ tool: "pen", points: [{ x: 1, y: 2, pressure: 0.5 }] }, "a"));
    assert.deepEqual(back, { tool: "pen", points: [{ x: 1, y: 2, pressure: 0.5 }], id: "a" });
    assert.equal(Object.hasOwn(back, "size"), false);
    assert.equal(Object.hasOwn(fromWire(toWire({ tool: "pen", size: 1, points: [] }, "b")), "size"), false);
  });
  it("round trips non-default size and tool", () => {
    const stroke: Stroke = { tool: "eraser", size: 4, id: "x", points: [{ x: 10.5, y: -3.25, pressure: 1 }, { x: 0.01, y: 2, pressure: 0.5 }] };
    assert.deepEqual(fromWire(toWire(stroke, "x")), stroke);
  });
  it("wire output passes the strict parser", () => {
    const stroke: Stroke = { tool: "pen", size: 2, points: [{ x: 100.004, y: 200.006, pressure: 0.9999 }] };
    const w = toWire(stroke, "id-1");
    assert.deepEqual(parseWireStroke(JSON.parse(JSON.stringify(w))), w);
    assert.deepEqual(w.pts, [100, 200.01, 1]);
  });
  it("fromWire ignores a trailing partial triple", () => {
    assert.equal(fromWire({ id: "a", tool: "pen", size: 1, pts: [1, 2, 0.5, 9, 9] }).points.length, 1);
  });
});

describe("applyOp", () => {
  const a = wire("a"), b = wire("b"), c = wire("c");
  it("push appends without mutating input", () => {
    const base = [a]; const next = applyOp(base, { k: "push", stroke: b });
    assert.deepEqual(next.map(s => s.id), ["a", "b"]); assert.equal(base.length, 1);
  });
  it("pop removes the last stroke and is safe on empty", () => {
    const base = [a, b]; assert.deepEqual(applyOp(base, { k: "pop" }).map(s => s.id), ["a"]); assert.equal(base.length, 2);
    assert.deepEqual(applyOp([], { k: "pop" }), []);
  });
  it("reset replaces with a copy", () => {
    const strokes = [c]; const next = applyOp([a, b], { k: "reset", strokes });
    assert.deepEqual(next, [c]); assert.notEqual(next, strokes);
    assert.deepEqual(applyOp([a], { k: "reset", strokes: [] }), []);
  });
});

describe("parseOp / parseOpMessage", () => {
  it("parses push, pop and reset", () => {
    assert.deepEqual(parseOp({ k: "push", stroke: wire() }), { k: "push", stroke: wire() });
    assert.deepEqual(parseOp({ k: "pop" }), { k: "pop" });
    assert.deepEqual(parseOp({ k: "reset", strokes: [wire("a"), wire("b")] }), { k: "reset", strokes: [wire("a"), wire("b")] });
  });
  it("rejects malformed ops", () => {
    for (const value of [null, {}, { k: "pop", x: 1 }, { k: "push" }, { k: "push", stroke: { ...wire(), size: 3 } },
      { k: "reset", strokes: "x" }, { k: "reset", strokes: [{}] }, { k: "reset" }, { k: "splice" }])
      assert.throws(() => parseOp(value), /Invalid/, JSON.stringify(value));
  });
  it("parses a valid op message", () => {
    assert.deepEqual(parseOpMessage({ t: "op", doc: "d:1", rev: 3, op: { k: "pop" }, redo: 1 }),
      { t: "op", doc: "d:1", rev: 3, op: { k: "pop" }, redo: 1 });
  });
  it("rejects bad op messages", () => {
    const ok = { t: "op", doc: "d", rev: 1, op: { k: "pop" }, redo: 0 };
    for (const value of [{ ...ok, t: "state" }, { ...ok, doc: "a b" }, { ...ok, rev: 0 }, { ...ok, rev: 1.5 }, { ...ok, rev: NaN },
      { ...ok, redo: -1 }, { ...ok, redo: Infinity }, { ...ok, extra: 1 }, { ...ok, op: { k: "nope" } }, null, []])
      assert.throws(() => parseOpMessage(value), /Invalid/);
  });
});

describe("parseDocSnapshot", () => {
  it("accepts a valid snapshot and parses strokes", () => {
    const parsed: DocSnapshot = parseDocSnapshot(snapshot({ strokes: [wire("a"), { ...wire("b"), size: 0.5 }] }));
    assert.equal(parsed.id, "win-1:session.a:0"); assert.equal(parsed.strokes.length, 2); assert.equal(parsed.strokes[1]!.size, 0.5);
  });
  it("accepts a blank sheet (0x0, empty background, practice/light)", () => {
    const parsed = parseDocSnapshot(snapshot({ width: 0, height: 0, background: "", kind: "practice", mode: "light", label: "Blank sheet", strokes: [] }));
    assert.equal(parsed.width, 0); assert.deepEqual(parsed.strokes, []);
  });
  it("rejects every invalid field", () => {
    const bad: Record<string, unknown>[] = [
      { id: "a b" }, { rev: -1 }, { rev: 1.5 }, { rev: NaN }, { kind: "exam" }, { label: 5 }, { label: "l".repeat(81) },
      { width: -1 }, { width: NaN }, { width: Infinity }, { width: 100_001 }, { height: "1" }, { height: NaN },
      { background: "http://evil/x.png" }, { background: "data:image/svg+xml;base64,AA" }, { backgroundColor: "c".repeat(101) },
      { mode: "sepia" }, { strokes: {} }, { strokes: [{ ...wire(), pts: [0, 0, 2] }] }, { redo: -1 }, { redo: 0.5 },
    ];
    for (const over of bad) assert.throws(() => parseDocSnapshot(snapshot(over)), /Invalid/, JSON.stringify(over));
  });
  it("rejects missing and extra keys", () => {
    const missing = snapshot(); delete missing.redo;
    assert.throws(() => parseDocSnapshot(missing), /Invalid drawing snapshot/);
    assert.throws(() => parseDocSnapshot(snapshot({ extra: true })), /Invalid drawing snapshot/);
    assert.throws(() => parseDocSnapshot(null), /Invalid drawing snapshot/);
  });
});

describe("camera transforms", () => {
  const close = (actual: number, expected: number, message?: string) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ""} expected ${expected}, got ${actual}`);
  it("screenToWorld and worldToScreen are inverses", () => {
    const camera: Camera = { x: 410.5, y: 900.25, scale: 0.788 };
    for (const [x, y] of [[0, 0], [123.4, -567.8], [-250, 200], [1e5, -1e5]] as const) {
      const s = worldToScreen(camera, x, y), w = screenToWorld(camera, s.x, s.y);
      close(w.x, x); close(w.y, y);
      const w2 = screenToWorld(camera, x, y), s2 = worldToScreen(camera, w2.x, w2.y);
      close(s2.x, x); close(s2.y, y);
    }
  });
  it("bottom-anchored reference maps consistently on portrait, landscape and desktop sizes", () => {
    const refW = 600, refH = 400;
    for (const [vw, vh] of [[820, 1180], [1180, 820], [1440, 900], [1920, 1080]] as const) {
      const scale = 1, camera = companionCamera(vw, vh, refW, refH, { x: 0, y: 0 }, scale);
      // Reference bottom-center sits 24px above the bottom, horizontally centered.
      const bottom = worldToScreen(camera, 0, refH / 2);
      close(bottom.x, vw / 2, `${vw}x${vh}`); close(bottom.y, vh - 24, `${vw}x${vh}`);
      // An ink point keeps the same offset from that anchor on every screen.
      const ink = worldToScreen(camera, -120.5, 75.25);
      close(ink.x - vw / 2, -120.5); close(ink.y - (vh - 24), 75.25 - refH / 2);
    }
  });
  it("default fit scale keeps the anchor and scales offsets uniformly", () => {
    const refW = 1000, refH = 500;
    for (const [vw, vh] of [[820, 1180], [1180, 820]] as const) {
      const camera = companionCamera(vw, vh, refW, refH, { x: 0, y: 0 });
      assert.equal(camera.scale, fitScale(vw, refW));
      const bottom = worldToScreen(camera, 0, refH / 2); close(bottom.x, vw / 2); close(bottom.y, vh - 24);
      const ink = worldToScreen(camera, 100, -50);
      close(ink.x - vw / 2, 100 * camera.scale); close(ink.y - (vh - 24), (-50 - refH / 2) * camera.scale);
    }
    close(companionCamera(820, 1180, refW, refH, { x: 0, y: 0 }).scale, (820 - 32) / 1000);
    assert.equal(companionCamera(1180, 820, refW, refH, { x: 0, y: 0 }).scale, 1);
  });
  it("blank sheets are centered and pan translates", () => {
    const camera = companionCamera(820, 1180, 0, 0, { x: 10, y: -20 });
    assert.deepEqual(camera, { x: 420, y: 570, scale: 1 });
  });
  it("fitScale fits narrow screens, never enlarges, clamps and guards bad input", () => {
    assert.equal(fitScale(1180, 800), 1);
    close(fitScale(820, 1000), 0.788);
    close(fitScale(400, 1000, 0), 0.4);
    assert.equal(fitScale(100, 10_000), MIN_SCALE);
    assert.equal(fitScale(20, 500), MIN_SCALE);
    for (const [v, r] of [[0, 500], [500, 0], [NaN, 500], [500, NaN], [-1, 500]] as const) assert.equal(fitScale(v, r), 1);
    assert.equal(clampScale(10), MAX_SCALE); assert.equal(clampScale(0.01), MIN_SCALE);
    assert.equal(clampScale(NaN), 1); assert.equal(clampScale(Infinity), 1); assert.equal(clampScale(2), 2);
  });
  it("zoomPan keeps the focus point fixed in world space", () => {
    const cases = [
      { vw: 820, vh: 1180, rw: 1000, rh: 500, pan: { x: 0, y: 0 }, s: 0.788, n: 2, fx: 300, fy: 700 },
      { vw: 1180, vh: 820, rw: 600, rh: 400, pan: { x: 35, y: -12 }, s: 1, n: 0.5, fx: 1000, fy: 100 },
      { vw: 1180, vh: 820, rw: 0, rh: 0, pan: { x: -5, y: 7 }, s: 1.5, n: 3.25, fx: 10, fy: 810 },
    ];
    for (const c of cases) {
      const before = companionCamera(c.vw, c.vh, c.rw, c.rh, c.pan, c.s);
      const world = screenToWorld(before, c.fx, c.fy);
      const pan = zoomPan(c.vw, c.vh, c.rw, c.rh, c.pan, c.s, c.n, c.fx, c.fy);
      const after = companionCamera(c.vw, c.vh, c.rw, c.rh, pan, c.n);
      assert.equal(after.scale, c.n);
      const screen = worldToScreen(after, world.x, world.y);
      close(screen.x, c.fx); close(screen.y, c.fy);
    }
  });
  it("zoomPan with unchanged scale keeps the pan", () => {
    const pan = zoomPan(820, 1180, 600, 400, { x: 12, y: -8 }, 1.25, 1.25, 50, 60);
    close(pan.x, 12); close(pan.y, -8);
  });
});
