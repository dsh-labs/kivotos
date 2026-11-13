// The lab side of the phone e2e: dsh with the mock model, started through
// scripts/dev.mjs (a relay and two dsh instances, each with its own DSH_HOME).
import { spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { exec } from "./device.ts";
import {
  decodeFrames,
  mockPatch,
  parseLabBanner,
  sessionEvents,
  turnFacts,
  type LabBanner,
  type TurnFacts,
} from "./lib.ts";

/** The dsh release the lab runs, and the one Kivotos's dsh adapter targets. */
export const DSH_VERSION = "0.2.2-rc.2";

const here = path.dirname(new URL(import.meta.url).pathname);
/** The repository root. */
export const REPO = path.resolve(here, "..", "..", "..");

/** @returns a string field of the package.json in `dir`, or undefined. */
function packageField(dir: string, field: "name" | "version"): string | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof manifest !== "object" || manifest === null || !(field in manifest)) return undefined;
  const value: unknown = Reflect.get(manifest, field);
  return typeof value === "string" ? value : undefined;
}

/**
 * @returns the dsh to run: `given` when set, else @deepseek-ai/dsh@DSH_VERSION,
 * installed once into the e2e's cache directory.
 */
export async function resolveDsh(given: string | undefined): Promise<string> {
  if (given !== undefined) return path.resolve(given);
  const cache = path.join(
    process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"),
    "kivotos-e2e",
    `dsh-${DSH_VERSION}`,
  );
  const bin = path.join(cache, "node_modules", ".bin", "dsh");
  const version = packageField(path.join(cache, "node_modules", "@deepseek-ai", "dsh"), "version");
  if (version !== DSH_VERSION || !existsSync(bin)) {
    console.log(`e2e: installing @deepseek-ai/dsh@${DSH_VERSION} into ${cache}`);
    mkdirSync(cache, { recursive: true });
    writeFileSync(
      path.join(cache, "package.json"),
      JSON.stringify({ name: "kivotos-e2e-dsh", private: true }),
    );
    await exec(
      "npm",
      ["install", "--prefix", cache, "--no-audit", "--no-fund", `@deepseek-ai/dsh@${DSH_VERSION}`],
      15 * 60_000,
    );
  }
  return bin;
}

/**
 * The mock model must import @deepseek-ai/dsh-llm from the dsh install that
 * loads it. This finds that install from the dsh executable (its real path is
 * inside @deepseek-ai/dsh) and returns its dsh-llm package directory.
 */
export function dshLlmOf(dsh: string): string {
  let dir = path.dirname(realpathSync(dsh));
  while (packageField(dir, "name") !== "@deepseek-ai/dsh") {
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `${dsh} is not inside an npm install of @deepseek-ai/dsh; pass its lib/bin.js or node_modules/.bin/dsh`,
      );
    }
    dir = parent;
  }
  for (let at = dir; ; at = path.dirname(at)) {
    const candidate = path.join(at, "node_modules", "@deepseek-ai", "dsh-llm");
    if (existsSync(path.join(candidate, "package.json"))) return realpathSync(candidate);
    if (path.dirname(at) === at) break;
  }
  throw new Error(`no @deepseek-ai/dsh-llm next to ${dir}`);
}

/**
 * Puts a copy of mock-llm.mjs into `dir` with dsh's own dsh-llm linked
 * beside it, and writes the patch layer that loads it and points dsh's
 * Documents directory at `dir`/documents.
 * @returns the patch file.
 */
export function prepareMock(dir: string, dsh: string): string {
  const scope = path.join(dir, "node_modules", "@deepseek-ai");
  mkdirSync(scope, { recursive: true });
  symlinkSync(dshLlmOf(dsh), path.join(scope, "dsh-llm"), "dir");
  const mock = path.join(dir, "mock-llm.mjs");
  copyFileSync(path.join(here, "mock-llm.mjs"), mock);
  const documents = path.join(dir, "documents");
  mkdirSync(documents, { recursive: true });
  const patch = path.join(dir, "mock.patch.yml");
  writeFileSync(patch, mockPatch(mock, documents));
  return patch;
}

/** @returns a TCP port free on this host right now. */
export async function freePort(): Promise<number> {
  const server = createServer();
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address();
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
  if (address === null || typeof address === "string") throw new Error("no free port");
  return address.port;
}

export interface LabOptions {
  dir: string;
  dsh: string;
  patch: string;
  relayHost: string;
  plugin?: string;
  timeoutMs: number;
}

/** A running lab: dev.mjs and what it printed. */
export class Lab {
  readonly dir: string;
  readonly banner: LabBanner;
  private readonly child: ChildProcess;
  private exited: Promise<void>;

  private constructor(dir: string, banner: LabBanner, child: ChildProcess, exited: Promise<void>) {
    this.dir = dir;
    this.banner = banner;
    this.child = child;
    this.exited = exited;
  }

  /** Starts dev.mjs and waits until it prints that the lab is up. */
  static async start(options: LabOptions): Promise<Lab> {
    const [relayPort, webA, webB] = [await freePort(), await freePort(), await freePort()];
    const log = path.join(options.dir, "dev.log");
    const args = [
      path.join(REPO, "scripts", "dev.mjs"),
      "--lab-dir",
      path.join(options.dir, "lab"),
      "--relay-host",
      options.relayHost,
      "--relay-port",
      String(relayPort),
      "--web-a-port",
      String(webA),
      "--web-b-port",
      String(webB),
      "--dsh",
      options.dsh,
      "--patch",
      options.patch,
    ];
    if (options.plugin !== undefined) args.push("--plugin", options.plugin);
    const out = openSync(log, "w");
    const child = spawn(process.execPath, args, { stdio: ["ignore", out, out] });
    const status: { exit?: string } = {};
    const ended = Promise.withResolvers<void>();
    const exited = ended.promise;
    child.once("exit", (code, signal) => {
      status.exit = `exited with ${signal ?? code}`;
      ended.resolve();
    });
    child.once("error", (error) => {
      status.exit = error.message;
      ended.resolve();
    });
    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline && status.exit === undefined) {
      const banner = parseLabBanner(readFileSync(log, "utf8"));
      if (banner !== undefined) {
        if (banner.online < 2)
          console.log(`e2e: warning: ${banner.online} of 2 lab members online`);
        return new Lab(options.dir, banner, child, exited);
      }
      await sleep(250);
    }
    const tail = readFileSync(log, "utf8").trim().split("\n").slice(-5).join("\n");
    child.kill("SIGTERM");
    await Promise.race([exited, sleep(15_000)]);
    throw new Error(
      `the lab did not come up (${status.exit ?? `no banner in ${options.timeoutMs / 1000} s`}):\n${tail}`,
    );
  }

  /** The two dsh homes: where the session logs are. */
  get homes(): string[] {
    return ["home-a", "home-b"].map((home) => path.join(this.dir, "lab", home));
  }

  /**
   * @returns what the dsh side logged for the turn of the prompt holding
   * `marker`, in whichever home and session it is.
   */
  turn(marker: string): TurnFacts {
    for (const home of this.homes) {
      const root = path.join(home, "sessions");
      if (!existsSync(root)) continue;
      for (const workspace of readdirSync(root)) {
        for (const session of readdirSync(path.join(root, workspace))) {
          const file = path.join(root, workspace, session, "session.v4.jsonl.zstd");
          if (!existsSync(file)) continue;
          const facts = turnFacts(sessionEvents(decodeFrames(readFileSync(file))), marker);
          if (facts.found) return facts;
        }
      }
    }
    return { found: false, started: false, asked: 0, decided: [] };
  }

  /** Stops dev.mjs, which stops the relay and both dsh and removes its directory. */
  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    const stopped = await Promise.race([this.exited.then(() => true), sleep(30_000, false)]);
    if (!stopped) {
      this.child.kill("SIGKILL");
      await this.exited;
    }
  }
}
