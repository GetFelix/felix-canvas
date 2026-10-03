import { STROKE_WIDTH, bounds, handles, type Box, type Shape } from "./shapes.js";

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
}

/** Another session's selection, drawn in its colour. */
export interface PeerSelection {
  name: string;
  color: string;
  shapes: bigint[];
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
  for (const shape of scene.draft ? [...scene.shapes, scene.draft] : scene.shapes) {
    drawShape(ctx, shape, palette);
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
      if (i === 0) nameTag(ctx, peer.name, peer.color, box.x - 1, box.y - 1);
    }
  }

  const selected = scene.shapes.filter((shape) => scene.selection.has(shape.id));
  for (const shape of selected) {
    if (shape.type === "line") continue;
    outline(ctx, toScreen(bounds(shape)), palette.accent);
  }
  if (scene.handles && selected.length === 1) {
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
  const offsetX = -camera.x * camera.zoom - size / 2;
  const offsetY = -camera.y * camera.zoom - size / 2;
  gridTile.pattern.setTransform(
    new DOMMatrix().translateSelf(offsetX, offsetY).scaleSelf(scale / dpr, scale / dpr),
  );
  ctx.fillStyle = gridTile.pattern;
  ctx.fillRect(0, 0, width, height);
}

function trace(ctx: CanvasRenderingContext2D, shape: Shape): void {
  ctx.beginPath();
  switch (shape.type) {
    case "rect": {
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
  trace(ctx, shape);
  if (shape.type === "rect" || shape.type === "ellipse") {
    ctx.fillStyle = palette.fill;
    ctx.fill();
  }
  ctx.strokeStyle = palette.ink;
  ctx.lineWidth = STROKE_WIDTH;
  ctx.stroke();
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
): void {
  ctx.font = TAG_FONT;
  const width = ctx.measureText(name).width + 12;
  const height = 18;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y - height - 2, width, height, 4);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  ctx.fillText(name, x + 6, y - height / 2 - 1.5);
}
