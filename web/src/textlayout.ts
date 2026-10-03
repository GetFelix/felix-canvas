import { FONT_SIZES, type TextBlock, type TextMarks } from "@felix-canvas/model";

// These match `.text-body` in styles.css, which the editor uses. The two must
// agree, or text moves when the editor opens.
export const FONT_FAMILY = '"Inter Variable", system-ui, sans-serif';
/** Font sizes of heading levels 1 to 3. */
export const HEADING_SIZES = [28, 22, 18] as const;
export const LINE_HEIGHT = 1.4;
export const HEADING_LINE_HEIGHT = 1.25;
/** How far each list level indents its text, in canvas units. */
export const LIST_INDENT = 24;
/** Space between a box's edge and the text inside a rectangle or ellipse. */
export const BOX_PADDING = 8;

/** One piece of a line drawn in a single font and colour. */
export interface Segment {
  x: number;
  width: number;
  text: string;
  font: string;
  /** Font size, in canvas units. */
  size: number;
  marks: TextMarks;
  /** Character offset in its block where it starts. */
  start: number;
}

export interface Line {
  block: number;
  /** Top of the line box, from the top of the body. */
  top: number;
  height: number;
  /** Baseline, from the top of the body. */
  baseline: number;
  /** Left edge of the text, after any list indent. */
  left: number;
  /** Character offsets in the block this line covers. */
  start: number;
  end: number;
  segments: Segment[];
  /** A list marker drawn in the gutter, on the first line of an item. */
  marker: { text: string; font: string; x: number } | null;
}

export interface TextLayout {
  /** The width of the widest line. */
  width: number;
  height: number;
  lines: Line[];
}

const measurer = document.createElement("canvas").getContext("2d")!;
measurer.fontKerning = "normal";

let generation = 0;
let ready = false;

/**
 * Resolves once Inter has loaded. Measuring before then would measure a
 * fallback font and break lines in the wrong places, so layouts made earlier
 * are made again afterwards.
 */
export const fontsLoaded: Promise<void> = Promise.all(
  ["400", "700", "italic 400", "italic 700"].map((style) =>
    document.fonts.load(`${style} 16px ${FONT_FAMILY}`),
  ),
).then(() => {
  ready = true;
  generation++;
});

/** Whether layouts are measured in Inter yet. */
export function fontsReady(): boolean {
  return ready;
}

/** The CSS font for a run in a block. */
export function fontOf(block: TextBlock, marks: TextMarks): string {
  const heading = block.heading > 0;
  const size = sizeOf(block, marks);
  const weight = marks.b ? (heading ? 800 : 700) : heading ? 650 : 400;
  return `${marks.i ? "italic " : ""}${weight} ${size}px ${FONT_FAMILY}`;
}

function sizeOf(block: TextBlock, marks: TextMarks): number {
  if (marks.size) return FONT_SIZES[marks.size];
  return block.heading > 0 ? HEADING_SIZES[block.heading - 1]! : FONT_SIZES.medium;
}

function blockFont(block: TextBlock): { font: string; size: number } {
  return { font: fontOf(block, {}), size: sizeOf(block, {}) };
}

function lineHeightOf(block: TextBlock): number {
  return block.heading > 0 ? HEADING_LINE_HEIGHT : LINE_HEIGHT;
}

const cache = new WeakMap<TextBlock[], { width: number; generation: number; layout: TextLayout }>();

/**
 * Lay out a body's content at `width` canvas units, or as wide as its longest
 * line when `width` is `Infinity`. Layouts are cached per content and width.
 */
export function layout(content: TextBlock[], width: number): TextLayout {
  const hit = cache.get(content);
  if (hit && hit.width === width && hit.generation === generation) return hit.layout;
  const result = layoutBlocks(content, width);
  cache.set(content, { width, generation, layout: result });
  return result;
}

const words = new Intl.Segmenter(undefined, { granularity: "word" });
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function layoutBlocks(content: TextBlock[], width: number): TextLayout {
  const lines: Line[] = [];
  let top = 0;
  let widest = 0;
  const blocks = content.length > 0 ? content : [{ heading: 0, lists: [], item: null, runs: [] }];
  for (const [index, block] of blocks.entries()) {
    const left = block.lists.length * LIST_INDENT;
    const available = Math.max(1, width - left);
    const text = block.runs.map((run) => run.text).join("");
    const ranges = breakLines(block, text, available);
    for (const [i, [start, end]] of ranges.entries()) {
      const line = buildLine(block, index, start, end, top, left);
      if (i === 0) line.marker = markerOf(block, left);
      lines.push(line);
      top += line.height;
      const last = line.segments.at(-1);
      widest = Math.max(widest, left + (last ? last.x + trimmedWidth(last) : 0));
    }
  }
  return { width: widest, height: top, lines };
}

function trimmedWidth(segment: Segment): number {
  const trimmed = segment.text.trimEnd();
  if (trimmed === segment.text) return segment.width;
  measurer.font = segment.font;
  return measurer.measureText(trimmed).width;
}

/** The width of `text[from, to)` with each character in its run's font. */
function measure(block: TextBlock, from: number, to: number): number {
  let width = 0;
  let at = 0;
  for (const run of block.runs) {
    const end = at + run.text.length;
    const a = Math.max(from, at);
    const b = Math.min(to, end);
    if (a < b) {
      measurer.font = fontOf(block, run.marks);
      width += measurer.measureText(run.text.slice(a - at, b - at)).width;
    }
    at = end;
    if (at >= to) break;
  }
  return width;
}

/**
 * Break one block into lines, greedily, the way the editor's CSS does with
 * `white-space: pre-wrap` and `overflow-wrap: anywhere`: a line may end after
 * a space, trailing spaces hang past the edge, and a word wider than a whole
 * line breaks between characters.
 */
function breakLines(block: TextBlock, text: string, width: number): [number, number][] {
  const lines: [number, number][] = [];
  let paragraph = 0;
  for (const part of text.split("\n")) {
    const offset = paragraph;
    paragraph += part.length + 1;
    if (part.length === 0) {
      lines.push([offset, offset]);
      continue;
    }
    let start = 0;
    let end = 0;
    const fits = (to: number) =>
      measure(block, offset + start, offset + trimEnd(part, to)) <= width;
    for (const piece of pieces(part)) {
      if (fits(piece.end)) {
        end = piece.end;
        continue;
      }
      if (end > start) {
        lines.push([offset + start, offset + end]);
        start = piece.start;
        if (fits(piece.end)) {
          end = piece.end;
          continue;
        }
      }
      // Wider than a line on its own: break it between characters.
      for (const { index, segment } of graphemes.segment(part.slice(piece.start, piece.end))) {
        const to = piece.start + index + segment.length;
        if (to - segment.length > start && !fits(to)) {
          lines.push([offset + start, offset + piece.start + index]);
          start = piece.start + index;
        }
        end = to;
      }
    }
    lines.push([offset + start, offset + end]);
  }
  return lines;
}

function trimEnd(text: string, to: number): number {
  while (to > 0 && /\s/.test(text[to - 1]!)) to--;
  return to;
}

/**
 * The pieces a line can break between: each runs up to and including the
 * spaces after it. Word boundaries come from `Intl.Segmenter`; only those
 * after a space, after a hyphen inside a word, or around an ideograph allow
 * a break, as in CSS line breaking.
 */
function pieces(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = 0;
  for (const { index } of words.segment(text)) {
    if (index === 0 || !breaksBefore(text, index)) continue;
    out.push({ start, end: index });
    start = index;
  }
  out.push({ start, end: text.length });
  return out;
}

const IDEOGRAPH = /\p{Ideographic}/u;

function breaksBefore(text: string, index: number): boolean {
  const before = text[index - 1]!;
  const after = text[index]!;
  if (/\s/.test(after)) return false;
  if (/\s/.test(before)) return true;
  if (before === "-") return /\p{L}/u.test(text[index - 2] ?? "") && /\p{L}/u.test(after);
  return IDEOGRAPH.test(before) || IDEOGRAPH.test(after);
}

interface Metrics {
  ascent: number;
  descent: number;
}
const metricsCache = new Map<string, Metrics>();

// Rounded as Blink rounds a font's ascent and descent, so mixed sizes on one
// line stack the same way in the canvas and in the editor.
function metrics(font: string): Metrics {
  let found = metricsCache.get(font);
  if (!found) {
    measurer.font = font;
    const m = measurer.measureText("Hg");
    found = {
      ascent: Math.round(m.fontBoundingBoxAscent),
      descent: Math.round(m.fontBoundingBoxDescent),
    };
    if (ready) metricsCache.set(font, found);
  }
  return found;
}

function buildLine(
  block: TextBlock,
  index: number,
  start: number,
  end: number,
  top: number,
  left: number,
): Line {
  const factor = lineHeightOf(block);
  // The block's own font sets a strut every line has, as CSS does.
  const strut = blockFont(block);
  let above = 0;
  let below = 0;
  const extend = (font: string, size: number) => {
    const { ascent, descent } = metrics(font);
    const half = (size * factor - ascent - descent) / 2;
    above = Math.max(above, ascent + half);
    below = Math.max(below, descent + half);
  };
  extend(strut.font, strut.size);

  const segments: Segment[] = [];
  let x = 0;
  let at = 0;
  for (const run of block.runs) {
    const runEnd = at + run.text.length;
    const a = Math.max(start, at);
    const b = Math.min(end, runEnd);
    if (a < b) {
      const font = fontOf(block, run.marks);
      measurer.font = font;
      const text = run.text.slice(a - at, b - at);
      const width = measurer.measureText(text).width;
      const size = sizeOf(block, run.marks);
      segments.push({ x, width, text, font, size, marks: run.marks, start: a });
      extend(font, size);
      x += width;
    }
    at = runEnd;
  }
  return {
    block: index,
    top,
    height: above + below,
    baseline: top + above,
    left,
    start,
    end,
    segments,
    marker: null,
  };
}

// The same markers as `.text-body li::marker` in styles.css, each with the
// space after it, so it ends where the item's text starts.
const BULLETS = ["• ", "◦ ", "▪ "];

function markerOf(block: TextBlock, left: number): Line["marker"] {
  const kind = block.lists.at(-1);
  if (!kind || block.item === null) return null;
  const font = fontOf({ ...block, heading: 0 }, {});
  const text = kind === "ol" ? `${block.item}. ` : BULLETS[(block.lists.length - 1) % 3]!;
  measurer.font = font;
  return { text, font, x: left - measurer.measureText(text).width };
}

// Match `text-underline-offset` and `text-decoration-thickness` in styles.css.
const UNDERLINE_OFFSET = 0.15;
const UNDERLINE_THICKNESS = 1 / 16;

/**
 * Draw a layout with its top-left corner at `x, y`, in the current
 * transform's units. `color` gives the colour for a run's colour mark, or for
 * none.
 */
export function drawLayout(
  ctx: CanvasRenderingContext2D,
  result: TextLayout,
  x: number,
  y: number,
  color: (name: string | undefined) => string,
): void {
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fontKerning = "normal";
  for (const line of result.lines) {
    const baseline = y + line.baseline;
    if (line.marker) {
      ctx.font = line.marker.font;
      ctx.fillStyle = color(undefined);
      ctx.fillText(line.marker.text, x + line.marker.x, baseline);
    }
    for (const [i, segment] of line.segments.entries()) {
      const left = x + line.left + segment.x;
      ctx.font = segment.font;
      ctx.fillStyle = color(segment.marks.color);
      ctx.fillText(segment.text, left, baseline);
      if (segment.marks.u || segment.marks.a) {
        // Spaces hanging past the end of a line are not underlined.
        const last = i === line.segments.length - 1;
        const width = last ? trimmedWidth(segment) : segment.width;
        const thickness = segment.size * UNDERLINE_THICKNESS;
        ctx.fillRect(left, baseline + segment.size * UNDERLINE_OFFSET, width, thickness);
      }
    }
  }
}

/** Where in the layout a block offset falls: the line and the x within the body. */
export function caretAt(
  result: TextLayout,
  block: number,
  offset: number,
): { line: Line; x: number } | null {
  const candidates = result.lines.filter((line) => line.block === block);
  const line =
    candidates.find((candidate) => offset >= candidate.start && offset < candidate.end) ??
    candidates.findLast((candidate) => offset >= candidate.start) ??
    candidates[0];
  if (!line) return null;
  let x = line.left;
  for (const segment of line.segments) {
    if (offset <= segment.start) break;
    const within = Math.min(offset - segment.start, segment.text.length);
    measurer.font = segment.font;
    x = line.left + segment.x + measurer.measureText(segment.text.slice(0, within)).width;
  }
  return { line, x };
}

/** The run of text a link mark covers at a point in the body, if any. */
export function linkAt(result: TextLayout, x: number, y: number): string | null {
  for (const line of result.lines) {
    if (y < line.top || y > line.top + line.height) continue;
    for (const segment of line.segments) {
      const left = line.left + segment.x;
      if (segment.marks.a && x >= left && x <= left + segment.width) return segment.marks.a;
    }
  }
  return null;
}

/** The text of each line, for comparing with the editor's lines. */
export function lineTexts(result: TextLayout): string[] {
  return result.lines.map((line) => line.segments.map((segment) => segment.text).join(""));
}
