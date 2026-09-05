# Speech-to-text module

This module owns final-only composer dictation for web, Electron, hosted mobile, and Capacitor clients. Clients capture mono 16 kHz PCM16 and send binary frames over `/api/stt/ws`. The server buffers bounded segments, commits long recordings at silence or a 90 second hard limit, and returns one combined transcript after `Done`. It never emits incremental transcript text.

## Ownership

- `runtime.js` registers the HTTP and WebSocket routes before static fallback routes and shuts sockets, streams, and workers down with the server.
- `protocol.js` defines the version 1 control messages and binary frame header. A binary frame is a four-byte little-endian sequence followed by PCM16LE bytes.
- `stream-manager.js` owns ordering, reconnect attachment, five-minute limits, silence detection, segmentation, final ordering, cancellation, and cleanup. A disconnected recording remains for 30 seconds so the client can reconnect. The client also retains the bounded recording and replays from the server's contiguous acknowledgement.
- `service.js` resolves server-stored provider IDs, model state, downloads, and worker lifecycle.
- `providers/` adapts one complete committed PCM buffer to either the local worker or an OpenAI-compatible `/v1/audio/transcriptions` endpoint.
- `local/` owns the pinned model catalog, atomic downloader, native-addon loader, forked worker, bounded two-engine LRU, and one-at-a-time inference queue.

## Routes

- `GET /api/stt/status`
- `PUT /api/stt/config`
- `POST /api/stt/models/:modelId/download`
- `DELETE /api/stt/models/:modelId`
- `WS /api/stt/ws`

All routes use the existing `/api` authentication middleware. The WebSocket path is in both the URL-token and private-relay allowlists. Shared UI opens it through `openRuntimeWebSocket` with the token returned by that connection's URL-auth mint. A failed older connection cannot clear a newer shared token.

Remote URL and API-key values live in `<PiChamber data>/stt/config.json` with owner-only permissions where the platform supports them. Status responses redact API keys. WebSocket start frames carry only a stored provider configuration ID. They never accept a URL or credential.

Local models live under `<PiChamber data>/speech-models`. Downloads verify a pinned archive size and SHA-256 checksum, extract into a staging directory, hash required installed files into a manifest, and rename only after verification. Missing, changed-size, or checksum-invalid models are removed before retry. The main server process never imports `sherpa-onnx-node`; only `worker-process.js` does.

## Performance contract

- Show recording UI within 100 ms after microphone permission succeeds.
- Send 250 ms binary chunks, about 32 KB/s.
- Keep audio bounded to five minutes on client and server.
- Keep audio level events outside broad React state. The visualizer coalesces them with `requestAnimationFrame` and writes only `transform` and `opacity`.
- Send one IPC request per committed segment, not one per network chunk.
- Limit local inference to one operation at a time, cache at most two engines, and stop the worker after five idle minutes.
- Measure model load separately from warm transcription. Use `bun run benchmark:stt`; see `scripts/stt/DOCUMENTATION.md`.

Cancellation, socket failure, runtime switching, empty audio, model errors, and provider errors remove buffered audio and do not mutate the composer draft. Only a successful final transcript reaches the editor.
