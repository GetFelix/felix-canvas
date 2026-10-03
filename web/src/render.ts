import { STROKE_WIDTH, bounds, handles, textOrigin, type Box, type Shape } from "./shapes.js";
import { FLAG_MS, type PlacedCaret } from "./textcarets.js";
import { caretAt, drawLayout, selectionBoxes } from "./textlayout.js";

/** Which part of the world the canvas shows: `x, y` at its top-left corner. */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

/** Colours read from the theme's custom properties. */
export interface Palette {
  canvas: string;
  dot: string;
  ink: string;
  fill: string;
  accent: string;
  accentSoft: string;
  handle: string;
  /** Text colours by name; `ink` is the colour of text with none. */
  text: Record<string, string>;
  /** How strongly another person's text selection is tinted. */
  selectionAlpha: number;
}

/** Another session's selection, drawn in its colour. */
export interface PeerSelection {
  name: string;
  color: string;
  shapes: bigint[];
  /** The shape whose text they are editing, if any. */
  editing: bigint | null;
}

export interface Scene {
  shapes: Shape[];
  selection: ReadonlySet<bigint>;
  hover: bigint | null;
  draft: Shape | null;
  marquee: Box | null;
  peers: PeerSelection[];
  /** Hidden while a shape is moving under the pointer. */
  handles: boolean;
  /** The shape whose text is open in the editor, which draws it instead. */
  editing: bigint | null;
  /** Other people's carets in text the canvas draws. */
  carets: (PlacedCaret & { shape: bigint })[];
}

const GRID = 24;
const HANDLE = 8;
const TAG_FONT = '600 11px "Inter Variable", system-ui, sans-serif';

/** Draw one frame. `width` and `height` are CSS pixels. */
export function render(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  camera: Camera,
  palette: Palette,
  scene: Scene,
): void {
  const dpr = ctx.canvas.width / width;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = palette.canvas;
  ctx.fillRect(0, 0, width, height);
  drawGrid(ctx, width, height, camera, palette);

  const { zoom } = camera;
  ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, -camera.x * zoom * dpr, -camera.y * zoom * dpr);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const byId = new Map(scene.shapes.map((shape) => [shape.id, shape]));
  const textColor = (name: string | undefined) => palette.text[name ?? "ink"] ?? palette.ink;
  for (const shape of scene.draft ? [...scene.shapes, scene.draft] : scene.shapes) {
    drawShape(ctx, shape, palette);
    if (shape.text && shape.id !== scene.editing) {
      const { x, y } = textOrigin(shape);
      ctx.globalAlpha = palette.selectionAlpha;
      for (const { caret, anchor, head } of scene.carets) {
        if (caret.shape !== shape.id) continue;
        if (anchor.block === head.block && anchor.offset === head.offset) continue;
        ctx.fillStyle = caret.color;
        for (const box of selectionBoxes(shape.text, anchor, head)) {
          ctx.fillRect(x + box.x, y + box.y, box.w, box.h);
        }
      }
      ctx.globalAlpha = 1;
      drawLayout(ctx, shape.text, x, y, textColor);
    }
  }

  const hovered = scene.hover === null ? undefined : byId.get(scene.hover);
  if (hovered && !scene.selection.has(hovered.id)) {
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = 1.5 / zoom;
    trace(ctx, hovered);
    ctx.stroke();
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const toScreen = (box: Box): Box => ({
    x: (box.x - camera.x) * zoom,
    y: (box.y - camera.y) * zoom,
    w: box.w * zoom,
    h: box.h * zoom,
  });

  for (const peer of scene.peers) {
    const boxes = peer.shapes.flatMap((id) => {
      const shape = byId.get(id);
      return shape ? [toScreen(bounds(shape))] : [];
    });
    for (const [i, box] of boxes.entries()) {
      outline(ctx, box, peer.color);
      const tag = peer.editing === null ? peer.name : `${peer.name} · editing`;
      if (i === 0) nameTag(ctx, tag, peer.color, box.x - 1, box.y - 1);
    }
  }

  drawCarets(ctx, scene, byId, camera);

  if (scene.draft?.type === "text") outline(ctx, toScreen(bounds(scene.draft)), palette.accent);

  const selected = scene.shapes.filter((shape) => scene.selection.has(shape.id));
  for (const shape of selected) {
    if (shape.type === "line") continue;
    outline(ctx, toScreen(bounds(shape)), palette.accent);
  }
  if (scene.handles && selected.length === 1 && scene.editing === null) {
    const shape = selected[0]!;
    if (shape.type === "line") {
      ctx.strokeStyle = palette.accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo((shape.x - camera.x) * zoom, (shape.y - camera.y) * zoom);
      ctx.lineTo((shape.x + shape.w - camera.x) * zoom, (shape.y + shape.h - camera.y) * zoom);
      ctx.stroke();
    }
    for (const [, x, y] of handles(shape)) {
      const sx = Math.round((x - camera.x) * zoom) + 0.5;
      const sy = Math.round((y - camera.y) * zoom) + 0.5;
      ctx.fillStyle = palette.handle;
      ctx.strokeStyle = palette.accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (shape.type === "line") ctx.arc(sx, sy, HANDLE / 2 + 0.5, 0, Math.PI * 2);
      else ctx.roundRect(sx - HANDLE / 2, sy - HANDLE / 2, HANDLE, HANDLE, 1.5);
      ctx.fill();
      ctx.stroke();
    }
  }

  if (scene.marquee) {
    const box = toScreen(scene.marquee);
    ctx.fillStyle = palette.accentSoft;
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(box.x) + 0.5, Math.round(box.y) + 0.5, box.w, box.h);
  }
}

// One dot per tile, filled as a pattern: a fillRect per dot costs a frame's
// budget on a large screen without GPU canvas.
let gridTile: { key: string; pattern: CanvasPattern } | null = null;

function drawGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  camera: Camera,
  palette: Palette,
): void {
  let step = GRID * camera.zoom;
  while (step < 12) step *= 2;
  const dpr = ctx.canvas.width / width;
  const size = camera.zoom < 0.75 ? 1 : 1.5;
  const key = `${step}/${dpr}/${size}/${palette.dot}`;
  if (gridTile?.key !== key) {
    const tile = document.createElement("canvas");
    tile.width = tile.height = Math.max(1, Math.round(step * dpr));
    const tileCtx = tile.getContext("2d")!;
    tileCtx.fillStyle = palette.dot;
    const dot = size * dpr;
    tileCtx.fillRect(0, 0, dot, dot);
    gridTile = { key, pattern: ctx.createPattern(tile, "repeat")! };
  }
  const scale = step / (Math.round(step * dpr) / dpr);
  // Reduced to one tile: the pattern's transform loses precision far from the origin.
  const offsetX = modulo(-camera.x * camera.zoom, step) - size / 2;
  const offsetY = modulo(-camera.y * camera.zoom, step) - size / 2;
  gridTile.pattern.setTransform(
    new DOMMatrix().translateSelf(offsetX, offsetY).scaleSelf(scale / dpr, scale / dpr),
  );
  ctx.fillStyle = gridTile.pattern;
  ctx.fillRect(0, 0, width, height);
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function trace(ctx: CanvasRenderingContext2D, shape: Shape): void {
  ctx.beginPath();
  switch (shape.type) {
    case "rect":
    case "text": {
      const box = bounds(shape);
      ctx.rect(box.x, box.y, box.w, box.h);
      break;
    }
    case "ellipse": {
      const box = bounds(shape);
      ctx.ellipse(box.x + box.w / 2, box.y + box.h / 2, box.w / 2, box.h / 2, 0, 0, Math.PI * 2);
      break;
    }
    case "line":
      ctx.moveTo(shape.x, shape.y);
      ctx.lineTo(shape.x + shape.w, shape.y + shape.h);
      break;
    case "stroke": {
      // Quadratic curves through the midpoints between samples smooth the
      // polyline without moving it off the points the pointer reported.
      const p = shape.points;
      if (p.length < 2) break;
      ctx.moveTo(shape.x + p[0]!, shape.y + p[1]!);
      if (p.length === 2) {
        ctx.lineTo(shape.x + p[0]! + 0.01, shape.y + p[1]!);
        break;
      }
      for (let i = 2; i < p.length - 2; i += 2) {
        const mx = (p[i]! + p[i + 2]!) / 2;
        const my = (p[i + 1]! + p[i + 3]!) / 2;
        ctx.quadraticCurveTo(shape.x + p[i]!, shape.y + p[i + 1]!, shape.x + mx, shape.y + my);
      }
      ctx.lineTo(shape.x + p.at(-2)!, shape.y + p.at(-1)!);
      break;
    }
  }
}

function drawShape(ctx: CanvasRenderingContext2D, shape: Shape, palette: Palette): void {
  if (shape.type === "text") return;
  trace(ctx, shape);
  if (shape.type === "rect" || shape.type === "ellipse") {
    ctx.fillStyle = palette.fill;
    ctx.fill();
  }
  ctx.strokeStyle = palette.ink;
  ctx.lineWidth = STROKE_WIDTH;
  ctx.stroke();
}

/**
 * Other people's carets: a 2 px bar a line tall, with their name on a flag
 * while they type and for a moment after, then a small square cap.
 */
function drawCarets(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  byId: Map<bigint, Shape>,
  camera: Camera,
): void {
  const now = performance.now();
  for (const { caret, head, shape: id } of scene.carets) {
    const shape = byId.get(id);
    if (!shape?.text || id === scene.editing) continue;
    const at = caretAt(shape.text, head.block, head.offset);
    if (!at) continue;
    const origin = textOrigin(shape);
    const x = Math.round((origin.x + at.x - camera.x) * camera.zoom);
    const top = (origin.y + at.line.top - camera.y) * camera.zoom;
    const height = at.line.height * camera.zoom;
    ctx.fillStyle = caret.color;
    ctx.fillRect(x - 1, top, 2, height);
    // The flag shrinks into the cap over 140 ms once it has shown long enough.
    const shrink = Math.min(1, Math.max(0, (now - caret.movedAt - FLAG_MS) / 140));
    if (shrink < 1) {
      ctx.globalAlpha = 1 - shrink;
      nameTag(ctx, caret.name, caret.color, x - 1, top, 3);
      ctx.globalAlpha = 1;
    }
    if (shrink > 0) ctx.fillRect(x - 1, top - 6 * shrink, 6, 6 * shrink);
  }
}

function outline(ctx: CanvasRenderingContext2D, box: Box, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(Math.round(box.x) + 0.5, Math.round(box.y) + 0.5, box.w, box.h);
}

function nameTag(
  ctx: CanvasRenderingContext2D,
  name: string,
  color: string,
  x: number,
  y: number,
  radius = 4,
): void {
  ctx.font = TAG_FONT;
  const width = ctx.measureText(name).width + 12;
  const height = 18;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y - height - 2, width, height, radius);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  ctx.fillText(name, x + 6, y - height / 2 - 1.5);
}
