import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';

import { createOpenAICompatibleProvider } from './openai-compatible-provider.js';

const servers = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))));

describe('OpenAI-compatible STT provider', () => {
  test('sends a WAV multipart request to the configured transcription endpoint', async () => {
    let requestSnapshot;
    const server = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requestSnapshot = { url: request.url, authorization: request.headers.authorization, contentType: request.headers['content-type'], body: Buffer.concat(chunks) };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ text: 'remote transcript' }));
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const provider = createOpenAICompatibleProvider({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'server-secret', model: 'whisper-test', language: 'en' });
    const result = await provider.transcribe(Buffer.alloc(3200));
    expect(result).toEqual({ text: 'remote transcript' });
    expect(requestSnapshot.url).toBe('/v1/audio/transcriptions');
    expect(requestSnapshot.authorization).toBe('Bearer server-secret');
    expect(requestSnapshot.contentType).toStartWith('multipart/form-data; boundary=');
    expect(requestSnapshot.body.includes(Buffer.from('RIFF'))).toBe(true);
    expect(requestSnapshot.body.includes(Buffer.from('whisper-test'))).toBe(true);
  });
});
