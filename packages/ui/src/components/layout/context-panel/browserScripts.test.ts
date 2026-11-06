import { describe, expect, test } from 'bun:test';

import { normalizeBrowserUrl } from './browserScripts';

describe('normalizeBrowserUrl', () => {
  test('uses http for typed local addresses and https elsewhere', () => {
    expect(normalizeBrowserUrl('localhost:3000')).toBe('http://localhost:3000/');
    expect(normalizeBrowserUrl('127.0.0.1:5173/a')).toBe('http://127.0.0.1:5173/a');
    expect(normalizeBrowserUrl('10.0.0.5')).toBe('http://10.0.0.5/');
    expect(normalizeBrowserUrl('172.31.0.5:8080')).toBe('http://172.31.0.5:8080/');
    expect(normalizeBrowserUrl('172.32.0.5')).toBe('https://172.32.0.5/');
    expect(normalizeBrowserUrl('app.local')).toBe('http://app.local/');
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com/');
    expect(normalizeBrowserUrl('localhost.example.com')).toBe('https://localhost.example.com/');
    expect(normalizeBrowserUrl('https://localhost')).toBe('https://localhost/');
  });

  test('rejects other schemes', () => {
    expect(normalizeBrowserUrl('file:///etc/passwd')).toBe('about:blank');
    expect(normalizeBrowserUrl('')).toBe('about:blank');
  });
});
