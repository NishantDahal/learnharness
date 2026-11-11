import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginSubmission } from "learnharness-plugin-api";
import { Sheets } from "../src/state.ts";
import { BRUSH_SIZES, inkSignature, paintStroke, strokeSize, strokeWidth, visibleStrokes, type Stroke } from "../src/strokes.ts";
import { inkBounds } from "../src/geometry.ts";
import { fromWire, toWire } from "../src/companion/protocol.ts";
import { appendDrawing } from "../src/submission.ts";

const pen = (x = 10, extra: Partial<Stroke> = {}): Stroke => ({ tool: "pen", points: [{ x, y: 10, pressure: .5 }], ...extra });
const blank = { background: "data:image/png;base64,fixture", backgroundColor: "#141414", width: 500, height: 400, pixelRatio: 2 };
function fixture(kind: "teaching" | "practice" = "teaching") {
  let changes = 0, listened = 0, live = 0;
  const sheets = new Sheets(() => changes++, () => {}), state = sheets.session("a", kind);
  sheets.create(state, blank);
  sheets.onChange(() => listened++);
  sheets.onLive(() => live++);
  return { sheets, state, changes: () => changes, listened: () => listened, live: () => live };
}
const xs = (strokes: readonly Stroke[]) => strokes.map(stroke => stroke.points[0]!.x);

describe("Sheets undo / redo / clear", () => {
  it("starts with an empty redo stack", () => {
    const { sheets, state } = fixture();
    assert.deepEqual(state.draft!.redo, []); assert.equal(sheets.canRedo(state), false);
  });
  it("redo restores undone strokes in original order and bumps revision", () => {
    const { sheets, state } = fixture(); sheets.update(state, [pen(1), pen(2), pen(3)]);
    const rev = state.draft!.revision;
    sheets.undo(state); sheets.undo(state);
    assert.deepEqual(xs(state.draft!.strokes), [1]); assert.deepEqual(xs(state.draft!.redo!), [3, 2]);
    assert.equal(sheets.canRedo(state), true); assert.equal(state.draft!.revision, rev + 2);
    sheets.redo(state); assert.deepEqual(xs(state.draft!.strokes), [1, 2]);
    sheets.redo(state); assert.deepEqual(xs(state.draft!.strokes), [1, 2, 3]);
    assert.equal(sheets.canRedo(state), false); assert.equal(state.draft!.revision, rev + 4);
    const before = state.draft; sheets.redo(state); assert.equal(state.draft, before, "redo with an empty stack is a no-op");
  });
  it("undo on an empty sheet is a no-op", () => {
    const { sheets, state, changes } = fixture(); const before = state.draft, count = changes();
    sheets.undo(state); assert.equal(state.draft, before); assert.equal(changes(), count);
  });
  it("redo preserves stroke identity (id/size) of the undone stroke", () => {
    const { sheets, state } = fixture(); const ipad = pen(5, { id: "s1", size: 4 });
    sheets.update(state, [ipad]); sheets.undo(state); sheets.redo(state);
    assert.equal(state.draft!.strokes[0], ipad);
  });
  it("a new stroke discards the redo stack", () => {
    const { sheets, state } = fixture(); sheets.update(state, [pen(1), pen(2)]); sheets.undo(state);
    assert.equal(sheets.canRedo(state), true);
    sheets.update(state, [...state.draft!.strokes, pen(9)]);
    assert.equal(sheets.canRedo(state), false); assert.deepEqual(state.draft!.redo, []);
    sheets.redo(state); assert.deepEqual(xs(state.draft!.strokes), [1, 9]);
  });
  it("clear empties strokes, discards redo and cannot be undone", () => {
    const { sheets, state } = fixture(); sheets.update(state, [pen(1), pen(2)]); sheets.undo(state);
    sheets.clear(state);
    assert.deepEqual(state.draft!.strokes, []); assert.deepEqual(state.draft!.redo, []);
    assert.equal(state.draft!.hasInk, false); assert.equal(sheets.canRedo(state), false);
    sheets.undo(state); assert.deepEqual(state.draft!.strokes, []);
    sheets.redo(state); assert.deepEqual(state.draft!.strokes, []);
  });
  it("clear with only a redo stack still discards it; clear on an empty sheet is a no-op", () => {
    const { sheets, state, changes } = fixture(); sheets.update(state, [pen(1)]); sheets.undo(state);
    sheets.clear(state); assert.equal(sheets.canRedo(state), false);
    const draft = state.draft, count = changes(); sheets.clear(state);
    assert.equal(state.draft, draft); assert.equal(changes(), count);
  });
  it("teaching acceptance after an iPad-originated stroke clears the sheet and its redo", () => {
    const { sheets, state } = fixture("teaching");
    sheets.update(state, [pen(1)]); sheets.undo(state); sheets.redo(state); sheets.update(state, [pen(1), pen(2)]); sheets.undo(state);
    const wire = toWire({ tool: "pen", points: [{ x: 3.333, y: 4.444, pressure: .12345 }], size: 2 }, "ipad-1");
    sheets.update(state, [...state.draft!.strokes, fromWire(wire)]);
    const captured = sheets.capture(state)!; assert.equal(captured.sendImage, true);
    sheets.accepted(captured);
    assert.deepEqual(state.draft!.strokes, []); assert.deepEqual(state.draft!.redo, []); assert.equal(sheets.pending(state), false);
  });
  it("practice resend detection: undo/redo back to the sent image does not resend", () => {
    const { sheets, state } = fixture("practice"); sheets.update(state, [pen(1)]); sheets.accepted(sheets.capture(state)!);
    assert.equal(sheets.pending(state), false);
    sheets.update(state, [...state.draft!.strokes, pen(2)]); assert.equal(sheets.pending(state), true);
    sheets.undo(state); assert.equal(sheets.pending(state), false);
    sheets.redo(state); assert.equal(sheets.pending(state), true);
    sheets.undo(state); assert.equal(sheets.capture(state)!.sendImage, false);
  });
  it("practice resend detection ignores stroke ids but not sizes", () => {
    const { sheets, state } = fixture("practice"); sheets.update(state, [pen(1)]); sheets.accepted(sheets.capture(state)!);
    sheets.update(state, [pen(1, { id: "remote" })]); assert.equal(sheets.pending(state), false);
    sheets.update(state, [pen(1, { id: "remote", size: 1 })]); assert.equal(sheets.pending(state), false);
    sheets.update(state, [pen(1, { size: 2 })]); assert.equal(sheets.pending(state), true);
  });
});

describe("live preview store", () => {
  it("setLive/clearLive notify only onLive listeners, never changed/onChange, and keep revision", () => {
    const { sheets, state, changes, listened, live } = fixture("practice"); sheets.update(state, [pen(1)]);
    const draft = state.draft!, c = changes(), l = listened(), signature = sheets.signature(state);
    sheets.setLive(state, "k1", pen(50, { size: 4 }));
    sheets.setLive(state, "k2", { tool: "eraser", points: [{ x: 1, y: 10, pressure: .5 }] });
    assert.equal(live(), 2);
    assert.deepEqual(sheets.liveStrokes(state).map(s => s.tool), ["pen", "eraser"]);
    sheets.setLive(state, "k1", pen(60)); assert.equal(live(), 3);
    assert.equal(sheets.liveStrokes(state).length, 2, "same key replaces");
    assert.equal(changes(), c); assert.equal(listened(), l);
    assert.equal(state.draft, draft); assert.equal(state.draft!.revision, draft.revision);
    assert.deepEqual(xs(state.draft!.strokes), [1]);
    const captured = sheets.capture(state)!;
    assert.equal(captured.signature, signature, "live strokes are not part of the signature");
    assert.deepEqual(xs(captured.draft.strokes), [1]);
    assert.equal(captured.draft.strokes.some(s => s.tool === "eraser"), false);
    sheets.setLive(state, "k1", undefined); assert.equal(live(), 4); assert.equal(sheets.liveStrokes(state).length, 1);
    sheets.setLive(state, "missing", undefined); assert.equal(live(), 4, "removing an unknown key does not notify");
    sheets.clearLive(state); assert.equal(live(), 5); assert.deepEqual(sheets.liveStrokes(state), []);
    sheets.clearLive(state); assert.equal(live(), 5, "clearing an empty sheet does not notify");
    assert.equal(changes(), c); assert.equal(listened(), l); assert.equal(state.draft, draft);
  });
  it("clearLive() without a sheet clears every sheet once", () => {
    const { sheets, state, live } = fixture(); const other = sheets.session("b", "practice");
    sheets.setLive(state, "a", pen(1)); sheets.setLive(other, "b", pen(2)); const n = live();
    sheets.clearLive(); assert.equal(live(), n + 1);
    assert.deepEqual(sheets.liveStrokes(state), []); assert.deepEqual(sheets.liveStrokes(other), []);
    sheets.clearLive(); assert.equal(live(), n + 1);
  });
  it("live strokes do not affect pending/sendImage on a blank teaching sheet", () => {
    const { sheets, state } = fixture(); sheets.setLive(state, "k", pen(5));
    assert.equal(sheets.pending(state), false); assert.equal(sheets.capture(state)!.sendImage, false);
    assert.equal(state.draft!.hasInk, false);
  });
  it("onLive unsubscribe stops notifications", () => {
    const { sheets, state } = fixture(); let n = 0; const off = sheets.onLive(() => n++);
    sheets.setLive(state, "k", pen()); off(); sheets.setLive(state, "k", undefined); assert.equal(n, 1);
  });
});

describe("brush size", () => {
  it("strokeSize defaults invalid sizes to 1 and keeps valid multipliers", () => {
    assert.deepEqual([...BRUSH_SIZES], [0.5, 1, 2, 4]);
    for (const size of BRUSH_SIZES) assert.equal(strokeSize({ size }), size);
    for (const size of [undefined, 0, -2, NaN, Infinity]) assert.equal(strokeSize({ size }), 1);
  });
  it("size scales painted line width", () => {
    const widths = (stroke: Stroke) => {
      const recorded: number[] = [];
      const context = { set lineWidth(value: number) { recorded.push(value); }, get lineWidth() { return recorded.at(-1) ?? 1; },
        beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {} } as unknown as CanvasRenderingContext2D;
      paintStroke(context, stroke, "#fff");
      return recorded;
    };
    const points = [{ x: 0, y: 0, pressure: .5 }, { x: 10, y: 0, pressure: .5 }];
    const base = widths({ tool: "pen", points });
    assert.deepEqual(base, [3, 3]);
    assert.deepEqual(widths({ tool: "pen", points, size: 1 }), base);
    assert.deepEqual(widths({ tool: "pen", points, size: 4 }), [12, 12]);
    assert.deepEqual(widths({ tool: "pen", points, size: 0.5 }), [1.5, 1.5]);
    assert.equal(strokeWidth(points[0]!, points[1]!, 2), 6);
  });
  it("size scales ink bounds", () => {
    const point = [{ x: 0, y: 0, pressure: 1 }];
    assert.deepEqual(inkBounds([{ tool: "pen", points: point }]), { x: -2.25, y: -2.25, width: 4.5, height: 4.5 });
    assert.deepEqual(inkBounds([{ tool: "pen", points: point, size: 4 }]), { x: -9, y: -9, width: 18, height: 18 });
    assert.deepEqual(inkBounds([{ tool: "pen", points: point, size: 0.5 }]), { x: -1.125, y: -1.125, width: 2.25, height: 2.25 });
  });
  it("eraser size scales the erase radius", () => {
    const target: Stroke = { tool: "pen", points: [{ x: 0, y: 0, pressure: 0 }] }; // radius 0.75
    const eraserAt = (x: number, size?: number): Stroke => ({ tool: "eraser", points: [{ x, y: 0, pressure: 0 }], ...(size === undefined ? {} : { size }) });
    // size 1: reach 12 + 0.75 = 12.75
    assert.equal(visibleStrokes([target, eraserAt(12.5)]).length, 0);
    assert.equal(visibleStrokes([target, eraserAt(13)]).length, 1);
    // size 2: reach 24.75; size 0.5: reach 6.75
    assert.equal(visibleStrokes([target, eraserAt(24.5, 2)]).length, 0);
    assert.equal(visibleStrokes([target, eraserAt(25, 2)]).length, 1);
    assert.equal(visibleStrokes([target, eraserAt(7, 0.5)]).length, 1);
    assert.equal(visibleStrokes([target, eraserAt(6.5, 0.5)]).length, 0);
    // Larger pens are also easier to hit.
    assert.equal(visibleStrokes([{ ...target, size: 4 }, eraserAt(14)]).length, 0);
  });
  it("inkSignature is unchanged for size 1/undefined and ids, differs when size differs", () => {
    const points = [{ x: 1, y: 2, pressure: .3 }];
    const legacy = JSON.stringify(["#fff", [points]]);
    assert.equal(inkSignature([{ tool: "pen", points }], "#fff"), legacy);
    assert.equal(inkSignature([{ tool: "pen", points, size: 1 }], "#fff"), legacy);
    assert.equal(inkSignature([{ tool: "pen", points, id: "abc" }], "#fff"), legacy);
    assert.equal(inkSignature([{ tool: "pen", points, id: "xyz", size: 1 }], "#fff"), legacy);
    const two = inkSignature([{ tool: "pen", points, size: 2 }], "#fff");
    assert.notEqual(two, legacy); assert.notEqual(two, inkSignature([{ tool: "pen", points, size: 4 }], "#fff"));
    assert.equal(two, inkSignature([{ tool: "pen", points, size: 2, id: "q" }], "#fff"));
    assert.equal(inkSignature([], "#fff"), "");
  });
});

describe("submission compatibility", () => {
  it("a wire round-tripped stroke is captured with sendImage true", () => {
    const original: Stroke = { tool: "pen", points: [{ x: 1.006, y: -2.4449, pressure: .12345 }, { x: 20, y: 30, pressure: 1 }], size: 2 };
    const wire = toWire(original, "w1");
    assert.deepEqual(wire, { id: "w1", tool: "pen", size: 2, pts: [1.01, -2.44, 0.123, 20, 30, 1] });
    const back = fromWire(wire);
    assert.deepEqual(back, { tool: "pen", id: "w1", size: 2, points: [{ x: 1.01, y: -2.44, pressure: .123 }, { x: 20, y: 30, pressure: 1 }] });
    assert.equal(Object.hasOwn(fromWire(toWire({ tool: "pen", points: original.points }, "w2")), "size"), false, "size 1 is omitted");
    for (const kind of ["teaching", "practice"] as const) {
      const { sheets, state } = fixture(kind); sheets.update(state, [back]);
      const captured = sheets.capture(state)!;
      assert.equal(captured.sendImage, true); assert.notEqual(captured.signature, "");
      assert.equal(captured.draft.strokes[0], back);
    }
  });
  it("appendDrawing keeps the existing image channel shapes", () => {
    const existing = { type: "image" as const, mimeType: "image/png", data: "existing" };
    const drawing = { type: "image" as const, mimeType: "image/png" as const, data: "drawing" };
    const content = { text: "t", images: [existing] };
    const inputs: PluginSubmission[] = [
      { type: "text", content }, { type: "thinking", content },
      { type: "answer", answer: { values: ["b"], confidence: 30, images: [existing] }, thinking: content, readingThinking: content },
      { type: "plugin-question-answer", answer: false, answerImages: [existing], thinking: content, readingThinking: content },
      { type: "plugin-problem-submission", submission: 0, submissionImages: [existing], thinking: content },
    ];
    for (const input of inputs) {
      const result = appendDrawing(input, drawing);
      assert.deepEqual(Object.keys(result).sort(), Object.keys(input).sort());
      const images = result.type === "text" || result.type === "thinking" ? result.content.images
        : result.type === "answer" ? result.answer.images
        : result.type === "plugin-question-answer" ? result.answerImages : result.submissionImages;
      assert.deepEqual(images, [existing, drawing]);
    }
  });
});
