// The single registration point for extra session engines. Each entry is an
// engine factory `(host) => engine | Promise<engine>` (see
// `../session-engines.js` for the engine contract). PiChamber main ships no
// engines, so the daemon behaves exactly as Pi-only until a factory is
// registered here.
export const sessionEngineFactories = [];
