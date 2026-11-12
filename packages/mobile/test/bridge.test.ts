import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { backScript, parseBridgeMessage } from "../src/bridge.ts";

/** Run `backScript` in a page whose `__kivotosBack` is `back`; returns what it posted. */
function answer(back: unknown): unknown {
  const posted: string[] = [];
  const window = {
    __kivotosBack: back,
    ReactNativeWebView: { postMessage: (data: string) => posted.push(data) },
  };
  runInNewContext(backScript(7), { window });
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
