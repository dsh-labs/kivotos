/**
 * dsh 0.2.2-rc.2's rendered frame and conversation, as Kivotos reads them.
 *
 * dsh lays itself out for a phone below 768px: the sidebar becomes a modal
 * drawer with its own opener and mask (ui-layout AppFrame, ui-sidebar), and
 * Settings fills the screen with its sections as a tab row (ui-settings-general
 * SettingsRoot). Kivotos adds only what dsh does not do on a phone, in the
 * phone stylesheet:
 *
 * - plain-element touch rules (no dsh markup);
 * - `phone-conversation`: the welcome page's hero pinned near the top of a
 *   tall screen, and a conversation scroller that does not chain its
 *   overscroll into the page (ui-conversation ConversationRoot).
 *
 * Reading the conversation's markup is a deliberate, version-pinned exception
 * to "do not read another plugin's DOM" (CLAUDE.md): CSS-module class
 * suffixes (`_viewArea`, matched as `[class*="_viewArea"]`, since the prefix
 * is a build hash) and data attributes. The group is built from the same
 * {@link PARTS} its probe checks, and withheld when the probe fails.
 *
 * No Node imports: the Client bundle includes this module.
 */
import { changed, ok, usable, type CompatReport, type Probe } from "./compat.ts";

const suffix = (name: string): string => `[class*="_${name}"]`;

/** Every piece of dsh markup the client module relies on. */
export const PARTS = {
  /** AppFrame's overlay layer; the frame is its parent. */
  overlay: "[data-shell-overlay]",
  composer: "[data-composer-seat]",
  content: "[data-conversation-content]",
  scroll: "[data-conversation-scroll]",
  /** The Session's message view; the welcome page, with no Session open, has none. */
  viewArea: suffix("viewArea"),
  /** An open dsh menu (account menu, row menus, the composer's selects). */
  menu: "[role=menu]",
  /** A dsh modal dialog: Settings, a confirmation, the preview notice, and the drawer while it is open. */
  modal: '[role=dialog][aria-modal="true"]',
} as const;

const P = PARTS;

/** The element reads a probe makes; `Element` satisfies it. */
export interface FrameNode {
  querySelector(selectors: string): FrameNode | null;
}

/** The page read a probe makes; `Document` satisfies it. */
export interface FramePage {
  querySelector(selectors: string): FrameNode | null;
}

/**
 * The conversation scroller the phone stylesheet pins and contains. Point
 * `phone-conversation`; judged once the conversation content is on the page,
 * which is the same on the welcome page and in a Session.
 * @param page - the page dsh rendered.
 */
export function probePhoneConversation(page: FramePage): Probe | undefined {
  const content = page.querySelector(P.content);
  if (content === null) return undefined;
  if (content.querySelector(P.scroll) === null) return changed(`${P.content} has no ${P.scroll}`);
  return ok("the conversation matches the pinned markup");
}

const CONVERSATION_CSS = (phone: string): string => `
@media ${phone}{
  ${P.scroll}{overscroll-behavior:contain}
  /* dsh centers the welcome page's hero (its hero phase centers the scroll
     body). A phone's screen is tall, so centering leaves a large blank above
     it; on a phone the hero sits near the top. A conversation with messages
     has the message view and is untouched. Marked important because the hero
     phase's rule is more specific. */
  ${P.scroll}:not(:has(${P.viewArea})){justify-content:flex-start!important;padding-top:clamp(16px,10vh,96px)}
}`;

/** Phone rules on plain elements: they rely on no dsh markup. */
const TOUCH_CSS = (phone: string): string => `
@media ${phone}{
  html,body{overscroll-behavior:none}
  button,[role="button"],[role="treeitem"]{touch-action:manipulation}
  input,textarea,select,[contenteditable="true"]{font-size:max(16px,1em)}
}`;

/**
 * The phone stylesheet, without the group whose probe failed.
 * @param report - the page's compat report.
 * @param phone - the media query that means a phone.
 * @returns CSS text.
 */
export function phoneStylesheet(report: CompatReport, phone: string): string {
  let css = TOUCH_CSS(phone);
  if (usable(report, "phone-conversation")) css += CONVERSATION_CSS(phone);
  return css;
}

/** @returns whether dsh has rendered its frame on the page. */
export function shellRendered(page: FramePage): boolean {
  return page.querySelector(P.overlay) !== null;
}

/** Kivotos' own machine switcher list (client.tsx), which closes on Escape like a dsh menu. */
const SWITCHER_LIST = ".kivotos-machines-list";

/** Every layer a phone Back may find open over the page: by ARIA, plus the switcher. */
const LAYERS = `${P.modal}, ${P.menu}, ${SWITCHER_LIST}`;

/**
 * A suggestions popup (the composer's `/` and `@` triggers: ui-input-trigger
 * renders it as a `[role=listbox]` in `conversation.input.overlay`, inside the
 * composer seat, with no portal). dsh 0.2.2-rc.2 marks no combobox owner for
 * it (no `aria-controls`, `aria-owns` or `aria-expanded` on the editor), so
 * it counts as a layer only while its owner has the focus: an editor
 * ({@link EDITOR}) in the same composer seat, whose keymap closes it on
 * Escape. An approval card, which takes the editor's place in the seat, is
 * never an owner.
 */
const LISTBOX = "[role=listbox]";

/** The composer's editor (Lexical's `contenteditable` root). */
const EDITOR = '[contenteditable="true"]';

/** The page `openLayer` reads and `closeLayer` dispatches on; `Document` satisfies it. */
export interface LayerPage {
  readonly activeElement: Element | null;
  querySelectorAll(selectors: string): ArrayLike<Element>;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** What a phone Back finds open over the page (`openLayer`). */
export interface OpenLayer {
  /** The topmost layer, the one an Escape closes. */
  readonly element: Element;
  /**
   * Where its Escape goes: the focused element when it is inside the layer,
   * the editor that owns a suggestions popup, else the layer itself; never
   * the document, an approval card or the conversation outside the layer.
   */
  readonly target: Element;
  /** How many layers are open, the topmost included; it changes whenever one opens or closes. */
  readonly depth: number;
}

/**
 * Find what dsh shows over the page, for a phone Back to close as a native
 * app's Back would. The topmost layer is the last open menu, switcher list,
 * modal dialog or owned suggestions popup ({@link LISTBOX}) in document
 * order, the order of dsh's own modal stack (`useModalLayer`); the open
 * drawer is a modal dialog too. Nothing is open when the topmost layer is
 * one an Escape did not close (`closeLayer`): a dialog only its own buttons
 * dismiss, such as the preview notice.
 * @param page - the page dsh rendered.
 * @param kept - layers an Escape did not close; dropped once gone or no longer open.
 * @returns the open layers, or null when there is none to close.
 */
export function openLayer(page: LayerPage, kept: Set<Element>): OpenLayer | null {
  for (const element of kept)
    if (!element.isConnected || !element.matches(`${LAYERS}, ${LISTBOX}`)) kept.delete(element);
  const focused = page.activeElement;
  const seat = focused?.matches(EDITOR) === true ? focused.closest(P.composer) : null;
  const layers = Array.from(page.querySelectorAll(`${LAYERS}, ${LISTBOX}`)).filter(
    (element) =>
      !element.matches(LISTBOX) || (seat !== null && element.closest(P.composer) === seat),
  );
  const top = layers.at(-1);
  if (top === undefined || kept.has(top)) return null;
  const target =
    focused !== null && (top.contains(focused) || top.matches(LISTBOX)) ? focused : top;
  return { element: top, target, depth: layers.length };
}

/**
 * Close the topmost layer with one Escape, the key dsh closes its own layers
 * on: menus take it in the capture phase, modals and the drawer in
 * `useModalLayer`, a suggestions popup in the composer's keymap, the
 * switcher in client.tsx. The keydown and keyup go to the layer's
 * {@link OpenLayer.target}, so an Escape never reaches an approval card (it
 * would reject the approval). Nothing is sent when nothing is open.
 *
 * An Escape no layer spent (`defaultPrevented`, as each of the above does)
 * stops at the document: a one-shot bubble listener there, added after
 * dsh's own document listeners and so run after them, keeps it from the
 * window, where dsh's shortcut service (`dsh-client-shortcuts`, a `window`
 * bubble `keydown`) would count it toward stopping the reply. That is the
 * case of a modal outside dsh's Escape stack.
 * @param page - the page dsh rendered.
 * @param kept - layers an Escape did not close (`openLayer`); one more is added here.
 * @param render - runs the dispatch and renders what it changed before it
 *   returns (react-dom's `flushSync`), so the outcome can be read at once.
 * @returns whether the topmost layer closed; false when nothing was open, or
 *   when the Escape left the layer open (it is kept from then on).
 */
export function closeLayer(
  page: LayerPage,
  kept: Set<Element>,
  render: (dispatch: () => void) => void,
): boolean {
  const layer = openLayer(page, kept);
  if (layer === null) return false;
  const init = {
    key: "Escape",
    code: "Escape",
    keyCode: 27,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  const unspent = (event: Event): void => {
    if (!event.defaultPrevented) event.stopPropagation();
  };
  page.addEventListener("keydown", unspent);
  page.addEventListener("keyup", unspent);
  try {
    render(() => {
      for (const type of ["keydown", "keyup"])
        layer.target.dispatchEvent(new KeyboardEvent(type, init));
    });
  } finally {
    page.removeEventListener("keydown", unspent);
    page.removeEventListener("keyup", unspent);
  }
  if (openLayer(page, kept)?.element !== layer.element) return true;
  kept.add(layer.element);
  return false;
}

/** The fields of a composer keydown the phone layout judges; `KeyboardEvent` satisfies it. */
export interface ComposerKey {
  readonly key: string;
  readonly isComposing?: boolean;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
}

/**
 * Whether a phone's keydown in the composer asks for a line break instead of
 * a send. dsh sends on a plain Enter and writes the line break for
 * Shift+Enter; a phone's keyboard has no Shift to ask with, so the phone
 * layout turns the send into the line break dsh already knows how to insert
 * (`client.tsx`, `usePhoneComposerLineBreak`). A composition's Enter commits
 * the composition and is dsh's to handle; the other chords keep their meaning.
 * @param event - the composer's keydown.
 * @returns whether the phone layout re-sends this keydown with Shift held.
 */
export function plainEnter(event: ComposerKey): boolean {
  return (
    event.key === "Enter" &&
    event.isComposing !== true &&
    event.shiftKey !== true &&
    event.ctrlKey !== true &&
    event.altKey !== true &&
    event.metaKey !== true
  );
}

/** Strings the nightly check expects in dsh's bundles (scripts/dsh-compat.mjs). */
export const MARKERS = Object.values(PARTS)
  .filter((part) => part !== PARTS.menu && part !== PARTS.modal)
  .map(
    (part) => /^\[class\*="(_\w+)"\]$/.exec(part)?.[1] ?? /^\[?([\w-]+)/.exec(part)?.[1] ?? part,
  );
