// Pure helpers of the phone e2e (packages/mobile/e2e/phone-back.ts), kept apart
// so test/e2e-lib.test.ts can cover them without a device.
import { zstdDecompressSync } from "node:zlib";

/** One node of a `uiautomator dump`. */
export interface UiNode {
  text: string;
  desc: string;
  className: string;
  focused: boolean;
  /** [left, top, right, bottom] in screen pixels. */
  bounds: [number, number, number, number];
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function unescapeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** @returns every node of a `uiautomator dump` XML document, in document order. */
export function parseUiNodes(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  for (const [tag] of xml.matchAll(/<node\b[^>]*>/g)) {
    const attrs = new Map<string, string>();
    for (const [, name, value] of tag.matchAll(/([\w-]+)="([^"]*)"/g)) {
      attrs.set(name, unescapeXml(value));
    }
    const box = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(attrs.get("bounds") ?? "");
    if (box === null) continue;
    nodes.push({
      text: attrs.get("text") ?? "",
      desc: attrs.get("content-desc") ?? "",
      className: attrs.get("class") ?? "",
      focused: attrs.get("focused") === "true",
      bounds: [Number(box[1]), Number(box[2]), Number(box[3]), Number(box[4])],
    });
  }
  return nodes;
}

/** @returns the point at the middle of a node, where a tap lands on it. */
export function centerOf(node: UiNode): [number, number] {
  const [left, top, right, bottom] = node.bounds;
  return [Math.round((left + right) / 2), Math.round((top + bottom) / 2)];
}

/**
 * The machine list's rows: the buttons whose label starts with the machine's
 * name (`<name>, <summary>`), topmost first.
 */
export function machineRows(nodes: UiNode[], name: string): UiNode[] {
  return nodes
    .filter(
      (node) => node.className === "android.widget.Button" && node.desc.startsWith(`${name}, `),
    )
    .sort((a, b) => a.bounds[1] - b.bounds[1]);
}

/**
 * Quotes text for `adb shell input text`, which the device's shell parses
 * first. `input text` itself turns `%s` into a space, so text holding it
 * cannot be typed; neither can a non-ASCII character.
 */
export function inputTextArgument(text: string): string {
  if (text.includes("%s")) throw new Error("input text cannot type %s");
  if (!/^[\x20-\x7e]*$/.test(text)) throw new Error("input text types printable ASCII only");
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** What `scripts/dev.mjs` prints once its lab is up. */
export interface LabBanner {
  machineA: string;
  machineB: string;
  relay: string;
  online: number;
  invite: string;
}

/** @returns the lab's banner from dev.mjs's output, or undefined while it is not printed. */
export function parseLabBanner(output: string): LabBanner | undefined {
  if (!output.includes("Kivotos lab is up")) return undefined;
  const field = (name: string) => new RegExp(`^\\s+${name}\\s+(\\S+)`, "m").exec(output)?.[1];
  const machineA = field("machine A");
  const machineB = field("machine B");
  const relay = field("relay");
  const invite = field("invite");
  const online = /^\s+members\s+(\d+) of \d+ online/m.exec(output)?.[1];
  if ([machineA, machineB, relay, invite, online].includes(undefined)) return undefined;
  return {
    machineA: machineA as string,
    machineB: machineB as string,
    relay: relay as string,
    online: Number(online),
    invite: invite as string,
  };
}

/**
 * The cordis patch layer dev.mjs appends to the lab's own: it makes the mock
 * model (mock-llm.mjs) dsh's default, and names the Documents directory dsh
 * makes its first Workspace in. Without one dsh asks the OS (`xdg-user-dir`
 * on Linux), and a host with no Documents directory, such as a CI runner,
 * gets no Workspace and so no Session: the composer stays inert.
 */
export function mockPatch(mockFile: string, documentsDir: string): string {
  return [
    "- id: agent-default-model",
    "  config:",
    "    provider: lab-mock",
    "    model: lab-mock",
    "- id: workspace-controller",
    "  config:",
    `    documentsDirectory: ${JSON.stringify(documentsDir)}`,
    "- insert:",
    "    - id: kivotos-e2e-mock-llm",
    `      name: ${JSON.stringify(mockFile)}`,
    "",
  ].join("\n");
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/**
 * Decodes a session log (`session.v4.jsonl.zstd`): concatenated zstd frames,
 * the last of which may still be being written. A frame is found by its magic
 * number; a magic that is only frame data merges into the frame before it,
 * and a frame that does not decode (the unfinished last one) is left out.
 */
export function decodeFrames(bytes: Uint8Array): string {
  const starts: number[] = [];
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (ZSTD_MAGIC.every((byte, k) => bytes[i + k] === byte)) starts.push(i);
  }
  let text = "";
  let k = 0;
  while (k < starts.length) {
    let end = k + 1;
    let decoded: string | undefined;
    while (decoded === undefined && end <= starts.length) {
      try {
        decoded = zstdDecompressSync(
          bytes.subarray(starts[k], starts[end] ?? bytes.length),
        ).toString();
      } catch {
        end += 1;
      }
    }
    if (decoded === undefined) break;
    text += decoded;
    k = end;
  }
  return text;
}

/** One event of a session log. */
export interface SessionEvent {
  type: string;
  data?: unknown;
}

/** @returns the events of a decoded session log; a line that is not JSON is skipped. */
export function sessionEvents(text: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const event: unknown = JSON.parse(line);
      const type = member(event, "type");
      if (typeof type === "string") events.push({ type, data: member(event, "data") });
    } catch {
      // a torn line
    }
  }
  return events;
}

/** What a session log says about the turn a prompt started. */
export interface TurnFacts {
  /** The prompt is in this log. */
  found: boolean;
  /** Its turn started. */
  started: boolean;
  /** Its turn ended, and why (`turn/end` `reason.kind`). */
  ended?: string;
  asked: number;
  decided: string[];
}

/** @returns `value[key]` when `value` is an object that has it. */
function member(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? Reflect.get(value, key)
    : undefined;
}

/**
 * @returns what `events` say about the first turn after the prompt holding
 * `marker`: the first event that holds it (dsh logs the prompt into the
 * agent's inbox before the turn starts).
 */
export function turnFacts(events: SessionEvent[], marker: string): TurnFacts {
  const facts: TurnFacts = { found: false, started: false, asked: 0, decided: [] };
  for (const event of events) {
    if (!facts.found) {
      facts.found = JSON.stringify(event.data ?? null).includes(marker);
      continue;
    }
    if (event.type === "turn/start") facts.started = true;
    if (event.type === "approval/asked") facts.asked += 1;
    if (event.type === "approval/decided") {
      facts.decided.push(JSON.stringify(member(event.data, "outcome") ?? event.data ?? null));
    }
    if (event.type === "turn/end") {
      const kind = member(member(event.data, "reason"), "kind");
      facts.ended = typeof kind === "string" ? kind : "unknown";
      break;
    }
  }
  return facts;
}

/** One row of the result table. */
export interface Result {
  state: string;
  pass: boolean;
  detail: string;
  ms: number;
}

/** @returns the pass/fail table the run prints. */
export function formatTable(results: Result[]): string {
  const header = ["state", "result", "time", "observed"];
  const rows = results.map((result) => [
    result.state,
    result.pass ? "pass" : "FAIL",
    `${(result.ms / 1000).toFixed(1)}s`,
    result.detail,
  ]);
  const widths = header.map((title, i) =>
    Math.max(title.length, ...rows.map((row) => row[i].length)),
  );
  const line = (cells: string[]) =>
    `| ${cells.map((cell, i) => cell.padEnd(widths[i])).join(" | ")} |`;
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join(
    "\n",
  );
}
