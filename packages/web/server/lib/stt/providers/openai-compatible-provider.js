import OpenAI, { toFile } from 'openai';

import { PCM_SAMPLE_RATE, pcm16ToWav } from '../audio.js';

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('STT provider URL is not configured');
  const parsed = new URL(value.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('STT provider URL must use HTTP or HTTPS');
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  if (!parsed.pathname.endsWith('/v1')) parsed.pathname = `${parsed.pathname}/v1`.replace(/\/+/g, '/');
  return parsed.toString().replace(/\/$/, '');
}

export function createOpenAICompatibleProvider({ baseUrl, apiKey, model, language }) {
  if (typeof model !== 'string' || !model.trim()) throw new Error('STT provider model is not configured');
  const client = new OpenAI({ baseURL: normalizeBaseUrl(baseUrl), apiKey: apiKey || 'not-required' });
  return {
    sampleRate: PCM_SAMPLE_RATE,
    async transcribe(pcm16) {
      const file = await toFile(pcm16ToWav(pcm16), 'recording.wav', { type: 'audio/wav' });
      const result = await client.audio.transcriptions.create({
        file,
        model: model.trim(),
        response_format: 'json',
        ...(language ? { language } : {}),
      });
      return { text: String(result.text ?? '').trim() };
    },
    close() {},
  };
}
