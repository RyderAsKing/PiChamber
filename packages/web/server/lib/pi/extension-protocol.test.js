import { describe, expect, it } from 'vitest';

import {
  sanitizeExtensionFormFields,
  validateExtensionFormValues,
  isValidCustomInputItems,
  MAX_CUSTOM_INPUT_CHARS,
} from './extension-protocol.js';

describe('extension form protocol', () => {
  it('uses one bounded field projection for daemon and public routes', () => {
    const fields = sanitizeExtensionFormFields([
      { id: 'name', label: 'Name', type: 'text', required: true, placeholder: 'x'.repeat(300) },
      { id: 'mode', label: 'Mode', type: 'select', options: ['fast', 'safe'] },
      { id: 'count', label: 'Count', type: 'number', min: 1, max: 3 },
      { id: '', label: 'Invalid' },
    ]);
    expect(fields).toHaveLength(3);
    expect(fields[0].placeholder).toHaveLength(256);
    expect(fields[1].options).toEqual(['fast', 'safe']);
  });

  it('rejects unknown, malformed, and out-of-range answers', () => {
    const fields = sanitizeExtensionFormFields([
      { id: 'name', label: 'Name', type: 'text', required: true },
      { id: 'mode', label: 'Mode', type: 'select', options: ['fast', 'safe'] },
      { id: 'count', label: 'Count', type: 'number', min: 1, max: 3 },
      { id: 'enabled', label: 'Enabled', type: 'checkbox' },
    ]);
    expect(validateExtensionFormValues(fields, {
      name: 'worker', mode: 'safe', count: '2', enabled: 'true',
    })).toBe(true);
    expect(validateExtensionFormValues(fields, { name: 'worker', unknown: 'x' })).toBe(false);
    expect(validateExtensionFormValues(fields, { name: '', mode: 'safe' })).toBe(false);
    expect(validateExtensionFormValues(fields, { name: 'worker', mode: 'turbo' })).toBe(false);
    expect(validateExtensionFormValues(fields, { name: 'worker', count: '4' })).toBe(false);
    expect(validateExtensionFormValues(fields, { name: 'worker', enabled: 'yes' })).toBe(false);
  });
});

describe('custom() surface input limits', () => {
  it('accepts up to 256 non-empty items and 65,536 characters in all', () => {
    expect(isValidCustomInputItems(['a', '\x1b[B'])).toBe(true);
    expect(isValidCustomInputItems(Array.from({ length: 256 }, () => 'a'))).toBe(true);
    expect(isValidCustomInputItems(['x'.repeat(MAX_CUSTOM_INPUT_CHARS)])).toBe(true);
    expect(isValidCustomInputItems(Array.from({ length: 257 }, () => 'a'))).toBe(false);
    // Each item fits, but together they exceed the request cap.
    expect(isValidCustomInputItems(['x'.repeat(MAX_CUSTOM_INPUT_CHARS), 'y'])).toBe(false);
    expect(isValidCustomInputItems([''])).toBe(false);
    expect(isValidCustomInputItems([1])).toBe(false);
    expect(isValidCustomInputItems('abc')).toBe(false);
  });
});
