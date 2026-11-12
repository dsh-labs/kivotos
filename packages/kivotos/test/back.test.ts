import assert from "node:assert/strict";
import { test } from "node:test";
import { backLayer, closeLayer, PARTS } from "../src/dsh/frame.ts";

/** A rendered element: tag, attributes, children; enough for `backLayer`'s selectors. */
interface Node {
  tag?: string;
  attrs?: Record<string, string>;
  children?: Node[];
  /** What clicks on it did (`click()`). */
  clicked?: number;
  /** Gone from the page: dsh has rendered its closing. */
  removed?: boolean;
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
  readonly isConnected: boolean;
  matches(selectors: string): boolean;
  querySelector(selectors: string): Element | null;
  click(): void;
}

// One element per node, so `backLayer`'s `closing` set can hold them.
const elements = new WeakMap<Node, Element>();

function element(node: Node): Element {
  const known = elements.get(node);
  if (known !== undefined) return known;
  const self: Element = {
    get isConnected() {
      return node.removed !== true;
    },
    matches: (selectors) => matches(node, selectors),
    querySelector: (selectors) => {
      const found = all(node.children ?? []).find((each) => matches(each, selectors));
      return found === undefined ? null : element(found);
    },
    click: () => {
      node.clicked = (node.clicked ?? 0) + 1;
    },
  };
  elements.set(node, self);
  return self;
}

/** A page of `roots` in document order, as `backLayer` reads it; a removed node is gone. */
function pageOf(...roots: Node[]): Document {
  const nodes = (): Node[] => all(roots).filter((node) => node.removed !== true);
  const page = {
    body: element({ tag: "body" }),
    querySelector: (selectors: string) => {
      const found = nodes().find((node) => matches(node, selectors));
      return found === undefined ? null : element(found);
    },
    querySelectorAll: (selectors: string) =>
      nodes()
        .filter((node) => matches(node, selectors))
        .map(element),
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

const openOf = (page: Document, closing = new Set<Element>()): string | null =>
  backLayer(page, closing as unknown as Set<globalThis.Element>)?.open ?? null;

test("Back finds nothing over a conversation with the drawer closed", () => {
  assert.equal(openOf(pageOf(frame(false))), null);
});

test("Back finds the open drawer, not a modal without a close button", () => {
  // SidebarRoot is `[role=dialog][aria-modal=true]` with no `_close` while open.
  assert.equal(openOf(pageOf(frame(true))), "drawer");
  assert.ok(PARTS.drawer.includes("sidebar"));
});

test("Back closes a menu or the switcher before the drawer under it", () => {
  const menu: Node = { attrs: { role: "menu" } };
  assert.equal(openOf(pageOf(frame(true), menu)), "menu");
  const switcher: Node = { tag: "ul", attrs: cls("kivotos-machines-list") };
  // The switcher sits inside the drawer's footer: after SidebarRoot in document order.
  assert.equal(openOf(pageOf(frame(true, [switcher]))), "menu");
});

test("Back clicks the close button of the topmost dialog", () => {
  const confirm = close();
  const dialog: Node = { attrs: { ...cls("_dialog_14mp3_33"), ...modal }, children: [confirm] };
  const page = pageOf(frame(true), settings(), dialog);
  const layer = backLayer(page, new Set());
  assert.equal(layer?.open, "dialog");
  if (layer !== null) closeLayer(page, layer, () => assert.fail("not the drawer"));
  assert.equal(confirm.clicked, 1);
});

test("Back closes Settings over the drawer by its header button", () => {
  const panel = settings();
  const page = pageOf(frame(true), panel);
  const layer = backLayer(page, new Set());
  assert.equal(layer?.open, "dialog");
  if (layer !== null) closeLayer(page, layer, () => assert.fail("not the drawer"));
  assert.equal(all([panel]).find((node) => node.tag === "button")?.clicked, 1);
});

test("Back closes the drawer through the caller", () => {
  const page = pageOf(frame(true));
  const layer = backLayer(page, new Set());
  let closed = 0;
  if (layer !== null) closeLayer(page, layer, () => (closed += 1));
  assert.equal(closed, 1);
});

test("Back has nothing to close under a dialog without a close button (the preview notice)", () => {
  const notice: Node = {
    attrs: { ...cls("_dialog_14mp3_33 jLrgrW_dialog"), ...modal },
    children: [{ tag: "button", attrs: cls("_button_1ulci_2 _primary_1ulci_30") }],
  };
  assert.equal(openOf(pageOf(frame(true), notice)), null);
});

test("Back does not read the drawer as a modal when dsh is not in drawer mode", () => {
  // Wide layout: SidebarRoot carries no role and no aria-modal.
  const wide: Node = { attrs: cls("pI_x6G_frame"), children: [{ attrs: cls("hHd-Xa_root") }] };
  assert.equal(openOf(pageOf(wide)), null);
});

test("a second Back before dsh renders the first close takes the next layer", () => {
  const menu: Node = { attrs: { role: "menu" } };
  const drawer = frame(true);
  const page = pageOf(drawer, menu);
  const closing = new Set<globalThis.Element>();
  const first = backLayer(page, closing);
  assert.equal(first?.open, "menu");
  if (first !== null) closing.add(first.element);
  // The menu is still in the page: the drawer is next, and is not toggled twice.
  const second = backLayer(page, closing);
  assert.equal(second?.open, "drawer");
  if (second !== null) closing.add(second.element);
  assert.equal(backLayer(page, closing), null);
  // Once rendered closed, the layers leave `closing`: the drawer reopened is open again.
  menu.removed = true;
  const root = all([drawer]).find((node) => node.attrs?.["data-shortcut-modal"] === "sidebar");
  delete root?.attrs?.["aria-modal"];
  assert.equal(backLayer(page, closing), null);
  assert.equal(closing.size, 0);
  if (root?.attrs !== undefined) root.attrs["aria-modal"] = "true";
  assert.equal(backLayer(page, closing)?.open, "drawer");
});
