// Chrome sends a new screencast frame only after the previous one is acked.
// Acking no sooner than these caps the stream near 60 frames per second
// while someone is using the page and 30 otherwise, so a page that animates
// on its own does not keep the server busy at the full rate.
const ACTIVE_ACK_INTERVAL_MS = 16;
const IDLE_ACK_INTERVAL_MS = 33;
const ACTIVE_AFTER_INPUT_MS = 1_000;
// Frames a viewer may have unacknowledged before it only keeps the latest.
const VIEWER_MAX_INFLIGHT_FRAMES = 2;
const SCREENCAST_QUALITY = 70;

/**
 * Encodes a frame for viewers: a 4-byte big-endian header length, the JSON
 * header, then the JPEG bytes.
 */
const encodeFrame = (header, jpeg) => {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(headerBytes.length, 0);
  return Buffer.concat([prefix, headerBytes, jpeg]);
};

/**
 * The screencast of one page, shared by its viewers. Chrome encodes each
 * frame once; every viewer gets frames at the pace it acknowledges them, and
 * a viewer that falls behind gets only the newest.
 *
 * `send` is the page's CDP session; `bind` replaces it when the page does.
 * Viewers are `{ sendFrame(buffer) }`.
 */
export const createTabStream = ({ viewport }) => {
  let send = null;
  const viewers = new Set();
  let screencasting = false;
  // Starting fails while the page swaps renderer processes; it is retried
  // when the next navigation commits.
  let startFailed = false;
  let frameSeq = 0;
  let lastChromeAck = 0;
  let lastInputAt = 0;
  let ackTimer = null;
  // The newest frame, for a viewer that joins and for inspect. Chrome's
  // screenshots are not used: while it takes one, it changes the page's
  // emulated scale, and input in that moment lands at the wrong place.
  let latest = null;

  const deliver = (viewer, frame) => {
    if (viewer.inflight >= VIEWER_MAX_INFLIGHT_FRAMES) {
      viewer.pendingFrame = frame;
      return;
    }
    viewer.inflight += 1;
    viewer.sendFrame(frame);
  };

  const ackChrome = (frameSessionId) => {
    const current = send;
    const interval = Date.now() - lastInputAt < ACTIVE_AFTER_INPUT_MS ? ACTIVE_ACK_INTERVAL_MS : IDLE_ACK_INTERVAL_MS;
    const wait = Math.max(0, interval - (Date.now() - lastChromeAck));
    clearTimeout(ackTimer);
    ackTimer = setTimeout(() => {
      ackTimer = null;
      lastChromeAck = Date.now();
      void current?.('Page.screencastFrameAck', { sessionId: frameSessionId }).catch(() => {});
    }, wait);
    ackTimer.unref?.();
  };

  const start = async () => {
    if (!send || viewers.size === 0) return;
    const { width, height, dpr } = viewport();
    screencasting = true;
    // Chrome draws at 2x; the stream is scaled to the viewer's pixel ratio.
    startFailed = await send('Page.startScreencast', {
      format: 'jpeg',
      quality: SCREENCAST_QUALITY,
      maxWidth: Math.round(width * dpr),
      maxHeight: Math.round(height * dpr),
      everyNthFrame: 1,
    }).then(() => false, () => true);
  };

  const stop = async () => {
    if (!screencasting) return;
    screencasting = false;
    latest = null;
    clearTimeout(ackTimer);
    ackTimer = null;
    await send?.('Page.stopScreencast').catch(() => {});
  };

  const header = (metadata = {}) => ({
    seq: ++frameSeq,
    width: metadata.deviceWidth,
    height: metadata.deviceHeight,
    offsetTop: metadata.offsetTop || 0,
    pageScaleFactor: metadata.pageScaleFactor || 1,
  });

  return {
    /** Uses a (new) page session; the screencast restarts on it. */
    async bind(nextSend) {
      clearTimeout(ackTimer);
      ackTimer = null;
      send = nextSend;
      screencasting = false;
      latest = null;
      await start();
    },

    onFrame(params) {
      ackChrome(params.sessionId);
      if (viewers.size === 0) return;
      const jpeg = Buffer.from(params.data, 'base64');
      const frameHeader = header(params.metadata);
      const frame = encodeFrame(frameHeader, jpeg);
      latest = { frame, jpeg, width: frameHeader.width, height: frameHeader.height };
      for (const viewer of viewers) deliver(viewer, frame);
    },

    noteInput() {
      lastInputAt = Date.now();
    },

    async addViewer(viewer) {
      viewer.inflight = 0;
      viewer.pendingFrame = null;
      viewers.add(viewer);
      if (viewers.size === 1) {
        await start();
        return;
      }
      // An idle page does not draw again for a new viewer, so a late viewer
      // starts from the newest frame.
      if (latest) deliver(viewer, latest.frame);
    },

    /** The newest frame's JPEG and its CSS size, or null before the first. */
    still() {
      return latest ? { jpeg: latest.jpeg, width: latest.width, height: latest.height } : null;
    },

    removeViewer(viewer) {
      viewers.delete(viewer);
      if (viewers.size === 0) void stop();
    },

    ack(viewer) {
      viewer.inflight = Math.max(0, viewer.inflight - 1);
      if (viewer.pendingFrame && viewer.inflight < VIEWER_MAX_INFLIGHT_FRAMES) {
        const frame = viewer.pendingFrame;
        viewer.pendingFrame = null;
        viewer.inflight += 1;
        viewer.sendFrame(frame);
      }
    },

    /** Retries a screencast that failed to start. */
    async retry() {
      if (screencasting && startFailed) await start();
    },

    /** The viewport changed: the stream restarts at the new size. */
    async restart() {
      if (!screencasting) return;
      await stop();
      await start();
    },

    close() {
      clearTimeout(ackTimer);
      ackTimer = null;
      viewers.clear();
      send = null;
    },
  };
};
