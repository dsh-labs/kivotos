import assert from "node:assert/strict";
import { test } from "node:test";
import { backLayer, PARTS } from "../src/dsh/frame.ts";

/** A rendered element: tag, attributes, children; enough for `backLayer`'s selectors. */
interface Node {
  tag?: string;
  attrs?: Record<string, string>;
  children?: Node[];
  /** Set by `pageOf`: what a click on it did. */
  clicked?: number;
}

/** One compound selector: `tag`, `.class`, `[attr]`, `[attr=v]`, `[attr="v"]`, `[attr*="v"]`. */
function matchesOne(node: Node, selector: string): boolean {
  const attrs = node.attrs ?? {};
  const tag = /^[a-z]+/.exec(selector)?.[0];
  if (tag !== undefined && (node.tag ?? "div") !== tag) return false;
  for (const [, name] of selector.matchAll(/\.([\w-]+)/g))
    if (!(attrs.class ?? "").split(" ").includes(name)) return false;
  for (const [, name, op, value] of selector.matchAll(/\[([\w-]+)(?:(\*?=)"?([^"\]]*)"?)?\]/g)) {
    if (!(name in attrs)) return false;
    if (op === "=" && attrs[name] !== value) return false;
    if (op === "*=" && !attrs[name].includes(value)) return false;
  }
  return true;
}

const matches = (node: Node, list: string): boolean =>
  list.split(",").some((selector) => matchesOne(node, selector.trim()));

function all(nodes: Node[]): Node[] {
  return nodes.flatMap((node) => [node, ...all(node.children ?? [])]);
}

interface Element {
  matches(selectors: string): boolean;
  querySelector(selectors: string): Element | null;
  click(): void;
}

function element(node: Node): Element {
  return {
    matches: (selectors) => matches(node, selectors),
    querySelector: (selectors) => {
      const found = all(node.children ?? []).find((each) => matches(each, selectors));
      return found === undefined ? null : element(found);
    },
    click: () => {
      node.clicked = (node.clicked ?? 0) + 1;
    },
  };
}

/** A page of `roots` in document order, as `backLayer` reads it. */
function pageOf(...roots: Node[]): Document {
  const nodes = all(roots);
  const page = {
    body: element({ tag: "body" }),
    querySelector: (selectors: string) => {
      const found = nodes.find((node) => matches(node, selectors));
      return found === undefined ? null : element(found);
    },
    querySelectorAll: (selectors: string) => {
      const found = nodes.filter((node) => matches(node, selectors)).map(element);
      return { length: found.length, item: (index: number) => found[index] ?? null };
    },
  };
  return page as unknown as Document;
}

const cls = (value: string): Record<string, string> => ({ class: value });
const modal = { role: "dialog", "aria-modal": "true" };
const close = (): Node => ({ tag: "button", attrs: cls("_close_14mp3_80") });

/** dsh 0.2.2-rc.2's frame; SidebarRoot is a modal dialog while it is the open drawer. */
function frame(drawerOpen: boolean, sidebar: Node[] = []): Node {
  const root: Node = {
    attrs: {
      ...cls("hHd-Xa_root"),
      role: "dialog",
      "data-shortcut-modal": "sidebar",
      ...(drawerOpen ? { "aria-modal": "true" } : {}),
    },
    children: sidebar,
  };
  return {
    attrs: { ...cls("pI_x6G_frame"), "data-sidebar-drawer": "true" },
    children: [
      { attrs: cls("pI_x6G_sidebarCol"), children: [{ children: [root] }] },
      { attrs: cls("pI_x6G_centerCol") },
      { attrs: { "data-shell-overlay": "true" } },
    ],
  };
}

/** dsh's Settings panel: a modal with its close button in the header. */
const settings = (): Node => ({
  attrs: { ...cls("VOzbGW_panel"), ...modal, "data-shortcut-modal": "settings" },
  children: [
    {
      attrs: cls("VOzbGW_content"),
      children: [{ attrs: cls("VOzbGW_header"), children: [close()] }],
    },
  ],
});

test("Back finds nothing over a conversation with the drawer closed", () => {
  assert.deepEqual(backLayer(pageOf(frame(false))), { kind: "none" });
});

test("Back finds the open drawer, not a modal without a close button", () => {
  // SidebarRoot is `[role=dialog][aria-modal=true]` with no `_close` while open.
  assert.equal(backLayer(pageOf(frame(true))).kind, "drawer");
  assert.ok(PARTS.drawer.includes("sidebar"));
});

test("Back closes a menu or the switcher before the drawer under it", () => {
  const menu: Node = { attrs: { role: "menu" } };
  assert.equal(backLayer(pageOf(frame(true), menu)).kind, "close");
  const switcher: Node = { tag: "ul", attrs: cls("kivotos-machines-list") };
  // The switcher sits inside the drawer's footer: after SidebarRoot in document order.
  assert.equal(backLayer(pageOf(frame(true, [switcher]))).kind, "close");
});

test("Back clicks the close button of the topmost dialog", () => {
  const confirm = close();
  const dialog: Node = { attrs: { ...cls("_dialog_14mp3_33"), ...modal }, children: [confirm] };
  const layer = backLayer(pageOf(frame(true), settings(), dialog));
  assert.equal(layer.kind, "close");
  if (layer.kind === "close") layer.close();
  assert.equal(confirm.clicked, 1);
});

test("Back closes Settings over the drawer by its header button", () => {
  const panel = settings();
  const layer = backLayer(pageOf(frame(true), panel));
  assert.equal(layer.kind, "close");
  if (layer.kind === "close") layer.close();
  assert.equal(all([panel]).find((node) => node.tag === "button")?.clicked, 1);
});

test("Back keeps a dialog without a close button (the preview notice)", () => {
  const notice: Node = {
    attrs: { ...cls("_dialog_14mp3_33 jLrgrW_dialog"), ...modal },
    children: [{ tag: "button", attrs: cls("_button_1ulci_2 _primary_1ulci_30") }],
  };
  assert.deepEqual(backLayer(pageOf(frame(false), notice)), { kind: "kept" });
});

test("Back does not read the drawer as a modal when dsh is not in drawer mode", () => {
  // Wide layout: SidebarRoot carries no role and no aria-modal.
  const wide: Node = { attrs: cls("pI_x6G_frame"), children: [{ attrs: cls("hHd-Xa_root") }] };
  assert.deepEqual(backLayer(pageOf(wide)), { kind: "none" });
});
