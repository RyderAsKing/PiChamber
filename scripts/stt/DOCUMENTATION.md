# STT benchmarks

`benchmark.mjs` measures cold model load separately from warm inference and finalization. It runs every supported local model against 5, 30, 90, and 300 second fixtures.

Prepare one raw mono PCM16LE file at 16 kHz for each duration, named `5.pcm`, `30.pcm`, `90.pcm`, and `300.pcm`. Use the same recorded speech fixtures for every model and benchmark revision.

```sh
bun run benchmark:stt -- --fixtures /path/to/fixtures --models ~/.config/pichamber/speech-models --runs 5 --output artifacts/stt-benchmark.json
```

The report contains every run plus warm median, p95, real-time factor, worker startup and IPC overhead, model load, and worker RSS after inference. RSS is sampled after each synchronous native decode. It is not a high-water mark inside ONNX Runtime, so use an operating-system process monitor when an exact native peak is required.

Do not compare runs from different machines, power modes, thermal states, fixture audio, model archives, or PiChamber builds. Keep the first run as cold and the remaining runs warm. A warm real-time factor below 0.2 is the initial target.
