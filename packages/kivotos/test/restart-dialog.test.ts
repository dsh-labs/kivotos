/**
 * The Restart-dsh dialog's text grid.
 *
 * The empty-state line used to sit at the dialog's left edge because its own
 * class carried the horizontal padding while the dialog's body did not (and
 * `RESTART_CSS` was only rendered by the overlay and the notice, never by the
 * dialog). These assertions keep every line — title, description, body text and
 * buttons — on one left edge, at desktop and at phone width.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const KIVOTOS = new URL("../src/", import.meta.url);

/** Declarations of the first rule whose selector list contains `selector`. */
function rule(css: string, selector: string): Record<string, string> {
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of css.matchAll(pattern)) {
    const selectors = (match[1] ?? "").split(",").map((part) => part.trim());
    if (selectors.includes(selector)) {
      const out: Record<string, string> = {};
      for (const declaration of (match[2] ?? "").split(";")) {
        const index = declaration.indexOf(":");
        if (index < 0) continue;
        out[declaration.slice(0, index).trim()] = declaration.slice(index + 1).trim();
      }
      return out;
    }
  }
  throw new Error(`no rule for ${selector}`);
}

/** The body of `@media (max-width:…520…)`, or "" for the base stylesheet. */
function phone(css: string): string {
  const start = css.search(/@media\s*\(max-width:\s*520px\)/);
  if (start < 0) return "";
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return "";
}

/**
 * Left padding a rule gives its text; "" when it sets none (the box does).
 * Understands the `padding` and `padding-inline` shorthands.
 */
function left(styles: Record<string, string>): string {
  if (styles["padding-left"] !== undefined) return styles["padding-left"];
  const inline = styles["padding-inline"];
  if (inline !== undefined) return inline.split(/\s+/)[0] ?? "";
  const padding = styles["padding"];
  if (padding === undefined) return "";
  const parts = padding.split(/\s+/).filter(Boolean);
  // 1 value: all sides. 2: vertical | horizontal. 3: top | horizontal | bottom. 4: top right bottom left.
  if (parts.length === 1) return parts[0] ?? "";
  if (parts.length === 3) return parts[1] ?? "";
  return (parts.length === 2 ? parts[1] : parts[3]) ?? "";
}

const settings = await readFile(new URL("settings.tsx", KIVOTOS), "utf8");
const restart = await readFile(new URL("restart-ui.tsx", KIVOTOS), "utf8");

/** The dialog stylesheet of settings.tsx (`kivotos-dialog*` rules). */
function dialogCss(source: string): string {
  const start = source.indexOf(".kivotos-dialog{");
  assert.ok(start > 0, "settings.tsx defines the dialog stylesheet");
  return source.slice(start);
}

for (const [label, css] of [
  ["desktop", dialogCss(settings)],
  ["phone", phone(dialogCss(settings))],
] as const) {
  test(`title, description, body and buttons share one left edge (${label})`, () => {
    assert.notEqual(css.length, 0, `${label} rules are present`);
    const head = left(rule(css, ".kivotos-dialog-head"));
    const desc = left(rule(css, ".kivotos-dialog-desc"));
    const body = left(rule(css, ".kivotos-dialog-body"));
    const foot = left(rule(css, ".kivotos-dialog-foot"));
    for (const [name, value] of Object.entries({ desc, body, foot })) {
      assert.equal(value, head, `${name} starts at the title's left edge (${label})`);
    }
    // The title itself has no padding: it inherits the head's edge.
    assert.equal(left(rule(css, ".kivotos-dialog-title")), "");
  });
}

test("the empty-state line takes its edge from the dialog body, not its own padding", () => {
  const note = left(rule(restart, ".kivotos-restart-note"));
  assert.equal(note, "0", "the note sets no horizontal padding of its own");
  assert.equal(rule(restart, ".kivotos-restart-note")["margin"], "0");
  // And the dialog puts every line inside that body, with its own stylesheet.
  assert.match(restart, /<style>\{RESTART_CSS\}<\/style>/);
  assert.match(restart, /<div className="kivotos-dialog-body">/);
  assert.match(restart, /<div className="kivotos-dialog-foot">/);
  assert.ok(
    restart.indexOf('className="kivotos-dialog-body"') <
      restart.indexOf('className="kivotos-dialog-foot"'),
  );
  // Within the dialog's JSX (the stylesheet above also names the class).
  const jsx = restart.slice(restart.indexOf("export function RestartDialog"));
  assert.ok(jsx.indexOf("kivotos-restart-note") > jsx.indexOf('className="kivotos-dialog-body"'));
});

test("phone dialogs fit the viewport with reachable, fat-enough buttons", () => {
  const dialog = rule(phone(dialogCss(settings)), ".kivotos-dialog");
  assert.match(dialog["max-height"] ?? "", /dvh/, "the dialog is bounded by the dynamic viewport");
  assert.match(
    dialog["padding-bottom"] ?? "",
    /env\(safe-area-inset-bottom/,
    "the foot clears the safe area",
  );
  const foot = rule(phone(dialogCss(settings)), ".kivotos-dialog-foot");
  assert.equal(foot["flex-wrap"], "wrap", "buttons wrap instead of overflowing");
  const button = rule(phone(dialogCss(settings)), ".kivotos-dialog-foot .kivotos-btn");
  assert.ok(
    Number.parseInt(button["min-height"] ?? "0", 10) >= 44,
    "buttons keep a 44px tap target",
  );
  assert.ok((button["flex"] ?? "").length > 0, "buttons share the row");
  const close = rule(
    phone(dialogCss(settings)),
    '.kivotos-dialog-head .kivotos-btn[data-kind="icon"]',
  );
  assert.ok(
    Number.parseInt(close["width"] ?? "0", 10) >= 44,
    "the close control keeps a 44px target",
  );
  const title = rule(phone(dialogCss(settings)), ".kivotos-dialog-title");
  assert.equal(title["overflow-wrap"], "anywhere", "a long machine name wraps instead of clipping");
});
