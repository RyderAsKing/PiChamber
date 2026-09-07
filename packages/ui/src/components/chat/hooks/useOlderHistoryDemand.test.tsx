import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, test } from 'bun:test';

import { useOlderHistoryDemand } from './useOlderHistoryDemand';

const installMinimalDom = () => {
    const descriptors = new Map<string, PropertyDescriptor | undefined>();
    const setGlobal = (name: string, value: unknown) => {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    };
    class ElementStub {}
    const documentStub: Record<string, unknown> = {
        nodeType: 9,
        defaultView: globalThis,
        activeElement: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    };
    const rootElement = {
        nodeType: 1,
        tagName: 'DIV',
        nodeName: 'DIV',
        namespaceURI: 'http://www.w3.org/1999/xhtml',
        ownerDocument: documentStub,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    };
    documentStub.documentElement = rootElement;
    documentStub.body = rootElement;
    setGlobal('document', documentStub);
    setGlobal('window', globalThis);
    setGlobal('Element', ElementStub);
    setGlobal('HTMLElement', ElementStub);
    setGlobal('HTMLIFrameElement', ElementStub);
    setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    return {
        container: rootElement as unknown as Element,
        restore: () => {
            for (const [name, descriptor] of descriptors) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        },
    };
};

const flush = async () => {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
    });
};

describe('useOlderHistoryDemand', () => {
    test('requests the next cursor when a page adds no scrollable height', async () => {
        const dom = installMinimalDom();
        const root: Root = createRoot(dom.container);
        const listeners = new Set<EventListener>();
        const scroller = {
            scrollTop: 0,
            scrollHeight: 900,
            clientHeight: 600,
            addEventListener: (_name: string, listener: EventListener) => listeners.add(listener),
            removeEventListener: (_name: string, listener: EventListener) => listeners.delete(listener),
        } as unknown as HTMLDivElement;
        const calls: string[] = [];
        let beforeCursor: string | undefined = 'cursor-2';
        const resolveScrollContainer = () => scroller;
        const loadOlder = async () => {
            calls.push(beforeCursor ?? 'none');
            if (beforeCursor === 'cursor-2') {
                beforeCursor = 'cursor-1';
                return true;
            }
            beforeCursor = undefined;
            return false;
        };
        const onBeforeLoad = () => undefined;
        const onLoadError = () => undefined;

        const Harness = () => {
            useOlderHistoryDemand({
                hasMoreBefore: beforeCursor !== undefined,
                beforeCursor,
                resolveScrollContainer,
                loadOlder,
                onBeforeLoad,
                onLoadError,
            });
            return null;
        };

        try {
            await act(async () => root.render(React.createElement(Harness)));
            await flush();
            // The first page contains records hidden inside the existing turn,
            // so scrollTop and scrollHeight do not change. The accepted page's
            // result keeps demand active for the next server cursor.
            expect(calls).toEqual(['cursor-2', 'cursor-1']);

            await act(async () => root.render(React.createElement(Harness)));
            await flush();
            expect(calls).toHaveLength(2);
        } finally {
            await act(async () => root.unmount());
            dom.restore();
        }
    });
});
