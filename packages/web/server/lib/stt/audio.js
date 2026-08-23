import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const PCM_SAMPLE_RATE = 16_000;
export const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2;

const asInt16 = (pcm16) => new Int16Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength / 2);

export function pcm16Peak(pcm16) {
  if (!Buffer.isBuffer(pcm16) || pcm16.byteLength % 2 !== 0) throw new Error('PCM16 audio must contain complete samples');
  let peak = 0;
  for (const sample of asInt16(pcm16)) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

export function pcm16ToFloat32(pcm16, gain = 1) {
  const input = asInt16(pcm16);
  const output = new Float32Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    output[index] = Math.max(-1, Math.min(1, (input[index] / 32768) * gain));
  }
  return output;
}

export function pcm16ToWav(pcm16, sampleRate = PCM_SAMPLE_RATE) {
  const wav = Buffer.allocUnsafe(44 + pcm16.byteLength);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcm16.byteLength, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm16.byteLength, 40);
  pcm16.copy(wav, 44);
  return wav;
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
