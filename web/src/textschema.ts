import { FONT_SIZES, TEXT_COLORS, isSafeLink, type TextColor } from "@felix-canvas/model";
import { Schema, type DOMOutputSpec } from "prosemirror-model";

/**
 * The editor's schema: exactly the elements and marks `model/` derives
 * content from, under the same names, so what the editor writes is what
 * every replica draws. Pasted HTML is parsed against it and anything else is
 * dropped. Sizes and colours are parsed only from this editor's own markup,
 * never from a page's styles, so a body cannot pick up a colour outside the
 * palette. Marks nest in the order listed, so an underline takes the colour
 * and size of the text it is under.
 */
export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    p: {
      group: "block",
      content: "text*",
      parseDOM: [{ tag: "p" }, { tag: "div", priority: 0 }],
      toDOM: () => ["p", 0],
    },
    h: {
      group: "block",
      content: "text*",
      attrs: { level: { default: 1 } },
      defining: true,
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
        tag: `h${level}`,
        attrs: { level: Math.min(level, 3) },
      })),
      toDOM: (node) => [`h${node.attrs.level as number}`, 0],
    },
    ul: {
      group: "block",
      content: "li+",
      parseDOM: [{ tag: "ul" }],
      toDOM: () => ["ul", 0],
    },
    ol: {
      group: "block",
      content: "li+",
      parseDOM: [{ tag: "ol" }],
      toDOM: () => ["ol", 0],
    },
    li: {
      content: "p block*",
      defining: true,
      parseDOM: [{ tag: "li" }],
      toDOM: () => ["li", 0],
    },
    text: {},
  },
  marks: {
    size: {
      attrs: { step: {} },
      parseDOM: [
        {
          tag: "span[data-size]",
          getAttrs: (node) => {
            const step = node.dataset.size;
            return step === "small" || step === "large" || step === "huge" ? { step } : false;
          },
        },
      ],
      toDOM: (mark): DOMOutputSpec => {
        const step = mark.attrs.step as keyof typeof FONT_SIZES;
        return ["span", { "data-size": step, style: `font-size: ${FONT_SIZES[step]}px` }, 0];
      },
    },
    color: {
      attrs: { name: {} },
      parseDOM: [
        {
          tag: "span[data-color]",
          getAttrs: (node) => {
            const name = node.dataset.color as TextColor;
            return TEXT_COLORS.includes(name) && name !== "ink" ? { name } : false;
          },
        },
      ],
      toDOM: (mark): DOMOutputSpec => {
        const name = mark.attrs.name as string;
        return ["span", { "data-color": name, style: `color: var(--text-${name})` }, 0];
      },
    },
    b: {
      parseDOM: [
        { tag: "strong" },
        // Google Docs wraps everything in <b style="font-weight:normal">.
        { tag: "b", getAttrs: (node) => node.style.fontWeight !== "normal" && null },
        {
          style: "font-weight",
          getAttrs: (value) => /^(bold(er)?|[6-9]\d\d)$/.test(value) && null,
        },
      ],
      toDOM: () => ["strong", 0],
    },
    i: {
      parseDOM: [{ tag: "em" }, { tag: "i" }, { style: "font-style=italic" }],
      toDOM: () => ["em", 0],
    },
    u: {
      parseDOM: [{ tag: "u" }, { style: "text-decoration=underline" }],
      toDOM: () => ["u", 0],
    },
    a: {
      attrs: { href: {} },
      inclusive: false,
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (node) => {
            const href = node.getAttribute("href") ?? "";
            return isSafeLink(href) ? { href } : false;
          },
        },
      ],
      toDOM: (mark): DOMOutputSpec => [
        "a",
        { href: mark.attrs.href as string, rel: "noopener noreferrer nofollow", target: "_blank" },
        0,
      ],
    },
  },
});
