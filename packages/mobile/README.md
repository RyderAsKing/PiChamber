# PiChamber Mobile

Capacitor shell for the dedicated PiChamber mobile web surface.

The mobile package reuses the web build, then rewrites `mobile.html` to `index.html` in `packages/mobile/dist` so native iOS/Android always launch `MobileApp` instead of the hosted surface selector.

## Runtime Model

- The native app bundles the mobile UI only; it connects to an existing PiChamber server and its Pi session daemon.
- On first launch in Capacitor, the app shows a connection screen for an existing PiChamber server.
- Connections are saved locally in the app and can be managed from `Instances` in the sessions sidebar header.
- The connection screen and the `Instances` entry are Capacitor-only. Hosted `mobile.html` in a normal browser keeps the regular web behavior.
- Phones and tablets share one navigation model: a sessions drawer/sidebar on the left, the workspace drawer (Changes / Files / Terminal / PRs / Issues) on the right, and no overflow menu. The PRs and Issues tabs render the shared Pull requests / Issues surfaces as a list → detail stack and appear only under the desktop rail's `github-repo` rule (hidden while scope loads, visible with >=1 GitHub repo or on scope failure; an active GitHub tab falls back to Changes when unavailable). v1 parity differences with desktop are intentional: mobile PR detail is Overview + Checks (the drawer passes `hideFilesTab`; Files/review on mobile is a follow-up), and there is no composer link picker on mobile. The phone sessions drawer covers about 72% of the width with a dark (not blurred) scrim on the rest; the workspace drawer covers about 80% from the right. Both use the same slide motion and sidebar surface color. Workspace destinations are header button selectors with always-visible labels. Add folder in the sessions sidebar opens the same directory explorer overlay as desktop. Choosing a project folder keeps the sessions drawer open while that folder's session loads, so another session can still be picked; tapping Settings closes the drawer. In Files, directory rows span the drawer and an Up one level row (plus the header back control) steps to the parent folder inside the project. The new-session control is a circular opaque FAB on the empty scrim of the sessions overlay, not inside the panel. The chat composer stays in its full stacked form with model and variant controls; it does not collapse into a pill. Tablets differ only in that the sessions list is a resizable persistent sidebar and the header dropdowns are anchored popovers.
- The tablet layout is a live size class (`useTabletLayout`), not a device check: any surface whose short side is at least 600px gets it, and the workspace only becomes a side panel where the width can host the sidebar, the panel and a readable chat at once. Book foldables therefore pick it up when unfolded, keep the portrait layout in both orientations (their long side is barely wider than a tablet's short one), and drop back to the phone layout when folded shut. The Android activity declares the matching `configChanges`, so folding resizes the WebView instead of recreating it.
- Password-protected PiChamber servers can be unlocked from the mobile app. The app stores the issued client token in native secure storage with an in-memory cache, distinguishing secure-storage read timeouts and failures from authoritatively missing credentials. Read timeouts and native read errors are temporary (the endpoint is retained and recovery retries). A saved row whose credential is authoritatively missing — or whose ciphertext can never decrypt (`invalidData`, AES-GCM tag mismatch) — enters the existing sign-in-again flow instead of retrying forever or silently dropping to the connect screen. Android backup and device transfer exclude the Keystore-encrypted token store (`res/xml/backup_rules.xml`, `res/xml/data_extraction_rules.xml`) because the Keystore key itself is never backed up; a restored install therefore re-pairs.
- Android registers the `pichamber://` URL scheme (matching iOS `CFBundleURLSchemes`); links arrive through `App` `appUrlOpen`, including cold launches, and route through the deep-link vocabulary. Pairing links (`pichamber://connect?…`) are not auto-applied from external opens; they are accepted when pasted or scanned on the connect screen.
- A temporarily unreachable saved server retains its endpoint, saved row, stale chats, drafts, and local session while the app retries in the foreground (including across cold launches with a persisted endpoint, where the boot splash holds until classification resolves rather than dropping the endpoint on a waking radio). Retries are paced and bounded (8 attempts: 1s, 2s, 4s, 8s, 15s, 30s, 30s, 30s); offline or hidden uses a 60s cap and wakes on online, visible, resume, or manual retry instead of probing a known-dead network. An exhausted cycle keeps polling slowly (60s) while foreground+online and restarts as a fresh bounded cycle on a genuine online/foreground/manual wake so a long outage wakes promptly; offline/hidden wakes never restart and duplicate wakes collapse into the single in-flight probe. Probes reuse the verified candidate failover (server identity, direct/relay preference) and close unused relay tunnels. A probe that times out or fails is never counted as healthy, for direct and relay alike; fast relay probes get their own 8s budget (fresh relay socket, E2EE handshake, and one tunneled round trip) instead of the 2.5s direct LAN budget. The transport core owns that single in-flight probe for every caller (recovery controller, resume/startup classification, and the background candidate-refresh follow-up): it captures the endpoint selection generation plus runtime identity before every secure read, network send, storage upsert, and transport switch, so a late probe after an explicit disconnect, host switch, or same-instance disconnect/reconnect flap commits nothing — no late upsert, no late switch, no old credential sent to the new host — and stale relay winners are closed instead of adopted. Auth-invalid enters the existing login/repair flow (never the retry loop); no saved candidate, explicit disconnect, and host switch leave recovery with nothing retained to retry. While recovering the composer blocks sends (drafts stay local, queued auto-send stays paused until a verified healthy probe) and the native EventSource resume path is left untouched.
- The Terminal workspace surface runs its PTY on the active PiChamber server over the shared authenticated runtime transport; it never opens a local shell on the phone or tablet. Closing the surface detaches the renderer while the server session remains available for reattachment. On touch devices, dragging scrolls the buffer while long-pressing and dragging selects terminal text.
- Composer dictation captures microphone audio in the WebView and streams binary PCM through the active authenticated runtime transport. Local speech models run on the connected PiChamber server, not on the phone. iOS and Android declare microphone usage and runtime permissions in their native projects.
- The native app has no background push: there is no push relay and no APNs/FCM device registration. Completion and error alerts surface in-app while the app is open; local notifications are not used.
- Sessions waiting on the user surface in-app only in this phase: a warning toast with an Open action, the needing-input badges/dots, and (on hosted mobile web with notifications enabled) the browser notification path. No push is sent for input-needed.
- Android hardware back button and back gestures use a persistent root listener installed once for the native app lifetime. Open surfaces, sheets, dialogs, manual connection forms, and overlays (such as the QR scanner) register into a LIFO handler stack via `useNativeAndroidBackButton`. Back presses close the topmost active UI layer first; if nothing in the stack consumes the event (or at root screens), it falls through to minimize the app.
- Native file saving and exports (session markdown, message images, table CSV/TSV, diagram SVG, and diagnostics) use the local `PiChamberFiles` plugin on Android to write files to the cache directory and open the Android system share chooser (`Intent.ACTION_SEND`) via `FileProvider`. On iOS, the Web Share API (`navigator.share`) with `File` objects is used. The `PiChamberFiles` plugin also provides `setWebViewBackground` to restore the theme background color after camera QR code scanning stops on Android.

## Commands

Run these from `packages/mobile`, or use the root `mobile:*` aliases.

- `bun run build`: builds `packages/web` and prepares mobile web assets.
- `bun run build:assets`: prepares mobile assets from an existing `packages/web/dist` build; the root workspace build uses this to avoid rebuilding web.
- `bun run sync`: prepares assets and runs `cap sync`.
- `bun run add:ios`: creates the native iOS project.
- `bun run add:android`: creates the native Android project.
- `bun run build:android:debug`: builds a debug Android APK without launching an emulator.
- `bun run build:ios:simulator`: builds an iOS Simulator app without launching Xcode or Simulator.
- `bun run sim:run`: boots a simulator if needed, installs the built iOS app, and launches it.
- `bun run sim:dev`: one-command dev loop — builds the simulator app, installs + launches it, starts the `serve-sim` stream, and prints the preview URL; Ctrl+C stops the stream. Pass `--no-build` to skip the build step.
- `bun run sim:serve`: starts `serve-sim` in detached JSON mode and prints the browser preview URL.
- `bun run sim:list`: lists running `serve-sim` streams.
- `bun run sim:kill`: stops running `serve-sim` streams.
- `bun run open:ios`: opens the iOS project.
- `bun run open:android`: opens the Android project.

## Headless Quickstart

```sh
bun run build
bun run sync
bun run build:ios:simulator
bun run build:android:debug
```

These commands build and sync the native projects without launching Xcode, Android Studio, Simulator, or an emulator.

## Local Tooling

The default scripts assume the local Homebrew/Xcode paths prepared for this workspace:

- Xcode: `/Applications/Xcode.app/Contents/Developer`
- JDK 21: `/opt/homebrew/opt/openjdk@21`
- Android SDK: `/opt/homebrew/share/android-commandlinetools`

Override `DEVELOPER_DIR`, `JAVA_HOME`, `ANDROID_HOME`, or `ANDROID_SDK_ROOT` when using a different local setup.

Required local tools:

- Xcode with iOS Simulator support.
- CocoaPods for iOS dependency installation.
- JDK 21 for Android Gradle builds.
- Android SDK command-line tools with platform/build-tools 35.

## Troubleshooting

- If `xcodebuild` reports that the active developer directory is Command Line Tools, keep using the provided scripts or set `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.
- If Android builds fail with `Unable to locate a Java Runtime` or `source release: 21`, install/use JDK 21 and set `JAVA_HOME` accordingly.
- If Android SDK packages are missing, install `platform-tools`, `platforms;android-35`, and `build-tools;35.0.0`, then accept SDK licenses.
- If CocoaPods cannot find Capacitor pods after reinstalling dependencies, run `bun install` from the workspace root, then rerun `bun run sync`.
- If chat sends or live output stalls only in the native app, verify the app build includes the direct-LAN `EventSource` transport for `/api/pi/events`; CapacitorHttp is intentionally used for ordinary API requests but buffers long-lived SSE responses. The server sends named SSE heartbeats that the native `EventSource` can observe; the client replaces a foreground stream that goes silent and resumes from its last accepted sequence. Native resume also replaces the `EventSource` because WKWebView may preserve a dead connection while the app is suspended without reporting an error. Temporary-unreachable recovery never disposes that stream; it only re-probes transports. From Instances, `Export diagnostics` shares a bounded, redacted client log (`pichamber-mobile-diagnostics-v1`). Diagnostics persist to `localStorage` under `pichamber.mobile.diagnostics.v1` (bounded to 300 entries, debounced with synchronous flush on `pagehide` / `visibilitychange` hidden) so logs survive process kills across cold launches. Redacted on record (tokens, passwords, URLs, and filesystem paths). Recorded lifecycle categories include `app-launch` (`start`), `app-lifecycle` (`resume`, `pause`, `visible`, `hidden`), `auto-connect` (`connected`, `unreachable`, `needs-login`, `no-candidate`), `recovery` (`start`, `attempt`, `success`, `exhausted`, `auth-expired`, `no-connection`, `cancel`), `reprobe` (`switched`, `unchanged`, `unreachable`, `needs-login`, `no-connection`), `pi-connection` (`loading`, `ready`, `unavailable`, `error`), `config-reconcile` (`attempt`, `success`, `failure`), `connect`, and `window-error` / `unhandled-rejection`.
- If `serve-sim` preview says the stream is not producing frames, check the raw MJPEG stream before assuming the simulator stopped. In prior testing the raw stream worked while the browser preview UI stayed stale.

## Generated Assets

Launcher, splash, and notification icons are generated from the PiChamber SVG mark with `bun run icons:brand` (same command that writes desktop/web brand PNGs). Do not restore Capacitor's default app or Android Studio placeholders.
