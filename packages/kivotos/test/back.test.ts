import assert from "node:assert/strict";
import { test } from "node:test";
import { closeLayer, openLayer, type LayerPage } from "../src/dsh/frame.ts";

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
 * One rendered element: what it is (by ARIA), what it holds, and what an
 * Escape that reaches it does, as dsh's own listeners would.
 */
interface Fake {
  role?: "menu" | "modal" | "switcher" | "card" | "composer";
  children?: Fake[];
  /** Whether it is still rendered as open (an Escape it handles may close it). */
  open?: boolean;
  /** What an Escape reaching it does: true closes it, false spends it without closing. */
  onEscape?: boolean;
  /** Escape keydowns that reached it (its own or a child's, as they bubble). */
  escapes?: number;
}

const ROLES: Record<string, Fake["role"]> = {
  "[role=menu]": "menu",
  '[role=dialog][aria-modal="true"]': "modal",
  ".kivotos-machines-list": "switcher",
};

interface Page extends LayerPage {
  focus(fake: Fake | null): void;
  element(fake: Fake): Element;
}

/** A page of `roots` in document order, read the way `openLayer` reads one. */
function pageOf(...roots: Fake[]): Page {
  const elements = new Map<Fake, Element>();
  const parents = new Map<Fake, Fake>();
  const walk = (nodes: Fake[], parent?: Fake): Fake[] =>
    nodes.flatMap((node) => {
      if (parent !== undefined) parents.set(node, parent);
      return [node, ...walk(node.children ?? [], node)];
    });
  const all = (): Fake[] => walk(roots).filter((node) => node.open !== false);
  const isLayer = (node: Fake, selectors: string): boolean =>
    node.open !== false &&
    selectors.split(",").some((selector) => ROLES[selector.trim()] === node.role);
  const inside = (node: Fake | undefined, outer: Fake): boolean => {
    for (let at = node; at !== undefined; at = parents.get(at)) if (at === outer) return true;
    return false;
  };
  let focused: Fake | null = null;
  const element = (node: Fake): Element => {
    let made = elements.get(node);
    if (made === undefined) {
      made = {
        get isConnected() {
          return all().includes(node);
        },
        matches: (selectors: string) => isLayer(node, selectors),
        contains: (other: Element | null) =>
          inside([...elements].find(([, each]) => each === other)?.[0], node),
        dispatchEvent(event: Event) {
          // The event bubbles from `node` up; the first handler on the way acts.
          for (let at: Fake | undefined = node; at !== undefined; at = parents.get(at)) {
            if (event.type !== "keydown" || (event as KeyboardEvent).key !== "Escape") break;
            at.escapes = (at.escapes ?? 0) + 1;
            if (at.onEscape === undefined) continue;
            if (at.onEscape) at.open = false;
            break;
          }
          return true;
        },
      } as unknown as Element;
      elements.set(node, made);
    }
    return made;
  };
  return {
    get activeElement() {
      return focused === null ? null : element(focused);
    },
    querySelectorAll: (selectors: string) =>
      all()
        .filter((node) => isLayer(node, selectors))
        .map(element),
    focus(fake) {
      focused = fake;
    },
    element,
  };
}

// What `flushSync` does here: the fakes change at once.
const render = (dispatch: () => void): void => dispatch();

const drawer = (...children: Fake[]): Fake => ({ role: "modal", onEscape: true, children });
const menu = (): Fake => ({ role: "menu", onEscape: true });

test("nothing is open over a conversation, and Back sends no Escape there", () => {
  const card: Fake = { role: "card", onEscape: true };
  const composer: Fake = { role: "composer", onEscape: true };
  const page = pageOf({ children: [card, composer] });
  const kept = new Set<Element>();
  assert.equal(openLayer(page, kept), null);
  for (const focus of [card, composer, null]) {
    page.focus(focus);
    assert.equal(closeLayer(page, kept, render), false);
  }
  // A pending approval is not rejected; a running reply is not stopped.
  assert.equal(card.escapes, undefined);
  assert.equal(composer.escapes, undefined);
  assert.equal(card.open, undefined);
});

test("the topmost layer is the last one in document order, and the depth counts them all", () => {
  const top = menu();
  const page = pageOf(drawer(), top);
  const layer = openLayer(page, new Set());
  assert.equal(layer?.element, page.element(top));
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
  const settings: Fake = { role: "modal", onEscape: true, children: [button] };
  const card: Fake = { role: "card", onEscape: true };
  const page = pageOf({ children: [card] }, settings);
  page.focus(button);
  assert.equal(closeLayer(page, new Set(), render), true);
  assert.equal(button.escapes, 1);
  assert.equal(settings.open, false);

  const dialog: Fake = { role: "modal", onEscape: true };
  const other = pageOf({ children: [card] }, dialog);
  other.focus(card);
  assert.equal(closeLayer(other, new Set(), render), true);
  assert.equal(dialog.open, false);
  assert.equal(card.escapes, undefined);
  assert.equal(card.open, undefined);
});

test("the switcher in the drawer is a layer of its own", () => {
  const switcher: Fake = { role: "switcher", onEscape: true };
  const sidebar = drawer(switcher);
  const page = pageOf(sidebar);
  const kept = new Set<Element>();
  assert.equal(openLayer(page, kept)?.element, page.element(switcher));
  assert.equal(closeLayer(page, kept, render), true);
  assert.equal(switcher.open, false);
  assert.equal(sidebar.open, undefined);
  assert.equal(openLayer(page, kept)?.element, page.element(sidebar));
});

test("a dialog an Escape does not close (the preview notice) is kept: nothing is open after it", () => {
  const notice: Fake = { role: "modal", onEscape: false };
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
