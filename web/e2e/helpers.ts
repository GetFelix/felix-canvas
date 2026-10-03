import {
  encodeOp,
  randomSessionId,
  textClientId,
  type Op,
  type TextBlock,
} from "@felix-canvas/model";
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import * as Y from "yjs";

interface Replica {
  hash(): string;
  applied(): number;
  pending(): number;
  shapes(): number;
  firstFrameMs(): number | null;
  snapshotOffset(): number | null;
  fellBehind(): number;
  saveTimes(count: number): number[];
  ackTimes(count: number): number[];
  echoTimes(count: number): number[];
  peerEditTimes(count: number): number[];
  cursorTimes(count: number): number[];
  textEchoTimes(count: number): number[];
  peerTextTimes(count: number): number[];
  /** This tab's session id, in decimal. */
  sid(): string;
  /** The canvas's lines of a shape's text, or `null` if it has none. */
  text(id: string): string[] | null;
  /** The height of a shape's text as the canvas lays it out. */
  textHeight(id: string): number | null;
  /** The median time to lay out a shape's text, in milliseconds. */
  layoutMs(id: string): number;
  /** Open the editor on a shape's text. */
  edit(id: string): void;
  /** A shape's text as blocks and runs, as this tab shows it. */
  content(id: string): TextBlock[] | null;
  /** Other people's carets the canvas drew last. */
  carets(): { name: string; block: number; offset: number }[];
  /** Other people's carets in the open editor, with the text before each in its block. */
  editorCarets(): { name: string; before: string }[];
  /** Start again from the snapshot, as when the log no longer holds this tab's place. */
  rejoin(): void;
  /** The shape whose text is open in the editor. */
  editing(): string | null;
  centre(x: number, y: number): void;
  history: {
    ready(): boolean;
    position(): number;
    start(): number;
    end(): number;
    hash(): string;
    slowestSeekMs(): number;
    freshHash(position: number): string;
  };
}

declare global {
  interface Window {
    felixCanvas: Replica;
  }
}

const opened: BrowserContext[] = [];

/**
 * Open `room` in a fresh context, signed in as `user`: through the development
 * IdP, or with CANVAS_E2E_PASSWORD through a Dex login form as
 * `<user>@example.com`. Returns once the page is back from signing in, joined
 * or not.
 */
export async function open(
  browser: Browser,
  {
    user = "ana",
    room = "lobby",
    setup,
  }: {
    user?: string | undefined;
    room?: string;
    /** Runs on the new page before it loads, to attach listeners. */
    setup?: ((page: Page) => void) | undefined;
  } = {},
): Promise<Page> {
  const context = await browser.newContext();
  opened.push(context);
  const page = await context.newPage();
  setup?.(page);
  await page.goto(`/?room=${room}`);
  const password = process.env.CANVAS_E2E_PASSWORD;
  if (password) {
    await page.locator("input[name=login]").fill(`${user}@example.com`);
    await page.locator("input[name=password]").fill(password);
    await page.locator("#submit-login").click();
  } else {
    // The form takes any name, not only those the page offers as links.
    await page.getByRole("textbox", { name: "Name" }).fill(user);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  }
  await page.waitForURL(`**/?room=${room}`);
  return page;
}

/**
 * Open the lobby as {@link open} does, signed in as `name` in lower case, or as
 * ana without one, and wait until it shows a correct frame.
 */
export async function join(
  browser: Browser,
  name?: string,
  setup?: (page: Page) => void,
): Promise<Page> {
  const page = await open(browser, { user: name?.toLowerCase(), setup });
  await expect(page.locator("#joining")).toBeHidden({ timeout: 30_000 });
  return page;
}

/**
 * Close every context {@link join} opened. The browser outlives each test,
 * and so would its tabs, still in the room.
 */
export async function leaveAll(): Promise<void> {
  await Promise.all(opened.splice(0).map((context) => context.close()));
}

export function read(page: Page) {
  return page.evaluate(() => ({
    hash: window.felixCanvas.hash(),
    applied: window.felixCanvas.applied(),
    pending: window.felixCanvas.pending(),
    shapes: window.felixCanvas.shapes(),
    firstFrameMs: window.felixCanvas.firstFrameMs(),
    snapshotOffset: window.felixCanvas.snapshotOffset(),
  }));
}

/** Wait until no page has an edit in flight and all have applied the same log prefix. */
export async function settle(pages: Page[], timeout = 15_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const states = await Promise.all(pages.map(read));
        return states.every((s) => s.pending === 0 && s.applied === states[0]!.applied);
      },
      { timeout },
    )
    .toBe(true);
}

/**
 * A spot of canvas nothing else uses, so tests that click on empty canvas
 * find it empty however often they run against one dev stack.
 */
export function freshSpot(): [number, number] {
  return [
    Math.round(20_000 + Math.random() * 1_000_000),
    Math.round(20_000 + Math.random() * 1_000_000),
  ];
}

/** Put world point `spot` at the centre of `page`'s canvas, at 100%. */
export async function centre(page: Page, [x, y]: [number, number]): Promise<void> {
  await page.evaluate((spot) => window.felixCanvas.centre(spot.x, spot.y), { x, y });
}

export async function hashes(pages: Page[]): Promise<string[]> {
  return Promise.all(pages.map(async (page) => (await read(page)).hash));
}

const GATEWAY = "ws://127.0.0.1:8787/ws";
const IDP = "http://127.0.0.1:9400";

/** A session that publishes ops over its own gateway connection, as a browser does. */
export class Writer {
  readonly sid = randomSessionId();
  readonly #socket: WebSocket;
  readonly #acks = new Map<number, (offset: number) => void>();
  #seq = 0;
  #id = 0;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (message) => {
      const reply = JSON.parse(String(message.data));
      if (reply.type === "ack") this.#acks.get(reply.id)?.(reply.offset);
      if (reply.type === "error") console.error(`gateway: ${reply.message}`);
    });
  }

  /** Join `room` as ana. */
  static async open(room = "lobby"): Promise<Writer> {
    return new Writer(await joinRoom(room));
  }

  /** Publish an op and resolve with its log offset. */
  publish(shape: bigint, kind: Op["kind"], fields: Op["fields"]): Promise<number> {
    const id = this.#id++;
    const op = { sid: this.sid, seq: this.#seq++, shape, kind, fields, at: Date.now() };
    const payload = encodeOp(op);
    this.#socket.send(
      JSON.stringify({
        type: "publish",
        stream: "ops",
        payload: Buffer.from(payload).toString("base64"),
        ack: true,
        id,
      }),
    );
    return new Promise((resolve) => this.#acks.set(id, resolve));
  }

  close(): void {
    this.#socket.close();
  }
}

/**
 * Fill `room` with `count` ops from `sessions` writers: each creates a few
 * shapes well away from where the other tests draw, then moves them. With
 * `text`, five of each writer's shapes are text boxes and half the ops after
 * the creates type into them. Resolves with the last offset written.
 */
export async function busyRoom(
  count: number,
  sessions: number,
  room = "lobby",
  { text = false } = {},
): Promise<number> {
  const writers = await Promise.all(Array.from({ length: sessions }, () => Writer.open(room)));
  const offsets = await Promise.all(
    writers.map((writer, w) => {
      const shapes = Array.from({ length: 30 }, (_, i) => BigInt(w * 1000 + i + 1) << 64n);
      const boxes = text ? shapes.slice(25) : [];
      const typists = new Map(boxes.map((box) => [box, new Typist(writer.sid)]));
      return Promise.all(
        Array.from({ length: count / sessions }, (_, i) => {
          const shape = shapes[i % shapes.length]!;
          const x = 2000 + (i % 30) * 60 + w * 8;
          const y = 2000 + w * 120 + (i % 7);
          if (i < shapes.length) {
            const fields = typists.has(shape)
              ? { type: "text", x, y: y + 900, w: 160, z: "V" }
              : { type: "rect", x, y, w: 40, h: 30, z: "V" };
            return writer.publish(shape, "create", fields);
          }
          if (text && i % 2 === 0) {
            const box = boxes[(i / 2) % boxes.length]!;
            return writer.publish(box, "text", { y: typists.get(box)!.type(`w${i} `) });
          }
          return writer.publish(shape, "patch", { x, y });
        }),
      );
    }),
  );
  for (const writer of writers) writer.close();
  return Math.max(...offsets.flat());
}

/** One session typing at the end of one body, as the editor would, for ops a test publishes. */
export class Typist {
  readonly #doc = new Y.Doc();
  #text: Y.XmlText | null = null;

  constructor(sid: bigint) {
    this.#doc.clientID = textClientId(sid);
  }

  /** The update that types `text` at the end, starting a paragraph the first time. */
  type(text: string): Uint8Array {
    const before = Y.encodeStateVector(this.#doc);
    this.#doc.transact(() => {
      if (!this.#text) {
        const paragraph = new Y.XmlElement("p");
        this.#text = new Y.XmlText();
        paragraph.insert(0, [this.#text]);
        this.#doc.getXmlFragment("body").insert(0, [paragraph]);
      }
      this.#text.insert(this.#text.length, text);
    });
    return Y.encodeStateAsUpdateV2(this.#doc, before);
  }
}

/** Join `room` as ana over a gateway connection, with an ID token straight from the development IdP. */
async function joinRoom(room: string): Promise<WebSocket> {
  const response = await fetch(`${IDP}/token?sub=ana&aud=felix-canvas`);
  const { id_token: token } = (await response.json()) as { id_token: string };
  const socket = new WebSocket(GATEWAY);
  return new Promise((resolve, reject) => {
    socket.addEventListener(
      "open",
      () => socket.send(JSON.stringify({ type: "join", room, token })),
      { once: true },
    );
    socket.addEventListener(
      "message",
      (message) => {
        const hello = JSON.parse(String(message.data));
        if (hello.type === "hello") resolve(socket);
        else reject(new Error(`join refused: ${hello.message}`));
      },
      { once: true },
    );
    socket.addEventListener("error", reject, { once: true });
  });
}

/** The lobby's log from offset 0 up to `next`, as `[offset, payload]` pairs. */
export async function readLog(next: number): Promise<[number, Uint8Array][]> {
  const socket = await joinRoom("lobby");
  const records: [number, Uint8Array][] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", (message) => {
        const event = JSON.parse(String(message.data));
        if (event.type === "error") reject(new Error(`gateway: ${event.message}`));
        if (event.type !== "event" || event.stream !== "ops") return;
        records.push([event.offset, Buffer.from(event.payload, "base64")]);
        if (event.offset >= next - 1) resolve();
      });
      socket.send(JSON.stringify({ type: "subscribe", stream: "ops", from: 0 }));
    });
  } finally {
    socket.close();
  }
  return records;
}

/** Marks as `y-prosemirror` stores them. */
export type Marks = Record<string, Record<string, string>>;
/** A paragraph or heading as runs of text, or a list of items that each hold blocks. */
export type BlockSpec =
  | { block: "p" | "h"; level?: number; runs: [string, Marks?][] }
  | { list: "ul" | "ol"; items: BlockSpec[][] };

/** The update that writes `blocks` into an empty body, as the editor would. */
export function bodyUpdate(blocks: BlockSpec[], sid = randomSessionId()): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = textClientId(sid);
  const element = (spec: BlockSpec): Y.XmlElement => {
    if ("list" in spec) {
      const list = new Y.XmlElement(spec.list);
      list.insert(
        0,
        spec.items.map((blocks) => {
          const item = new Y.XmlElement("li");
          item.insert(0, blocks.map(element));
          return item;
        }),
      );
      return list;
    }
    const block = new Y.XmlElement(spec.block);
    if (spec.block === "h") block.setAttribute("level", spec.level as unknown as string);
    const text = new Y.XmlText();
    let at = 0;
    for (const [run, marks = {}] of spec.runs) {
      text.insert(at, run, marks);
      at += run.length;
    }
    block.insert(0, [text]);
    return block;
  };
  doc.getXmlFragment("body").insert(0, blocks.map(element));
  return Y.encodeStateAsUpdateV2(doc);
}
