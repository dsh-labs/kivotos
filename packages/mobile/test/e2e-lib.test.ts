import assert from "node:assert/strict";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import {
  centerOf,
  decodeFrames,
  formatTable,
  inputTextArgument,
  machineRows,
  mockPatch,
  parseLabBanner,
  parseUiNodes,
  postedNotifications,
  sessionEvents,
  turnFacts,
} from "../e2e/lib.ts";

const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="Machines" resource-id="" class="android.widget.TextView" content-desc="" focused="false" bounds="[42,307][1038,439]" />
<node index="1" text="" resource-id="" class="android.widget.Button" content-desc="host.local, Relay" focused="false" bounds="[43,599][1037,756]">
<node index="0" text="host.local" class="android.widget.TextView" content-desc="" bounds="[216,648][763,706]" /></node>
<node index="2" text="" resource-id="" class="android.widget.Button" content-desc="host.local, Relay" focused="false" bounds="[43,440][1037,599]" />
<node index="3" text="kivotos://join?relay=ws%3A%2F%2F127.0.0.1&amp;key=a&quot;b" class="android.widget.EditText" content-desc="Or paste an invite link" focused="true" bounds="[80,1074][792,1191]" />
<node index="4" text="other.local" class="android.widget.Button" content-desc="other.local, Tailscale" bounds="[43,800][1037,900]" />
<node index="5" text="no bounds" class="android.widget.TextView" />
</hierarchy>`;

test("parseUiNodes reads text, label, class, focus and bounds, unescaping entities", () => {
  const nodes = parseUiNodes(DUMP);
  assert.equal(nodes.length, 6);
  assert.deepEqual(nodes[0], {
    text: "Machines",
    desc: "",
    className: "android.widget.TextView",
    focused: false,
    checked: false,
    bounds: [42, 307, 1038, 439],
  });
  const field = nodes.find((node) => node.className === "android.widget.EditText");
  assert.equal(field?.text, 'kivotos://join?relay=ws%3A%2F%2F127.0.0.1&key=a"b');
  assert.equal(field?.focused, true);
});

const NOTIFICATIONS = `Current Notification Manager state:
  Notification List:
    NotificationRecord(0x0ae8f69e: pkg=android user=UserHandle{-1} id=55 tag=null importance=2 key=-1|android|55|null|1000: Notification(channel=DEVELOPER shortcut=null contentView=null vibrate=null sound=null tick defaults=0 flags=ONGOING_EVENT|CAN_COLORIZE color=0x00000000 vis=PUBLIC))
      uid=1000 userId=-1
      flags=ONGOING_EVENT|CAN_COLORIZE
    NotificationRecord(0x0ae8f69f: pkg=com.rinai.kivotos user=UserHandle{0} id=7380 tag=null importance=3 key=0|com.rinai.kivotos|7380|null|10210: Notification(channel=live shortcut=null contentView=null vibrate=null sound=null defaults=0 flags=ONGOING_EVENT|NO_CLEAR|FOREGROUND_SERVICE|PROMOTED_ONGOING color=0xff3478db vis=PRIVATE publicVersion=Notification(channel=live))
      notification=
            extras={
                android.title=String (lab-a · Fix login)
                android.text=String (Waiting for your approval)
                android.shortCriticalText=String (Approve)
                android.showChronometer=Boolean (false)
            }
      publicNotification=
            extras={
                android.title=String (Kivotos)
            }
  Snoozed notifications:
    NotificationRecord(0x0ae8f69f: pkg=com.rinai.kivotos user=UserHandle{0} id=7380 tag=null importance=3 key=0|com.rinai.kivotos|7380|null|10210: Notification(channel=live shortcut=null contentView=null vibrate=null sound=null defaults=0 flags=ONGOING_EVENT color=0xff3478db vis=PRIVATE))
`;

test("postedNotifications reads a package's records once, with flags, chip and own extras", () => {
  assert.deepEqual(postedNotifications(NOTIFICATIONS, "com.rinai.kivotos", 7380), [
    {
      channel: "live",
      flags: ["ONGOING_EVENT", "NO_CLEAR", "FOREGROUND_SERVICE", "PROMOTED_ONGOING"],
      title: "lab-a · Fix login",
      text: "Waiting for your approval",
      chip: "Approve",
      chronometer: false,
    },
  ]);
  assert.deepEqual(postedNotifications(NOTIFICATIONS, "com.rinai.kivotos", 1), []);
  assert.equal(postedNotifications(NOTIFICATIONS, "android").length, 1);
});

test("machineRows lists the named machine's buttons topmost first; centerOf taps the middle", () => {
  const rows = machineRows(parseUiNodes(DUMP), "host.local");
  assert.deepEqual(
    rows.map((row) => row.bounds[1]),
    [440, 599],
  );
  assert.deepEqual(centerOf(rows[0]), [540, 520]);
  assert.deepEqual(machineRows(parseUiNodes(DUMP), "host"), []);
});

test("inputTextArgument quotes for the device shell and refuses what input text cannot type", () => {
  assert.equal(inputTextArgument("kivotos://join?a=1&b=2"), "'kivotos://join?a=1&b=2'");
  assert.equal(inputTextArgument("it's"), `'it'\\''s'`);
  assert.throws(() => inputTextArgument("100%sure"), /%s/);
  assert.throws(() => inputTextArgument("héllo"), /ASCII/);
});

const BANNER = `dev: starting the two dsh instances

Kivotos lab is up. Press Ctrl-C to stop it.

  machine A   http://127.0.0.1:7612/?token=abc
  machine B   http://127.0.0.1:7613/?token=def
  relay       127.0.0.1:7611  (log: /tmp/lab/relay.log)
  members     2 of 2 online

  invite      kivotos://join?relay=ws%3A%2F%2F127.0.0.1%3A7611%2Fv1%2Fconnect&key=K-_y

Open machine A, then Machines in the sidebar: machine B is in the list.`;

test("parseLabBanner reads dev.mjs's banner, and nothing before it is complete", () => {
  assert.deepEqual(parseLabBanner(BANNER), {
    machineA: "http://127.0.0.1:7612/?token=abc",
    machineB: "http://127.0.0.1:7613/?token=def",
    relay: "127.0.0.1:7611",
    online: 2,
    invite: "kivotos://join?relay=ws%3A%2F%2F127.0.0.1%3A7611%2Fv1%2Fconnect&key=K-_y",
  });
  assert.equal(parseLabBanner("dev: building the relay\n"), undefined);
  assert.equal(parseLabBanner(BANNER.slice(0, BANNER.indexOf("  invite"))), undefined);
});

test("mockPatch makes the mock the default model, pins Documents and loads the mock by absolute path", () => {
  assert.equal(
    mockPatch("/tmp/e2e/mock-llm.mjs", "/tmp/e2e/documents"),
    [
      "- id: agent-default-model",
      "  config:",
      "    provider: lab-mock",
      "    model: lab-mock",
      "- id: workspace-controller",
      "  config:",
      '    documentsDirectory: "/tmp/e2e/documents"',
      "- insert:",
      "    - id: kivotos-e2e-mock-llm",
      '      name: "/tmp/e2e/mock-llm.mjs"',
      "",
    ].join("\n"),
  );
});

const line = (type: string, data: unknown) => `${JSON.stringify({ type, data })}\n`;

test("decodeFrames joins every complete frame and leaves out a torn last one", () => {
  const first = zstdCompressSync(line("session", {}));
  const second = zstdCompressSync(line("turn/start", { turn: 1 }));
  const torn = zstdCompressSync(line("turn/end", { turn: 1 })).subarray(0, 8);
  const text = decodeFrames(Buffer.concat([first, second, torn]));
  assert.deepEqual(
    sessionEvents(text).map((event) => event.type),
    ["session", "turn/start"],
  );
});

test("decodeFrames keeps a frame whose data holds the magic number", () => {
  // Stored uncompressed (level 1 does not compress random bytes), so the magic stays in the frame.
  const payload = Buffer.concat([
    Buffer.from(line("a", "x").trimEnd()),
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
    Buffer.from("\n"),
  ]);
  const frame = zstdCompressSync(payload);
  const next = zstdCompressSync(line("b", 1));
  const text = decodeFrames(Buffer.concat([frame, next]));
  assert.ok(text.endsWith(line("b", 1)));
  assert.ok(text.startsWith(line("a", "x").trimEnd()));
});

test("sessionEvents skips blank, torn and untyped lines", () => {
  const events = sessionEvents(`${line("x", 1)}\n{"type":\n{"data":2}\n${line("y", { z: 1 })}`);
  assert.deepEqual(events, [
    { type: "x", data: 1 },
    { type: "y", data: { z: 1 } },
  ]);
});

test("turnFacts follows the turn the marked prompt started", () => {
  const events = sessionEvents(
    [
      line("agent/inbox/spliced", { text: "approve e2e-1" }),
      line("turn/start", { turn: 1 }),
      line("approval/asked", {}),
      line("approval/decided", { outcome: "rejected" }),
      line("turn/end", { reason: { kind: "stop" } }),
      line("agent/inbox/spliced", { text: "slow e2e-2" }),
      line("turn/start", { turn: 2 }),
      line("approval/asked", {}),
    ].join(""),
  );
  assert.deepEqual(turnFacts(events, "e2e-1"), {
    found: true,
    started: true,
    asked: 1,
    decided: ['"rejected"'],
    ended: "stop",
  });
  assert.deepEqual(turnFacts(events, "e2e-2"), {
    found: true,
    started: true,
    asked: 1,
    decided: [],
  });
  assert.equal(turnFacts(events, "e2e-3").found, false);
  const aborted = sessionEvents(
    line("x", "e2e-4") +
      line("turn/end", { reason: { kind: "aborted", reason: { kind: "user" } } }),
  );
  assert.equal(turnFacts(aborted, "e2e-4").ended, "aborted");
});

test("formatTable pads columns and marks failures", () => {
  assert.equal(
    formatTable([
      { state: "drawer", pass: true, detail: "closed", ms: 1234 },
      { state: "approval", pass: false, detail: "timed out", ms: 50 },
    ]),
    [
      "| state    | result | time | observed  |",
      "| -------- | ------ | ---- | --------- |",
      "| drawer   | pass   | 1.2s | closed    |",
      "| approval | FAIL   | 0.1s | timed out |",
    ].join("\n"),
  );
});
