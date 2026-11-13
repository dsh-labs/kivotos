# Contributing to Kivotos

Kivotos is a plugin for DeepSeek Harness (dsh), plus an Android app and a relay server. This file is how to build and test each of them, and how a change gets merged. Architecture and conventions live in [CLAUDE.md](CLAUDE.md); read the part of it that covers what you are about to change.

## Prerequisites

| Tool                               | Version                                                                                  | Needed for                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [Node](https://nodejs.org)         | `^22.19.0 \|\| >=24`                                                                     | the plugin, the app, the build and test tooling           |
| [Go](https://go.dev/dl/)           | `1.25` or newer                                                                          | the relay                                                 |
| JDK                                | 17 (Temurin tested)                                                                      | the Android APK                                           |
| Android SDK                        | `platforms;android-36`, `build-tools;36.0.0` (React Native 0.86 compiles against SDK 36) | the Android APK                                           |
| [dsh](https://deepseek.com)        | `0.2.2-rc.2`                                                                             | running the plugin (`npm install` alone does not need it) |
| [pnpm](https://pnpm.io)            | 11                                                                                       | `dsh plugin add`, which the lab and the dsh check run     |
| [Tailscale](https://tailscale.com) | any                                                                                      | only if you want to exercise federation over a tailnet    |

`npm install` runs the plugin's `prepare` script, which builds `dist/` — no separate build step is needed before the first test run.

## Build and test

From the repository root:

```sh
npm install            # installs tooling, sets up the git hooks, builds packages/kivotos/dist
npm run build          # rebuild dist/ after changing packages/kivotos/src
npm run typecheck      # tsc for packages/kivotos and packages/mobile
npm run lint           # oxlint
npm run check:dsh      # dsh internals only inside packages/kivotos/src/dsh/
npm run format         # oxfmt, in place; `npm run format:check` only reports
npm test               # node --test on packages/kivotos/test/*.test.ts and packages/mobile/test/*.test.ts
```

`npm test` runs the plugin's and the app's regression tests directly on the TypeScript sources (Node type stripping): the admission fences, index rewrites, the federation derivation, relay sessions, the phone's machine list, the mount cache, the trace log, the proxy helpers, and the app's page and switch logic (`packages/mobile/src/views.ts`).

Kivotos relies on some dsh internals that are not plugin API (the phone stylesheet's class names, the index markup it rewrites, a localStorage key). All of them live in `packages/kivotos/src/dsh/`, each probed where it is used; code anywhere else must call that adapter and never write a dsh selector, page global or storage key itself — `npm run check:dsh` fails if it does. When dsh is upgraded, run `node scripts/dsh-compat.mjs --tag <dist-tag>` and fix what it reports inside `src/dsh/`. [CLAUDE.md](CLAUDE.md#the-dsh-adapter-packageskivotossrcdsh) has the details.

The relay is its own Go module and its own test run:

```sh
cd packages/relay
gofmt -l .             # must print nothing
go vet ./...
go test -race ./...    # includes end-to-end tests against a real relay on loopback
go build -o kivotos-relay .
```

The Android APK needs the JDK and the Android SDK:

```sh
export JAVA_HOME=/path/to/jdk-17
export ANDROID_HOME=/path/to/Android/sdk
npm run apk -w packages/mobile
# packages/mobile/android/app/build/outputs/apk/release/app-release.apk
```

`expo prebuild` regenerates `packages/mobile/android/` on every run, and that directory is gitignored: change native behavior in `packages/mobile/modules/` or in `app.json`, never in the generated project.

## Run a lab in one command

`npm run dev` (`scripts/dev.mjs`) starts a relay built from `packages/relay` and two dsh instances, each with its own `DSH_HOME`, both already members of the same relay network. It prints each instance's UI URL and the invite link, and removes everything it created when you stop it with Ctrl-C. A start that fails (a port in use, say) says why and keeps the directory, so the log it names is there to read.

```sh
npm run dev                                      # relay on 7411, dsh on 7412 and 7413
npm run dev -- --lab-dir /tmp/kivotos-lab --relay-port 8411 --web-a-port 8412 --web-b-port 8413
npm run dev -- --keep                            # keep the files for inspection
npm run dev -- --help
```

It needs `dsh` on `PATH` (`--dsh <path>` or `$DSH_BIN` override it), Go and pnpm. If the lab is up but a process dies, it stops the rest and keeps the directory too. It never touches `~/.dsh` or an installed dsh: everything it writes is under `--lab-dir`, which defaults to `.lab/` in the repository root. Because it deletes that directory, it refuses one that already holds files it did not make. `--plugin <dir>` installs another built plugin package (another checkout's `packages/kivotos`), `--relay-host` sets the address the relay listens on and the invite names, and `--patch <file>` appends a cordis patch layer to the instances' own.

The two instances run relay-only (`listen: false`, `discover: false`), so the lab needs no Tailscale and never mounts the machines of your own tailnet. To exercise the tailnet listener, the phone layout, or an Android device against a lab, use the two-instance lab in [CLAUDE.md](CLAUDE.md#two-instance-lab) instead — it sets `allowSelf` and `staticPeers` and runs the listener on the tailnet address.

## Phone e2e (hardware Back)

`npm run e2e:phone` (`packages/mobile/e2e/phone-back.ts`) checks what the hardware Back does on a machine's page, on an emulator or a device. It starts its own lab through `scripts/dev.mjs` in a temp directory, with a keyless mock model as dsh's default (`packages/mobile/e2e/mock-llm.mjs`: a prompt with `slow` streams for five minutes, any other prompt asks for an approval). It installs the APK, clears the app's data and joins the app to the lab's network by typing the invite. Then, for each state (menus, the drawer, Settings, a modal, the switcher, the model select, the `/` popup, nothing open, a double press, a pending approval, a running reply, an Escape no layer takes, the Preview Notice), it sets the state up over the WebView's DevTools protocol, presses Back with `adb shell input keyevent`, and asserts the result over DevTools and, for a prompt, in dsh's session log. It prints a pass/fail table and exits non-zero on any failure. Whatever happens, it stops the lab, removes its temp directory, the adb forward and reverse, and clears the app's data.

It needs an inspection build of the app. A plain build's WebView cannot be inspected; `EXPO_PUBLIC_KIVOTOS_WEBVIEW_DEBUG=1` at build time turns `webviewDebuggingEnabled` on (Expo inlines the variable into the bundle, so only that build has it):

```sh
cd packages/mobile
npx expo prebuild --platform android --no-install
cd android && EXPO_PUBLIC_KIVOTOS_WEBVIEW_DEBUG=1 ./gradlew assembleRelease
cd ../../.. && npm run e2e:phone -- --apk packages/mobile/android/app/build/outputs/apk/release/app-release.apk
npm run e2e:phone -- --apk app.apk --avd kivotos-lab           # use or boot this AVD
npm run e2e:phone -- --apk app.apk --serial emulator-5554      # one of several devices
npm run e2e:phone -- --apk app.apk --plugin ../other/packages/kivotos --only drawer,approval
npm run e2e:phone -- --help
```

It needs Go and pnpm (for the lab), adb (`$ANDROID_HOME/platform-tools`, else `PATH`) and, the first time, network access: without `--dsh` (or `$DSH_BIN`) it installs `@deepseek-ai/dsh@0.2.2-rc.2` into `~/.cache/kivotos-e2e`. A `--dsh` must sit inside an npm install of `@deepseek-ai/dsh` (its `node_modules/.bin/dsh`), because the mock model imports that install's `@deepseek-ai/dsh-llm`. The relay listens on `127.0.0.1` and reaches the device through `adb reverse`, so no LAN address is needed. States run in order and depend on it: the Preview Notice needs a machine's first load, and the header and row menus need the Session the approval state creates. Every wait has a bound; on a slow host, `--timeout-scale 2` doubles them. The `Phone e2e` workflow runs it in CI on an x86_64 API 35 emulator: nightly, by hand, and on pull requests that change `packages/mobile/`, the plugin's `client.tsx` or `src/dsh/frame.ts`, `scripts/dev.mjs` or the workflow.

On an Apple silicon Mac under memory pressure, an emulator with host GPU rendering can freeze or be killed by its own hang detector during the run; start it with `-gpu swiftshader_indirect -crash-report-mode disabled` (CI uses software rendering too).

A last state opens Settings five times across its sections and requires that no Kivotos compat notice (`.kivotos-compat`, "Part of dsh changed…") and no `slot entry crashed` showed up, in the page or in its console. `packages/mobile/metro.config.js` makes the flag part of Metro's cache key: Metro caches transforms by file contents, not by the environment, so without it a plain build after an inspection build would reuse the inlined `true`. On an emulator image built `userdebug` (the google_apis images), every WebView is inspectable whatever the flag; only a `user` build (a phone) tells the two apart.

The four `live-*` states check the app's Live Update (`packages/mobile/e2e/live.ts`). Each starts a turn in a new Session with a prompt holding `liveupdate` (the mock streams for eight seconds, then asks for approval), sends the app to the launcher and reads the app's ongoing notification from `adb shell dumpsys notification --noredact`: `live-running` wants it on the `live` channel with the `PROMOTED_ONGOING` flag (`Notification.FLAG_PROMOTED_ONGOING`), `android.showChronometer` and the chip (`android.shortCriticalText`) "<1 min", `live-waiting` the chip "Approve", `live-finished` (the approval allowed on the page) "Done" and, within 25 s, the quiet service notification again, and `live-off` (the Live updates switch off) no promotion. For each chip they also require SystemUI to draw it, with the app in the background: a `com.android.systemui` node of the window dump showing the text, else a chip line of `dumpsys activity service com.android.systemui` naming it. With `--shots DIR` they save the screen (the status-bar chip) and the opened shade as `DIR/<state>-chip.png` and `-shade.png`, and SystemUI's chip lines as `<state>-systemui.txt` when the chip was not found. On an Android without Live Updates (before 16 QPR1), the same states pass only when nothing changed: the Live updates switch disabled with "Needs Android 16 or later" under it (scrolled into view on a short screen), the service notification as before, nothing promoted, no `live` channel. Promotion needs an Android 16 QPR1 image (`system-images;android-36.1;google_apis;arm64-v8a`, or `x86_64` on Linux); the app runs in English there, so the chip texts are the English ones:

```sh
sdkmanager "system-images;android-36.1;google_apis;arm64-v8a"
avdmanager create avd -n kivotos-live -k "system-images;android-36.1;google_apis;arm64-v8a" -d pixel_6
npm run e2e:phone -- --apk app.apk --avd kivotos-live --only live-running,live-waiting,live-finished,live-off --shots shots --expect-live
```

`--expect-live` makes those states fail when the device has no Live Updates, instead of passing because nothing changed; the API 36.1 CI job passes it. Locally on macOS 27 the 36.1 arm64 image does not boot: the emulator (37.2.13) logs "hvf is not enabled on this aarch64 host", falls back to TCG and never finishes booting ([Google issue 567993833](https://issuetracker.google.com/issues/567993833)), while the API 35 image on the same host runs with HVF. Until that is fixed, the promoted states run on CI only (x86_64 with KVM); locally, run the full set on API 35, where the Live Update states check that nothing changed.

## Relay (`packages/relay/`)

The relay is deliberately split into domain packages — `wire`, `registry`, `admission`, `tunnel`, `admin`, `config`, `cmd` — instead of the single flat root package the Go skill recommends by default. Dependencies point one way: `wire` is imported by all; `registry`, `admission` and `tunnel` never import each other (they meet through interfaces declared by the consumer); `admin` sits on `registry` and `tunnel`; `cmd` assembles everything. Put a change in the package that owns the thing it changes, and keep that shape.

Federation, the wire protocol and the relay's security invariants are documented in [CLAUDE.md](CLAUDE.md#relay-packagesrelay); anything touching the protocol must stay in step with `packages/kivotos/src/federation.ts` and the app's `Network.kt`.

## Commits

- Write commit messages in English, imperative mood, one line (`Add the relay's member roster`). Add a body when the reason is not obvious from the diff.
- The lefthook pre-commit hook runs the formatter check, the linter, the dsh boundary check and the typecheck on what you staged, and it runs by itself after `npm install`. Fix what it reports and re-stage; never commit with `--no-verify` or similar.
- Format the files you touched before committing: `npx oxfmt <files>` (or `npm run format`).
- Add a line under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md) for anything a user can notice.
- Update [CLAUDE.md](CLAUDE.md) when you change the area it describes — architecture, conventions, invariants, or the lab.

## Pull requests

Open the PR against `main`, in English, and say what the change does and how you verified it. Reference the issue it closes.

A PR runs these CI jobs; all of them must pass:

| Job                                     | What it checks                                                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `check (node 22)`, `check (node 24)`    | format, lint, typecheck, the dsh boundary, the built `dist/`, `npm test`                                                     |
| `relay (go)`                            | `gofmt -l`, `go vet`, `go test -race`, a build, the container image starting, and the compose file                           |
| `relay image`                           | the relay image builds for amd64 and arm64 (pushed only on `main` and tags)                                                  |
| `android apk`                           | `expo prebuild` and `gradlew assembleRelease`; uploads the APK as an artifact                                                |
| `dsh compatibility` (nightly)           | boots the npm `latest`/`next` dsh with the plugin and checks every coupling point (`scripts/dsh-compat.mjs`)                 |
| `phone e2e (API 35)` (nightly, paths)   | builds the inspection APK and runs `npm run e2e:phone` on an emulator (see [Phone e2e](#phone-e2e-hardware-back))            |
| `phone e2e (API 36.1)` (nightly, paths) | the same on Android 16 QPR1, the Live Update states only, where the notification must be promoted; uploads their screenshots |

Pushes to `main` and `v*` tags additionally publish the image, and a tag also publishes the npm package and the GitHub Release (`publish npm package`, `publish GitHub Release`). Do not tag or release from a PR.

Report security problems privately through [SECURITY.md](SECURITY.md), never in an issue or a PR.
