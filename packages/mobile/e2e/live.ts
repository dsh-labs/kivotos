// Live Update cases of the phone e2e (phone-back.ts): the app's ongoing
// notification while a machine runs a turn, waits for an approval, and
// finished, read from `dumpsys notification --noredact`. On Android 16 QPR1+
// it must be promoted (the status-bar chip); before, nothing may change: the
// quiet service notification only, no Live Updates channel, nothing promoted.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Device } from "./device.ts";
import type { Lab } from "./lab.ts";
import {
  ACTIVITY,
  PACKAGE,
  postedNotifications,
  type PostedNotification,
  type UiNode,
} from "./lib.ts";

/** The service's ongoing notification (AttentionService.SERVICE_NOTIFICATION_ID). */
const ONGOING_ID = 7380;
const PROMOTED = "PROMOTED_ONGOING";

/** What these cases need of the harness's run. */
export interface LiveRun {
  readonly device: Device;
  readonly lab: Lab;
  /** Where screenshots go; none taken when undefined. */
  readonly shots: string | undefined;
  /** The device must promote (`--expect-live`): an Android without Live Updates fails instead of passing unchanged. */
  readonly expectLive: boolean;
  ms(base: number): number;
  marker(): string;
  show(): Promise<void>;
  newSession(): Promise<void>;
  send(prompt: string): Promise<void>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  until<T>(
    what: string,
    probe: () => Promise<T | undefined | false>,
    timeoutMs: number,
  ): Promise<T>;
}

export interface LiveCase {
  id: string;
  state: string;
  run(run: LiveRun): Promise<string>;
}

/** The app's own screens: the machine list with its Settings. */
async function home(run: LiveRun): Promise<UiNode[]> {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (!(await run.device.focusedWindow()).includes(PACKAGE)) {
      await run.device.shell(`am start -W -n ${ACTIVITY}`, run.ms(30_000));
    }
    const nodes = await run.device.ui();
    if (nodes.some((node) => node.text === "Live updates")) return nodes;
    await run.device.back();
    await sleep(500);
  }
  throw new Error("the app's machine list did not come up");
}

const switchOf = (nodes: UiNode[], label: string) =>
  nodes.find((node) => node.className === "android.widget.Switch" && node.desc === label);

/** Set one of the home screen's switches; returns false when it is disabled (it stays as it is). */
async function setSwitch(run: LiveRun, label: string, on: boolean): Promise<boolean> {
  const node = switchOf(await home(run), label);
  if (node === undefined) throw new Error(`no ${label} switch`);
  if (node.checked === on) return true;
  await run.device.tapNode(node);
  return run
    .until(
      `${label} ${on ? "on" : "off"}`,
      async () => switchOf(await run.device.ui(), label)?.checked === on,
      5000,
    )
    .then(() => true)
    .catch(() => false);
}

const NO_LIVE = "Needs Android 16 or later";
const BLOCKED = "Live updates are off for Kivotos";

/**
 * The Live updates switch on the machine list.
 * @returns undefined while it can be switched; else the reason it shows
 *   under it, scrolled into view on a short screen.
 * @throws when it is disabled without a reason.
 */
async function disabledReason(run: LiveRun): Promise<string | undefined> {
  let nodes = await home(run);
  const live = switchOf(nodes, "Live updates");
  if (live === undefined) throw new Error("no Live updates switch");
  if (live.enabled) return undefined;
  const reason = () =>
    nodes.find((node) => node.text === NO_LIVE || node.text.startsWith(BLOCKED))?.text;
  if (reason() === undefined) {
    // The reason sits under the switch, below the fold of a small screen.
    const [left, top, right] = live.bounds;
    const x = Math.round((left + right) / 2);
    await run.device.shell(`input swipe ${x} ${top} ${x} ${Math.max(0, top - 600)} 300`);
    nodes = await run.device.ui();
  }
  const shown = reason();
  if (shown === undefined) throw new Error("the Live updates switch is disabled without a reason");
  return shown;
}

/**
 * Notifications on, and Live Updates as asked.
 * @returns whether Android has Live Updates for the app (the switch is not disabled with a notice).
 */
async function prepare(run: LiveRun, live: boolean): Promise<boolean> {
  if (!(await setSwitch(run, "Notifications", true))) throw new Error("Notifications stay off");
  const reason = await disabledReason(run);
  if (reason === NO_LIVE) {
    if (run.expectLive) throw new Error("--expect-live, but this Android has no Live Updates");
    return false;
  }
  if (reason !== undefined)
    throw new Error(`Android does not allow the app's Live Updates: ${reason}`);
  if (!(await setSwitch(run, "Live updates", live)))
    throw new Error("the Live updates switch did not change");
  return true;
}

/** A new Session runs a "liveupdate" turn (ticks for 8 s, then an approval); the app goes to the background. */
async function startTurn(run: LiveRun): Promise<string> {
  await run.show();
  await run.newSession();
  const marker = run.marker();
  await run.send(`liveupdate ${marker}`);
  await run.until("dsh to start the turn", async () => run.lab.turn(marker).started, 15_000);
  // The Session on screen gets no "finished": watch from the launcher.
  await run.device.shell("input keyevent KEYCODE_HOME");
  return marker;
}

async function ongoing(run: LiveRun): Promise<PostedNotification[]> {
  return postedNotifications(await run.device.shell("dumpsys notification --noredact"), PACKAGE);
}

/** Waits for the ongoing notification to match; names what it last was on a timeout. */
async function untilOngoing(
  run: LiveRun,
  what: string,
  check: (notification: PostedNotification) => boolean,
  timeoutMs: number,
): Promise<PostedNotification> {
  let last: PostedNotification | undefined;
  try {
    return await run.until(
      what,
      async () => {
        const [notification] = postedNotifications(
          await run.device.shell("dumpsys notification --noredact"),
          PACKAGE,
          ONGOING_ID,
        );
        last = notification;
        return notification !== undefined && check(notification) ? notification : undefined;
      },
      timeoutMs,
    );
  } catch (error) {
    throw new Error(`${String(error)}; ongoing notification: ${JSON.stringify(last)}`, {
      cause: error,
    });
  }
}

const describe = (n: PostedNotification) =>
  `${n.channel} [${n.flags.filter((flag) => flag !== "ONGOING_EVENT").join("|")}] "${n.title}" / "${n.text}"` +
  (n.chip === "" ? "" : `, chip "${n.chip}"`) +
  (n.chronometer ? ", chronometer" : "");

/** Before Android 16 QPR1: the quiet service notification only, nothing promoted, no Live Updates channel. */
async function unchanged(run: LiveRun, during: string): Promise<string> {
  // The service may have just been started by the Notifications switch.
  const all = await run
    .until(
      "the service notification",
      async () => {
        const now = await ongoing(run);
        return now.some((n) => n.flags.includes("FOREGROUND_SERVICE")) ? now : undefined;
      },
      10_000,
    )
    .catch(() => {
      throw new Error(`no service notification during ${during}`);
    });
  const service = all.find((n) => n.flags.includes("FOREGROUND_SERVICE"));
  if (service === undefined) throw new Error(`no service notification during ${during}`);
  if (service.channel !== "service" || !service.title.startsWith("Watching")) {
    throw new Error(`the service notification changed during ${during}: ${describe(service)}`);
  }
  const extra = all.filter((n) => n.channel === "live" || isPromoted(n));
  if (extra.length > 0)
    throw new Error(`a Live Update on Android without them: ${extra.map(describe).join("; ")}`);
  // The app's channels: its block of the ranking preferences, else the whole dump
  // (where no other app on the image has a channel named `live`).
  const dump = await run.device.shell("dumpsys notification --noredact");
  const settings =
    new RegExp(
      `AppSettings: ${PACKAGE.replaceAll(".", "\\.")} \\(\\d+\\)[\\s\\S]*?(?=AppSettings:|$)`,
    ).exec(dump)?.[0] ?? dump;
  if (settings.includes("mId='live'")) throw new Error("the Live Updates channel exists");
  const reason = await disabledReason(run);
  if (reason !== NO_LIVE)
    throw new Error(`the Live updates switch is not disabled as unsupported: ${reason}`);
  return `no Live Updates on this Android: switch disabled, "${reason}"; ${describe(service)}; ${all.length} notification(s), none promoted, no live channel`;
}

/**
 * The status-bar chip as SystemUI draws it, with the app in the background:
 * a SystemUI node of the window dump that shows `chip`, else a line of
 * SystemUI's own dump that names it. Then, with `--shots`, the screen and
 * the opened shade.
 */
async function chipShown(run: LiveRun, name: string, chip: string): Promise<string> {
  if ((await run.device.focusedWindow()).includes(PACKAGE)) {
    await run.device.shell("input keyevent KEYCODE_HOME");
  }
  await run.device.shell("cmd statusbar collapse");
  let seen = "";
  try {
    seen = await run.until(
      `the status-bar chip "${chip}"`,
      async () => {
        const node = (await run.device.ui()).find(
          (n) => n.pkg === "com.android.systemui" && (n.text === chip || n.desc.includes(chip)),
        );
        if (node !== undefined) return `SystemUI shows "${node.text || node.desc}"`;
        const dump = await run.device.shell("dumpsys activity service com.android.systemui");
        const line = dump.split("\n").find((each) => /chip/i.test(each) && each.includes(chip));
        return line === undefined ? undefined : `SystemUI dump: ${line.trim().slice(0, 160)}`;
      },
      10_000,
    );
  } finally {
    if (run.shots !== undefined) {
      mkdirSync(run.shots, { recursive: true });
      if (seen === "") {
        const dump = await run.device.shell("dumpsys activity service com.android.systemui");
        writeFileSync(
          path.join(run.shots, `${name}-systemui.txt`),
          dump
            .split("\n")
            .filter((each) => /chip|promot|ongoing/i.test(each))
            .join("\n"),
        );
      }
      const take = async (file: string) => {
        await run.device.shell("screencap -p /sdcard/kivotos-e2e.png");
        await run.device.adb(["pull", "/sdcard/kivotos-e2e.png", path.join(run.shots ?? "", file)]);
      };
      await take(`${name}-chip.png`);
      await run.device.shell("cmd statusbar expand-notifications");
      await sleep(1500);
      await take(`${name}-shade.png`);
      await run.device.shell("cmd statusbar collapse");
      await sleep(500);
    }
  }
  return `; ${seen}${run.shots === undefined ? "" : `; shots ${name}-chip.png, ${name}-shade.png`}`;
}

/**
 * `Notification.FLAG_PROMOTED_ONGOING`, by name or, where the dump prints a
 * flag it has no name for as hex, by value.
 */
function isPromoted(n: PostedNotification): boolean {
  return n.flags.some(
    (flag) => flag === PROMOTED || (/^0x[0-9a-f]+$/i.test(flag) && (Number(flag) & 0x40000) !== 0),
  );
}

const promoted = (n: PostedNotification) => n.channel === "live" && isPromoted(n);

const CASES: LiveCase[] = [
  {
    id: "live-running",
    state: "Live Update while a turn runs: promoted, a counting chip",
    async run(run) {
      const supported = await prepare(run, true);
      const marker = await startTurn(run);
      if (!supported) return unchanged(run, "a running turn");
      const shown = await untilOngoing(
        run,
        "a promoted Live Update with a chronometer and the elapsed minutes",
        (n) => promoted(n) && n.chronometer && n.chip === "<1 min" && n.text.startsWith("Running"),
        6000,
      );
      if (run.lab.turn(marker).asked > 0)
        throw new Error("the turn already asked; running was not seen alone");
      return `${describe(shown)}${await chipShown(run, "running", "<1 min")}`;
    },
  },
  {
    id: "live-waiting",
    state: "Live Update while a turn waits for approval: chip Approve",
    async run(run) {
      const supported = await prepare(run, true);
      const marker = await startTurn(run);
      await run.until(
        "dsh to ask for approval",
        async () => run.lab.turn(marker).asked > 0,
        30_000,
      );
      if (!supported) return unchanged(run, "a pending approval");
      const shown = await untilOngoing(
        run,
        "the Live Update waiting",
        (n) =>
          promoted(n) && n.chip === "Approve" && n.text.startsWith("Waiting for your approval"),
        10_000,
      );
      return `${describe(shown)}${await chipShown(run, "waiting", "Approve")}`;
    },
  },
  {
    id: "live-finished",
    state: "Live Update when the turn ends: chip Done, then cleared",
    async run(run) {
      const supported = await prepare(run, true);
      const marker = await startTurn(run);
      await run.until(
        "dsh to ask for approval",
        async () => run.lab.turn(marker).asked > 0,
        30_000,
      );
      // Allow it on the page (hidden, still running): the turn goes on and ends.
      await run.until(
        "an Allow button on the approval card",
        () =>
          run.evaluate<boolean>(
            `(() => { const b = [...document.querySelectorAll("[data-approval-key] button")].find((e) => /^(Allow|Approve)/.test(e.textContent.trim())); if (!b) return false; b.click(); return true; })()`,
          ),
        10_000,
      );
      await run.until("dsh to end the turn", async () => run.lab.turn(marker).ended, 30_000);
      if (!supported) return unchanged(run, "a finished turn");
      const done = await untilOngoing(
        run,
        "the Live Update finished",
        (n) => promoted(n) && n.chip === "Done" && n.text.startsWith("Finished"),
        10_000,
      );
      const detail = `${describe(done)}${await chipShown(run, "finished", "Done")}`;
      const at = Date.now();
      const cleared = await untilOngoing(
        run,
        "the Live Update cleared",
        (n) => n.channel === "service" && !isPromoted(n),
        25_000,
      );
      return `${detail}; cleared after ${((Date.now() - at) / 1000).toFixed(0)} s: ${describe(cleared)}`;
    },
  },
  {
    id: "live-off",
    state: "Live updates switched off: a running turn is not promoted",
    async run(run) {
      const supported = await prepare(run, false);
      try {
        const marker = await startTurn(run);
        if (!supported) return unchanged(run, "a running turn");
        // Running for 8 s: well past the first render (throttled at 600 ms).
        await sleep(4000);
        const [shown] = await ongoing(run).then((all) =>
          all.filter((n) => n.flags.includes("FOREGROUND_SERVICE")),
        );
        if (run.lab.turn(marker).asked > 0 || run.lab.turn(marker).ended !== undefined) {
          throw new Error("the turn no longer runs alone");
        }
        if (shown === undefined || promoted(shown) || shown.channel !== "service") {
          throw new Error(
            `switched off, but: ${shown === undefined ? "no service notification" : describe(shown)}`,
          );
        }
        return `switched off: ${describe(shown)}`;
      } finally {
        if (supported) await prepare(run, true);
      }
    },
  },
];

/**
 * Each case ends on the app's machine list, as a case whose Back leaves the
 * page does: coming back from the launcher straight onto the page is a state
 * the next case's set-up does not expect.
 */
export const LIVE_CASES: LiveCase[] = CASES.map(({ id, state, run: body }) => ({
  id,
  state,
  async run(run) {
    try {
      return await body(run);
    } finally {
      await home(run);
    }
  },
}));
