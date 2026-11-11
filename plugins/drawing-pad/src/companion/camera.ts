/** Companion view geometry. Both devices store ink in the Drawing Pad's world space:
 * CSS pixels around the frozen reference's center (geometry.ts). The iPad only
 * chooses a camera (translation + uniform scale); it never rescales stored ink, so
 * handwriting keeps its size and position on every screen and orientation. */
import { viewOrigin, type Offset } from "../geometry.ts";

export interface Camera { x: number; y: number; scale: number }
export const MIN_SCALE = 0.25, MAX_SCALE = 4;

/** Fit a wide reference to narrow (portrait) screens; never enlarge by default. */
export function fitScale(viewWidth: number, referenceWidth: number, margin = 16): number {
  if (!(viewWidth > 0) || !(referenceWidth > 0)) return 1;
  return clampScale(Math.min(1, (viewWidth - 2 * margin) / referenceWidth));
}
export function clampScale(scale: number): number {
  return Number.isFinite(scale) ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)) : 1;
}
/** Same anchoring rule as the desktop pad (reference bottom-centered with a 24px gap,
 * blank sheets centered) so a fresh iPad view shows the same region of the sheet. */
export function companionCamera(viewWidth: number, viewHeight: number, referenceWidth: number, referenceHeight: number,
  pan: Offset, scale = fitScale(viewWidth, referenceWidth)): Camera {
  const origin = viewOrigin(viewWidth, viewHeight, { x: 0, y: 0 }, referenceHeight * scale);
  return { x: origin.x + pan.x, y: origin.y + pan.y, scale };
}
export function screenToWorld(camera: Camera, x: number, y: number): Offset {
  return { x: (x - camera.x) / camera.scale, y: (y - camera.y) / camera.scale };
}
export function worldToScreen(camera: Camera, x: number, y: number): Offset {
  return { x: camera.x + x * camera.scale, y: camera.y + y * camera.scale };
}
/** Zoom around a fixed screen point (pinch center), returning the new pan. */
export function zoomPan(viewWidth: number, viewHeight: number, referenceWidth: number, referenceHeight: number,
  pan: Offset, scale: number, nextScale: number, focusX: number, focusY: number): Offset {
  const before = companionCamera(viewWidth, viewHeight, referenceWidth, referenceHeight, pan, scale);
  const world = screenToWorld(before, focusX, focusY);
  const after = companionCamera(viewWidth, viewHeight, referenceWidth, referenceHeight, { x: 0, y: 0 }, nextScale);
  return { x: focusX - world.x * nextScale - after.x, y: focusY - world.y * nextScale - after.y };
}
