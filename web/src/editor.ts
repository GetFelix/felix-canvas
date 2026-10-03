import {
  FONT_SIZES,
  TEXT_SHAPES,
  keyBetween,
  randomShapeId,
  type Doc,
  type FieldValue,
} from "@felix-canvas/model";

import type { Camera } from "./render.js";
import type { Session } from "./session.js";
import type { TextEditor } from "./texteditor.js";
import { LINE_HEIGHT, linkAt } from "./textlayout.js";
import {
  bounds,
  handleCursor,
  handles,
  hits,
  intersects,
  normalize,
  resize,
  textOrigin,
  union,
  type Box,
  type Handle,
  type Shape,
} from "./shapes.js";

export type Tool = "select" | "hand" | "rect" | "ellipse" | "line" | "pen" | "text";

interface Point {
  x: number;
  y: number;
}

type Gesture =
  | { kind: "pan"; from: Point; camera: Camera }
  | { kind: "press"; from: Point; screen: Point; id: bigint | null; toggle: boolean }
  | { kind: "move"; from: Point; origins: Map<bigint, Point> }
  | { kind: "resize"; shape: Shape; handle: Handle }
  | { kind: "marquee"; from: Point; base: Set<bigint> }
  | { kind: "draw"; from: Point; screen: Point }
  | { kind: "pen"; id: bigint; points: number[] };

/** Screen pixels a press must travel before it becomes a drag, so clicks never nudge. */
const DRAG_THRESHOLD = 3;
const HANDLE_REACH = 8;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const CAMERA_MS = 280;

/**
 * Turns pointer and keyboard input into edits. Everything it changes goes
 * through {@link Session.submit}, so the canvas only ever shows the replica.
 */
export class Editor {
  tool: Tool = "select";
  camera: Camera = { x: 0, y: 0, zoom: 1 };
  readonly selection = new Set<bigint>();
  hover: bigint | null = null;
  draft: Shape | null = null;
  marquee: Box | null = null;
  /** The pointer in world units, or `null` when it is off the canvas. */
  pointer: Point | null = null;
  /** Whether a shape is moving or resizing under the pointer right now. */
  dragging = false;
  /** Whether only the camera may move, as while looking at history. */
  readOnly = false;
  /** The address of a link in text under the pointer, which Cmd+click opens. */
  hoverLink: string | null = null;

  /** Called when anything drawn changed. */
  onChange: () => void = () => {};
  /** Called when the tool, selection or camera zoom changed. */
  onStateChange: () => void = () => {};
  /** Called when an edit was refused for want of a sequence number. */
  onRefused: () => void = () => {};

  readonly #canvas: HTMLCanvasElement;
  readonly #session: Session;
  readonly #shapes: () => Shape[];
  readonly #text: TextEditor;
  #gesture: Gesture | null = null;
  #space = false;
  #animation = 0;

  constructor(
    canvas: HTMLCanvasElement,
    session: Session,
    shapes: () => Shape[],
    text: TextEditor,
  ) {
    this.#canvas = canvas;
    this.#session = session;
    this.#shapes = shapes;
    this.#text = text;
    text.onClose = (id, abandoned) => {
      this.selection.clear();
      // A new text box left empty goes; anything else stays selected, so a second Esc deselects.
      if (abandoned) this.#submit("delete", id, {});
      else this.selection.add(id);
      this.onStateChange();
      this.onChange();
    };
    canvas.addEventListener("dblclick", (event) => {
      if (this.readOnly || this.tool !== "select") return;
      const shape = this.#topAt(this.#world(this.#screen(event)));
      if (shape && TEXT_SHAPES.includes(shape.type)) this.editText(shape, { at: event });
    });
    canvas.addEventListener("pointerdown", (event) => this.#down(event));
    canvas.addEventListener("pointermove", (event) => this.#move(event));
    canvas.addEventListener("pointerup", (event) => this.#up(event));
    canvas.addEventListener("pointercancel", () => this.cancel());
    canvas.addEventListener("pointerleave", () => {
      if (this.#gesture) return;
      this.pointer = null;
      this.hover = null;
      this.hoverLink = null;
      this.onChange();
    });
    canvas.addEventListener("wheel", (event) => this.#wheel(event), { passive: false });
    window.addEventListener("keydown", (event) => this.#keydown(event));
    window.addEventListener("keyup", (event) => {
      if (event.code === "Space") {
        this.#space = false;
        this.#updateCursor();
      }
    });
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.#text.close();
    this.cancel();
    if (tool !== "select") this.selection.clear();
    this.#updateCursor();
    this.onStateChange();
    this.onChange();
  }

  /** Allow edits, or stop them and let the pointer only pan. */
  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    this.#text.close();
    this.selection.clear();
    this.hover = null;
    this.cancel();
    this.#updateCursor();
    this.onStateChange();
  }

  /** Drop the gesture in progress without committing it. */
  cancel(): void {
    this.#gesture = null;
    this.draft = null;
    this.marquee = null;
    this.dragging = false;
    this.onChange();
  }

  /** Put the world point at the centre of the canvas, at 100%. */
  centre(x: number, y: number): void {
    const { width, height } = this.#size();
    this.#setCamera({ x: x - width / 2, y: y - height / 2, zoom: 1 });
  }

  /** Zoom by `factor` around a screen point, the canvas centre by default. */
  zoomBy(factor: number, at?: Point, animate = false): void {
    const { width, height } = this.#size();
    const anchor = at ?? { x: width / 2, y: height / 2 };
    const { x, y, zoom } = this.camera;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
    const target = {
      x: x + anchor.x / zoom - anchor.x / next,
      y: y + anchor.y / zoom - anchor.y / next,
      zoom: next,
    };
    if (animate) this.#animateTo(target);
    else this.#setCamera(target);
  }

  /** Fit `box`, or every shape when it is omitted, with a margin. */
  zoomToFit(box: Box | null = union(this.#shapes().map(bounds))): void {
    if (!box) return this.zoomBy(1 / this.camera.zoom, undefined, true);
    const { width, height } = this.#size();
    const margin = 96;
    const scale = Math.min(
      (width - margin * 2) / Math.max(box.w, 1),
      (height - margin * 2) / Math.max(box.h, 1),
    );
    // Fitting one small shape should not blow it up to fill the screen.
    const zoom = Math.min(2, Math.max(MIN_ZOOM, scale));
    this.#animateTo({
      x: box.x + box.w / 2 - width / 2 / zoom,
      y: box.y + box.h / 2 - height / 2 / zoom,
      zoom,
    });
  }

  /** Edit the text of `shape`, which keeps it selected. */
  editText(shape: Shape, options: Parameters<TextEditor["open"]>[2] = {}): void {
    this.selection.clear();
    this.selection.add(shape.id);
    this.#text.open(shape, this.camera, options);
    this.onStateChange();
    this.onChange();
  }

  /** Drop selected ids that no longer exist. Call after the view changes. */
  prune(): void {
    const present = new Set(this.#shapes().map((shape) => shape.id));
    // Someone else deleted the shape being edited. While rejoining, the canvas
    // can be older than the shape for a moment, which is not that.
    const gone = this.#text.shape !== null && !present.has(this.#text.shape);
    if (gone && this.#session.caughtUp) this.#text.close();
    let changed = false;
    for (const id of this.selection) {
      if (!present.has(id)) changed = this.selection.delete(id);
    }
    if (this.hover !== null && !present.has(this.hover)) this.hover = null;
    if (changed) this.onStateChange();
  }

  #size(): { width: number; height: number } {
    return { width: this.#canvas.clientWidth, height: this.#canvas.clientHeight };
  }

  #screen(event: PointerEvent | WheelEvent | MouseEvent): Point {
    const rect = this.#canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  #world(screen: Point): Point {
    return {
      x: this.camera.x + screen.x / this.camera.zoom,
      y: this.camera.y + screen.y / this.camera.zoom,
    };
  }

  #topAt(point: Point): Shape | undefined {
    const slack = 4 / this.camera.zoom;
    return this.#shapes().findLast((shape) => hits(shape, point.x, point.y, slack));
  }

  #handleAt(screen: Point): [Shape, Handle] | undefined {
    if (this.selection.size !== 1) return undefined;
    const shape = this.#shapes().find((candidate) => this.selection.has(candidate.id));
    if (!shape) return undefined;
    for (const [handle, x, y] of handles(shape)) {
      const sx = (x - this.camera.x) * this.camera.zoom;
      const sy = (y - this.camera.y) * this.camera.zoom;
      if (Math.abs(sx - screen.x) <= HANDLE_REACH && Math.abs(sy - screen.y) <= HANDLE_REACH) {
        return [shape, handle];
      }
    }
    return undefined;
  }

  #down(event: PointerEvent): void {
    if (event.button === 2) return;
    this.#canvas.setPointerCapture(event.pointerId);
    cancelAnimationFrame(this.#animation);
    // A click outside the text being edited stops editing, then acts as usual.
    this.#text.close();
    const screen = this.#screen(event);
    const point = this.#world(screen);
    const link = (event.metaKey || event.ctrlKey) && event.button === 0 && this.#linkAt(point);
    if (link) {
      window.open(link, "_blank", "noopener,noreferrer");
      return;
    }
    if (event.button === 1 || this.tool === "hand" || this.#space || this.readOnly) {
      this.#gesture = { kind: "pan", from: screen, camera: { ...this.camera } };
      this.#canvas.style.cursor = "grabbing";
      return;
    }
    switch (this.tool) {
      case "select": {
        const handle = this.#handleAt(screen);
        if (handle) {
          this.#gesture = { kind: "resize", shape: handle[0], handle: handle[1] };
          this.dragging = true;
          return;
        }
        const shape = this.#topAt(point);
        if (!shape) {
          if (!event.shiftKey) this.selection.clear();
          this.#gesture = { kind: "marquee", from: point, base: new Set(this.selection) };
          this.onStateChange();
          return;
        }
        const wasSelected = this.selection.has(shape.id);
        if (!wasSelected) {
          if (!event.shiftKey) this.selection.clear();
          this.selection.add(shape.id);
          this.onStateChange();
        }
        this.#gesture = {
          kind: "press",
          from: point,
          screen,
          id: shape.id,
          toggle: wasSelected && event.shiftKey,
        };
        this.onChange();
        return;
      }
      case "text": {
        const shape = this.#topAt(point);
        if (shape && TEXT_SHAPES.includes(shape.type)) {
          this.editText(shape, { at: event });
          this.setToolQuietly("select");
          return;
        }
        this.#gesture = { kind: "draw", from: point, screen };
        this.draft = this.#drawn(point, point, false);
        this.onChange();
        return;
      }
      case "pen":
        this.#gesture = {
          kind: "pen",
          id: randomShapeId(),
          points: [round1(point.x), round1(point.y)],
        };
        this.draft = penShape(this.#gesture.id, this.#gesture.points);
        this.onChange();
        return;
      default:
        this.#gesture = { kind: "draw", from: point, screen };
        this.draft = this.#drawn(point, point, false);
        this.onChange();
    }
  }

  #move(event: PointerEvent): void {
    const screen = this.#screen(event);
    const point = this.#world(screen);
    this.pointer = point;
    const gesture = this.#gesture;
    if (!gesture) {
      this.#hoverAt(screen, point);
      this.onChange();
      return;
    }
    switch (gesture.kind) {
      case "pan":
        this.#setCamera({
          ...gesture.camera,
          x: gesture.camera.x - (screen.x - gesture.from.x) / gesture.camera.zoom,
          y: gesture.camera.y - (screen.y - gesture.from.y) / gesture.camera.zoom,
        });
        break;
      case "press": {
        const moved = Math.hypot(screen.x - gesture.screen.x, screen.y - gesture.screen.y);
        if (moved < DRAG_THRESHOLD) break;
        const origins = new Map<bigint, Point>();
        for (const shape of this.#shapes()) {
          if (this.selection.has(shape.id)) origins.set(shape.id, { x: shape.x, y: shape.y });
        }
        this.#gesture = { kind: "move", from: gesture.from, origins };
        this.dragging = true;
        this.#move(event);
        return;
      }
      case "move": {
        let dx = point.x - gesture.from.x;
        let dy = point.y - gesture.from.y;
        if (event.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        for (const [id, origin] of gesture.origins) {
          this.#submit("patch", id, {
            x: Math.round(origin.x + dx),
            y: Math.round(origin.y + dy),
          });
        }
        break;
      }
      case "resize": {
        const box = resize(gesture.shape, gesture.handle, point.x, point.y);
        this.#submit("patch", gesture.shape.id, {
          x: Math.round(box.x),
          y: Math.round(box.y),
          w: Math.round(box.w),
          h: Math.round(box.h),
        });
        break;
      }
      case "marquee": {
        this.marquee = normalize({
          x: gesture.from.x,
          y: gesture.from.y,
          w: point.x - gesture.from.x,
          h: point.y - gesture.from.y,
        });
        this.selection.clear();
        for (const id of gesture.base) this.selection.add(id);
        for (const shape of this.#shapes()) {
          if (intersects(this.marquee, bounds(shape))) this.selection.add(shape.id);
        }
        this.onStateChange();
        break;
      }
      case "draw":
        this.draft = this.#drawn(gesture.from, point, event.shiftKey);
        break;
      case "pen": {
        const samples = event.getCoalescedEvents?.() ?? [event];
        for (const sample of samples.length ? samples : [event]) {
          const at = this.#world(this.#screen(sample));
          const p = gesture.points;
          if (Math.hypot(at.x - p.at(-2)!, at.y - p.at(-1)!) * this.camera.zoom < 2) continue;
          p.push(round1(at.x), round1(at.y));
        }
        this.draft = penShape(gesture.id, gesture.points);
        break;
      }
    }
    this.onChange();
  }

  #up(event: PointerEvent): void {
    const gesture = this.#gesture;
    this.#gesture = null;
    this.dragging = false;
    if (!gesture) return;
    switch (gesture.kind) {
      case "pan":
        this.#updateCursor();
        break;
      case "press":
        if (gesture.toggle && gesture.id !== null) {
          this.selection.delete(gesture.id);
          this.onStateChange();
        }
        break;
      case "marquee":
        this.marquee = null;
        break;
      case "draw": {
        const screen = this.#screen(event);
        const travelled = Math.hypot(screen.x - gesture.screen.x, screen.y - gesture.screen.y);
        let draft = this.draft;
        this.draft = null;
        if (!draft) break;
        if (draft.type === "text") {
          this.#createText(draft, travelled < DRAG_THRESHOLD);
          break;
        }
        if (travelled < DRAG_THRESHOLD) {
          if (draft.type === "line") break;
          draft = { ...draft, x: gesture.from.x - 60, y: gesture.from.y - 40, w: 120, h: 80 };
        }
        const { id, type, x, y, w, h } = draft;
        const fields = {
          type,
          x: Math.round(x),
          y: Math.round(y),
          w: Math.round(w),
          h: Math.round(h),
        };
        if (this.#create(id, fields)) {
          this.selection.clear();
          this.selection.add(id);
          this.setTool("select");
        }
        break;
      }
      case "pen": {
        const draft = this.draft;
        this.draft = null;
        if (draft) {
          this.#create(draft.id, {
            type: "stroke",
            x: draft.x,
            y: draft.y,
            w: draft.w,
            h: draft.h,
            points: draft.points,
          });
        }
        break;
      }
    }
    this.onChange();
  }

  #wheel(event: WheelEvent): void {
    event.preventDefault();
    cancelAnimationFrame(this.#animation);
    if (event.ctrlKey || event.metaKey) {
      this.zoomBy(Math.exp(-event.deltaY * 0.01), this.#screen(event));
      return;
    }
    const { x, y, zoom } = this.camera;
    this.#setCamera({ x: x + event.deltaX / zoom, y: y + event.deltaY / zoom, zoom });
  }

  #keydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, [contenteditable], dialog[open]")) return;
    const mod = event.metaKey || event.ctrlKey;
    if (this.#cameraKey(event)) return;
    if (this.readOnly) return;
    if (event.code === "Space") {
      if (!this.#space) {
        this.#space = true;
        this.#updateCursor();
      }
      event.preventDefault();
      return;
    }
    if (mod) {
      const key = event.key.toLowerCase();
      if (key === "d") this.#duplicate();
      else if (key === "a") this.#selectAll();
      else return;
      event.preventDefault();
      return;
    }
    const tools: Record<string, Tool> = {
      v: "select",
      h: "hand",
      r: "rect",
      o: "ellipse",
      l: "line",
      p: "pen",
      d: "pen",
      t: "text",
    };
    const tool = event.altKey ? undefined : tools[event.key.toLowerCase()];
    if (tool && !event.shiftKey) return this.setTool(tool);
    switch (event.key) {
      case "Enter": {
        const [only] = this.selection;
        const shape = this.#shapes().find((candidate) => candidate.id === only);
        if (this.selection.size !== 1 || !shape || !TEXT_SHAPES.includes(shape.type)) return;
        event.preventDefault();
        this.editText(shape, { selectAll: true });
        return;
      }
      case "Escape":
        if (this.#gesture) return this.cancel();
        this.selection.clear();
        this.setTool("select");
        return;
      case "Backspace":
      case "Delete":
        for (const id of this.selection) this.#submit("delete", id, {});
        this.selection.clear();
        this.onStateChange();
        return;
      case "]":
      case "[":
        this.#restack(event.key === "]" ? 1 : -1);
        return;
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown": {
        if (this.selection.size === 0) return;
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
        const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        for (const shape of this.#shapes()) {
          if (!this.selection.has(shape.id)) continue;
          this.#submit("patch", shape.id, { x: shape.x + dx, y: shape.y + dy });
        }
      }
    }
  }

  /** Zoom shortcuts, which work whether or not the canvas can be edited. Returns whether it was one. */
  #cameraKey(event: KeyboardEvent): boolean {
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (mod && (key === "=" || key === "+")) this.zoomBy(1.25, undefined, true);
    else if (mod && key === "-") this.zoomBy(0.8, undefined, true);
    else if (event.shiftKey && event.code === "Digit1") this.zoomToFit();
    else if (event.shiftKey && event.code === "Digit2") this.zoomToFit(this.#selectedBox());
    else if (event.shiftKey && event.code === "Digit0")
      this.zoomBy(1 / this.camera.zoom, undefined, true);
    else return false;
    event.preventDefault();
    return true;
  }

  /** The address of a link in shape text at world `point`, if there is one. */
  #linkAt(point: Point): string | null {
    const shape = this.#topAt(point);
    if (!shape?.text) return null;
    const origin = textOrigin(shape);
    return linkAt(shape.text, point.x - origin.x, point.y - origin.y);
  }

  #hoverAt(screen: Point, point: Point): void {
    this.hoverLink = this.#space ? null : this.#linkAt(point);
    if (this.tool !== "select" || this.#space || this.readOnly) {
      this.hover = null;
      return;
    }
    const handle = this.#handleAt(screen);
    this.hover = handle ? null : (this.#topAt(point)?.id ?? null);
    this.#canvas.style.cursor = handle ? handleCursor(handle[1]) : "";
  }

  #updateCursor(): void {
    const canvas = this.#canvas;
    if (this.#space || this.tool === "hand" || this.readOnly) canvas.style.cursor = "grab";
    else if (this.tool === "select") canvas.style.cursor = "";
    else if (this.tool === "text") canvas.style.cursor = "text";
    else canvas.style.cursor = "crosshair";
  }

  #drawn(from: Point, to: Point, constrain: boolean): Shape {
    let w = to.x - from.x;
    let h = to.y - from.y;
    const type =
      this.tool === "ellipse" || this.tool === "line" || this.tool === "text" ? this.tool : "rect";
    if (constrain && type === "line") {
      const angle = Math.round(Math.atan2(h, w) / (Math.PI / 12)) * (Math.PI / 12);
      const length = Math.hypot(w, h);
      w = Math.cos(angle) * length;
      h = Math.sin(angle) * length;
    } else if (constrain) {
      const side = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * side;
      h = Math.sign(h || 1) * side;
    }
    const box =
      type === "line" ? { x: from.x, y: from.y, w, h } : normalize({ x: from.x, y: from.y, w, h });
    return {
      id: this.draft?.id ?? randomShapeId(),
      type,
      ...box,
      z: "",
      points: [],
      grows: false,
      text: null,
    };
  }

  /**
   * Make a text box from the text tool's gesture and start typing in it: a
   * click makes one that grows as you type, with the first line centred on
   * the click; a drag sets its width.
   */
  #createText(draft: Shape, click: boolean): void {
    const line = FONT_SIZES.medium * LINE_HEIGHT;
    const fields = click
      ? { type: "text", x: Math.round(draft.x), y: Math.round(draft.y - line / 2), w: 0 }
      : { type: "text", x: Math.round(draft.x), y: Math.round(draft.y), w: Math.round(draft.w) };
    if (!this.#create(draft.id, fields)) return;
    this.setToolQuietly("select");
    const shape = this.#shapes().find((candidate) => candidate.id === draft.id);
    if (shape) this.editText(shape, { fresh: true });
  }

  /** Change tool without stopping the text being edited. */
  setToolQuietly(tool: Tool): void {
    this.tool = tool;
    this.#updateCursor();
    this.onStateChange();
  }

  #create(id: bigint, fields: Record<string, FieldValue>): boolean {
    return this.#submit("create", id, { ...fields, z: this.#topKey() });
  }

  /** A z key above every shape. */
  #topKey(): string {
    return keyBetween(this.#shapes().at(-1)?.z || null, null);
  }

  #submit(kind: "create" | "patch" | "delete", id: bigint, fields: Record<string, FieldValue>) {
    const accepted = this.#session.submit(kind, id, fields);
    if (!accepted) this.onRefused();
    return accepted;
  }

  #duplicate(): void {
    const view: Doc = this.#session.replica.view();
    const copies: bigint[] = [];
    let z = this.#topKey();
    for (const shape of this.#shapes()) {
      const state = view.shapes.get(shape.id);
      if (!this.selection.has(shape.id) || !state) continue;
      const id = randomShapeId();
      z = copies.length === 0 ? z : keyBetween(z, null);
      const fields = { ...state.fields, x: shape.x + 16, y: shape.y + 16, z };
      if (this.#submit("create", id, fields)) copies.push(id);
    }
    if (copies.length === 0) return;
    this.selection.clear();
    for (const id of copies) this.selection.add(id);
    this.onStateChange();
  }

  #selectAll(): void {
    this.setTool("select");
    for (const shape of this.#shapes()) this.selection.add(shape.id);
    this.onStateChange();
    this.onChange();
  }

  #selectedBox(): Box | null {
    return union(
      this.#shapes()
        .filter((s) => this.selection.has(s.id))
        .map(bounds),
    );
  }

  // One step up or down the stack: a new z key between the next shape over
  // and the one past it, which is what fractional indexing is for.
  #restack(direction: 1 | -1): void {
    const order = this.#shapes();
    const indices = order.flatMap((shape, i) => (this.selection.has(shape.id) ? [i] : []));
    if (direction > 0) indices.reverse();
    for (const i of indices) {
      const shape = order[i]!;
      const neighbour = order[i + direction];
      if (!neighbour || this.selection.has(neighbour.id)) continue;
      const beyond = order[i + direction * 2]?.z || null;
      let z: string;
      try {
        z = direction > 0 ? keyBetween(neighbour.z, beyond) : keyBetween(beyond, neighbour.z);
      } catch {
        // Concurrent restacks can leave two neighbours with one key. Going to
        // the very top or bottom still moves the shape the right way.
        z =
          direction > 0
            ? keyBetween(order.at(-1)!.z || null, null)
            : keyBetween(null, order[0]!.z || null);
      }
      this.#submit("patch", shape.id, { z });
      order.splice(i, 1);
      order.splice(i + direction, 0, { ...shape, z });
    }
  }

  #setCamera(camera: Camera): void {
    this.camera = camera;
    this.onStateChange();
    this.onChange();
  }

  #animateTo(target: Camera): void {
    cancelAnimationFrame(this.#animation);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return this.#setCamera(target);
    const from = { ...this.camera };
    const start = performance.now();
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / CAMERA_MS);
      const e = easeInOut(t);
      // Interpolate the zoom geometrically, so it feels even in and out.
      const zoom = from.zoom * (target.zoom / from.zoom) ** e;
      this.#setCamera({
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
        zoom,
      });
      if (t < 1) this.#animation = requestAnimationFrame(frame);
    };
    this.#animation = requestAnimationFrame(frame);
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** A stroke in progress, with its points made relative to its corner. */
function penShape(id: bigint, absolute: number[]): Shape {
  const xs = absolute.filter((_, i) => i % 2 === 0);
  const ys = absolute.filter((_, i) => i % 2 === 1);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    id,
    type: "stroke",
    x,
    y,
    w: round1(Math.max(...xs) - x),
    h: round1(Math.max(...ys) - y),
    z: "",
    points: absolute.map((value, i) => round1(value - (i % 2 === 0 ? x : y))),
    grows: false,
    text: null,
  };
}

// The cubic-bezier(0.77, 0, 0.175, 1) the brief gives camera moves, as a
// quartic in-out it closely matches.
function easeInOut(t: number): number {
  return t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2;
}
