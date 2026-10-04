import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { PiProviderLoginState } from '@/lib/pi/protocol';
import { ProviderLoginFlow } from './ProviderLoginFlow';

const REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback';

const browserLogin = (placeholder?: string): PiProviderLoginState => ({
  id: 'login-1',
  providerId: 'openai',
  state: 'pending',
  authUrl: { url: 'https://auth.example.test/authorize?state=abc' },
  prompt: { type: 'manual_code', message: 'Paste the code shown after you sign in:', ...(placeholder ? { placeholder } : {}) },
});

const render = (login: PiProviderLoginState, promptValue = '') => renderToStaticMarkup(
  <ProviderLoginFlow login={login} promptValue={promptValue} onPromptValueChange={() => {}} onSubmit={() => {}} busy={false} />,
);

describe('ProviderLoginFlow', () => {
  test('guides browser sign-in with a redirect URL paste step', () => {
    const html = render(browserLogin(REDIRECT_URI));

    expect(html).toContain('href="https://auth.example.test/authorize?state=abc"');
    expect(html).toContain('Open sign-in page');
    expect(html).toContain('2. Paste the redirect URL');
    expect(html).toContain(REDIRECT_URI);
    expect(html).toContain('finishes on its own');
  });

  test('rejects a pasted URL that is not the redirect address', () => {
    const html = render(browserLogin(REDIRECT_URI), 'https://chatgpt.com/');

    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('This isn&#x27;t the redirect address.');
  });

  test('accepts the redirect URL with its query string', () => {
    const html = render(browserLogin(REDIRECT_URI), `${REDIRECT_URI}?code=abc&state=xyz`);

    expect(html).not.toContain('aria-invalid="true"');
    expect(html).not.toContain('redirect address.');
  });

  test('falls back to a code paste step when Pi expects a code', () => {
    const html = render(browserLogin('code#state'));

    expect(html).toContain('2. Paste the code');
    expect(html).toContain('Paste the code shown after you sign in:');
    expect(html).toContain('placeholder="code#state"');
  });
});
