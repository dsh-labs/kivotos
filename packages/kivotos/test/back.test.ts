import assert from "node:assert/strict";
import { test } from "node:test";
import { closeLayer, openLayer, PARTS, type LayerPage } from "../src/dsh/frame.ts";

// Node has no KeyboardEvent; this is enough for what `closeLayer` builds.
class KeyboardEvent extends Event {
  readonly key: string;
  constructor(type: string, init: KeyboardEventInit) {
    super(type, init);
    this.key = init.key ?? "";
  }
}
Object.assign(globalThis, { KeyboardEvent });

/**
 * One rendered element: what it is, what it holds, and what an Escape that
 * reaches it does, as dsh's own listeners would.
 */
interface Fake {
  role?: "menu" | "modal" | "switcher" | "listbox" | "seat" | "editor" | "card";
  children?: Fake[];
  /** Whether it is still rendered (an Escape it handles may close it). */
  open?: boolean;
  /**
   * What an Escape reaching it does: `close` spends it and closes `closes`
   * (itself by default); `spend` spends it and closes nothing (the preview
   * notice); none lets it bubble on.
   */
  onEscape?: "close" | "spend";
  closes?: Fake;
  /** Escape keydowns that reached it (its own or a child's, as they bubble). */
  escapes?: number;
}

const ROLES: Record<string, Fake["role"]> = {
  "[role=menu]": "menu",
  '[role=dialog][aria-modal="true"]': "modal",
  ".kivotos-machines-list": "switcher",
  "[role=listbox]": "listbox",
  [PARTS.composer]: "seat",
  '[contenteditable="true"]': "editor",
};

interface Page extends LayerPage {
  focus(fake: Fake | null): void;
  element(fake: Fake): Element;
  /** Escape keydowns that reached the window, where dsh's shortcut service listens. */
  window: number;
}

/** A page of `roots` in document order, read and dispatched on the way `closeLayer` does. */
function pageOf(...roots: Fake[]): Page {
  const elements = new Map<Fake, Element>();
  const parents = new Map<Fake, Fake>();
  const link = (nodes: Fake[], parent?: Fake): void => {
    for (const node of nodes) {
      if (parent !== undefined) parents.set(node, parent);
      link(node.children ?? [], node);
    }
  };
  link(roots);
  const rendered = (): Fake[] => {
    const out: Fake[] = [];
    const visit = (nodes: Fake[]): void => {
      for (const node of nodes) {
        if (node.open === false) continue;
        out.push(node);
        visit(node.children ?? []);
      }
    };
    visit(roots);
    return out;
  };
  const is = (node: Fake, selectors: string): boolean =>
    selectors.split(",").some((selector) => ROLES[selector.trim()] === node.role);
  const fakeOf = (other: Element | null): Fake | undefined =>
    [...elements].find(([, each]) => each === other)?.[0];
  const up = function* (node: Fake | undefined): Generator<Fake> {
    for (let at = node; at !== undefined; at = parents.get(at)) yield at;
  };
  const listeners = new Map<string, Set<(event: Event) => void>>();
  let focused: Fake | null = null;
  const page: Page = {
    window: 0,
    get activeElement() {
      return focused === null ? null : element(focused);
    },
    querySelectorAll: (selectors) =>
      rendered()
        .filter((node) => is(node, selectors))
        .map(element),
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    focus(fake) {
      focused = fake;
    },
    element,
  };
  function element(node: Fake): Element {
    let made = elements.get(node);
    if (made !== undefined) return made;
    made = {
      get isConnected() {
        return rendered().includes(node);
      },
      matches: (selectors: string) => is(node, selectors),
      closest: (selectors: string) => {
        for (const at of up(node)) if (is(at, selectors)) return element(at);
        return null;
      },
      contains: (other: Element | null) => [...up(fakeOf(other))].includes(node),
      dispatchEvent(event: Event) {
        // Up from `node`: the first handler on the way acts; then the
        // document's listeners; then the window, unless stopped.
        for (const at of up(node)) {
          if (event.type === "keydown") at.escapes = (at.escapes ?? 0) + 1;
          if (at.onEscape === undefined || event.type !== "keydown") continue;
          event.preventDefault();
          if (at.onEscape === "close") (at.closes ?? at).open = false;
          break;
        }
        for (const listener of listeners.get(event.type) ?? []) listener(event);
        if (event.type === "keydown" && !event.cancelBubble) page.window += 1;
        return true;
      },
    } as unknown as Element;
    elements.set(node, made);
    return made;
  }
  return page;
}

// What `flushSync` does here: the fakes change at once.
const render = (dispatch: () => void): void => dispatch();

const drawer = (...children: Fake[]): Fake => ({ role: "modal", onEscape: "close", children });
const menu = (): Fake => ({ role: "menu", onEscape: "close" });
/** A composer seat: the editor and, when open, its suggestions popup. */
function composer(popup: boolean): { seat: Fake; editor: Fake; listbox: Fake } {
  const listbox: Fake = { role: "listbox", open: popup };
  const editor: Fake = { role: "editor", onEscape: "close", closes: listbox };
  return { seat: { role: "seat", children: [listbox, editor] }, editor, listbox };
}

test("nothing is open over a conversation, and Back sends no Escape there", () => {
  const card: Fake = { role: "card", onEscape: "close" };
  const { seat, editor } = composer(false);
  const page = pageOf({ children: [card, seat] });
  const kept = new Set<Element>();
  assert.equal(openLayer(page, kept), null);
  for (const focus of [card, editor, null]) {
    page.focus(focus);
    assert.equal(closeLayer(page, kept, render), false);
  }
  // A pending approval is not rejected; a running reply is not stopped.
  assert.equal(card.escapes, undefined);
  assert.equal(editor.escapes, undefined);
  assert.equal(page.window, 0);
});

test("the topmost layer is the last one in document order, and the depth counts them all", () => {
  const top = menu();
  const page = pageOf(drawer(), top);
  const layer = openLayer(page, new Set());
  assert.equal(layer?.element, page.element(top));
  assert.equal(layer?.target, page.element(top));
  assert.equal(layer?.depth, 2);
});

test("one Back closes one layer: a menu over the drawer, then the drawer", () => {
  const over = menu();
  const under = drawer();
  const page = pageOf(under, over);
  const kept = new Set<Element>();
  assert.equal(closeLayer(page, kept, render), true);
  assert.equal(over.open, false);
  assert.equal(under.open, undefined);
  assert.equal(openLayer(page, kept)?.depth, 1);
  assert.equal(closeLayer(page, kept, render), true);
  assert.equal(under.open, false);
  assert.equal(openLayer(page, kept), null);
  assert.equal(over.escapes, 1);
  assert.equal(under.escapes, 1);
});

test("the Escape goes to the focus inside the layer, else to the layer, never to a card outside it", () => {
  const button: Fake = {};
  const settings: Fake = { role: "modal", onEscape: "close", children: [button] };
  const card: Fake = { role: "card", onEscape: "close" };
  const page = pageOf({ children: [card] }, settings);
  page.focus(button);
  assert.equal(closeLayer(page, new Set(), render), true);
  assert.equal(button.escapes, 1);
  assert.equal(settings.open, false);

  const dialog: Fake = { role: "modal", onEscape: "close" };
  const other = pageOf({ children: [card] }, dialog);
  other.focus(card);
  assert.equal(closeLayer(other, new Set(), render), true);
  assert.equal(dialog.open, false);
  assert.equal(card.escapes, undefined);
  assert.equal(card.open, undefined);
});

test("the switcher in the drawer is a layer of its own", () => {
  const switcher: Fake = { role: "switcher", onEscape: "close" };
  const sidebar = drawer(switcher);
  const page = pageOf(sidebar);
  const kept = new Set<Element>();
  assert.equal(openLayer(page, kept)?.element, page.element(switcher));
  assert.equal(closeLayer(page, kept, render), true);
  assert.equal(switcher.open, false);
  assert.equal(sidebar.open, undefined);
  assert.equal(openLayer(page, kept)?.element, page.element(sidebar));
});

test("a suggestions popup is a layer while its editor has the focus, and its Escape goes to the editor", () => {
  const { seat, editor, listbox } = composer(true);
  const page = pageOf({ children: [seat] });
  const kept = new Set<Element>();
  page.focus(editor);
  const layer = openLayer(page, kept);
  assert.equal(layer?.element, page.element(listbox));
  assert.equal(layer?.target, page.element(editor));
  assert.equal(closeLayer(page, kept, render), true);
  assert.equal(listbox.open, false);
  assert.equal(editor.escapes, 1);
  assert.equal(openLayer(page, kept), null);
});

test("a suggestions popup without its editor focused is not a layer, and nothing is sent", () => {
  const { seat, editor, listbox } = composer(true);
  const card: Fake = { role: "card", onEscape: "close" };
  // Another seat's editor, an approval card, a button in the seat, nothing.
  const elsewhere = composer(false);
  const button: Fake = {};
  seat.children?.push(button);
  const page = pageOf({ children: [card, seat, elsewhere.seat] });
  const kept = new Set<Element>();
  for (const focus of [elsewhere.editor, card, button, null]) {
    page.focus(focus);
    assert.equal(openLayer(page, kept), null);
    assert.equal(closeLayer(page, kept, render), false);
  }
  assert.equal(listbox.open, true);
  assert.equal(editor.escapes, undefined);
  assert.equal(card.escapes, undefined);
  assert.equal(page.window, 0);
});

test("an Escape no layer spends stops at the document and never reaches the shortcut service", () => {
  // A modal outside dsh's Escape stack: nothing on its path handles Escape.
  const foreign: Fake = { role: "modal" };
  const page = pageOf(foreign);
  const kept = new Set<Element>();
  assert.equal(closeLayer(page, kept, render), false);
  assert.equal(foreign.escapes, 1);
  assert.equal(page.window, 0);
  // It is kept: Back leaves, and no second Escape is sent.
  assert.equal(openLayer(page, kept), null);
  assert.equal(closeLayer(page, kept, render), false);
  assert.equal(foreign.escapes, 1);
  // A spent Escape is left to propagate, so dsh's shortcut service sees it
  // as spent (and resets its Esc Esc sequence); the one-shot listener is gone.
  const other = pageOf(menu());
  assert.equal(closeLayer(other, new Set(), render), true);
  assert.equal(other.window, 1);
});

test("a dialog an Escape does not close (the preview notice) is kept: nothing is open after it", () => {
  const notice: Fake = { role: "modal", onEscape: "spend" };
  const page = pageOf(drawer(), notice);
  const kept = new Set<Element>();
  assert.equal(openLayer(page, kept)?.depth, 2);
  // The close answers false, so the app leaves; the notice stays.
  assert.equal(closeLayer(page, kept, render), false);
  assert.equal(notice.open, undefined);
  assert.equal(openLayer(page, kept), null);
  // No second Escape goes to it, nor to the drawer under it.
  assert.equal(closeLayer(page, kept, render), false);
  assert.equal(notice.escapes, 1);
  // Once it is dismissed by its own button, the drawer is open again.
  notice.open = false;
  assert.equal(openLayer(page, kept)?.depth, 1);
  assert.equal(kept.size, 0);
});
