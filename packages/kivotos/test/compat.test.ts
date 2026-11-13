import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { bootResources } from "../src/cache.ts";
import {
  COMPAT_GLOBAL,
  compatReportOf,
  failedPoints,
  injectCompatReport,
  mergeCompat,
  PAGE_SETTLE_MS,
  PageVerdicts,
  type CompatReport,
} from "../src/dsh/compat.ts";
import { guardDesktopBoot } from "../src/dsh/desktop.ts";
import {
  PARTS,
  phoneStylesheet,
  probePhoneConversation,
  type FrameNode,
} from "../src/dsh/frame.ts";
import { bootGraphOf, keyboardViewport, credentialedManifest } from "../src/dsh/index-html.ts";
import {
  currentSession,
  injectStorageNamespace,
  probeSessionStore,
  selectSession,
} from "../src/dsh/sessions.ts";

/** An index a dsh release serves, byte for byte (`dsh --profile web`, fetched signed in). */
interface PinnedIndex {
  readonly version: string;
  readonly index: string;
  /** Rows of each boot batch, in boot order. */
  readonly rows: readonly number[];
}

/**
 * Every index the probes are kept working on: the release Kivotos is pinned
 * to, and the one before it, since both are still served by released dsh.
 */
const FIXTURES: readonly PinnedIndex[] = [
  {
    version: "0.2.2-rc.1",
    index: readFileSync(new URL("fixtures/dsh-0.2.2-rc.1.index.html", import.meta.url), "utf8"),
    rows: [1, 57, 15],
  },
  {
    version: "0.2.2-rc.2",
    index: readFileSync(new URL("fixtures/dsh-0.2.2-rc.2.index.html", import.meta.url), "utf8"),
    rows: [1, 57, 17],
  },
];

/** The index dsh 0.2.2-rc.2 serves: what the altered-index tests start from. */
const PINNED = FIXTURES[1].index;

/** The pinned index with one string replaced, the way an upstream change would. */
function altered(from: string, to: string): string {
  assert.ok(PINNED.includes(from), `the fixture has no ${from}`);
  return PINNED.replace(from, to);
}

const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1" />';
const MANIFEST = '<link rel="manifest" href="./manifest.webmanifest" />';
const GATE = "(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()";

test("every index rewrite applies to each pinned index", () => {
  for (const fixture of FIXTURES) {
    const release = `dsh ${fixture.version}`;
    const viewport = keyboardViewport(fixture.index);
    assert.equal(viewport.probe.state, "ok", release);
    assert.match(viewport.html, /interactive-widget=resizes-content/);
    assert.doesNotMatch(viewport.html, /viewport-fit/);
    const manifest = credentialedManifest(fixture.index);
    assert.equal(manifest.probe.state, "ok", release);
    assert.match(manifest.html, /crossorigin="use-credentials"/);
    assert.equal(bootGraphOf(fixture.index).probe.state, "ok", release);
    assert.equal(guardDesktopBoot(fixture.index, "/kivotos/peer/b").probe.state, "ok", release);
    // The warm-up reads its targets from the same graph the probe accepted.
    assert.ok((bootResources(fixture.index)?.targets.length ?? 0) > 0, release);
    // The piece manifests read every batch's rows, each served on its own URL.
    const graph = bootGraphOf(fixture.index).graph;
    assert.deepEqual(
      graph?.urls.map((url) => graph.rows.get(url)?.length),
      fixture.rows,
      release,
    );
    assert.ok(
      [...(graph?.rows.values() ?? [])]
        .flat()
        .every((row) => /^plugins\/\?\?[^,]+&rev=\w+$/.test(row)),
      release,
    );
  }
});

test("a changed index is served as dsh sent it, and says which markup moved", () => {
  for (const [rewrite, from, to, state] of [
    [
      keyboardViewport,
      VIEWPORT,
      '<meta name="viewport" content="width=device-width" />',
      "changed",
    ],
    [keyboardViewport, VIEWPORT, "", "missing"],
    [credentialedManifest, MANIFEST, '<link rel="manifest" href="/app.webmanifest" />', "changed"],
    [credentialedManifest, MANIFEST, "", "missing"],
  ] as const) {
    const html = altered(from, to);
    const out = rewrite(html);
    assert.equal(out.probe.state, state, `${from} -> ${to}`);
    assert.equal(out.html, html, "a failed probe still rewrote the page");
  }
});

test("the desktop guard is installed whatever the gate, and reports a moved gate", () => {
  const moved = guardDesktopBoot(altered(GATE, "globalThis.__DSH_BOOT_READY__?.resolve()"), "/p");
  assert.equal(moved.probe.state, "changed");
  assert.ok(moved.html.includes("dshDesktopBoot"));
  const gone = guardDesktopBoot(PINNED.replaceAll("__DSH_BOOT_READY__", "__DSH_READY__"), "/p");
  assert.equal(gone.probe.state, "missing");
});

test("a boot graph of another shape turns the warm-up off instead of feeding it", () => {
  const graph = altered('"batches":', '"chunks":');
  assert.equal(bootGraphOf(graph).probe.state, "changed");
  assert.equal(bootResources(graph), undefined);
  const gone = PINNED.replace(/<script>globalThis\["__DSH_BOOT__"\] = .*?<\/script>/s, "");
  assert.equal(bootGraphOf(gone).probe.state, "missing");
});

test("only the failures travel to the page, and the page reads them back", () => {
  assert.equal(injectCompatReport(PINNED, { viewport: keyboardViewport(PINNED).probe }), PINNED);
  const broken = altered(MANIFEST, "");
  const report: CompatReport = {
    manifest: credentialedManifest(broken).probe,
    viewport: keyboardViewport(broken).probe,
  };
  const page = injectCompatReport(broken, report);
  const script = /<script>(Object\.assign\(globalThis\.__KIVOTOS_COMPAT__[^<]*)<\/script>/.exec(
    page,
  );
  assert.ok(script, "the report is not in the page");
  const realm: Record<string, unknown> = {};
  new Function("globalThis", script[1])(realm);
  assert.deepEqual(compatReportOf(realm[COMPAT_GLOBAL]), { manifest: report.manifest });
  // A reason cannot close the script that carries it.
  const hostile = injectCompatReport("<head></head>", {
    manifest: { state: "changed", reason: "</script><script>alert(1)</script>" },
  });
  assert.equal(hostile.split("</script>").length, 2);
});

test("anything in the page global that is not a probe is ignored", () => {
  assert.deepEqual(compatReportOf(undefined), {});
  assert.deepEqual(
    compatReportOf({
      viewport: { state: "broken", reason: "x" },
      manifest: { state: "missing" },
      unknown: { state: "missing", reason: "x" },
      "boot-graph": { state: "changed", reason: "moved" },
    }),
    { "boot-graph": { state: "changed", reason: "moved" } },
  );
});

test("two reports of one point keep the worse answer", () => {
  const ok = { state: "ok", reason: "" } as const;
  const changed = { state: "changed", reason: "" } as const;
  const missing = { state: "missing", reason: "" } as const;
  assert.deepEqual(mergeCompat({ viewport: ok }, { viewport: changed }), { viewport: changed });
  assert.deepEqual(mergeCompat({ viewport: missing }, { viewport: changed }), {
    viewport: missing,
  });
  assert.deepEqual(
    failedPoints(mergeCompat({ viewport: ok }, { manifest: missing })).map(({ point }) => point),
    ["manifest"],
  );
});

test("a page verdict settles on ok at once, and on a failure only once it has lasted", () => {
  const ok = { state: "ok", reason: "" } as const;
  const changed = { state: "changed", reason: "mid-render" } as const;
  const verdicts = new PageVerdicts();
  // Nothing to judge yet, then failures within the settle time: nothing settles.
  assert.equal(verdicts.read({}, 0), false);
  assert.equal(verdicts.read({ "phone-conversation": changed, "session-store": ok }, 0), true);
  assert.deepEqual(verdicts.report(), { "session-store": ok });
  assert.equal(verdicts.read({ "phone-conversation": changed }, PAGE_SETTLE_MS - 1), false);
  assert.ok(verdicts.isFailing());
  // A failure that clears before then is forgotten.
  verdicts.read({ "phone-conversation": ok }, PAGE_SETTLE_MS);
  assert.deepEqual(verdicts.report(), { "session-store": ok, "phone-conversation": ok });
  assert.ok(!verdicts.isFailing());

  const failing = new PageVerdicts();
  failing.read({ "phone-conversation": changed }, 0);
  failing.read({ "phone-conversation": changed }, PAGE_SETTLE_MS);
  assert.deepEqual(failing.report(), { "phone-conversation": changed });
  assert.ok(!failing.isFailing());
  // Settled is final: a later reading changes nothing.
  failing.read({ "phone-conversation": ok }, 2 * PAGE_SETTLE_MS);
  assert.deepEqual(failing.report(), { "phone-conversation": changed });
});

test("a page failure starts over when its subject leaves the page", () => {
  const changed = { state: "changed", reason: "unmounting" } as const;
  const verdicts = new PageVerdicts();
  verdicts.read({ "phone-conversation": changed }, 0);
  // The subject left (the probe answered undefined), then came back failing.
  verdicts.read({}, 500);
  assert.ok(!verdicts.isFailing());
  verdicts.read({ "phone-conversation": changed }, 900);
  assert.equal(verdicts.read({ "phone-conversation": changed }, PAGE_SETTLE_MS + 100), false);
  assert.equal(verdicts.read({ "phone-conversation": changed }, 900 + PAGE_SETTLE_MS), true);
});

/** A rendered element as the probes see it: tag, class, data attributes. */
interface Node {
  tag?: string;
  attrs?: Record<string, string>;
  children?: Node[];
}

/** The selector shapes the probes use: a tag, `[attr]`, `[attr="v"]`, `[class*="part"]`. */
function matches(node: Node, selector: string): boolean {
  const attrs = node.attrs ?? {};
  const contains = /^\[class\*="(.+)"\]$/.exec(selector);
  if (contains !== null) return (attrs.class ?? "").includes(contains[1]);
  const attr = /^\[([\w-]+)(?:="(.*)")?\]$/.exec(selector);
  if (attr !== null)
    return attr[1] in attrs && (attr[2] === undefined || attrs[attr[1]] === attr[2]);
  return (node.tag ?? "div") === selector;
}

/** An element both the conversation and the Session probes can read. */
interface TestNode extends FrameNode {
  querySelector(selectors: string): TestNode | null;
  getAttribute(name: string): string | null;
}

function element(node: Node): TestNode {
  return {
    querySelector: (selector) => find(node.children ?? [], selector),
    getAttribute: (name) => node.attrs?.[name] ?? null,
  };
}

function find(nodes: Node[], selector: string): TestNode | null {
  for (const node of nodes) {
    if (matches(node, selector)) return element(node);
    const deeper = find(node.children ?? [], selector);
    if (deeper !== null) return deeper;
  }
  return null;
}

function pageOf(...roots: Node[]): { querySelector(selectors: string): TestNode | null } {
  const top = element({ children: roots });
  return { querySelector: (selector) => top.querySelector(selector) };
}

const cls = (value: string): Record<string, string> => ({ class: value });

/**
 * dsh 0.2.2-rc.2's AppFrame at phone width with a Session open, as rendered
 * (ui-layout AppFrame.module.css `pI_x6G_`, ui-conversation `wSkVaW_`).
 */
function frame(overrides: { scroll?: Record<string, string> } = {}): Node {
  const conversation: Node = {
    attrs: {
      ...cls("wSkVaW_body"),
      "data-conversation-content": "",
      "data-conversation-session": "s1",
      "data-conversation-region": "chat",
      "data-content-phase": "active",
    },
    children: [
      {
        attrs: { "data-slot": "conversation" },
        children: [
          {
            attrs: cls("q08b7a_layer"),
            children: [
              {
                attrs: overrides.scroll ?? {
                  ...cls("wSkVaW_scrollBody"),
                  "data-conversation-scroll": "",
                },
                children: [{ attrs: cls("wSkVaW_viewArea") }],
              },
            ],
          },
        ],
      },
    ],
  };
  return {
    attrs: {
      ...cls("pI_x6G_frame"),
      "data-sidebar-drawer": "true",
      "data-sidebar-collapsed": "true",
    },
    children: [
      { attrs: { ...cls("pI_x6G_drawerMask"), "data-sidebar-mask": "true" } },
      { attrs: cls("pI_x6G_sidebarCol") },
      {
        attrs: cls("pI_x6G_centerCol"),
        children: [
          {
            attrs: cls("pI_x6G_mainPanel"),
            children: [
              {
                attrs: { ...cls("wSkVaW_root"), "data-phase": "active" },
                children: [conversation],
              },
            ],
          },
        ],
      },
      { attrs: { ...cls("pI_x6G_rightbarCol"), "data-rightbar-col": "true" } },
      { attrs: { ...cls("pI_x6G_bottomRow"), "data-shell-bottom": "true" } },
      { attrs: { ...cls("pI_x6G_overlayLayer"), "data-shell-overlay": "true" } },
      { attrs: { ...cls("pI_x6G_leadingSeat"), "data-shell-leading": "true" } },
    ],
  };
}

test("the phone probe passes on dsh 0.2.2-rc.2's conversation", () => {
  assert.equal(probePhoneConversation(pageOf(frame()))?.state, "ok");
});

test("the phone probe judges only what is on the page", () => {
  assert.equal(probePhoneConversation(pageOf({})), undefined);
});

test("the phone probe catches a renamed conversation scroller", () => {
  const renamed = pageOf(frame({ scroll: cls("wSkVaW_scrollBody") }));
  assert.equal(probePhoneConversation(renamed)?.state, "changed");
});

test("the phone stylesheet relies on no dsh markup its probe does not check, and drops a failed group", () => {
  const phone = "(max-width: 767px)";
  const all = phoneStylesheet({}, phone);
  const declared = new Set<string>(Object.values(PARTS));
  const used = all.match(/\[class\*="[^"]+"\]|\[data-[\w-]+(?:="[^"]*")?\]/g) ?? [];
  assert.ok(used.length > 0);
  for (const selector of used)
    assert.ok(declared.has(selector), `${selector} is not a declared part`);
  // dsh 0.2.2-rc.2 lays out its own drawer and Settings on a phone.
  assert.ok(!all.includes("_sidebarCol"));
  assert.ok(!all.includes("data-shortcut-modal"));
  // The welcome page's hero is pinned near the top on a phone (dsh centers it).
  assert.ok(all.includes("justify-content:flex-start"));
  assert.ok(all.includes(PARTS.viewArea));
  const failed = { state: "changed", reason: "" } as const;
  const withoutConversation = phoneStylesheet({ "phone-conversation": failed }, phone);
  assert.ok(!withoutConversation.includes("justify-content:flex-start"));
  assert.ok(!withoutConversation.includes(PARTS.scroll));
  // Rules on plain elements stay whatever dsh looks like.
  assert.ok(withoutConversation.includes("touch-action:manipulation"));
  // The page pads no safe area: the viewport no longer extends under it.
  assert.ok(!all.includes("safe-area-inset"));
});

test("the Session store passes while dsh writes what Kivotos reads", () => {
  const store = (value: string | null) => ({ getItem: () => value, setItem: () => undefined });
  const shown = pageOf(frame());
  assert.equal(probeSessionStore(store('{"sessionId":"s1"}'), shown)?.state, "ok");
  assert.equal(
    probeSessionStore(store('{"sessionId":"s1","subagentAddress":{"id":"a"}}'), shown)?.state,
    "ok",
  );
  // No Session on screen is nothing to judge.
  assert.equal(probeSessionStore(store(null), pageOf({})), undefined);
  for (const value of [null, '"s1"', '{"session":"s1"}', "not json"]) {
    assert.equal(probeSessionStore(store(value), shown)?.state, "changed", String(value));
  }
});

test("what Kivotos writes as the current Session is what it reads back", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
  assert.equal(currentSession(storage), "");
  selectSession(storage, "s2");
  assert.equal(currentSession(storage), "s2");
  const shown = pageOf({ attrs: { "data-conversation-session": "s2" } });
  assert.equal(probeSessionStore(storage, shown)?.state, "ok");
});

test("a mounted page opened on a Session stores it in its own namespace before dsh boots", () => {
  const data = new Map<string, string>();
  const storage = {
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
  const replaced: string[] = [];
  const window = { localStorage: storage };
  const context = createContext({
    window,
    location: { hash: "#kivotos-session=s%203", pathname: "/kivotos/peer/b/", search: "" },
    history: {
      state: null,
      replaceState: (_: unknown, __: string, url: string) => replaced.push(url),
    },
  });
  const html = injectStorageNamespace("<head></head>", "b");
  runInContext(/<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "", context);
  // dsh, reading its key through the namespace, finds the Session.
  assert.equal(currentSession((window as { localStorage: typeof storage }).localStorage), "s 3");
  assert.deepEqual([...data.keys()], ["kivotos:b:dsh.sessions.current"]);
  assert.deepEqual(replaced, ["/kivotos/peer/b/"]);
});
