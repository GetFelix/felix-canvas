import { stateHash } from "@felix-canvas/model";
import {
  Circle,
  ExternalLink,
  EyeOff,
  Hand,
  Keyboard,
  Link,
  Minus,
  Monitor,
  Moon,
  MousePointer2,
  Pencil,
  Plus,
  Slash,
  Square,
  Sun,
  X,
  createIcons,
} from "lucide";

import type { Editor, Tool } from "./editor.js";
import { PEER_COLORS, type Peer } from "./peers.js";
import type { Session } from "./session.js";

type Theme = "system" | "light" | "dark";

/** Unacknowledged edits older than this turn the chip to "Saving". */
const SAVING_AFTER_MS = 300;
/** Brief drops stay quiet: the chip says "Reconnecting" only after this. */
const RECONNECT_GRACE_MS = 800;
const MAX_AVATARS = 4;
const TOOLTIP_DELAY_MS = 500;

const element = <T extends Element = HTMLElement>(id: string) =>
  document.getElementById(id) as unknown as T;

/**
 * Everything around the canvas. Numbers refresh at most four times a second
 * and every slot has a fixed width, so state changes never move the layout.
 */
export class Chrome {
  /** Called when the theme changed and the canvas must reread its colours. */
  onThemeChange: () => void = () => {};

  readonly #session: Session;
  readonly #editor: Editor;
  readonly #name: string;
  #ownColor = 0;
  #peers: Peer[] = [];
  #pendingSince: number | null = null;
  #disconnectedAt: number | null = null;
  #metrics: { browser: number; felix: number } | null = null;
  #toastTimer = 0;

  constructor(session: Session, editor: Editor, name: string) {
    this.#session = session;
    this.#editor = editor;
    this.#name = name;
    createIcons({
      icons: {
        Circle,
        ExternalLink,
        EyeOff,
        Hand,
        Keyboard,
        Link,
        Minus,
        Monitor,
        Moon,
        MousePointer2,
        Pencil,
        Plus,
        Slash,
        Square,
        Sun,
        X,
      },
    });
    if (!/Mac|iPhone|iPad/.test(navigator.platform)) {
      for (const node of document.querySelectorAll("kbd, [data-key]")) {
        if (node instanceof HTMLElement && node.dataset.key) {
          node.dataset.key = node.dataset.key.replace("⌘", "Ctrl");
        } else if (node.textContent) {
          node.textContent = node.textContent.replace("⌘", "Ctrl ");
        }
      }
    }
    this.#wireToolbar();
    this.#wireMenu();
    this.#wireStatus();
    this.#wireTooltips();
    this.#wireKeys();
    element("share").addEventListener("click", () => this.#share());
    element("zoom-in").addEventListener("click", () => editor.zoomBy(1.25, undefined, true));
    element("zoom-out").addEventListener("click", () => editor.zoomBy(0.8, undefined, true));
    element("zoom-reset").addEventListener("click", () =>
      editor.zoomBy(1 / editor.camera.zoom, undefined, true),
    );
    this.#applyTheme(this.#savedTheme());
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () =>
      this.onThemeChange(),
    );
    setInterval(() => this.refresh(), 250);
  }

  /** Show a short message above the toolbar. */
  toast(message: string): void {
    const toast = element("toast");
    toast.textContent = message;
    toast.classList.add("shown");
    clearTimeout(this.#toastTimer);
    this.#toastTimer = window.setTimeout(() => toast.classList.remove("shown"), 2000);
  }

  /** This session's palette index changed, or the peer list did. */
  setPeers(peers: Peer[], ownColor: number): void {
    this.#peers = peers;
    this.#ownColor = ownColor;
    this.#renderAvatars();
  }

  /** Reflect the editor's tool and zoom. */
  syncEditor(): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
      button.setAttribute("aria-pressed", String(button.dataset.tool === this.#editor.tool));
    }
    element("zoom-reset").textContent = `${Math.round(this.#editor.camera.zoom * 100)}%`;
  }

  /** Update the room name, cards, chip and status numbers. */
  refresh(): void {
    const session = this.#session;
    const now = performance.now();
    if (session.room) {
      element("workspace").textContent = session.room.namespace;
      element("room").textContent = session.room.room;
      element("status-room").textContent = session.room.room;
      document.title = `${session.room.room} · Felix Canvas`;
    }

    if (session.connection === "reconnecting") this.#disconnectedAt ??= now;
    else this.#disconnectedAt = null;
    const pending = session.replica.pending.length;
    if (pending === 0) this.#pendingSince = null;
    else this.#pendingSince ??= now;

    const joining = !session.caughtUp;
    element("joining").hidden = !joining;
    element("empty").hidden =
      joining || session.replica.view().shapes.size > 0 || this.#editor.draft !== null;
    if (joining) this.#renderJoining();

    let state: string;
    let label: string;
    if (this.#disconnectedAt !== null && now - this.#disconnectedAt > RECONNECT_GRACE_MS) {
      [state, label] = ["reconnecting", "Reconnecting"];
    } else if (session.connection === "connecting") {
      [state, label] = ["connecting", "Connecting"];
    } else if (this.#pendingSince !== null && now - this.#pendingSince > SAVING_AFTER_MS) {
      [state, label] = ["saving", `Saving ${pending}`];
    } else {
      const rtt = session.editTrips.quantile(0.5) ?? session.cursorTrips.quantile(0.5);
      [state, label] = ["live", rtt === null ? "Live" : `Live · ${formatMs(rtt)}`];
    }
    const chip = element("chip");
    chip.dataset.state = state;
    element("chip-label").textContent = label;

    if (!element("status").hidden) this.#renderStatus();
  }

  #renderJoining(): void {
    const session = this.#session;
    const title = element("joining-title");
    const detail = element("joining-detail");
    const bar = element("joining-bar");
    const room = session.room?.room;
    title.textContent = room ? `Joining ${room}` : "Joining the room";
    if (session.connection !== "live") {
      detail.textContent = session.connection === "connecting" ? "Connecting" : "Reconnecting";
      bar.style.width = "0";
      return;
    }
    const total = session.tail + 1;
    const done = Math.min(session.replica.next, total);
    detail.textContent = `Loading the canvas: ${done.toLocaleString()} of ${total.toLocaleString()} changes`;
    bar.style.width = `${total === 0 ? 100 : (done / total) * 100}%`;
  }

  #renderStatus(): void {
    const session = this.#session;
    const edit = session.editTrips;
    const p50 = edit.quantile(0.5);
    const p99 = edit.quantile(0.99);
    element("status-tail").textContent = (session.tail + 1).toLocaleString();
    element("status-applied").textContent = session.replica.next.toLocaleString();
    element("status-edit").textContent =
      p50 === null || p99 === null ? "no changes yet" : `${formatMs(p50)} · p99 ${formatMs(p99)}`;
    const cursor = session.cursorTrips.quantile(0.5);
    element("status-cursor").textContent = cursor === null ? "none" : formatMs(cursor);
    element("status-browser").textContent = this.#metrics
      ? formatMs(this.#metrics.browser)
      : "none";
    element("status-server").textContent = this.#metrics ? formatMs(this.#metrics.felix) : "none";
    element("status-hash").textContent = stateHash(session.replica.confirmed);

    const samples = edit.latest(60);
    const max = Math.max(1, ...samples);
    const step = samples.length > 1 ? 280 / (samples.length - 1) : 0;
    const points = samples.map(
      (ms, i) => `${(i * step).toFixed(1)},${(30 - (ms / max) * 28).toFixed(1)}`,
    );
    element<SVGSVGElement>("status-spark")
      .querySelector("polyline")!
      .setAttribute("points", points.join(" "));
  }

  #renderAvatars(): void {
    const container = element("avatars");
    const people = [
      ...this.#peers.map((peer) => ({
        name: peer.name,
        color: peer.color,
        idle: peer.idle,
        you: false,
      })),
      { name: this.#name, color: PEER_COLORS[this.#ownColor]!, idle: false, you: true },
    ];
    const shown = people.length > MAX_AVATARS ? people.slice(0, MAX_AVATARS - 1) : people;
    const nodes: HTMLElement[] = shown.map((person) => {
      const avatar = document.createElement("span");
      avatar.className = person.idle ? "avatar idle" : "avatar";
      avatar.style.setProperty("--peer", person.color);
      avatar.textContent = person.name.slice(0, 1).toUpperCase();
      avatar.dataset.tip = person.you
        ? `${person.name} (you)`
        : person.idle
          ? `${person.name} · idle`
          : person.name;
      return avatar;
    });
    if (people.length > shown.length) {
      const more = document.createElement("span");
      more.className = "avatar more";
      more.textContent = `+${people.length - shown.length}`;
      more.dataset.tip = people
        .slice(shown.length)
        .map((person) => person.name)
        .join(", ");
      nodes.push(more);
    }
    container.replaceChildren(...nodes);
  }

  #wireToolbar(): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
      button.addEventListener("click", () => this.#editor.setTool(button.dataset.tool as Tool));
    }
    this.syncEditor();
  }

  #wireMenu(): void {
    const button = element("menu-button");
    const menu = element("menu");
    const setOpen = (open: boolean) => {
      menu.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
    };
    button.addEventListener("click", () => setOpen(Boolean(menu.hidden)));
    document.addEventListener("pointerdown", (event) => {
      const target = event.target as Node;
      if (!menu.contains(target) && !button.contains(target)) setOpen(false);
    });
    for (const choice of document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]")) {
      choice.addEventListener("click", () => {
        const theme = choice.dataset.themeChoice as Theme;
        try {
          localStorage.setItem("felix-canvas.theme", theme);
        } catch {
          // Private windows may refuse storage; the theme still applies now.
        }
        this.#applyTheme(theme);
      });
    }
    element("shortcuts-item").addEventListener("click", () => {
      setOpen(false);
      this.#showShortcuts();
    });
    element("hide-ui-item").addEventListener("click", () => {
      setOpen(false);
      this.#toggleUi();
    });
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.focus();
      }
    });
    const dialog = element<HTMLDialogElement>("shortcuts");
    dialog.querySelector("[data-close]")!.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  #wireStatus(): void {
    const chip = element("chip");
    const status = element("status");
    let poll = 0;
    const setOpen = (open: boolean) => {
      status.hidden = !open;
      chip.setAttribute("aria-expanded", String(open));
      clearInterval(poll);
      if (open) {
        void this.#fetchMetrics();
        poll = window.setInterval(() => void this.#fetchMetrics(), 1000);
        this.#renderStatus();
      }
    };
    chip.addEventListener("click", () => setOpen(Boolean(status.hidden)));
    document.addEventListener("pointerdown", (event) => {
      const target = event.target as Node;
      if (!status.contains(target) && !chip.contains(target)) setOpen(false);
    });
  }

  async #fetchMetrics(): Promise<void> {
    try {
      const response = await fetch("/metrics");
      const body = (await response.json()) as Record<string, { p50_us: number; count: number }>;
      const browser = body.browser_rtt;
      const felix = body.felix_publish_ack_ops;
      if (browser && felix)
        this.#metrics = { browser: browser.p50_us / 1000, felix: felix.p50_us / 1000 };
    } catch {
      this.#metrics = null;
    }
  }

  #wireTooltips(): void {
    const tooltip = element("tooltip");
    let timer = 0;
    let lastHidden = 0;
    let current: HTMLElement | null = null;
    const hide = () => {
      clearTimeout(timer);
      if (current) lastHidden = performance.now();
      current = null;
      tooltip.classList.remove("shown");
    };
    const show = (target: HTMLElement) => {
      tooltip.replaceChildren(target.dataset.tip ?? "");
      if (target.dataset.key) {
        const key = document.createElement("kbd");
        key.textContent = target.dataset.key;
        tooltip.append(key);
      }
      const rect = target.getBoundingClientRect();
      const box = tooltip.getBoundingClientRect();
      const below = rect.top < window.innerHeight / 2;
      const left = Math.max(
        8,
        Math.min(window.innerWidth - box.width - 8, rect.left + rect.width / 2 - box.width / 2),
      );
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${below ? rect.bottom + 8 : rect.top - box.height - 8}px`;
      tooltip.classList.add("shown");
    };
    document.addEventListener("pointerover", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-tip]");
      if (target === current) return;
      hide();
      if (!target || target.getAttribute("aria-expanded") === "true") return;
      current = target;
      // Moving between neighbouring buttons shows the next tip at once.
      const delay = performance.now() - lastHidden < 300 ? 0 : TOOLTIP_DELAY_MS;
      timer = window.setTimeout(() => show(target), delay);
    });
    document.addEventListener("pointerdown", hide);
  }

  #wireKeys(): void {
    window.addEventListener("keydown", (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]")) return;
      if (event.key === "?") {
        event.preventDefault();
        this.#showShortcuts();
      } else if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
        event.preventDefault();
        this.#toggleUi();
      }
    });
  }

  #showShortcuts(): void {
    const dialog = element<HTMLDialogElement>("shortcuts");
    if (!dialog.open) dialog.showModal();
  }

  #toggleUi(): void {
    document.getElementById("app")!.classList.toggle("ui-hidden");
  }

  async #share(): Promise<void> {
    try {
      await navigator.clipboard.writeText(location.href);
      this.toast("Link copied");
    } catch {
      this.toast("Copy the address bar to share this room");
    }
  }

  #savedTheme(): Theme {
    const theme = document.documentElement.dataset.theme;
    return theme === "light" || theme === "dark" ? theme : "system";
  }

  #applyTheme(theme: Theme): void {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    for (const choice of document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]")) {
      choice.setAttribute("aria-checked", String(choice.dataset.themeChoice === theme));
    }
    this.onThemeChange();
  }
}

function formatMs(ms: number): string {
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}
