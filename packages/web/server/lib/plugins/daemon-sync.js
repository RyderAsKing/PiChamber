// Pushes the plugin config to every daemon process the server talks to.
//
// A daemon process is identified by its `streamEpoch`, a random id it picks at
// start and reports in every health probe. The supervisor probes health before
// each request and hands the result to `onDaemonReady`, so a push happens:
// - before the first request to a daemon process this server has not
//   configured (a new daemon, a restarted one, or one reused from an earlier
//   server run),
// - after every change (`changed()` bumps the revision and probes), and
// - again on a later request when a push failed (at most every `retryDelayMs`).
// A failed push only logs. The request it precedes still runs; a daemon that
// was never configured runs with every plugin off.
//
// A sandboxed project's daemon gets its own hook from `onDaemonReadyFor`,
// whose scope (`{ roots }`) reaches `buildConfig`, so the config it receives
// can leave out other projects.

const MAX_TRACKED_DAEMONS = 32;

export const createPluginDaemonSync = ({
  buildConfig,
  refresh = async () => {},
  logger = console,
  retryDelayMs = 2_000,
  now = Date.now,
}) => {
  let revision = 0;
  const configured = new Map();
  const inflight = new Map();
  let chain = Promise.resolve();
  let lastFailure = null;

  const remember = (epoch, pushedRevision) => {
    configured.delete(epoch);
    configured.set(epoch, pushedRevision);
    while (configured.size > MAX_TRACKED_DAEMONS) configured.delete(configured.keys().next().value);
  };

  const push = (epoch, target, request, scope) => {
    const key = `${epoch}:${target}`;
    const existing = inflight.get(key);
    if (existing) return existing;
    // Serialized so an older config can never land after a newer one. Each
    // push builds the config when it runs, so it carries the latest state.
    const task = chain.then(async () => {
      if (configured.get(epoch) === revision) return;
      const pushing = revision;
      try {
        await request('plugins.configure', await buildConfig(scope));
        remember(epoch, pushing);
        lastFailure = null;
      } catch (error) {
        lastFailure = { epoch, revision: pushing, at: now() };
        logger.warn?.(`[plugins] could not configure the session daemon: ${error?.code ?? error?.message ?? 'unknown error'}`);
      }
    }).finally(() => inflight.delete(key));
    chain = task;
    inflight.set(key, task);
    return task;
  };

  /**
   * Supervisor hook for a daemon whose config is built with `scope`: runs
   * after every successful health probe. Never throws.
   */
  const onDaemonReadyFor = (scope) => async ({ health, request }) => {
    const epoch = health?.streamEpoch;
    if (typeof epoch !== 'string' || epoch.length === 0 || typeof request !== 'function') return;
    if (configured.get(epoch) === revision) return;
    if (lastFailure && lastFailure.epoch === epoch && lastFailure.revision === revision
      && now() - lastFailure.at < retryDelayMs) return;
    await push(epoch, revision, request, scope);
  };

  /** The main daemon's hook: its config covers every project. */
  const onDaemonReady = onDaemonReadyFor(undefined);

  /** Call after a committed change; pushes in the background. */
  const changed = () => {
    revision += 1;
    lastFailure = null;
    void Promise.resolve().then(refresh).catch((error) => {
      logger.warn?.(`[plugins] could not reach the session daemon: ${error?.code ?? error?.message ?? 'unknown error'}`);
    });
  };

  return { onDaemonReady, onDaemonReadyFor, changed };
};
