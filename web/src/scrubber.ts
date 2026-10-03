import type { Doc, History } from "@felix-canvas/model";
import { History as HistoryIcon, Pause, Play, createIcons } from "lucide";

import type { HistoryFeed } from "./history.js";

/** Changes a second at 1x. The faster speeds are multiples of it. */
const PLAY_RATE = 60;
const SPEEDS = [1, 4, 16];
const BARS = 120;
/** How far back to look for an edit that carries its time. */
const TIME_LOOKBACK = 64;

const element = <T extends Element = HTMLElement>(id: string) =>
  document.getElementById(id) as unknown as T;

/**
 * History mode: the tool bar becomes a timeline over every change in the
 * room, and the canvas shows the room as it was at the playhead. The live
 * session keeps running underneath, so going back to live loses nothing.
 */
export class Scrubber {
  /** Whether history mode is on. */
  active = false;
  /** Changes applied at the playhead: the room after every offset below it. */
  position = 0;
  /** The longest a seek took, in milliseconds, for the end-to-end test. */
  slowestSeekMs = 0;
  /** Called when the canvas must redraw. */
  onChange: () => void = () => {};
  /** Called when history mode turned on or off. */
  onToggle: (active: boolean) => void = () => {};

  readonly #feed: HistoryFeed;
  #doc: Doc | null = null;
  /** The newest position when history finished loading, to count what arrived since. */
  #endAtEntry = 0;
  #playing = false;
  #speed = 0;
  #lastFrame = 0;
  #carry = 0;
  #barsDrawn = { end: -1, start: -1, at: 0 };
  #rendered = false;

  constructor(feed: HistoryFeed) {
    this.#feed = feed;
    feed.onChange = () => this.#grew();
    createIcons({ icons: { History: HistoryIcon, Pause, Play }, nameAttr: "data-history-icon" });
    element("history-button").addEventListener("click", () => this.toggle());
    element("history-live").addEventListener("click", () => this.leave());
    element("history-play").addEventListener("click", () => this.#setPlaying(!this.#playing));
    element("history-speed").addEventListener("click", () => {
      this.#speed = (this.#speed + 1) % SPEEDS.length;
      this.#render();
    });
    this.#wireTrack();
    window.addEventListener("keydown", (event) => this.#keydown(event));
    setInterval(() => this.active && this.#render(), 1000);
  }

  /** What to draw instead of the live room, or `null` to draw the live room. */
  get doc(): Doc | null {
    return this.active ? this.#doc : null;
  }

  get history(): History | null {
    return this.#feed.history;
  }

  /** Whether the timeline is ready to scrub. */
  get ready(): boolean {
    return this.active && this.#feed.loaded && this.#doc !== null;
  }

  toggle(): void {
    if (this.active) this.leave();
    else this.enter();
  }

  enter(): void {
    if (this.active) return;
    this.active = true;
    this.#doc = null;
    this.#rendered = false;
    document.getElementById("app")!.classList.add("history");
    element("history-bar").hidden = false;
    this.#feed.open();
    this.#grew();
    this.onToggle(true);
  }

  leave(): void {
    if (!this.active) return;
    this.active = false;
    this.#setPlaying(false);
    this.#feed.close();
    this.#doc = null;
    document.getElementById("app")!.classList.remove("history");
    element("history-bar").hidden = true;
    this.onToggle(false);
    this.onChange();
  }

  /** Move the playhead to `position`, clamped to the history held. */
  seek(position: number): void {
    const history = this.#feed.history;
    if (!this.active || !history || !this.#feed.loaded) return;
    const target = Math.round(Math.min(history.end, Math.max(history.start, position)));
    const started = performance.now();
    this.#doc = history.at(target);
    this.slowestSeekMs = Math.max(this.slowestSeekMs, performance.now() - started);
    this.position = target;
    this.#render();
    this.onChange();
  }

  #grew(): void {
    if (!this.active) return;
    const history = this.#feed.history;
    if (this.#feed.loaded && history && this.#doc === null) {
      // Open at the newest change, so the canvas does not jump.
      this.#endAtEntry = history.end;
      this.seek(history.end);
      return;
    }
    // Loading, or new changes arriving: redraw the timeline at most once a frame.
    if (!this.#rendered) {
      this.#rendered = true;
      requestAnimationFrame(() => {
        this.#rendered = false;
        if (this.active) this.#render();
      });
    }
  }

  #render(): void {
    const feed = this.#feed;
    const history = feed.history;
    const bar = element("history-bar");
    const loading = !feed.loaded || !history;
    bar.dataset.state = loading ? "loading" : "ready";
    const change = element("history-change");
    const when = element("history-when");
    const track = element("history-track");
    if (loading) {
      const done = history ? history.end - history.start : 0;
      const total = Math.max(done, feed.target - (history?.start ?? 0));
      change.textContent =
        total > 0
          ? `Loading history · ${done.toLocaleString()} of ${total.toLocaleString()} changes`
          : "Loading history";
      when.textContent = "";
      element("history-fill").style.width = `${total > 0 ? (done / total) * 100 : 0}%`;
      return;
    }
    const { start, end } = history;
    const span = Math.max(1, end - start);
    const fraction = (this.position - start) / span;
    change.textContent = `Change ${this.position.toLocaleString()} of ${end.toLocaleString()}`;
    const at = this.#timeAt(this.position);
    when.textContent = at === null ? "" : timeAgo(Date.now() - at);
    when.title = at === null ? "" : new Date(at).toLocaleString();
    element("history-fill").style.width = `${fraction * 100}%`;
    element("history-playhead").style.left = `${fraction * 100}%`;
    track.setAttribute("aria-valuemin", String(start));
    track.setAttribute("aria-valuemax", String(end));
    track.setAttribute("aria-valuenow", String(this.position));
    track.setAttribute("aria-valuetext", change.textContent);
    const floor = element("history-floor");
    floor.hidden = start === 0;
    floor.dataset.tip = `History starts at change ${start.toLocaleString()}`;
    this.#renderBars(history);

    const fresh = end - this.#endAtEntry;
    const badge = element("history-new");
    badge.hidden = fresh <= 0;
    badge.textContent = `+${fresh.toLocaleString()} new`;
    const playing = this.#playing;
    const play = element("history-play");
    play.dataset.playing = String(playing);
    play.dataset.tip = playing ? "Pause" : "Play";
    play.setAttribute("aria-label", playing ? "Pause" : "Play");
    element("history-speed").textContent = `${SPEEDS[this.#speed]}×`;
  }

  /** How many changes landed in each slice of the timeline, as bars; the past ones tinted. */
  #renderBars(history: History): void {
    const svg = element<SVGSVGElement>("history-density");
    const { start, end } = history;
    const drawn = this.#barsDrawn;
    const now = performance.now();
    // Counting walks the whole history, so live changes recount twice a second at most.
    if (drawn.start !== start || (drawn.end !== end && now - drawn.at > 500)) {
      this.#barsDrawn = { start, end, at: now };
      const counts = new Array<number>(BARS).fill(0);
      const span = Math.max(1, end - start);
      for (let offset = start; offset < end; offset++) {
        if (history.op(offset)) counts[Math.floor(((offset - start) / span) * BARS)]!++;
      }
      const max = Math.max(1, ...counts);
      const bars = counts.map((count, i) => {
        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        const height = count === 0 ? 0 : Math.max(1.5, (count / max) * 16);
        rect.setAttribute("x", String(i + 0.15));
        rect.setAttribute("width", "0.7");
        rect.setAttribute("y", String(16 - height));
        rect.setAttribute("height", String(height));
        return rect;
      });
      svg.replaceChildren(...bars);
    }
    const past = ((this.position - start) / Math.max(1, end - start)) * BARS;
    for (const [i, rect] of [...svg.children].entries()) {
      rect.classList.toggle("past", i + 1 <= past);
    }
  }

  /** When the newest change at or before `position` was made, if it says. */
  #timeAt(position: number): number | null {
    const history = this.#feed.history;
    if (!history) return null;
    const floor = Math.max(history.start, position - TIME_LOOKBACK);
    for (let offset = position - 1; offset >= floor; offset--) {
      const at = history.op(offset)?.at;
      if (at !== undefined) return at;
    }
    return null;
  }

  #setPlaying(playing: boolean): void {
    const history = this.#feed.history;
    if (playing && (!this.ready || !history)) return;
    // Playing from the end starts again from the beginning.
    if (playing && history && this.position >= history.end) this.seek(history.start);
    this.#playing = playing;
    this.#carry = 0;
    this.#lastFrame = performance.now();
    if (playing) requestAnimationFrame((now) => this.#play(now));
    if (this.active) this.#render();
  }

  #play(now: number): void {
    const history = this.#feed.history;
    if (!this.#playing || !this.active || !history) return;
    this.#carry += ((now - this.#lastFrame) / 1000) * PLAY_RATE * SPEEDS[this.#speed]!;
    this.#lastFrame = now;
    const step = Math.floor(this.#carry);
    if (step > 0) {
      this.#carry -= step;
      this.seek(this.position + step);
    }
    if (this.position >= history.end) {
      this.#setPlaying(false);
      return;
    }
    requestAnimationFrame((next) => this.#play(next));
  }

  #wireTrack(): void {
    const track = element("history-track");
    const scale = element("history-scale");
    const seekTo = (event: PointerEvent) => {
      const history = this.#feed.history;
      if (!history) return;
      const rect = scale.getBoundingClientRect();
      const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      this.seek(history.start + fraction * (history.end - history.start));
    };
    track.addEventListener("pointerdown", (event) => {
      if (!this.ready) return;
      track.setPointerCapture(event.pointerId);
      this.#setPlaying(false);
      track.dataset.dragging = "true";
      seekTo(event);
    });
    track.addEventListener("pointermove", (event) => {
      if (track.hasPointerCapture(event.pointerId)) seekTo(event);
    });
    const release = () => delete track.dataset.dragging;
    track.addEventListener("pointerup", release);
    track.addEventListener("pointercancel", release);
  }

  #keydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, [contenteditable], dialog[open]")) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.shiftKey && event.key.toLowerCase() === "h") {
      event.preventDefault();
      this.toggle();
      return;
    }
    if (!this.active || mod || event.altKey) return;
    const history = this.#feed.history;
    switch (event.key) {
      case "Escape":
      case "l":
      case "L":
        this.leave();
        break;
      case " ":
        this.#setPlaying(!this.#playing);
        break;
      case "ArrowLeft":
      case "ArrowRight": {
        this.#setPlaying(false);
        const step = (event.shiftKey ? 100 : 1) * (event.key === "ArrowLeft" ? -1 : 1);
        this.seek(this.position + step);
        break;
      }
      case "Home":
        if (history) this.seek(history.start);
        break;
      case "End":
        if (history) this.seek(history.end);
        break;
      default:
        return;
    }
    event.preventDefault();
  }
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** How long ago something happened, in the words a person would use. */
export function timeAgo(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 45) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return capitalize(relative.format(-minutes, "minute"));
  const hours = Math.round(minutes / 60);
  if (hours < 24) return capitalize(relative.format(-hours, "hour"));
  return capitalize(relative.format(-Math.round(hours / 24), "day"));
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
