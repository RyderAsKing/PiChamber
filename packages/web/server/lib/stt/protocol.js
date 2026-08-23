export const STT_WS_PATH = '/api/stt/ws';
const STT_BINARY_HEADER_BYTES = 4;
const STT_MAX_CONTROL_BYTES = 16 * 1024;
export const STT_MAX_BINARY_FRAME_BYTES = 32 * 1024;

export function parseSttControlFrame(raw) {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (buffer.byteLength > STT_MAX_CONTROL_BYTES) throw new Error('STT control frame is too large');
  const message = JSON.parse(buffer.toString('utf8'));
  if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
    throw new Error('Invalid STT control frame');
  }
  return message;
}

export function parseSttAudioFrame(raw) {
  const frame = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (frame.byteLength < STT_BINARY_HEADER_BYTES || frame.byteLength > STT_MAX_BINARY_FRAME_BYTES) {
    throw new Error('Invalid STT audio frame size');
  }
  const sequence = frame.readUInt32LE(0);
  const pcm16 = frame.subarray(STT_BINARY_HEADER_BYTES);
  if (pcm16.byteLength === 0 || pcm16.byteLength % 2 !== 0) throw new Error('Invalid PCM16 audio frame');
  return { sequence, pcm16 };
}

export function createSttAudioFrame(sequence, pcm16) {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff) throw new Error('Invalid STT sequence');
  const frame = new Uint8Array(STT_BINARY_HEADER_BYTES + pcm16.byteLength);
  new DataView(frame.buffer).setUint32(0, sequence, true);
  frame.set(new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength), STT_BINARY_HEADER_BYTES);
  return frame;
}

export function parseRequestPathname(value) {
  try { return new URL(value, 'http://localhost').pathname; }
  catch { return typeof value === 'string' ? value.split('?')[0] : ''; }
}
