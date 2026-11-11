/** Adapted from hrdkj/learnharness, codex/handwriting-contribution (48dd022).
 * See THIRD-PARTY.md. Coordinates and pressure remain in unrestricted world space. */
import { getStroke } from "perfect-freehand";
export interface Point { x: number; y: number; pressure: number }
/** `id` is an opaque companion-sync identity; it is never rendered, exported or
 * part of the image signature. `size` is an optional brush multiplier: omitted
 * (or 1) keeps the original pen width and the original image signature. */
export interface Stroke { tool: "pen" | "eraser"; points: Point[]; id?: string; size?: number }
export type Tool = Stroke["tool"] | "hand";

/** Brush multipliers offered by the iPad companion. Desktop strokes use 1. */
export const BRUSH_SIZES = [0.5, 1, 2, 4] as const;
export function strokeSize(stroke: Pick<Stroke, "size">): number {
  const size = stroke.size;
  return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : 1;
}
const THINNING = 0.6;
/** Painted diameter at the average pressure of a segment: 1.2 (no pressure) to 4.8
 * (full pressure), 3 at medium, times the brush size. This is exactly the width of
 * the smoothed outline drawn by `paintStroke`, and is used for erasing and bounds. */
export function strokeWidth(a: Point, b: Point, size = 1): number {
  const pressure = (a.pressure + b.pressure) / 2;
  return 2 * 3 * size * (0.5 - THINNING * (0.5 - pressure));
}
function pointSegmentDistanceSquared(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return (point.x - a.x - t * dx) ** 2 + (point.y - a.y - t * dy) ** 2;
}
function segmentDistanceSquared(a: Point, b: Point, c: Point, d: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, ex = d.x - c.x, ey = d.y - c.y;
  const determinant = dx * ey - dy * ex;
  if (determinant !== 0) {
    const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / determinant;
    const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / determinant;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(pointSegmentDistanceSquared(a, c, d), pointSegmentDistanceSquared(b, c, d),
    pointSegmentDistanceSquared(c, a, b), pointSegmentDistanceSquared(d, a, b));
}
function touchesStroke(stroke: Stroke, eraser: Stroke): boolean {
  const penSize = strokeSize(stroke), eraserRadius = 12 * strokeSize(eraser);
  for (let i = 0; i < stroke.points.length; i++) {
    const a = stroke.points[Math.max(0, i - 1)]!, b = stroke.points[i]!;
    const radius = eraserRadius + strokeWidth(a, b, penSize) / 2;
    for (let j = 0; j < eraser.points.length; j++) {
      const c = eraser.points[Math.max(0, j - 1)]!, d = eraser.points[j]!;
      if (segmentDistanceSquared(a, b, c, d) <= radius * radius) return true;
    }
  }
  return false;
}
/** Keep eraser gestures in history so undo restores complete removed strokes. */
export function visibleStrokes(history: readonly Stroke[]): Stroke[] {
  let visible: Stroke[] = [];
  for (const stroke of history) {
    if (stroke.tool === "pen" && stroke.points.length) visible.push(stroke);
    else if (stroke.tool === "eraser") visible = visible.filter(pen => !touchesStroke(pen, stroke));
  }
  return visible;
}
/** History-only edits (or Undo back to the sent drawing) are not new image content.
 * Size-1 strokes keep their historical signature; ids never affect it. */
export function inkSignature(history: readonly Stroke[], color: string): string {
  const visible = visibleStrokes(history);
  return visible.length ? JSON.stringify([color, visible.map(stroke => strokeSize(stroke) === 1 ? stroke.points
    : { size: strokeSize(stroke), points: stroke.points })]) : "";
}
export function paintSegment(context: CanvasRenderingContext2D, a: Point, b: Point, color: string, size = 1): void {
  context.globalCompositeOperation = "source-over";
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = strokeWidth(a, b, size);
  context.beginPath();
  if (a.x === b.x && a.y === b.y) {
    context.arc(a.x, a.y, context.lineWidth / 2, 0, Math.PI * 2);
    context.fill();
  } else {
    context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
  }
}
/** Notes-style ink: perfect-freehand turns the raw samples and pressure into one
 * smooth, variable-width outline, filled with quadratic curves. Raw points stay
 * stored unchanged; only rendering is smoothed, so every device (and the exported
 * image) draws the same shape. Widths match `strokeWidth` (diameter = 2 × radius). */
export const INK = Object.freeze({ base: 3, thinning: THINNING, smoothing: 0.62, streamline: 0.42 });
/** Safari often delivers ~60 pencil samples per second, so a fast "a" or "o" arrives as
 * a few straight chords. Fill long gaps with a centripetal Catmull-Rom spline through
 * the samples (pressure interpolated linearly) so curves stay round on every device. */
export function densify(points: readonly Point[], spacing = 2): Point[] {
  if (points.length < 3) return [...points];
  const out: Point[] = [points[0]!];
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i]!, p2 = points[i + 1]!, p0 = points[i - 1] ?? p1, p3 = points[i + 2] ?? p2;
    const length = Math.hypot(p2.x - p1.x, p2.y - p1.y), steps = Math.min(24, Math.floor(length / spacing));
    if (steps > 1) {
      // Centripetal parameterization avoids loops and overshoot on sharp turns.
      const knot = (a: Point, b: Point) => Math.max(1e-4, Math.hypot(b.x - a.x, b.y - a.y) ** 0.5);
      const t1 = knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
      for (let s = 1; s < steps; s++) {
        const t = t1 + (t2 - t1) * s / steps;
        const lerp = (a: Point, b: Point, ta: number, tb: number) => {
          const w = tb === ta ? 0 : (t - ta) / (tb - ta);
          return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
        };
        const a1 = lerp(p0, p1, 0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
        const b1 = { x: a1.x + (a2.x - a1.x) * (t - 0) / t2, y: a1.y + (a2.y - a1.y) * (t - 0) / t2 };
        const b2 = { x: a2.x + (a3.x - a2.x) * (t - t1) / (t3 - t1), y: a2.y + (a3.y - a2.y) * (t - t1) / (t3 - t1) };
        const w = (t - t1) / (t2 - t1);
        out.push({ x: b1.x + (b2.x - b1.x) * w, y: b1.y + (b2.y - b1.y) * w, pressure: p1.pressure + (p2.pressure - p1.pressure) * s / steps });
      }
    }
    out.push(p2);
  }
  return out;
}
export function strokeOutline(stroke: Stroke, complete = true): number[][] {
  return getStroke(densify(stroke.points).map(point => [point.x, point.y, point.pressure]), {
    size: INK.base * strokeSize(stroke), thinning: INK.thinning, smoothing: INK.smoothing, streamline: INK.streamline,
    simulatePressure: false, last: complete, start: { cap: true }, end: { cap: true },
  });
}
export function fillOutline(context: CanvasRenderingContext2D, outline: readonly number[][]): void {
  const count = outline.length;
  if (count < 3) return;
  context.beginPath();
  const first = outline[0]!, second = outline[1]!;
  context.moveTo(first[0]!, first[1]!);
  context.quadraticCurveTo(second[0]!, second[1]!, (second[0]! + outline[2]![0]!) / 2, (second[1]! + outline[2]![1]!) / 2);
  for (let i = 2; i < count - 1; i++) {
    const a = outline[i]!, b = outline[i + 1]!;
    context.quadraticCurveTo(a[0]!, a[1]!, (a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2);
  }
  context.closePath();
  context.fill();
}
export function paintStroke(context: CanvasRenderingContext2D, stroke: Stroke, color: string, complete = true): void {
  if (!stroke.points.length) return;
  context.globalCompositeOperation = "source-over";
  context.fillStyle = color;
  if (stroke.points.length === 1) {
    // A tap: a round dot of the pen's width at that pressure.
    const point = stroke.points[0]!;
    context.beginPath();
    context.arc(point.x, point.y, strokeWidth(point, point, strokeSize(stroke)) / 2, 0, Math.PI * 2);
    context.fill();
    return;
  }
  fillOutline(context, strokeOutline(stroke, complete));
}
export function paintInk(canvas: HTMLCanvasElement, width: number, height: number, strokes: readonly Stroke[], color: string,
  origin: { x: number; y: number } = { x: 0, y: 0 }): void {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not create the drawing canvas.");
  context.resetTransform();
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.setTransform(canvas.width / width, 0, 0, canvas.height / height, origin.x * canvas.width / width, origin.y * canvas.height / height);
  for (const stroke of visibleStrokes(strokes)) paintStroke(context, stroke, color);
}
