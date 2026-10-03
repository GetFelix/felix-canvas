import { TEXT_COLORS, type FontSize, type TextBlock, type TextColor } from "@felix-canvas/model";
import type { Command } from "prosemirror-state";

import type { Shape } from "./shapes.js";
import {
  setBlock,
  setColor,
  setLink,
  setSize,
  toggleBold,
  toggleItalic,
  toggleList,
  toggleUnderline,
  type BlockKind,
  type Formats,
  type ListKind,
} from "./textcommands.js";

const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

/** Space between the bar and the shape it formats. */
const GAP = 8;
/** The height of a person's name tag over a shape they have selected, with its gap. */
const NAME_TAG = 22;
/** Keep clear of the islands along the top edge. */
const TOP_CLEARANCE = 60;

const COLOR_NAMES: Record<TextColor, string> = {
  ink: "Ink",
  muted: "Muted",
  coral: "Coral",
  orange: "Orange",
  amber: "Amber",
  green: "Green",
  blue: "Blue",
  violet: "Violet",
  magenta: "Magenta",
  rose: "Rose",
};

/** What the bar formats: the text open in the editor, or the whole of a selected shape's text. */
export interface TextTarget {
  shape: Shape;
  /** The shape's box on screen. */
  box: DOMRect;
  /** The formats to show as on. */
  formats: Formats;
  /** Whether someone else's name tag sits above the shape, which the bar must clear. */
  tagged: boolean;
  /** Run a command on the selection being edited, or on all of the shape's text. */
  run(command: Command): void;
}

/**
 * The text bar from the UX brief: block style, bold, italic, underline, link,
 * lists, size and colour, floating 8 px above the shape it formats.
 */
export class TextBar {
  /** Called to put the caret back in the text after a control took focus. */
  onDone: () => void = () => {};

  readonly #bar = element("text-bar");
  readonly #menus = {
    block: element("text-block-menu"),
    size: element("text-size-menu"),
    color: element("text-color-menu"),
  };
  readonly #link = element("link-popover");
  readonly #address = element<HTMLInputElement>("link-address");
  #target: TextTarget | null = null;

  constructor() {
    // Controls never take focus from the text being edited, so its selection stays.
    for (const container of [this.#bar, ...Object.values(this.#menus)]) {
      container.addEventListener("pointerdown", (event) => event.preventDefault());
    }
    for (const button of this.#bar.querySelectorAll<HTMLElement>("[data-format]")) {
      const command = { b: toggleBold, i: toggleItalic, u: toggleUnderline }[
        button.dataset.format as "b" | "i" | "u"
      ];
      button.addEventListener("click", () => this.#run(command));
    }
    for (const button of this.#bar.querySelectorAll<HTMLElement>("[data-list]")) {
      button.addEventListener("click", () =>
        this.#run(toggleList(button.dataset.list as ListKind)),
      );
    }
    this.#wireMenu(element("text-block"), this.#menus.block, "[data-block]", (item) => {
      const value = item.dataset.block!;
      return setBlock(value === "p" ? "p" : (Number(value) as BlockKind));
    });
    this.#wireMenu(element("text-size"), this.#menus.size, "[data-size]", (item) =>
      setSize(item.dataset.size as FontSize),
    );
    for (const name of TEXT_COLORS) {
      const swatch = document.createElement("button");
      swatch.setAttribute("role", "menuitemradio");
      swatch.dataset.color = name;
      swatch.dataset.tip = COLOR_NAMES[name];
      swatch.setAttribute("aria-label", COLOR_NAMES[name]);
      swatch.style.setProperty("--swatch", name === "ink" ? "var(--ink)" : `var(--text-${name})`);
      this.#menus.color.append(swatch);
    }
    this.#wireMenu(element("text-color"), this.#menus.color, "[data-color]", (item) =>
      setColor(item.dataset.color as TextColor),
    );
    element("text-link").addEventListener("click", () => this.openLink());
    element("link-apply").addEventListener("click", () => this.#applyLink(this.#address.value));
    element("link-remove").addEventListener("click", () => this.#applyLink(null));
    this.#address.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== "Escape") return;
      // Focus goes back to the text, which must not get the key as well.
      event.preventDefault();
      if (event.key === "Enter") this.#applyLink(this.#address.value);
      else this.#closeLink();
    });
    document.addEventListener("pointerdown", (event) => {
      const target = event.target as Node;
      if (!this.#link.hidden && !this.#link.contains(target) && !this.#bar.contains(target)) {
        this.#closeLink();
      }
      const inMenu = Object.values(this.#menus).some((menu) => menu.contains(target));
      if (!inMenu && !this.#bar.contains(target)) this.#closeMenus();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.#closeMenus();
    });
  }

  /** Show the bar for `target`, or hide it for `null`. Call when anything it shows may have changed. */
  show(target: TextTarget | null): void {
    if (!target && !this.#target) return;
    this.#target = target;
    this.#bar.hidden = target === null;
    if (!target) {
      this.#closeMenus();
      this.#closeLink();
      return;
    }
    const { formats: on } = target;
    for (const button of this.#bar.querySelectorAll<HTMLElement>("[data-format]")) {
      button.setAttribute("aria-pressed", String(on[button.dataset.format as "b" | "i" | "u"]));
    }
    for (const button of this.#bar.querySelectorAll<HTMLElement>("[data-list]")) {
      button.setAttribute("aria-pressed", String(on.list === button.dataset.list));
    }
    element("text-link").setAttribute("aria-pressed", String(on.link !== null));
    this.#check(this.#menus.block, "block", String(on.block));
    this.#check(this.#menus.size, "size", on.size);
    this.#check(this.#menus.color, "color", on.color);
    const swatch = this.#bar.querySelector<HTMLElement>(".swatch")!;
    swatch.style.setProperty(
      "--swatch",
      on.color === "ink" ? "var(--ink)" : `var(--text-${on.color})`,
    );
    element("text-color").dataset.tip = `Colour: ${COLOR_NAMES[on.color]}`;
    this.#place(target.box, target.tagged);
  }

  /** Show a link's address under it, with a way to open it, or hide that for `null`. */
  showLinkHover(link: { href: string; box: DOMRect } | null): void {
    const hover = element("link-hover");
    hover.hidden = link === null;
    if (!link) return;
    element("link-hover-address").textContent = link.href;
    element("link-hover-open").onclick = () => {
      window.open(link.href, "_blank", "noopener,noreferrer");
      hover.hidden = true;
    };
    hover.style.left = `${clamp(link.box.left, 8, innerWidth - hover.offsetWidth - 8)}px`;
    hover.style.top = `${link.box.bottom + 6}px`;
  }

  /** Open the link popover for the target's selection. */
  openLink(): void {
    const target = this.#target;
    if (!target) return;
    this.#closeMenus();
    this.#address.value = target.formats.link ?? "";
    element("link-remove").hidden = target.formats.link === null;
    this.#link.hidden = false;
    element("text-link").setAttribute("aria-expanded", "true");
    const bar = this.#bar.getBoundingClientRect();
    const button = element("text-link").getBoundingClientRect();
    this.#link.style.left = `${clamp(button.left + button.width / 2 - 130, 8, innerWidth - 268)}px`;
    this.#link.style.top = `${bar.bottom + 6}px`;
    this.#address.focus();
    this.#address.select();
  }

  #applyLink(address: string | null): void {
    if (address !== null && address.trim() === "") address = null;
    this.#run(setLink(address));
    this.#closeLink();
  }

  #closeLink(): void {
    if (this.#link.hidden) return;
    this.#link.hidden = true;
    element("text-link").setAttribute("aria-expanded", "false");
    this.onDone();
  }

  #run(command: Command): void {
    this.#target?.run(command);
    this.#closeMenus();
    this.onDone();
  }

  #wireMenu(
    trigger: HTMLElement,
    menu: HTMLElement,
    selector: string,
    command: (item: HTMLElement) => Command,
  ): void {
    trigger.addEventListener("click", () => {
      const open = menu.hidden;
      this.#closeMenus();
      this.#closeLink();
      if (!open) return;
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      const rect = trigger.getBoundingClientRect();
      const bar = this.#bar.getBoundingClientRect();
      menu.style.left = `${clamp(rect.left, 8, innerWidth - menu.offsetWidth - 8)}px`;
      menu.style.top = `${bar.bottom + 6}px`;
    });
    for (const item of menu.querySelectorAll<HTMLElement>(selector)) {
      item.addEventListener("click", () => this.#run(command(item)));
    }
  }

  #closeMenus(): void {
    for (const menu of Object.values(this.#menus)) menu.hidden = true;
    for (const trigger of this.#bar.querySelectorAll("[aria-haspopup=menu]")) {
      trigger.setAttribute("aria-expanded", "false");
    }
  }

  #check(menu: HTMLElement, key: string, value: string): void {
    for (const item of menu.querySelectorAll<HTMLElement>(`[data-${key}]`)) {
      item.setAttribute("aria-checked", String(item.dataset[key] === value));
    }
  }

  #place(box: DOMRect, tagged: boolean): void {
    const bar = this.#bar;
    const width = bar.offsetWidth;
    const height = bar.offsetHeight;
    const left = clamp(box.left + box.width / 2 - width / 2, 8, innerWidth - width - 8);
    let top = box.top - height - GAP - (tagged ? NAME_TAG : 0);
    // No room above: flip below the shape.
    if (top < TOP_CLEARANCE) top = box.bottom + GAP;
    bar.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }
}

/** The formats every part of a body has, for formatting a whole shape. */
export function wholeFormats(content: TextBlock[]): Formats {
  const runs = content.flatMap((block) => block.runs);
  const all = (test: (marks: TextBlock["runs"][number]["marks"]) => boolean) =>
    runs.length > 0 && runs.every((run) => test(run.marks));
  const first = content[0];
  const sameBlock = content.every(
    (block) => block.heading === first?.heading && block.lists.length === 0,
  );
  const lists = new Set(content.map((block) => block.lists.at(-1) ?? null));
  return {
    block: sameBlock && first && first.heading > 0 ? (first.heading as 1 | 2 | 3) : "p",
    list: lists.size === 1 ? [...lists][0]! : null,
    b: all((marks) => marks.b === true),
    i: all((marks) => marks.i === true),
    u: all((marks) => marks.u === true),
    link:
      runs.length > 0 && all((marks) => marks.a === runs[0]!.marks.a)
        ? (runs[0]!.marks.a ?? null)
        : null,
    size: runs[0]?.marks.size ?? "medium",
    color: runs[0]?.marks.color ?? "ink",
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
