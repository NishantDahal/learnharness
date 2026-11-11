import assert from "node:assert/strict";
import { it } from "node:test";
import { inkSignature, paintStroke, strokeOutline, strokeWidth, visibleStrokes, type Point, type Stroke } from "../src/strokes.ts";
const point = (x: number, y = 0, pressure = .5): Point => ({ x, y, pressure });
const pen = (points: Point[]): Stroke => ({ tool: "pen", points });
const erase = (points: Point[]): Stroke => ({ tool: "eraser", points });

it("uses pressure widths matching the smoothed outline, including fixed mouse pressure", () => {
  assert.ok(Math.abs(strokeWidth(point(0, 0, 0), point(0, 0, 0)) - 1.2) < 1e-9);
  assert.equal(strokeWidth(point(0), point(1)), 3);
  assert.ok(Math.abs(strokeWidth(point(0, 0, 1), point(0, 0, 1)) - 4.8) < 1e-9);
});
it("renders ink as one smooth filled outline whose width follows pressure and size", () => {
  const line = (pressure: number, size?: number): Stroke => ({ tool: "pen", ...(size ? { size } : {}),
    points: Array.from({ length: 21 }, (_, i) => ({ x: i * 5, y: 0, pressure })) });
  const height = (stroke: Stroke) => {
    const ys = strokeOutline(stroke).filter(([x]) => x! > 30 && x! < 70).map(([, y]) => y!);
    return Math.max(...ys) - Math.min(...ys);
  };
  assert.ok(Math.abs(height(line(.5)) - 3) < 0.35, `medium pen ≈ 3px, got ${height(line(.5))}`);
  assert.ok(height(line(1)) > height(line(.5)) && height(line(.5)) > height(line(0)), "pressure thickens");
  assert.ok(Math.abs(height(line(.5, 4)) / height(line(.5)) - 4) < 0.2, "brush size scales width");
  let fills = 0, curves = 0;
  const context = { globalCompositeOperation: "", fillStyle: "", beginPath() {}, moveTo() {}, closePath() {}, arc() {},
    quadraticCurveTo() { curves++; }, fill() { fills++; } } as unknown as CanvasRenderingContext2D;
  paintStroke(context, line(.5), "#000");
  assert.equal(fills, 1, "one filled shape per stroke, no overlapping segment stamps");
  assert.ok(curves > 10, "outline is drawn with curves");
});
it("erases a whole crossing stroke, not only its touched segment", () => {
  const a = pen([point(0), point(100)]), b = pen([point(0, 60), point(100, 60)]);
  assert.deepEqual(visibleStrokes([a, b, erase([point(50, -30), point(50, 30)])]), [b]);
});
it("handles dot strokes and single-contact erasers", () => {
  const dot = pen([point(10, 10)]);
  assert.deepEqual(visibleStrokes([dot, erase([point(10, 10)])]), []);
});
it("includes the reference eraser contact radius and ink edge", () => {
  const a = pen([point(0), point(100)]);
  assert.deepEqual(visibleStrokes([a, erase([point(50, 13)])]), []);
  assert.deepEqual(visibleStrokes([a, erase([point(50, 14)])]), [a]);
});
it("undoing an eraser restores exact complete strokes", () => {
  const a = pen([point(0), point(100)]), history = [a, erase([point(50)])];
  assert.equal(visibleStrokes(history).length, 0);
  assert.deepEqual(visibleStrokes(history.slice(0, -1)), [a]);
});
it("a pen stroke drawn after erasing is not retroactively erased", () => {
  const first = pen([point(0)]), next = pen([point(0)]);
  assert.deepEqual(visibleStrokes([first, erase([point(0)]), next]), [next]);
});
it("empty histories, empty pen records and fully erased histories have no signature", () => {
  assert.equal(inkSignature([], "#facc15"), "");
  assert.equal(inkSignature([pen([])], "#facc15"), "");
  assert.equal(inkSignature([pen([point(0)]), erase([point(0)])], "#facc15"), "");
});
it("signatures describe visible content, not no-op eraser history", () => {
  const a = pen([point(0), point(100)]);
  assert.equal(inkSignature([a], "#facc15"), inkSignature([a, erase([point(0, 100)])], "#facc15"));
  assert.notEqual(inkSignature([a], "#facc15"), inkSignature([a], "#ffffff"));
});
it("does not mutate stroke arrays while resolving erasers", () => {
  const a = pen([point(0), point(100)]), history = [a, erase([point(50)])];
  const before = JSON.stringify(history); visibleStrokes(history);
  assert.equal(JSON.stringify(history), before);
});
