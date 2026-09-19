import { describe, expect, test } from 'bun:test';

import { resolveAutocompleteTrigger, type TriggerContext } from '../triggers';

const normal: TriggerContext = { inputMode: 'normal' };

/** Resolve with the caret placed at the `|` marker in `text`. */
const at = (text: string, context: TriggerContext = normal) => {
    const cursor = text.indexOf('|');
    if (cursor === -1) throw new Error('caret marker `|` missing');
    return resolveAutocompleteTrigger(text.replace('|', ''), cursor, context);
};

describe('command palette', () => {
    test('a leading slash opens the command palette', () => {
        expect(at('/rev|')).toEqual({ kind: 'command', query: 'rev' });
    });

    test('a bare leading slash opens it with an empty query', () => {
        expect(at('/|')).toEqual({ kind: 'command', query: '' });
    });

    test('a space anywhere turns it into an invocation, not a search', () => {
        expect(at('/review |')?.kind).not.toBe('command');
        expect(at('/rev|iew now')?.kind).not.toBe('command');
    });

    test('the caret must stay inside the command word', () => {
        expect(at('/review\nnext line|')?.kind).not.toBe('command');
    });

    test('a slash that is not the first character opens nothing', () => {
        expect(at(' /rev|')).toBeNull();
    });

    test('a slash after prose opens nothing', () => {
        expect(at('please run /rev|')).toBeNull();
    });

    test('a slash after a newline opens nothing', () => {
        expect(at('line\n/pl|')).toBeNull();
    });
});

describe('slash is start-only', () => {
    test('a slash after whitespace never opens a picker', () => {
        expect(at('please run /rev|')).toBeNull();
    });

    test('a slash after a newline never opens a picker', () => {
        expect(at('line\n/pl|')).toBeNull();
    });

    test('a path separator does not open it', () => {
        expect(at('src/comp|')).toBeNull();
    });

    test('a space after the sigil closes it', () => {
        expect(at('run /review |')).toBeNull();
    });

    test('a second slash later in the message opens nothing', () => {
        expect(at('/a b /c|')).toBeNull();
    });
});

describe('snippet picker', () => {
    test('a hash after whitespace opens the snippet picker', () => {
        expect(at('use #sig|')).toEqual({ kind: 'snippet', query: 'sig' });
    });

    test('a hash at the start of the text opens it', () => {
        expect(at('#sig|')).toEqual({ kind: 'snippet', query: 'sig' });
    });

    test('an issue reference does not open it', () => {
        expect(at('issue#42|')).toBeNull();
    });

    test('a command search with no arguments outranks a later hash', () => {
        expect(at('/rev|')).toEqual({ kind: 'command', query: 'rev' });
    });

    test('a snippet after command arguments wins because a space closes the palette', () => {
        expect(at('/rev #sig|')).toEqual({ kind: 'snippet', query: 'sig' });
    });

    test('a mid-message slash opens nothing even with a hash candidate', () => {
        expect(at('#tag /skill|')).toBeNull();
    });
});

describe('mention picker', () => {
    test('an at-sign after whitespace opens the mention picker', () => {
        expect(at('see @src/ap|')).toEqual({ kind: 'mention', query: 'src/ap' });
    });

    test('a bare at-sign opens it with an empty query', () => {
        expect(at('@|')).toEqual({ kind: 'mention', query: '' });
    });

    test('an email address does not open it', () => {
        expect(at('me@example|')).toBeNull();
    });

    test('a space after the sigil closes it', () => {
        expect(at('@build now|')).toBeNull();
    });

    test('a pasted at-sign does not open the picker', () => {
        expect(at('@src/app.ts|', {
            inputMode: 'normal',
            inputSource: 'paste',
            insertedText: '@src/app.ts',
        })).toBeNull();
    });

    test('a paste without an at-sign still resolves normally', () => {
        expect(at('@src|', {
            inputMode: 'normal',
            inputSource: 'paste',
            insertedText: 'src',
        })).toEqual({ kind: 'mention', query: 'src' });
    });
});

describe('precedence and disabling', () => {
    test('shell mode disables every picker', () => {
        const shell: TriggerContext = { inputMode: 'shell' };
        expect(at('/rev|', shell)).toBeNull();
        expect(at('@src|', shell)).toBeNull();
        expect(at('#sig|', shell)).toBeNull();
    });

    test('a leading slash stays the command palette', () => {
        expect(at('/pl|')).toEqual({ kind: 'command', query: 'pl' });
    });

    test('plain prose triggers nothing', () => {
        expect(at('just typing a sentence|')).toBeNull();
        expect(at('|')).toBeNull();
    });
});
