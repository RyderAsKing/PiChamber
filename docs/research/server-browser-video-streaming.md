# Server browser: video streaming instead of JPEG frames

Status: rejected (2026-11-07). The **Server** Browser route keeps JPEG
screencast frames and scroll mode (`packages/web/server/lib/server-browser/`).

## The question

Server Browser pages reach the device as `Page.startScreencast` JPEG frames.
Every frame is a whole picture of the panel, with no compression between
frames. Scrolling a wide panel at 2x (2232x1476) sends about 365 KB a frame,
about 16 frames a second, around 50 Mbit/s. Could a video stream over the same
WebSocket scroll more smoothly and use less of the network?

## What was tried

A standalone prototype, outside the app:

- Server Chrome started the way `chrome-launch.js` starts it: persistent
  profile, `--force-device-scale-factor=2`, `--disable-gpu`, the same ignored
  Playwright defaults. One page at 1116x738 CSS pixels.
- Encoder: WebCodecs `VideoEncoder` (`latencyMode: 'realtime'`) in a hidden
  helper page in its own browser context, so it is not a Browser tab and never
  touches the person's page. Screencast JPEGs went in through
  `Runtime.callFunctionOn` (the base64 Chrome already sends), then
  `createImageBitmap`, `VideoFrame`, `encode`. Chunks came back through a
  `Runtime.addBinding` binding as base64.
- Viewer: a second headless Chrome standing in for the device. It decoded
  with `VideoDecoder` (or `createImageBitmap` for JPEG, newest frame only, as
  `useServerBrowserFrames` does), drew on a canvas, and acked each frame.
- Workload: one wheel step after the page was still (input to paint), then 3
  seconds of 60 wheel events a second, merged the way `tab-input.js` merges
  them.
- Throttled links: a Node TCP proxy between viewer and server with a fixed
  rate and one-way delay. It throttles raw TCP, so WebSocket traffic is
  included. Measured 9.85 Mbit/s for a nominal 10 and 3.98 for a nominal 4.
- Sites: a Wikipedia article, a YouTube search results page (a fresh
  profile's YouTube home page has nothing to scroll), and a Plannotator code
  review page with its "What's new" dialog open.

## Results

Painted frames a second / Mbit/s / capture-to-paint median. "Half" is the
CSS-pixel size (1116x738); "full" is 2x (2232x1476). Scroll mode is the
existing half-size JPEG at quality 50.

| Site, link | JPEG full | Scroll mode | H.264 half | H.264 full |
|---|---|---|---|---|
| Wikipedia, LAN | 17 / 50 / 30 ms | 31-37 / 25-30 / 8 ms | 29-38 / 6-8 / 34-44 ms | 15-17 / 11 / 170 ms |
| Wikipedia, 10 Mbit/s 40 ms | 3.7 / 11 / 640 ms | 13.6 / 11 / 154 ms | 21-29 / 5-8 / 85-109 ms | 11 / 9 / 274 ms |
| Wikipedia, 4 Mbit/s 80 ms | 1.5 / 4 / 1.6 s | 5.3 / 4.6 / 373 ms | 12-15 / 3.5-4 / 200 ms | 6 / 4.4 / 530 ms |
| YouTube results, LAN | 16 / 28 / 16 ms | 22 / 12 / 6 ms | 19 / 2.1 / 19 ms | 16 / 5 / 79 ms |
| YouTube results, 10 Mbit/s | 5.2 / 11 / 374 ms | 14.6 / 7.9 / 105 ms | 18.7 / 2.3 / 48 ms | 13 / 3.2 / 150 ms |
| YouTube results, 4 Mbit/s | 2.3 / 5.4 / 760 ms | 9.1 / 4.2 / 224 ms | 22.5 / 3 / 77 ms | 10 / 3.7 / 285 ms |
| Plannotator, LAN | 8 / 11 / 14 ms | 9 / 3.3 / 5 ms | 8 / 0.5 / 13 ms | 8 / 1 / 37 ms |

Frame sizes: H.264 half 7-31 KB, scroll mode 43-107 KB, JPEG full 160-365 KB.
Encoding added 0.3-0.6 of a core in server Chrome. VP9 at half size had 240-330
ms of latency and was dropped early. Mid-scroll H.264 at 2 Mbit/s showed
visible ringing around text but stayed readable, about as good as scroll
mode's quality-50 JPEG.

## Conclusions

- Full-size video loses everywhere. Software H.264 at 2232x1476 competes with
  Chrome's own rendering on 3 cores, lowers the frame rate, and adds 170-700
  ms.
- At half size on the LAN, H.264 ties scroll mode on frame rate and costs
  25-35 ms more latency and up to half a core. Its only LAN gain is 4-6x
  less bandwidth.
- On 4-10 Mbit/s links H.264 at half size wins: 1.3-2.5x the frame rate and
  a third to half the latency.
- Plannotator renders at about 8 frames a second whatever the stream does
  (its effects are expensive without a GPU). Video saves only bandwidth there.

Not a clear win on the LAN for the CPU and complexity it adds, so it was not
built.

## Findings worth keeping

- WebCodecs needs a secure context. `about:blank` is not one and has no
  `VideoEncoder`. A `file://` page is, and works in a separate browser
  context. The network guard's browser-level `Fetch` still pauses that load;
  it passes because only http(s) addresses are judged, but only after the
  guard's one-second wait for an owner.
- Chrome's H.264 encoder accepts 2232x1476 at a high enough level
  (`avc1.640033`); `avc1.42001f` and `avc1.640028` are too low for that size.
  Per-frame quantizer mode (`bitrateMode: 'quantizer'`) works for VP9 and AV1,
  not H.264.
- Feeding a frame to the helper took 10-25 ms at half size (about half of it
  JPEG decoding) and 55-165 ms at full size.
- Backpressure: skipping a slow viewer to the next keyframe stalled slow
  links, because keyframes are the most expensive frames to send. Pacing the
  encoder's input by viewer acks, as the JPEG path paces frames, fixed it.
  Leaving out an input frame never breaks the chain of deltas.
- Realtime CBR overshoots on scrolling text: a 2 Mbit/s target at 30 frames
  a second produced 26-31 KB frames, about 8 Mbit/s at 38 frames a second.
- `getDisplayMedia` fails in this headless Chrome ("Could not start video
  source"), and WebRTC needs UDP or TURN, which HTTP-only tunnels do not carry.

## If this comes back

What would change the answer: a GPU, a faster server, or a focus on slow
links. The design that would win there:

- Video only while the page scrolls, at CSS-pixel size, in place of scroll
  mode's half-size JPEG. Still frames stay full-size JPEG, which also gives a
  sharp frame when motion stops.
- Chosen per viewer: a viewer that keeps up with scroll-mode JPEG stays on
  it; one whose frames wait on acks while scrolling switches to video after a
  keyframe. The LAN never gets worse, and the encoder runs only when a slow
  viewer needs it.
- Encoder input paced by acks; skip-to-keyframe only as a fallback for
  viewers slower than the others on a shared encoder.

Before that, try the cheaper step: shrink scroll mode's frames further for a
viewer whose frames wait on acks.

## Measurement caveats

- The test machine already ran 2 to 2.9 of its 3 cores busy with unrelated
  work, and the container refused `nice`. Frame rates are contention-bound
  and moved between runs; the Wikipedia LAN rows were run 2 or 3 times.
- The "device" ran on the same machine and decoded in software.
- Not measured: a real phone or Safari, the relay path, the in-app path, or
  input-to-paint precisely (single wheel steps were too noisy to compare).
