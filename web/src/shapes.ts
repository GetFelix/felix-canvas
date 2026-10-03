import type { FieldValue, ShapeState, ShapeType } from "@felix-canvas/model";

import type { TextLayout } from "./textlayout.js";

/**
 * A shape as the renderer and tools see it. Rectangles and ellipses fill
 * `x, y, w, h`; a line runs from `x, y` to `x + w, y + h`; a stroke's points
 * are pairs relative to `x, y`, with `w, h` its extent. A text box's height,
 * and its width when it grows with its text, come from its layout.
 */
export interface Shape {
  id: bigint;
  type: ShapeType;
  x: number;
  y: number;
  w: number;
  h: number;
  z: string;
  points: number[];
  /** A text box with no set width, which grows with its longest line. */
  grows: boolean;
  /** The shape's text laid out, when it has any or is a text box. */
  text: TextLayout | null;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Selection handles: eight around a box, or a line's two ends. */
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "start" | "end";

export const STROKE_WIDTH = 2;

const number = (value: FieldValue | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/** Read a shape's fields, treating anything missing or malformed as zero. */
export function readShape(id: bigint, state: ShapeState): Shape {
  const { fields } = state;
  const points = Array.isArray(fields.points) ? fields.points.map((p) => number(p)) : [];
  return {
    id,
    type: fields.type as ShapeType,
    x: number(fields.x),
    y: number(fields.y),
    w: number(fields.w),
    h: number(fields.h),
    z: typeof fields.z === "string" ? fields.z : "",
    points,
    grows: fields.type === "text" && !(number(fields.w) > 0),
    text: null,
  };
}

/** The box a shape occupies, with a positive width and height. */
export function bounds(shape: Shape): Box {
  return normalize({ x: shape.x, y: shape.y, w: shape.w, h: shape.h });
}

export function normalize(box: Box): Box {
  return {
    x: Math.min(box.x, box.x + box.w),
    y: Math.min(box.y, box.y + box.h),
    w: Math.abs(box.w),
    h: Math.abs(box.h),
  };
}

export function union(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export function intersects(a: Box, b: Box): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

/** Whether world point `x, y` touches `shape`, within `slack` world units. */
export function hits(shape: Shape, x: number, y: number, slack: number): boolean {
  const box = bounds(shape);
  const reach = slack + STROKE_WIDTH / 2;
  if (
    x < box.x - reach ||
    x > box.x + box.w + reach ||
    y < box.y - reach ||
    y > box.y + box.h + reach
  ) {
    return false;
  }
  switch (shape.type) {
    case "rect":
    case "text":
      return true;
    case "ellipse": {
      const rx = box.w / 2 + reach;
      const ry = box.h / 2 + reach;
      const dx = (x - box.x - box.w / 2) / rx;
      const dy = (y - box.y - box.h / 2) / ry;
      return dx * dx + dy * dy <= 1;
    }
    case "line":
      return segmentDistance(x, y, shape.x, shape.y, shape.x + shape.w, shape.y + shape.h) <= reach;
    case "stroke": {
      const p = shape.points;
      if (p.length === 2) return Math.hypot(x - shape.x - p[0]!, y - shape.y - p[1]!) <= reach;
      for (let i = 2; i < p.length; i += 2) {
        const d = segmentDistance(x - shape.x, y - shape.y, p[i - 2]!, p[i - 1]!, p[i]!, p[i + 1]!);
        if (d <= reach) return true;
      }
      return false;
    }
  }
}

function segmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Where each handle of `shape` sits, in world units. Strokes have none. */
export function handles(shape: Shape): [Handle, number, number][] {
  if (shape.type === "line") {
    return [
      ["start", shape.x, shape.y],
      ["end", shape.x + shape.w, shape.y + shape.h],
    ];
  }
  if (shape.type === "stroke") return [];
  const { x, y, w, h } = bounds(shape);
  // A text box's height follows its text, so only its width can change.
  if (shape.type === "text") {
    return [
      ["w", x, y + h / 2],
      ["e", x + w, y + h / 2],
    ];
  }
  return [
    ["nw", x, y],
    ["n", x + w / 2, y],
    ["ne", x + w, y],
    ["e", x + w, y + h / 2],
    ["se", x + w, y + h],
    ["s", x + w / 2, y + h],
    ["sw", x, y + h],
    ["w", x, y + h / 2],
  ];
}

/** The geometry fields after dragging `handle` of `shape` to world point `x, y`. */
export function resize(shape: Shape, handle: Handle, x: number, y: number): Box {
  if (handle === "start") {
    return { x, y, w: shape.x + shape.w - x, h: shape.y + shape.h - y };
  }
  if (handle === "end") return { x: shape.x, y: shape.y, w: x - shape.x, h: y - shape.y };
  const box = bounds(shape);
  let left = box.x;
  let top = box.y;
  let right = box.x + box.w;
  let bottom = box.y + box.h;
  if (handle.includes("w")) left = x;
  if (handle.includes("e")) right = x;
  if (handle.includes("n")) top = y;
  if (handle.includes("s")) bottom = y;
  return normalize({ x: left, y: top, w: right - left, h: bottom - top });
}

/** The CSS cursor for a handle. */
export function handleCursor(handle: Handle): string {
  switch (handle) {
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    default:
      return "move";
  }
}
