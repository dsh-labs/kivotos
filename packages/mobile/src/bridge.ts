/**
 * Script injected into every dsh page the WebView loads. It reports which
 * Session is on screen to React Native, so the native service skips
 * notifications for it, and lets React Native open a given Session.
 *
 * dsh keeps the current Session in `localStorage['dsh.sessions.current']` as
 * `{"sessionId": ...}` and restores it at startup (dsh 0.2.2-rc.2,
 * ui-workspace). On a Kivotos peer page `localStorage` is already the peer's
 * namespace, so the same key works everywhere.
 *
 * `__kivotosSwitch` tells the plugin's switcher (packages/kivotos/src/client.tsx)
 * that this app takes `kivotos.switch` messages: a page of an app without it
 * navigates by itself.
 *
 * `ready` is posted once per document, when the plugin's switcher is on the
 * page: dsh has rendered its shell, so the page can be shown at once. A
 * MutationObserver watches for it, which a hidden page still runs.
 */
export const BRIDGE = `(() => {
  if (window.__kivotosBridge) return;
  window.__kivotosBridge = true;
  window.__kivotosSwitch = true;
  const KEY = "dsh.sessions.current";
  const read = () => {
    try { return JSON.parse(localStorage.getItem(KEY) || "{}").sessionId || ""; } catch (e) { return ""; }
  };
  let last = null;
  const report = () => {
    const sessionId = read();
    if (sessionId === last) return;
    last = sessionId;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: "session", sessionId, path: location.pathname }));
  };
  const store = window.localStorage;
  const set = store.setItem.bind(store);
  store.setItem = (key, value) => { set(key, value); if (key === KEY) report(); };
  setInterval(report, 1000);
  report();
  const SHELL = ".kivotos-machines-trigger";
  const ready = () => window.ReactNativeWebView.postMessage(JSON.stringify({ type: "ready" }));
  if (document.querySelector(SHELL) !== null) ready();
  else {
    const observer = new MutationObserver(() => {
      if (document.querySelector(SHELL) === null) return;
      observer.disconnect();
      ready();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})(); true;`;

/**
 * Script that posts the machines the page's computer lists (`/kivotos/peers`,
 * absolute: the serving computer's list also on a peer's page), or null.
 */
export const PEERS_SCRIPT = `fetch("/kivotos/peers", { headers: { accept: "application/json" } })
  .then((res) => (res.ok ? res.json() : null))
  .catch(() => null)
  .then((body) => window.ReactNativeWebView.postMessage(JSON.stringify({
    type: "kivotos.peers",
    machines: body !== null && typeof body === "object" && Array.isArray(body.machines) ? body.machines : null,
  }))); true;`;

/**
 * Script that opens a Session: store it as current, then reload so dsh
 * restores it.
 * @param sessionId - Session to open.
 * @returns script source.
 */
export function openSessionScript(sessionId: string): string {
  const value = JSON.stringify(JSON.stringify({ sessionId }));
  return `localStorage.setItem("dsh.sessions.current", ${value}); location.reload(); true;`;
}

/**
 * Script that sends the page to a path of its own origin, for a switch the
 * app has no page to show for (see `switchTarget` in views.ts).
 * @param path - absolute path on the page's origin.
 * @returns script source.
 */
export function assignScript(path: string): string {
  return `location.assign(${JSON.stringify(path)}); true;`;
}

/**
 * Script that offers the hardware Back to a page that never reported its
 * layers (`kivotos.layers`), an older Kivotos: the plugin's
 * `window.__kivotosBack` (packages/kivotos/src/client.tsx, `usePhoneBack`)
 * closes what dsh shows over the conversation and answers whether it did. A
 * page without one answers false.
 * @param seq - which Back this answers, so a late answer to an earlier one is ignored.
 * @returns script source; the page posts `kivotos.back`.
 */
export function backScript(seq: number): string {
  return answerScript("__kivotosBack", seq);
}

/**
 * Script that closes the layer a page reported open (`kivotos.layers`): the
 * plugin's `window.__kivotosClose` sends dsh one Escape for the topmost one
 * (a menu, the switcher, a dialog, Settings, the drawer) and answers whether
 * it closed; false also for one an Escape cannot close (the preview notice).
 * @param seq - which Back this answers.
 * @returns script source; the page posts `kivotos.back`.
 */
export function closeScript(seq: number): string {
  return answerScript("__kivotosClose", seq);
}

function answerScript(name: string, seq: number): string {
  return `(() => {
  let handled = false;
  try { handled = typeof window.${name} === "function" && window.${name}() === true; } catch (e) {}
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: "kivotos.back", seq: ${seq}, handled }));
})(); true;`;
}

/** What a page reports Back would close (`usePhoneBack`): how many layers are open; null: none. */
export type BackOpen = number | null;

/**
 * What a hardware Back on a page does, from the page's last `kivotos.layers`
 * (undefined: it never reported, an older Kivotos): close the layer, leave
 * the page (its WebView history, then the app), or ask the page with a
 * timeout ({@link backScript}). A page whose last close changed nothing
 * ({@link closeOutcome} `stalled`: it hangs, or keeps reporting a layer it
 * does not close) is left, so it can never keep Back.
 * @param open - the page's last report.
 * @param stalled - the last close sent to this page changed nothing.
 * @returns the action.
 */
export function backAction(
  open: BackOpen | undefined,
  stalled: boolean,
): "close" | "leave" | "ask" {
  if (open === undefined) return "ask";
  return open === null || stalled ? "leave" : "close";
}

/** How long a close waits for the page's new state before it counts as stalled. */
export const CLOSE_ANSWER_MS = 600;

/**
 * What a close comes to once {@link CLOSE_ANSWER_MS} has passed: `done` when
 * the page reported another state; `leave` (this press leaves now) when it
 * neither answered nor reported, a hung page; `stalled` (the next press
 * leaves) when it answered but its state did not change.
 * @param answered - the page answered the close (`kivotos.back`).
 * @param changed - the page reported a state other than the one closed.
 * @returns the outcome.
 */
export function closeOutcome(answered: boolean, changed: boolean): "done" | "leave" | "stalled" {
  if (changed) return "done";
  return answered ? "stalled" : "leave";
}

/** The machine a switcher row names, as the page's computer knows it (`MachineInfo`). */
export interface SwitchTarget {
  /** The computer's mount id; null for "This computer", the page's computer itself. */
  id: string | null;
  name: string;
  /** Kivotos node id, when the computer knows it. */
  node?: string;
  /** Its tailnet listener's `host:port`, when the computer reaches it over Tailscale. */
  address?: string;
}

/** A machine a page's computer lists, as its switcher would name it. */
export interface ListedMachine {
  target: SwitchTarget;
  /** The computer has a route to it now. */
  online: boolean;
  /** The computer's link in use to it (its `MachineInfo.route`); null when none works. */
  route: "tailscale" | "relay" | null;
}

/** The page's Back messages. */
export type BackMessage =
  /** {@link backScript}'s and {@link closeScript}'s answer: whether the page spent the Back itself. */
  | { type: "kivotos.back"; seq: number; handled: boolean }
  /** What Back would close on the page, pushed on every change (`usePhoneBack`). */
  | { type: "kivotos.layers"; open: BackOpen };

/** A message the bridge or the plugin's switcher posts. */
export type BridgeMessage =
  | { type: "session"; sessionId: string; path: string }
  | { type: "ready" }
  /** {@link PEERS_SCRIPT}'s answer; null when the computer did not list its machines. */
  | { type: "kivotos.peers"; machines: ListedMachine[] | null }
  | BackMessage
  | {
      type: "kivotos.switch";
      machine: SwitchTarget;
      /** A Session to open there. */
      sessionId?: string;
      /** The path on this page's origin that opens it through the computer's mount ({@link isFallbackFor}). */
      fallback: string;
    };

const optional = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** The fragment the plugin's namespace script stores as the current Session (packages/kivotos/src/dsh/sessions.ts). */
const SESSION_FRAGMENT = "#kivotos-session=";

/**
 * Whether `fallback` is one of the paths the switcher sends for `id`: "/"
 * for this computer, else the peer's mount path, optionally with the Session
 * fragment for `sessionId`. Only an exact match, built here with the id
 * encoded, so nothing a page sends can name another origin ("//host",
 * "/\\host") or another path.
 */
function isFallbackFor(
  fallback: string,
  id: string | null,
  sessionId: string | undefined,
): boolean {
  const path = id === null ? "/" : `/kivotos/peer/${encodeURIComponent(id)}/`;
  if (fallback === path) return true;
  return (
    id !== null &&
    sessionId !== undefined &&
    fallback === `${path}${SESSION_FRAGMENT}${encodeURIComponent(sessionId)}`
  );
}

function switchOf(message: Record<string, unknown>): BridgeMessage | null {
  const machine = message.machine as Record<string, unknown> | null | undefined;
  const fallback = message.fallback;
  if (typeof fallback !== "string") return null;
  if (typeof machine !== "object" || machine === null) return null;
  if (typeof machine.id !== "string" && machine.id !== null) return null;
  const sessionId = optional(message.sessionId);
  if (!isFallbackFor(fallback, machine.id, sessionId)) return null;
  const target: SwitchTarget = { id: machine.id, name: String(machine.name ?? "") };
  const node = optional(machine.node);
  const address = optional(machine.address);
  if (node !== undefined) target.node = node;
  if (address !== undefined) target.address = address;
  return sessionId === undefined
    ? { type: "kivotos.switch", machine: target, fallback }
    : { type: "kivotos.switch", machine: target, sessionId, fallback };
}

/** A `/kivotos/peers` entry (`MachineInfo`) the way the switcher names it (client.tsx, `navigate`). */
function listedOf(value: unknown): ListedMachine[] {
  if (typeof value !== "object" || value === null) return [];
  const machine = value as Record<string, unknown>;
  const id = optional(machine.id);
  if (id === undefined) return [];
  const target: SwitchTarget = { id, name: String(machine.name ?? "") };
  const node = optional(machine.node);
  const links = Array.isArray(machine.links) ? (machine.links as unknown[]) : [];
  const tailscale = links.find(
    (link): link is Record<string, unknown> =>
      typeof link === "object" && link !== null && Reflect.get(link, "via") === "tailscale",
  );
  const address = optional(tailscale?.address);
  if (node !== undefined) target.node = node;
  if (address !== undefined) target.address = address;
  const route = machine.route === "tailscale" || machine.route === "relay" ? machine.route : null;
  return [{ target, online: typeof machine.route === "string", route }];
}

/** @returns the message, or null for anything else a page posts. */
export function parseBridgeMessage(data: string): BridgeMessage | null {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null) return null;
  if (message.type === "kivotos.switch") return switchOf(message);
  if (message.type === "ready") return { type: "ready" };
  if (message.type === "kivotos.peers")
    return {
      type: "kivotos.peers",
      machines: Array.isArray(message.machines) ? message.machines.flatMap(listedOf) : null,
    };
  if (message.type === "kivotos.back")
    return typeof message.seq === "number"
      ? { type: "kivotos.back", seq: message.seq, handled: message.handled === true }
      : null;
  if (message.type === "kivotos.layers") {
    const open = message.open;
    return open === null || (typeof open === "number" && Number.isSafeInteger(open) && open > 0)
      ? { type: "kivotos.layers", open }
      : null;
  }
  if (message.type !== "session" || typeof message.sessionId !== "string") return null;
  return { type: "session", sessionId: message.sessionId, path: String(message.path ?? "") };
}
