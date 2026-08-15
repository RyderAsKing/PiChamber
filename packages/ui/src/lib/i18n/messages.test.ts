import { describe, expect, test } from 'bun:test';

import { dict as enDict } from './messages/en';

describe('i18n dictionaries', () => {
  test('english dictionary exposes expected surface keys', () => {
    expect(enDict['common.language.english']).toBeTruthy();
  });
});
