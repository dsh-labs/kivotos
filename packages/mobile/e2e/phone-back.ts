// Phone e2e for hardware Back on a machine's page (#61, #66): `npm run e2e:phone -- --apk <inspection APK>`.
//
// It starts its own lab (scripts/dev.mjs: a relay and two dsh with the mock
// model of mock-llm.mjs, each with its own DSH_HOME under a temp directory),
// installs the APK on an emulator or device, joins the app to the lab's relay
// network by invite, then for each state: sets it up over the DevTools
// protocol, presses the hardware Back with `adb shell input keyevent`, and
// asserts what Back did over the DevTools protocol again (and, for a prompt,
// on the dsh side from the session log). The APK must be an inspection build
// (EXPO_PUBLIC_KIVOTOS_WEBVIEW_DEBUG=1, see CONTRIBUTING.md).
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Page, pageTargets } from "./cdp.ts";
import { attachedSerials, Device, emulatorFor, type Booted } from "./device.ts";
import { Lab, freePort, prepareMock, resolveDsh } from "./lab.ts";
import { formatTable, machineRows, type Result, type UiNode } from "./lib.ts";

const PACKAGE = "com.rinai.kivotos";
const ACTIVITY = `${PACKAGE}/.MainActivity`;

const USAGE = `Usage: npm run e2e:phone -- --apk PATH [options]

Run the hardware Back e2e on an emulator or device against a fresh lab.

  --apk PATH            the inspection APK to install (built with
                        EXPO_PUBLIC_KIVOTOS_WEBVIEW_DEBUG=1)
  --serial SERIAL       the device to use (default: the only one attached)
  --avd NAME            use the running emulator of this AVD, else boot it
  --headless            boot the emulator without a window
  --dsh PATH            the dsh to run, inside an npm install of
                        @deepseek-ai/dsh (default: $DSH_BIN, else
                        @deepseek-ai/dsh@0.2.2-rc.2 installed into
                        ~/.cache/kivotos-e2e)
  --plugin DIR          the built plugin package the lab installs
                        (default: packages/kivotos of this repository)
  --relay-host HOST     the relay's address. 127.0.0.1 (the default) reaches
                        the device through adb reverse; any other address
                        must be one both this host and the device reach
  --only IDS            run only these states (comma-separated ids)
  --timeout-scale N     multiply every wait (default: $E2E_TIMEOUT_SCALE or 1)
  -h, --help            show this help`;

class Usage extends Error {}

interface Options {
  apk: string;
  serial?: string;
  avd?: string;
  headless: boolean;
  dsh?: string;
  plugin?: string;
  relayHost: string;
  only?: string[];
  scale: number;
}

function parseOptions(): Options {
  let values;
  try {
    values = parseArgs({
      options: {
        apk: { type: "string" },
        serial: { type: "string" },
        avd: { type: "string" },
        headless: { type: "boolean", default: false },
        dsh: { type: "string" },
        plugin: { type: "string" },
        "relay-host": { type: "string", default: "127.0.0.1" },
        only: { type: "string" },
        "timeout-scale": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    }).values;
  } catch (error) {
    throw new Usage(error instanceof Error ? error.message : String(error), { cause: error });
  }
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (values.apk === undefined) throw new Usage("--apk is required");
  if (values.serial !== undefined && values.avd !== undefined) {
    throw new Usage("pass --serial or --avd, not both");
  }
  const scale = Number(values["timeout-scale"] ?? process.env.E2E_TIMEOUT_SCALE ?? "1");
  if (!(scale > 0)) throw new Usage("--timeout-scale must be a positive number");
  const only = values.only?.split(",").map((id) => id.trim());
  const unknown = only?.filter((id) => !CASES.some((each) => each.id === id)) ?? [];
  if (unknown.length > 0) throw new Usage(`unknown state ids: ${unknown.join(", ")}`);
  return {
    apk: path.resolve(values.apk),
    serial: values.serial,
    avd: values.avd,
    headless: values.headless,
    dsh: values.dsh ?? process.env.DSH_BIN,
    plugin: values.plugin === undefined ? undefined : path.resolve(values.plugin),
    relayHost: values["relay-host"],
    only,
    scale,
  };
}

/** What the page shows, read over the DevTools protocol. */
interface PageState {
  vis: string;
  /** Whether dsh's shell (its composer) is up. */
  shell: boolean;
  drawerOpen: boolean | null;
  menus: number;
  switcher: boolean;
  modals: string[];
  notice: boolean;
  standIn: boolean;
  /** `/` and `@` suggestion lists in the composer's seat. */
  suggestions: number;
  listboxes: number;
  approval: string[];
  running: boolean;
  stopped: number;
  ticks: number;
  focus: string;
  editorText: string | null;
}

const STATE = `(() => {
  const all = (s) => [...document.querySelectorAll(s)];
  const frame = document.querySelector("div:has(> [data-shell-overlay])");
  const editor = document.querySelector('[data-composer-input][contenteditable="true"]');
  const active = document.activeElement;
  // The open drawer is an aria-modal dialog too; it is reported as drawerOpen instead.
  const modals = all('[role=dialog][aria-modal="true"]').filter((m) => !m.closest('[class*="_sidebarCol"]'));
  const text = document.body?.innerText ?? "";
  const ticks = [...text.matchAll(/tick (\\d+)/g)].map((m) => Number(m[1]));
  let focus = active ? active.tagName.toLowerCase() : "none";
  if (!active || active === document.body) focus = "body";
  else if (editor && active === editor) focus = "composer";
  else if (active.closest("[data-approval-key]")) focus = "approval";
  return {
    vis: document.visibilityState,
    shell: editor !== null,
    drawerOpen: frame ? !frame.hasAttribute("data-sidebar-collapsed") : null,
    menus: all("[role=menu]").length,
    switcher: document.querySelector(".kivotos-machines-list") !== null,
    modals: modals.map((m) => (m.getAttribute("aria-label") || m.textContent || "").trim().slice(0, 30)),
    notice: modals.some((m) => (m.textContent || "").trim().startsWith("Preview Notice")),
    standIn: document.getElementById("kivotos-e2e-stand-in") !== null,
    suggestions: all("[data-composer-seat] [role=listbox]").length,
    listboxes: all("[role=listbox]").length,
    approval: all("[data-approval-key] button").map((b) => (b.textContent || "").trim()).filter(Boolean),
    running: document.querySelector('[aria-label="Stop generating"]') !== null,
    stopped: (text.match(/^Stopped$/gm) ?? []).length,
    ticks: ticks.length > 0 ? Math.max(...ticks) : -1,
    focus,
    editorText: editor ? editor.textContent : null,
  };
})()`;

/** Records what the page posts to the app about Back (`kivotos.layers`, `kivotos.back`). */
const HOOK = `(() => {
  const bridge = window.ReactNativeWebView;
  if (!bridge) throw new Error("the page has no ReactNativeWebView bridge");
  window.__kivotosE2e = [];
  if (!bridge.__kivotosE2e) {
    const post = bridge.postMessage.bind(bridge);
    bridge.postMessage = (data) => {
      try {
        const message = JSON.parse(data);
        if (message.type === "kivotos.layers" || message.type === "kivotos.back") {
          window.__kivotosE2e.push(message);
        }
      } catch {}
      return post(data);
    };
    bridge.__kivotosE2e = true;
  }
  return true;
})()`;

interface Posted {
  type: "kivotos.layers" | "kivotos.back";
  open?: unknown;
  seq?: number;
  handled?: boolean;
}

const ESCAPE = `(() => {
  const target = document.activeElement ?? document.body;
  for (const type of ["keydown", "keyup"]) {
    target.dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true, composed: true }));
  }
  return true;
})()`;

const EDITOR = `document.querySelector('[data-composer-input][contenteditable="true"]')`;

/** A Lexical editor state with one empty paragraph: the composer cleared. */
const EMPTY_EDITOR = JSON.stringify({
  root: {
    children: [
      { children: [], direction: null, format: "", indent: 0, type: "paragraph", version: 1 },
    ],
    direction: null,
    format: "",
    indent: 0,
    type: "root",
    version: 1,
  },
});

/** @returns page code that clicks the element `selector` finds, or throws. */
function clickJs(selector: string, text?: string): string {
  const find =
    text === undefined
      ? `document.querySelector(${JSON.stringify(selector)})`
      : `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => (e.textContent || "").trim() === ${JSON.stringify(text)})`;
  const name = JSON.stringify(text === undefined ? selector : `${selector} "${text}"`);
  return `(() => { const e = ${find}; if (!e) throw new Error("not found: " + ${name}); e.click(); return true; })()`;
}

/** How many layers Back could close are open. */
function layers(state: PageState): number {
  return state.menus + state.listboxes + state.modals.length + (state.switcher ? 1 : 0);
}

function describe(state: PageState): string {
  const parts = [
    state.vis,
    `drawer ${state.drawerOpen === true ? "open" : "closed"}`,
    `menus ${state.menus}`,
  ];
  if (state.switcher) parts.push("switcher");
  if (state.modals.length > 0) parts.push(`modals [${state.modals.join("; ")}]`);
  if (state.listboxes > 0) parts.push(`listboxes ${state.listboxes}`);
  if (state.approval.length > 0) parts.push(`approval [${state.approval.join("/")}]`);
  if (state.running) parts.push(`running (tick ${state.ticks})`);
  parts.push(`focus ${state.focus}`);
  return parts.join(", ");
}

class Run {
  readonly device: Device;
  readonly lab: Lab;
  readonly scale: number;
  private readonly cdpPort: number;
  private page: Page | undefined;
  private row: UiNode | undefined;
  private counter = 0;

  constructor(device: Device, lab: Lab, cdpPort: number, scale: number) {
    this.device = device;
    this.lab = lab;
    this.cdpPort = cdpPort;
    this.scale = scale;
  }

  ms(base: number): number {
    return Math.round(base * this.scale);
  }

  /** A marker for one prompt, to find its turn in the session logs. */
  marker(): string {
    this.counter += 1;
    return `e2e-${process.pid}-${this.counter}`;
  }

  /**
   * Waits until `probe` returns a value other than undefined or false.
   * @throws naming `what` and the last value seen, once `timeoutMs` passed.
   */
  async until<T>(
    what: string,
    probe: () => Promise<T | undefined | false>,
    timeoutMs: number,
  ): Promise<T> {
    const deadline = Date.now() + this.ms(timeoutMs);
    let last: unknown;
    while (true) {
      try {
        const value = await probe();
        if (value !== undefined && value !== false) return value;
      } catch (error) {
        last = error instanceof Error ? error.message : error;
      }
      if (Date.now() >= deadline) break;
      await sleep(150);
    }
    let seen = last;
    if (seen === undefined) {
      try {
        seen = describe(await this.state());
      } catch (error) {
        seen = error instanceof Error ? error.message : error;
      }
    }
    throw new Error(
      `timed out after ${this.ms(timeoutMs)} ms waiting for ${what} (last: ${String(seen)})`,
    );
  }

  /** Waits until the page's state passes `check`. */
  untilState(
    what: string,
    check: (state: PageState) => boolean,
    timeoutMs = 5000,
  ): Promise<PageState> {
    return this.until(
      what,
      async () => {
        const state = await this.state();
        return check(state) ? state : undefined;
      },
      timeoutMs,
    );
  }

  private current(): Page {
    if (this.page === undefined || !this.page.open) throw new Error("no machine page is open");
    return this.page;
  }

  evaluate<T = unknown>(expression: string): Promise<T> {
    return this.current().evaluate<T>(expression);
  }

  state(): Promise<PageState> {
    return this.evaluate<PageState>(STATE);
  }

  click(selector: string, text?: string): Promise<unknown> {
    return this.evaluate(clickJs(selector, text));
  }

  /** Forwards the app's WebView DevTools socket and opens its visible page. */
  private async visiblePage(): Promise<Page | undefined> {
    const pid = (await this.device.shell(`pidof ${PACKAGE}`)).trim();
    if (pid === "") return undefined;
    await this.device.adb([
      "forward",
      `tcp:${this.cdpPort}`,
      `localabstract:webview_devtools_remote_${pid}`,
    ]);
    for (const target of await pageTargets(this.cdpPort)) {
      if (this.page?.id === target.id && this.page.open) {
        if ((await this.page.evaluate("document.visibilityState")) === "visible") return this.page;
        continue;
      }
      const page = await Page.open(target);
      if ((await page.evaluate("document.visibilityState").catch(() => "")) === "visible") {
        this.page?.close();
        return page;
      }
      page.close();
    }
    return undefined;
  }

  /** Puts the machine's page (the first row's) on screen, wherever the app is. */
  async show(): Promise<void> {
    try {
      if (
        this.page?.open === true &&
        (await this.page.evaluate("document.visibilityState")) === "visible"
      )
        return;
    } catch {
      // the page went away; find it again
    }
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (!(await this.device.focusedWindow()).includes(PACKAGE)) {
          await this.device.shell(`am start -W -n ${ACTIVITY}`, this.ms(30_000));
        }
        if (this.row === undefined || attempt > 0) {
          this.row = await this.device.waitForNode(
            "machine row",
            (nodes) => machineRows(nodes, hostname())[0],
            this.ms(30_000),
          );
        }
        await this.device.tapNode(this.row);
        this.page = await this.until(
          "the machine's page on screen",
          () => this.visiblePage(),
          15_000,
        );
        await this.untilState("dsh's shell", (state) => state.shell, 60_000);
        return;
      } catch (error) {
        failure = error;
      }
    }
    throw new Error(`cannot show the machine's page: ${String(failure)}`, { cause: failure });
  }

  /** Starts recording what the page posts about Back. */
  async hook(): Promise<void> {
    await this.evaluate(HOOK);
  }

  posted(): Promise<Posted[]> {
    return this.evaluate<Posted[]>("window.__kivotosE2e ?? []");
  }

  /** What the page's console printed (and threw) so far. */
  consoleLines(): string[] {
    return this.current().console;
  }

  /** Presses the hardware Back once, or twice in one `input keyevent`. */
  async back(times: 1 | 2 = 1): Promise<void> {
    await this.hook();
    await this.device.back(times);
  }

  /**
   * After Back: waits for the page's answers and for `check`, then requires
   * that the page stays on screen.
   * @returns the state and a summary of the answers.
   */
  async stays(what: string, check: (state: PageState) => boolean, presses = 1): Promise<string> {
    const answers = await this.until(
      `${presses} answer(s) to Back`,
      async () => {
        const back = (await this.posted()).filter((m) => m.type === "kivotos.back");
        return back.length >= presses ? back : undefined;
      },
      5000,
    );
    const state = await this.untilState(what, check, 5000);
    if (answers.some((answer) => answer.handled !== true)) {
      throw new Error(`the page did not handle every Back: ${JSON.stringify(answers)}`);
    }
    // The app leaves when an answer says so or none comes in 400 ms; give it more.
    const until = Date.now() + this.ms(1500);
    while (Date.now() < until) {
      const now = await this.state();
      if (now.vis !== "visible") throw new Error(`the app left the page: ${describe(now)}`);
      await sleep(200);
    }
    return `${what}; stayed; back handled ${answers.map((a) => String(a.handled)).join(",")}; ${describe(state)}`;
  }

  /** After Back: requires that the app leaves the page. */
  async leaves(): Promise<string> {
    await this.untilState("the app to leave the page", (state) => state.vis === "hidden", 8000);
    const answers = (await this.posted()).filter((m) => m.type === "kivotos.back");
    return answers.length === 0
      ? "left at once"
      : `left; back handled ${answers.map((a) => String(a.handled)).join(",")}`;
  }

  async openDrawer(open: boolean): Promise<void> {
    const state = await this.state();
    if (state.drawerOpen === open) return;
    // Kivotos' toggle where the plugin adds it; else dsh's own phone layout, whose
    // drawer opens from "Open sidebar" and, as a modal layer, closes on Escape.
    const toggle = open
      ? [".kivotos-drawer-toggle", '[aria-label="Open sidebar"]']
      : [".kivotos-drawer-toggle"];
    const clicked = await this.evaluate<string | null>(`(() => {
      const visible = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
      for (const selector of ${JSON.stringify(toggle)}) {
        const e = [...document.querySelectorAll(selector)].find(visible);
        if (e) { e.click(); return selector; }
      }
      return null;
    })()`);
    if (clicked === null) {
      if (open) throw new Error("no control opens the drawer");
      await this.evaluate(ESCAPE);
    }
    await this.untilState(
      open ? "the drawer open" : "the drawer closed",
      (s) => s.drawerOpen === open,
    );
  }

  async focusComposer(): Promise<void> {
    await this.evaluate(`${EDITOR}.focus(), true`);
    await this.untilState("the composer focused", (s) => s.focus === "composer");
  }

  async blur(): Promise<void> {
    await this.evaluate("document.activeElement?.blur?.(), true");
  }

  /** Starts a new Session, so a prompt's turn is the only one in it. */
  async newSession(): Promise<void> {
    const current = `localStorage.getItem("dsh.sessions.current")`;
    const before = await this.evaluate<string | null>(current);
    await this.evaluate(
      `(() => { const e = [...document.querySelectorAll('[aria-label="New session"]')].find((each) => each.offsetParent !== null); if (!e) throw new Error("no visible New session"); e.click(); return true; })()`,
    );
    await this.until(
      "dsh to switch to a new Session",
      async () => (await this.evaluate<string | null>(current)) !== before,
      10_000,
    );
    await this.untilState(
      "an empty Session",
      (s) => s.shell && !s.running && s.approval.length === 0 && s.ticks === -1,
      10_000,
    );
  }

  /** Empties the composer. execCommand("delete") misses Lexical's own selection, so set its state. */
  async clearComposer(): Promise<PageState> {
    await this.evaluate(`(() => {
      const editor = ${EDITOR}.__lexicalEditor;
      if (!editor) throw new Error("the composer has no Lexical editor");
      editor.setEditorState(editor.parseEditorState(${JSON.stringify(EMPTY_EDITOR)}));
      return true;
    })()`);
    return this.untilState("the composer empty", (s) => s.editorText === "");
  }

  /** Sends a prompt from the composer, then takes the focus out of it. */
  async send(prompt: string): Promise<void> {
    // The composer can be replaced just after a Session switch: type again until it holds the prompt.
    let typed = false;
    for (let attempt = 0; attempt < 3 && !typed; attempt++) {
      if (attempt > 0) await this.clearComposer();
      await this.focusComposer();
      await this.evaluate(`document.execCommand("insertText", false, ${JSON.stringify(prompt)})`);
      typed = await this.untilState("the prompt in the composer", (s) => s.editorText === prompt)
        .then(() => true)
        .catch(() => false);
    }
    if (!typed) throw new Error("the composer did not take the prompt");
    await this.click('[aria-label="Send message"]');
    await this.untilState("the composer emptied", (s) => s.editorText === "", 10_000);
    await this.blur();
  }

  /** Brings the page back to nothing open: no layer, drawer closed, no turn running. */
  async baseline(): Promise<void> {
    await this.show();
    await this.evaluate(`document.getElementById("kivotos-e2e-stand-in")?.remove(), true`);
    let state = await this.state();
    if (state.notice) {
      await this.click('[role=dialog][aria-modal="true"] button', "Continue");
      state = await this.untilState("the Preview Notice gone", (s) => !s.notice);
    }
    if (state.approval.includes("Reject")) {
      await this.click("[data-approval-key] button", "Reject");
      await this.untilState("the approval answered", (s) => s.approval.length === 0, 10_000);
      // The turn goes on with the answer (the mock replies at once): let it end.
      state = await this.untilState("the turn over", (s) => !s.running, 10_000);
    }
    if (state.running) {
      // The reply may end between the read and the click; Stop is pressed only if still there.
      await this.evaluate(
        `document.querySelector('[aria-label="Stop generating"]')?.click(), true`,
      );
      state = await this.untilState("the reply stopped", (s) => !s.running, 10_000);
    }
    if ((state.editorText ?? "") !== "") state = await this.clearComposer();
    for (let i = 0; i < 4 && layers(state) > 0; i++) {
      const before = layers(state);
      await this.evaluate(ESCAPE);
      state = await this.untilState("a layer closed by Escape", (s) => layers(s) < before).catch(
        () => state,
      );
    }
    await this.openDrawer(false);
    await this.blur();
    await this.untilState(
      "nothing open",
      (s) =>
        s.vis === "visible" &&
        layers(s) === 0 &&
        s.drawerOpen === false &&
        !s.running &&
        s.focus === "body",
    );
  }
}

interface Case {
  id: string;
  state: string;
  run(run: Run): Promise<string>;
}

/** Opens a menu by clicking `selector` and waits until it is open. */
async function openMenu(run: Run, selector: string): Promise<void> {
  await run.click(selector);
  await run.untilState(`a menu from ${selector}`, (s) => s.menus > 0);
}

/** A menu over the drawer: Back closes the menu only. */
async function menuInDrawer(run: Run, selector: string): Promise<string> {
  await run.openDrawer(true);
  await openMenu(run, selector);
  await run.back();
  return run.stays("menu closed, drawer open", (s) => s.menus === 0 && s.drawerOpen === true);
}

/** Two Backs while a reply runs, with `setup` run once the reply is running. */
async function runningReply(
  run: Run,
  setup: (run: Run) => Promise<void>,
  press: (run: Run) => Promise<string>,
): Promise<string> {
  await run.newSession();
  const marker = run.marker();
  await run.send(`slow ${marker}`);
  const running = await run
    .untilState("the reply running", (s) => s.running && s.ticks >= 1, 30_000)
    .catch((error: unknown) => {
      throw new Error(`${String(error)}; dsh: ${JSON.stringify(run.lab.turn(marker))}`, {
        cause: error,
      });
    });
  await setup(run);
  const left = await press(run);
  const afterLeave = run.lab.turn(marker);
  if (!afterLeave.started || afterLeave.ended !== undefined) {
    throw new Error(`dsh: the turn is not running after the leave: ${JSON.stringify(afterLeave)}`);
  }
  await run.show();
  const shown = await run.untilState(
    "the reply still running, further on",
    (s) => s.running && s.ticks > running.ticks,
    10_000,
  );
  if (shown.stopped !== running.stopped) {
    throw new Error(`the page shows "Stopped" ${shown.stopped - running.stopped} more time(s)`);
  }
  const facts = run.lab.turn(marker);
  if (facts.ended !== undefined) throw new Error(`dsh: the turn ended (${facts.ended})`);
  return `${left}; reply running at tick ${running.ticks} -> ${shown.ticks}, no "Stopped"; dsh: turn started, not ended`;
}

/** The open Settings dialog (dsh's, not the drawer's). */
const SETTINGS = `[...document.querySelectorAll('[role=dialog][aria-modal="true"]')].filter((m) => !m.closest('[class*="_sidebarCol"]')).find((m) => m.querySelector('[class*="_navCell"]'))`;

/** Records every Kivotos compat notice or "slot entry crashed" text added to the page from now on. */
const WATCH = `(() => {
  if (window.__kivotosE2eWatch) return true;
  const hits = (window.__kivotosE2eWatch = []);
  const check = (node) => {
    if (!(node instanceof Element)) return;
    if (node.matches(".kivotos-compat") || node.querySelector(".kivotos-compat")) hits.push("compat notice: " + (node.textContent || "").slice(0, 120));
    const text = node.textContent || "";
    if (text.includes("Part of dsh changed")) hits.push("compat text: " + text.slice(0, 120));
    if (text.includes("slot entry crashed")) hits.push("slot entry crashed: " + text.slice(0, 120));
  };
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) check(node);
  }).observe(document.body, { childList: true, subtree: true });
  return true;
})()`;

const CASES: Case[] = [
  {
    id: "preview-notice",
    state: "Preview Notice (fresh machine)",
    async run(run) {
      await run.show();
      await run.untilState("the Preview Notice", (s) => s.notice, 30_000);
      await run.back();
      const left = await run.leaves();
      await run.show();
      const state = await run.untilState("the Preview Notice again", (s) => s.notice);
      return `${left}; shown again: notice still there (${state.modals.join("; ")})`;
    },
  },
  {
    id: "approval",
    state: "pending approval, focus in the card",
    async run(run) {
      const marker = run.marker();
      await run.send(`approve ${marker}`);
      await run.untilState("the approval card", (s) => s.approval.includes("Reject"), 30_000);
      await run.evaluate(
        `[...document.querySelectorAll("[data-approval-key] button")].find((b) => b.textContent.trim() === "Reject").focus(), true`,
      );
      await run.untilState("the focus in the card", (s) => s.focus === "approval");
      await run.back();
      const left = await run.leaves();
      const facts = run.lab.turn(marker);
      if (facts.asked === 0 || facts.decided.length > 0 || facts.ended !== undefined) {
        throw new Error(`dsh: the approval is not pending: ${JSON.stringify(facts)}`);
      }
      await run.show();
      const state = await run.untilState("the approval card again", (s) =>
        s.approval.includes("Reject"),
      );
      return `${left}; dsh: asked ${facts.asked}, no approval/decided; shown again: [${state.approval.join("/")}]`;
    },
  },
  {
    id: "header-menu",
    state: "header menu",
    async run(run) {
      await openMenu(run, '[aria-label="More actions"]');
      await run.back();
      return run.stays("menu closed", (s) => s.menus === 0);
    },
  },
  {
    id: "account-menu",
    state: "account menu over the drawer",
    run: (run) => menuInDrawer(run, '[aria-label="Account menu"]'),
  },
  {
    id: "row-menu",
    state: "row menu (Session actions)",
    run: (run) => menuInDrawer(run, '[aria-label^="Session actions for"]'),
  },
  {
    id: "drawer",
    state: "drawer",
    async run(run) {
      await run.openDrawer(true);
      await run.back();
      return run.stays("drawer closed", (s) => s.drawerOpen === false);
    },
  },
  {
    id: "settings",
    state: "Settings",
    async run(run) {
      await run.openDrawer(true);
      await openMenu(run, '[aria-label="Account menu"]');
      await run.click("[role=menuitem]", "Settings");
      await run.untilState("Settings open", (s) => s.modals.length > 0 && s.menus === 0);
      await run.back();
      return run.stays(
        "Settings closed, drawer open",
        (s) => s.modals.length === 0 && s.drawerOpen === true,
      );
    },
  },
  {
    id: "modal",
    state: "modal (Delete workspace)",
    async run(run) {
      await run.openDrawer(true);
      await openMenu(run, '[aria-label^="Workspace actions for"]');
      await run.click("[role=menuitem]", "Delete workspace");
      await run.untilState(
        "the Delete workspace dialog",
        (s) => s.modals.length > 0 && s.menus === 0,
      );
      await run.back();
      return run.stays("dialog closed", (s) => s.modals.length === 0 && s.menus === 0);
    },
  },
  {
    id: "switcher",
    state: "machine switcher",
    async run(run) {
      await run.openDrawer(true);
      await run.click(".kivotos-machines-trigger");
      await run.untilState("the switcher open", (s) => s.switcher);
      await run.back();
      return run.stays("switcher closed, drawer open", (s) => !s.switcher && s.drawerOpen === true);
    },
  },
  {
    id: "model-select",
    state: "model select",
    async run(run) {
      await run.click('[aria-label^="Select model"]');
      await run.untilState("the model select open", (s) => layers(s) > 0);
      await run.back();
      return run.stays("model select closed", (s) => layers(s) === 0);
    },
  },
  {
    id: "slash-popup",
    state: "/ popup, editor focused",
    async run(run) {
      await run.focusComposer();
      await run.evaluate(`document.execCommand("insertText", false, "/")`);
      await run.untilState("the / suggestions", (s) => s.suggestions > 0);
      await run.back();
      return run.stays("suggestions closed", (s) => s.suggestions === 0);
    },
  },
  {
    id: "nothing-body",
    state: "nothing open, focus on body",
    async run(run) {
      const state = await run.state();
      if (state.focus !== "body") throw new Error(`the focus is on ${state.focus}`);
      await run.back();
      return run.leaves();
    },
  },
  {
    id: "nothing-composer",
    state: "nothing open, focus in the composer",
    async run(run) {
      await run.focusComposer();
      await run.back();
      return run.leaves();
    },
  },
  {
    id: "double",
    state: "double press, menu over the drawer",
    async run(run) {
      await run.openDrawer(true);
      await openMenu(run, '[aria-label="Account menu"]');
      await run.back(2);
      return run.stays("menu and drawer closed", (s) => s.menus === 0 && s.drawerOpen === false, 2);
    },
  },
  {
    id: "running",
    state: "two Backs while a reply runs",
    run: (run) =>
      runningReply(
        run,
        async () => {},
        async (r) => {
          await r.back(2);
          return r.leaves();
        },
      ),
  },
  {
    id: "unconsumed-escape",
    state: "unconsumed Escape (stand-in aria-modal), reply running",
    run: (run) =>
      runningReply(
        run,
        async (r) => {
          await r.hook();
          await r.evaluate(`(() => {
            const d = document.createElement("div");
            d.id = "kivotos-e2e-stand-in";
            d.setAttribute("role", "dialog");
            d.setAttribute("aria-modal", "true");
            d.textContent = "e2e stand-in";
            document.body.append(d);
            return true;
          })()`);
          await r.until(
            "the page to report the stand-in",
            async () =>
              (await r.posted()).some((m) => m.type === "kivotos.layers" && m.open !== null),
            5000,
          );
        },
        async (r) => {
          await r.back();
          const first = await r.leaves();
          // Shown again, the kept stand-in counts as nothing open: Back leaves at once.
          await r.show();
          await r.untilState("the stand-in still there", (s) => s.standIn);
          await r.back();
          const second = await r.leaves();
          return `1st Back ${first}; 2nd Back ${second}`;
        },
      ),
  },
  {
    id: "settings-sections",
    state: "Settings 5 times across its sections: no compat notice, no slot crash",
    async run(run) {
      await run.evaluate(WATCH);
      const opened: string[] = [];
      for (let i = 0; i < 5; i++) {
        await run.openDrawer(true);
        await openMenu(run, '[aria-label="Account menu"]');
        await run.evaluate(
          `(() => { const e = [...document.querySelectorAll("[role=menuitem]")].find((each) => (each.textContent || "").trim().startsWith("Settings")); if (!e) throw new Error("no Settings item"); e.click(); return true; })()`,
        );
        await run.untilState("Settings open", (s) => s.modals.length > 0 && s.menus === 0);
        const sections = await run.until(
          "Settings' sections",
          async () => {
            const names = await run.evaluate<string[]>(
              `[...(${SETTINGS}?.querySelectorAll('[class*="_navCell"]') ?? [])].map((e) => (e.textContent || "").trim())`,
            );
            return names.length > 0 ? names : undefined;
          },
          5000,
        );
        // The default section first opens on its own; each round opens another one.
        const name = sections[(i + 1) % sections.length];
        await run.evaluate(
          `[...${SETTINGS}.querySelectorAll('[class*="_navCell"]')].find((e) => (e.textContent || "").trim() === ${JSON.stringify(name)}).click(), true`,
        );
        await run.until(
          `the ${name} section`,
          () =>
            run.evaluate<boolean>(
              `[...${SETTINGS}.querySelectorAll('[class*="_navCell"]')].some((e) => (e.textContent || "").trim() === ${JSON.stringify(name)} && e.getAttribute("aria-current") === "true")`,
            ),
          5000,
        );
        opened.push(name);
        await run.evaluate(
          `(() => { const close = [...${SETTINGS}.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Close" || (b.textContent || "").trim() === "Close"); if (!close) throw new Error("Settings has no Close"); close.click(); return true; })()`,
        );
        await run.untilState("Settings closed", (s) => s.modals.length === 0);
      }
      const page = await run.evaluate<{ notice: number; text: string[]; watched: string[] }>(
        `({
          notice: document.querySelectorAll(".kivotos-compat").length,
          text: ["Part of dsh changed", "slot entry crashed"].filter((t) => (document.body.innerText || "").includes(t) || (document.body.textContent || "").includes(t)),
          watched: window.__kivotosE2eWatch ?? [],
        })`,
      );
      const crashes = run.consoleLines().filter((line) => line.includes("slot entry crashed"));
      const problems = [
        page.notice > 0 ? `${page.notice} .kivotos-compat element(s)` : "",
        page.text.length > 0 ? `page text has ${page.text.join(", ")}` : "",
        page.watched.length > 0 ? `seen during the run: ${page.watched.join(" / ")}` : "",
        crashes.length > 0 ? `console: ${crashes.slice(0, 3).join(" / ")}` : "",
      ].filter((problem) => problem !== "");
      if (problems.length > 0) throw new Error(problems.join("; "));
      return `opened ${opened.join(", ")}; no compat notice (DOM, text, observer); no "slot entry crashed" (page text, ${run.consoleLines().length} console lines)`;
    },
  },
];

async function joinNetwork(device: Device, invite: string, scale: number): Promise<void> {
  await device.shell(`pm clear ${PACKAGE}`);
  await device.shell(`pm grant ${PACKAGE} android.permission.POST_NOTIFICATIONS`).catch(() => "");
  await device.shell(`am start -W -n ${ACTIVITY}`, 60_000);
  const timeout = 30_000 * scale;
  const field = (nodes: UiNode[]) => nodes.find((n) => n.className === "android.widget.EditText");
  // A tap right after the app starts can be lost: tap Connections until its screen is up.
  let connections = false;
  for (let attempt = 0; attempt < 3 && !connections; attempt++) {
    await device.tapNode(
      await device.waitForNode(
        "Connections",
        (nodes) => nodes.find((n) => n.text === "Connections"),
        timeout,
      ),
    );
    connections = await device
      .waitForNode("invite field", field, 15_000 * scale)
      .then(() => true)
      .catch(() => false);
  }
  if (!connections) throw new Error("the Connections screen did not open");
  // A loaded device drops keys of a long `input text` into React Native's
  // controlled field: type in pieces, check each, and start over on a loss.
  let typed = false;
  for (let attempt = 0; attempt < 3 && !typed; attempt++) {
    // Focus is lost after a failed Join: tap the field and wait for it first.
    await device.tapNode(await device.waitForNode("invite field", field, timeout));
    const focused = await device.waitForNode(
      "focused invite field",
      (nodes) => (field(nodes)?.focused === true ? field(nodes) : undefined),
      timeout,
    );
    const now = focused.text;
    if (now !== "" && !now.endsWith("…")) {
      const deletes = Array.from({ length: now.length + 8 }, () => "67").join(" ");
      await device.shell(`input keyevent KEYCODE_MOVE_END ${deletes}`);
    }
    try {
      for (let end = 30; end < invite.length + 30; end += 30) {
        const sofar = invite.slice(0, end);
        await device.type(invite.slice(end - 30, end));
        await device.waitForNode(
          "typed invite",
          (nodes) => (field(nodes)?.text === sofar ? field(nodes) : undefined),
          10_000 * scale,
        );
      }
      typed = true;
    } catch (error) {
      console.log(`e2e: typing the invite again (${String(error).slice(0, 120)})`);
    }
  }
  if (!typed) throw new Error("could not type the invite into the app");
  await device.tapNode(
    await device.waitForNode("Join", (nodes) => nodes.find((n) => n.text === "Join"), timeout),
  );
  await device.waitForNode(
    "Leave network",
    (nodes) => nodes.find((n) => n.text === "Leave network"),
    60_000 * scale,
  );
  await device.back();
  await device.waitForNode("machine row", (nodes) => machineRows(nodes, hostname())[0], timeout);
}

async function pickDevice(options: Options): Promise<{ device: Device; booted?: Booted }> {
  if (options.avd !== undefined)
    return emulatorFor(options.avd, options.headless, 600_000 * options.scale);
  if (options.serial !== undefined) return { device: new Device(options.serial) };
  const serials = await attachedSerials();
  if (serials.length !== 1) {
    throw new Usage(`${serials.length} devices attached; pass --serial or --avd`);
  }
  return { device: new Device(serials[0]) };
}

async function main(): Promise<number> {
  const options = parseOptions();
  const started = Date.now();
  const temp = mkdtempSync(path.join(tmpdir(), "kivotos-e2e-"));
  const cleanups: [string, () => Promise<unknown>][] = [
    ["temp directory", async () => rmSync(temp, { recursive: true, force: true })],
  ];
  const cleanup = async () => {
    for (const [what, step] of cleanups.toReversed()) {
      try {
        await step();
      } catch (error) {
        console.error(
          `e2e: cleanup: ${what}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    cleanups.length = 0;
  };
  const interrupted = () => {
    console.error("e2e: interrupted; cleaning up");
    void cleanup().then(() => process.exit(130));
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    const { device, booted } = await pickDevice(options);
    if (booted !== undefined) {
      cleanups.push([
        "emulator",
        async () => {
          await device.adb(["emu", "kill"]).catch(() => booted.process.kill());
        },
      ]);
    }
    console.log(`e2e: device ${device.serial}`);
    const bootDeadline = Date.now() + 300_000 * options.scale;
    while (!(await device.bootCompleted())) {
      if (Date.now() > bootDeadline) throw new Error(`${device.serial} has not finished booting`);
      await sleep(2000);
    }
    await device.shell("settings put global hide_error_dialogs 1");

    const dsh = await resolveDsh(options.dsh);
    const patch = prepareMock(path.join(temp, "mock"), dsh);
    console.log("e2e: starting the lab");
    const lab = await Lab.start({
      dir: temp,
      dsh,
      patch,
      relayHost: options.relayHost,
      plugin: options.plugin,
      timeoutMs: 600_000 * options.scale,
    });
    cleanups.push(["lab", () => lab.stop()]);
    const relayPort = lab.banner.relay.split(":").at(-1) ?? "";
    if (options.relayHost === "127.0.0.1") {
      await device.adb(["reverse", `tcp:${relayPort}`, `tcp:${relayPort}`]);
      cleanups.push(["adb reverse", () => device.adb(["reverse", "--remove", `tcp:${relayPort}`])]);
    }

    console.log(`e2e: installing ${options.apk}`);
    await device.adb(["install", "-r", options.apk], 300_000);
    cleanups.push(["app data", () => device.shell(`pm clear ${PACKAGE}`)]);
    console.log("e2e: joining the app to the lab's network");
    await joinNetwork(device, lab.banner.invite, options.scale);

    const cdpPort = await freePort();
    cleanups.push(["adb forward", () => device.adb(["forward", "--remove", `tcp:${cdpPort}`])]);
    const run = new Run(device, lab, cdpPort, options.scale);

    const results: Result[] = [];
    const chosen = CASES.filter((each) => options.only?.includes(each.id) ?? true);
    const limit = run.ms(180_000);
    for (const [index, each] of chosen.entries()) {
      const at = Date.now();
      const state = `${each.id}: ${each.state}`;
      const timer = new AbortController();
      try {
        // The Preview Notice shows only on a machine's first load: nothing may dismiss it before.
        if (each.id !== "preview-notice") await run.baseline();
        const timeout = sleep(limit, undefined, { signal: timer.signal }).then(() => {
          throw new Error(`no result in ${limit / 1000} s`);
        });
        // Aborted once the state is done: that rejection is expected, not unhandled.
        timeout.catch(() => {});
        const detail = await Promise.race([each.run(run), timeout]);
        results.push({ state, pass: true, detail, ms: Date.now() - at });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        results.push({ state, pass: false, detail, ms: Date.now() - at });
      } finally {
        timer.abort();
      }
      console.log(`e2e: ${results.at(-1)?.pass === true ? "pass" : "FAIL"} ${each.id}`);
      if (results.at(-1)?.pass !== true && !(await attachedSerials()).includes(device.serial)) {
        for (const rest of chosen.slice(index + 1)) {
          results.push({
            state: `${rest.id}: ${rest.state}`,
            pass: false,
            detail: `not run: ${device.serial} is gone`,
            ms: 0,
          });
        }
        break;
      }
    }
    console.log(`\n${formatTable(results)}\n`);
    const failed = results.filter((result) => !result.pass).length;
    console.log(
      `e2e: ${results.length - failed} passed, ${failed} failed in ${((Date.now() - started) / 1000).toFixed(0)} s`,
    );
    return failed === 0 ? 0 : 1;
  } finally {
    await cleanup();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`e2e: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Usage) console.error(`\n${USAGE}`);
    process.exit(2);
  },
);
