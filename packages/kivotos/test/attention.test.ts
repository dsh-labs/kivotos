import assert from "node:assert/strict";
import { test } from "node:test";
import { AttentionTracker, firstQuestion, type AttentionFrame } from "../src/attention.ts";

const S = { id: "s1" };
let seq = 0;
const ev = (type: string, data: unknown) => ({ type, time: ++seq, data });

function record(tracker: AttentionTracker): AttentionFrame[] {
  const frames: AttentionFrame[] = [];
  tracker.subscribe((frame) => frames.push(frame));
  return frames;
}

test("an approval waits until decided, then resolves under the same key", () => {
  const tracker = new AttentionTracker();
  const frames = record(tracker);
  tracker.observe(S, ev("session/title", { title: "Fix login" }));
  tracker.observe(S, ev("approval/asked", { id: "a1", toolName: "bash", reason: "rm -rf build" }));
  assert.deepEqual(
    tracker.pending().map((f) => f.key),
    ["a1"],
  );
  tracker.observe(S, ev("approval/decided", { id: "a1", outcome: "allowed-once" }));
  assert.deepEqual(
    frames.map((f) => [f.kind, f.key, f.title, f.detail]),
    [
      ["approval", "a1", "Fix login", "rm -rf build"],
      ["resolved", "a1", "Fix login", "allowed-once"],
    ],
  );
  assert.deepEqual(tracker.pending(), []);
});

test("a question resolves on a final tool result or a late reply, not on a pending result", () => {
  const tracker = new AttentionTracker();
  const frames = record(tracker);
  const args = JSON.stringify({ questions: [{ id: "q", question: "Which branch?" }] });
  tracker.observe(S, ev("tool/call", { callId: "c1", name: "ask_user_question", arguments: args }));
  tracker.observe(
    S,
    ev("tool/result", {
      message: { toolCallId: "c1", content: [{ type: "text", text: '{"pending":true}' }] },
    }),
  );
  assert.equal(tracker.pending().length, 1, "a timed-out ask stays open for a late reply");
  tracker.observe(
    S,
    ev("user/message", { source: { kind: "user-question-reply", callId: "c1" }, content: [] }),
  );
  assert.deepEqual(
    frames.map((f) => [f.kind, f.key, f.detail]),
    [
      ["question", "c1", "Which branch?"],
      ["resolved", "c1", ""],
    ],
  );
  assert.deepEqual(tracker.pending(), []);
});

test("other tool calls and unknown resolutions produce nothing", () => {
  const tracker = new AttentionTracker();
  const frames = record(tracker);
  tracker.observe(S, ev("tool/call", { callId: "c2", name: "bash", arguments: "{}" }));
  tracker.observe(S, ev("tool/result", { message: { toolCallId: "c2", content: [] } }));
  tracker.observe(S, ev("approval/decided", { id: "never-asked", outcome: "rejected" }));
  assert.deepEqual(frames, []);
});

test("turn ends: success is done, failure is failed, a user stop and replay closers are silent", () => {
  const tracker = new AttentionTracker();
  const frames = record(tracker);
  tracker.observe(S, ev("turn/end", { turn: 1, reason: { kind: "completed" } }));
  tracker.observe(
    S,
    ev("turn/end", { turn: 2, reason: { kind: "error", error: { message: "rate limited" } } }),
  );
  tracker.observe(S, ev("turn/end", { turn: 3, reason: { kind: "aborted", reason: {} } }));
  tracker.observe(S, ev("turn/end", { turn: 4, reason: { kind: "interrupted" } }));
  tracker.observe(S, ev("turn/end", { turn: 5, reason: { kind: "forked" } }));
  assert.deepEqual(
    frames.map((f) => [f.kind, f.key, f.detail]),
    [
      ["done", "turn:1", ""],
      ["failed", "turn:2", "rate limited"],
    ],
  );
});

test("since() replays only newer frames, so a reconnect does not notify twice", () => {
  const tracker = new AttentionTracker();
  tracker.observe(S, ev("turn/end", { turn: 1, reason: { kind: "completed" } }));
  tracker.observe(S, ev("turn/end", { turn: 2, reason: { kind: "completed" } }));
  const [first, second] = tracker.since(0);
  assert.deepEqual(
    tracker.since(first.id).map((f) => f.id),
    [second.id],
  );
  assert.deepEqual(tracker.since(second.id), []);
  assert.equal(first.epoch, tracker.epoch);
  assert.notEqual(
    new AttentionTracker().epoch,
    tracker.epoch,
    "a new Host process has a new epoch",
  );
});

test("a turn start is running from its start time until any turn end, which is idle", () => {
  const tracker = new AttentionTracker();
  const frames = record(tracker);
  tracker.observe(S, ev("session/title", { title: "Fix login" }));
  tracker.observe(S, { type: "turn/start", time: 1000, data: { turn: 1 } });
  tracker.observe(S, ev("turn/end", { turn: 1, reason: { kind: "completed" } }));
  tracker.observe(S, { type: "turn/start", time: 2000, data: { turn: 2 } });
  tracker.observe(S, ev("turn/end", { turn: 2, reason: { kind: "interrupted" } }));
  // An end with no start the tracker saw (it joined mid-turn) says nothing about running.
  tracker.observe(S, ev("turn/end", { turn: 3, reason: { kind: "completed" } }));
  assert.deepEqual(
    frames.map((f) => [f.kind, f.key, f.title]),
    [
      ["running", "turn:1", "Fix login"],
      ["idle", "turn:1", "Fix login"],
      ["done", "turn:1", "Fix login"],
      ["running", "turn:2", "Fix login"],
      ["idle", "turn:2", "Fix login"],
      ["done", "turn:3", "Fix login"],
    ],
  );
  assert.equal(frames[0].time, 1000);
  assert.equal(frames[3].time, 2000);
  assert.deepEqual(tracker.pending(), [], "running is not a wait");
});

test("running and idle are replayed only to a subscriber that asks for them", () => {
  const tracker = new AttentionTracker();
  tracker.observe(S, ev("turn/start", { turn: 1 }));
  tracker.observe(S, ev("approval/asked", { id: "a1", toolName: "bash" }));
  assert.deepEqual(
    tracker.since(0).map((f) => f.kind),
    ["approval"],
  );
  assert.deepEqual(
    tracker.since(0, true).map((f) => f.kind),
    ["running", "approval"],
  );
});

test("the running frame of a turn in progress outlives the history ring", () => {
  const tracker = new AttentionTracker();
  tracker.observe(S, ev("turn/start", { turn: 7 }));
  const other = { id: "s2" };
  for (let turn = 0; turn < 300; turn++)
    tracker.observe(other, ev("turn/end", { turn, reason: { kind: "completed" } }));
  const replay = tracker.since(0, true);
  assert.equal(replay.length, 201);
  assert.deepEqual(
    [replay[0].kind, replay[0].key, replay[0].sessionId],
    ["running", "turn:7", "s1"],
  );
  assert.ok(replay.every((frame, index) => index === 0 || frame.id > replay[index - 1].id));
  // A cursor past it, or a turn that ended, replays no stale running.
  assert.equal(tracker.since(replay[0].id, true).length, 200);
  tracker.observe(S, ev("turn/end", { turn: 7, reason: { kind: "completed" } }));
  assert.ok(!tracker.since(0, true).some((frame) => frame.kind === "running"));
});

test("a session that leaves the store while running goes idle", () => {
  const tracker = new AttentionTracker();
  const frames = record(tracker);
  tracker.observe(S, ev("turn/start", { turn: 1 }));
  tracker.forget(S.id);
  tracker.forget(S.id);
  assert.deepEqual(
    frames.map((f) => [f.kind, f.key]),
    [
      ["running", "turn:1"],
      ["idle", "turn:1"],
    ],
  );
});

test("a session joined mid-log takes its current title from the title source", () => {
  const tracker = new AttentionTracker((session) => (session.id === "s1" ? "Deploy" : null));
  const frames = record(tracker);
  tracker.observe(S, ev("turn/end", { turn: 1, reason: { kind: "completed" } }));
  tracker.observe({ id: "s2" }, ev("turn/end", { turn: 1, reason: { kind: "completed" } }));
  assert.deepEqual(
    frames.map((f) => f.title),
    ["Deploy", ""],
  );
});

test("firstQuestion prefers the header and survives malformed arguments", () => {
  assert.equal(
    firstQuestion(JSON.stringify({ questions: [{ header: "Branch", question: "Which?" }] })),
    "Branch",
  );
  assert.equal(firstQuestion("{not json"), "");
  assert.equal(firstQuestion(JSON.stringify({ questions: "nope" })), "");
});
