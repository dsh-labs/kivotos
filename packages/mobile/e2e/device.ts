// The device side of the phone e2e: adb, the emulator, uiautomator.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { centerOf, inputTextArgument, parseUiNodes, type UiNode } from "./lib.ts";

/** The default time one adb command may take. */
const ADB_MS = 30_000;

function sdkTool(...parts: string[]): string | undefined {
  for (const root of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (root !== undefined && existsSync(path.join(root, ...parts)))
      return path.join(root, ...parts);
  }
  return undefined;
}

/** adb from the Android SDK ($ANDROID_HOME), else from PATH. */
export const ADB = sdkTool("platform-tools", "adb") ?? "adb";

/** Runs a command; a failure or a timeout is an error naming it. */
export function exec(command: string, args: string[], timeoutMs = ADB_MS): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(
    command,
    args,
    { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error === null) {
        resolve(stdout);
        return;
      }
      const what = `${path.basename(command)} ${args.join(" ")}`.slice(0, 200);
      const why = error.killed ? `timed out after ${timeoutMs} ms` : stderr.trim() || error.message;
      reject(new Error(`${what}: ${why}`, { cause: error }));
    },
  );
  return promise;
}

/** @returns the serials adb lists as attached devices. */
export async function attachedSerials(): Promise<string[]> {
  const out = await exec(ADB, ["devices"]);
  return out
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial !== undefined && state === "device")
    .map(([serial]) => serial);
}

/** One device or emulator, by its adb serial. */
export class Device {
  readonly serial: string;

  constructor(serial: string) {
    this.serial = serial;
  }

  adb(args: string[], timeoutMs = ADB_MS): Promise<string> {
    return exec(ADB, ["-s", this.serial, ...args], timeoutMs);
  }

  shell(command: string, timeoutMs = ADB_MS): Promise<string> {
    return this.adb(["shell", command], timeoutMs);
  }

  async tap([x, y]: [number, number]): Promise<void> {
    await this.shell(`input tap ${x} ${y}`);
  }

  /** Presses Back once, or twice in one `input` command (as fast as the device takes them). */
  async back(times: 1 | 2 = 1): Promise<void> {
    await this.shell(
      `input keyevent ${Array.from({ length: times }, () => "KEYCODE_BACK").join(" ")}`,
    );
  }

  async type(text: string): Promise<void> {
    await this.shell(`input text ${inputTextArgument(text)}`);
  }

  /** @returns the window that has the focus, as `dumpsys window` names it. */
  async focusedWindow(): Promise<string> {
    const out = await this.shell("dumpsys window windows");
    return /mCurrentFocus=Window\{\S+ \S+ ([^}]+)\}/.exec(out)?.[1] ?? "";
  }

  /** @returns the screen's nodes; a dump that fails or times out is retried. */
  async ui(attempts = 4): Promise<UiNode[]> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const out = await this.adb(["exec-out", "uiautomator", "dump", "/dev/tty"], 45_000);
        const end = out.lastIndexOf("</hierarchy>");
        const start = out.indexOf("<?xml");
        if (start >= 0 && end > start) return parseUiNodes(out.slice(start, end));
        last = new Error(`unexpected dump: ${out.slice(0, 120)}`);
      } catch (error) {
        last = error;
      }
      await sleep(1000 * (i + 1));
    }
    throw new Error(`uiautomator failed ${attempts} times: ${String(last)}`, { cause: last });
  }

  /**
   * Waits for a node `pick` chooses on the screen.
   * @throws when none appears within `timeoutMs`.
   */
  async waitForNode(
    what: string,
    pick: (nodes: UiNode[]) => UiNode | undefined,
    timeoutMs: number,
  ): Promise<UiNode> {
    const deadline = Date.now() + timeoutMs;
    let seen: UiNode[] = [];
    while (Date.now() < deadline) {
      seen = await this.ui();
      const node = pick(seen);
      if (node !== undefined) return node;
      await sleep(500);
    }
    const labels = seen
      .map((node) => node.text || node.desc)
      .filter((label) => label !== "")
      .slice(0, 20);
    throw new Error(`no ${what} on screen after ${timeoutMs} ms (saw: ${labels.join(" / ")})`);
  }

  async tapNode(node: UiNode): Promise<void> {
    await this.tap(centerOf(node));
  }

  async bootCompleted(): Promise<boolean> {
    try {
      return (await this.shell("getprop sys.boot_completed", 10_000)).trim() === "1";
    } catch {
      return false;
    }
  }

  /** @returns the AVD name of an emulator, or undefined for a device. */
  async avdName(): Promise<string | undefined> {
    if (!this.serial.startsWith("emulator-")) return undefined;
    try {
      return (await this.adb(["emu", "avd", "name"], 10_000)).split("\n")[0]?.trim();
    } catch {
      return undefined;
    }
  }
}

/** An emulator this run started, which it also stops. */
export interface Booted {
  device: Device;
  process: ChildProcess;
}

/**
 * Uses the running emulator of `avd`, else boots one and waits until Android
 * has booted.
 */
export async function emulatorFor(
  avd: string,
  headless: boolean,
  timeoutMs: number,
): Promise<{ device: Device; booted?: Booted }> {
  const before = await attachedSerials();
  for (const serial of before) {
    const device = new Device(serial);
    if ((await device.avdName()) === avd) return { device };
  }
  const emulator = sdkTool("emulator", "emulator") ?? "emulator";
  const args = ["-avd", avd, "-no-snapshot-save", "-no-boot-anim"];
  if (headless) args.push("-no-window", "-no-audio");
  console.log(`e2e: booting the emulator ${avd}`);
  const child = spawn(emulator, args, { stdio: "ignore", detached: false });
  const ended: { why?: string } = {};
  child.once("exit", (code) => {
    ended.why = `exited with ${code}`;
  });
  child.once("error", (error) => {
    ended.why = error.message;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && ended.why === undefined) {
    for (const serial of await attachedSerials()) {
      if (before.includes(serial)) continue;
      const device = new Device(serial);
      if ((await device.avdName()) === avd && (await device.bootCompleted())) {
        return { device, booted: { device, process: child } };
      }
    }
    await sleep(2000);
  }
  child.kill();
  throw new Error(
    ended.why === undefined
      ? `the emulator ${avd} did not boot in ${timeoutMs / 1000} s`
      : `the emulator ${avd} ${ended.why}`,
  );
}
