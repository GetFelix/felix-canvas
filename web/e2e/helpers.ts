import { encodeOp, randomSessionId, type Op } from "@felix-canvas/model";
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

interface Replica {
  hash(): string;
  applied(): number;
  pending(): number;
  shapes(): number;
  firstFrameMs(): number | null;
  snapshotOffset(): number | null;
  fellBehind(): number;
  saveTimes(count: number): number[];
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
 * `<user>@example.com`. With `name`, the page uses it as its display name.
 * Returns once the page is back from signing in, joined or not.
 */
export async function open(
  browser: Browser,
  {
    user = "ana",
    room = "lobby",
    name,
  }: { user?: string; room?: string; name?: string | undefined } = {},
): Promise<Page> {
  const context = await browser.newContext();
  opened.push(context);
  if (name) {
    await context.addInitScript((saved) => localStorage.setItem("felix-canvas.name", saved), name);
  }
  const page = await context.newPage();
  await page.goto(`/?room=${room}`);
  const password = process.env.CANVAS_E2E_PASSWORD;
  if (password) {
    await page.locator("input[name=login]").fill(`${user}@example.com`);
    await page.locator("input[name=password]").fill(password);
    await page.locator("#submit-login").click();
  } else {
    await page.getByRole("link", { name: `Continue as ${user}` }).click();
  }
  await page.waitForURL(`**/?room=${room}`);
  return page;
}

/** Open the lobby as {@link open} does and wait until it shows a correct frame. */
export async function join(browser: Browser, name?: string): Promise<Page> {
  const page = await open(browser, { name });
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

  /** Join `room` as ana, with an ID token straight from the development IdP. */
  static async open(room = "lobby"): Promise<Writer> {
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
          if (hello.type === "hello") resolve(new Writer(socket));
          else reject(new Error(`join refused: ${hello.message}`));
        },
        { once: true },
      );
      socket.addEventListener("error", reject, { once: true });
    });
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
 * shapes well away from where the other tests draw, then moves them.
 * Resolves with the last offset written.
 */
export async function busyRoom(count: number, sessions: number, room = "lobby"): Promise<number> {
  const writers = await Promise.all(Array.from({ length: sessions }, () => Writer.open(room)));
  const offsets = await Promise.all(
    writers.map((writer, w) => {
      const shapes = Array.from({ length: 30 }, (_, i) => BigInt(w * 1000 + i + 1) << 64n);
      return Promise.all(
        Array.from({ length: count / sessions }, (_, i) => {
          const shape = shapes[i % shapes.length]!;
          const x = 2000 + (i % 30) * 60 + w * 8;
          const y = 2000 + w * 120 + (i % 7);
          return i < shapes.length
            ? writer.publish(shape, "create", { type: "rect", x, y, w: 40, h: 30, z: "V" })
            : writer.publish(shape, "patch", { x, y });
        }),
      );
    }),
  );
  for (const writer of writers) writer.close();
  return Math.max(...offsets.flat());
}
