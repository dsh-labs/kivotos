import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { backAction, backScript, closeScript, parseBridgeMessage } from "../src/bridge.ts";

/** Run `script` in a page whose `window[name]` is `fn`; returns what it posted. */
function answer(fn: unknown, script = backScript(7), name = "__kivotosBack"): unknown {
  const posted: string[] = [];
  const window = {
    [name]: fn,
    ReactNativeWebView: { postMessage: (data: string) => posted.push(data) },
  };
  runInNewContext(script, { window });
  assert.equal(posted.length, 1);
  return parseBridgeMessage(posted[0]);
}

test("backScript posts the page's answer with its sequence number", () => {
  assert.deepEqual(
    answer(() => true),
    { type: "kivotos.back", seq: 7, handled: true },
  );
  assert.deepEqual(
    answer(() => false),
    { type: "kivotos.back", seq: 7, handled: false },
  );
});

test("backScript answers false for a page without __kivotosBack, or one that throws", () => {
  assert.deepEqual(answer(undefined), { type: "kivotos.back", seq: 7, handled: false });
  const throws = (): never => {
    throw new Error("dsh changed");
  };
  assert.deepEqual(answer(throws), { type: "kivotos.back", seq: 7, handled: false });
  // Only a literal true spends the Back.
  assert.deepEqual(
    answer(() => "yes"),
    { type: "kivotos.back", seq: 7, handled: false },
  );
});

test("closeScript runs __kivotosClose and posts its answer", () => {
  assert.deepEqual(
    answer(() => true, closeScript(9), "__kivotosClose"),
    {
      type: "kivotos.back",
      seq: 9,
      handled: true,
    },
  );
  // It does not fall back to __kivotosBack.
  assert.deepEqual(
    answer(() => true, closeScript(9), "__kivotosBack"),
    {
      type: "kivotos.back",
      seq: 9,
      handled: false,
    },
  );
});

test("kivotos.layers parses only the kinds Back knows", () => {
  for (const open of ["menu", "dialog", "drawer", null])
    assert.deepEqual(parseBridgeMessage(JSON.stringify({ type: "kivotos.layers", open })), {
      type: "kivotos.layers",
      open,
    });
  for (const open of ["kept", "none", "", 1, true, {}, []])
    assert.equal(parseBridgeMessage(JSON.stringify({ type: "kivotos.layers", open })), null);
  // A missing field is not null: it is refused, so the app keeps asking.
  assert.equal(parseBridgeMessage(JSON.stringify({ type: "kivotos.layers" })), null);
});

test("Back closes what the page reports open, leaves at once otherwise, and asks an older page", () => {
  assert.equal(backAction("menu"), "close");
  assert.equal(backAction("dialog"), "close");
  assert.equal(backAction("drawer"), "close");
  assert.equal(backAction(null), "leave");
  assert.equal(backAction(undefined), "ask");
});
