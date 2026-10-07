import { describe, expect, test } from 'bun:test';

import {
  createStickyScrollbarController,
  findPierreScrollers,
  findPierreShadowRoots,
  isHorizontallyOverflowing,
  maxScrollOverflowOf,
  syncScrollLeft,
} from './pierreScrollSync';

// Self-contained fakes: no DOM library, no shared-module mocks. Each fake
// implements just the surface the controller/finders touch.

type Listener = (event?: unknown) => void;

class FakeCode {
  scrollLeft = 0;
  scrollWidth = 0;
  clientWidth = 0;
  private listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  dispatchScroll(): void {
    for (const fn of this.listeners.get('scroll') ?? []) fn();
  }
}

class FakeShadowRoot {
  codes: FakeCode[] = [];
  querySelectorAll(selector: string): FakeCode[] {
    return selector === '[data-code]' ? [...this.codes] : [];
  }
}

class FakeContainer {
  tagName = 'DIFFS-CONTAINER';
  shadowRoot: FakeShadowRoot | null = new FakeShadowRoot();
}

class FakeHost {
  tagName = 'DIV';
  shadowRoot: FakeShadowRoot | null = null;
  containers: FakeContainer[] = [];
  style: Record<string, string> = {};
  querySelectorAll(selector: string): FakeContainer[] {
    return selector === 'diffs-container' ? [...this.containers] : [];
  }
}

class FakeProxy extends FakeCode {
  style: Record<string, string> = {};
}

const asElement = (value: unknown): HTMLElement => value as unknown as HTMLElement;

describe('findPierreScrollers', () => {
  test('returns empty for a null host or a host without containers', () => {
    expect(findPierreScrollers(null)).toEqual([]);
    expect(findPierreScrollers(asElement(new FakeHost()))).toEqual([]);
  });

  test('collects [data-code] from every shadow root (split mode: two)', () => {
    const host = new FakeHost();
    const container = new FakeContainer();
    const deletions = new FakeCode();
    const additions = new FakeCode();
    container.shadowRoot?.codes.push(deletions, additions);
    host.containers.push(container);
    expect(findPierreScrollers(asElement(host))).toEqual([deletions, additions]);
  });

  test('skips containers whose shadow root is not attached yet', () => {
    const host = new FakeHost();
    const pending = new FakeContainer();
    pending.shadowRoot = null;
    host.containers.push(pending);
    expect(findPierreScrollers(asElement(host))).toEqual([]);
  });

  test('finds shadow roots for observation', () => {
    const host = new FakeHost();
    host.containers.push(new FakeContainer());
    expect(findPierreShadowRoots(asElement(host))).toHaveLength(1);
    expect(findPierreShadowRoots(null)).toEqual([]);
  });
});

describe('syncScrollLeft', () => {
  test('proxy scroll drives every scroller (split panes stay together)', () => {
    const proxy = { scrollLeft: 120 };
    const deletions = { scrollLeft: 0 };
    const additions = { scrollLeft: 40 };
    syncScrollLeft(proxy, [deletions, additions]);
    expect(deletions.scrollLeft).toBe(120);
    expect(additions.scrollLeft).toBe(120);
  });

  test('equal positions write nothing (echoes converge, no loop)', () => {
    let writes = 0;
    const target = {
      _left: 50,
      get scrollLeft(): number {
        return this._left;
      },
      set scrollLeft(value: number) {
        writes += 1;
        this._left = value;
      },
    };
    syncScrollLeft({ scrollLeft: 50 }, [target]);
    expect(writes).toBe(0);
  });
});

describe('overflow measurement', () => {
  test('uses the largest per-scroller overflow', () => {
    expect(maxScrollOverflowOf([
      { scrollWidth: 300, clientWidth: 400 },
      { scrollWidth: 900, clientWidth: 400 },
    ])).toBe(500);
    expect(maxScrollOverflowOf([])).toBe(0);
  });

  test('proxy hides when content does not overflow (1px tolerance)', () => {
    expect(isHorizontallyOverflowing(0)).toBe(false);
    expect(isHorizontallyOverflowing(1)).toBe(false);
    expect(isHorizontallyOverflowing(2)).toBe(true);
  });
});

describe('createStickyScrollbarController', () => {
  const setup = () => {
    const host = new FakeHost();
    const container = new FakeContainer();
    const code = new FakeCode();
    code.scrollWidth = 1200;
    code.clientWidth = 800;
    container.shadowRoot?.codes.push(code);
    host.containers.push(container);
    const proxy = new FakeProxy();
    proxy.clientWidth = 800;
    const spacer = { style: {} as Record<string, string> };
    const visibility: boolean[] = [];
    const controller = createStickyScrollbarController({
      proxy: asElement(proxy),
      spacer: spacer as unknown as HTMLElement,
      getHost: () => asElement(host),
      onVisibilityChange: (next) => {
        visibility.push(next);
      },
    });
    return { host, container, code, proxy, spacer, visibility, controller };
  };

  test('shows the proxy and sizes the spacer to proxy width plus overflow', () => {
    const { spacer, visibility } = setup();
    expect(visibility).toEqual([true]);
    expect(spacer.style.width).toBe('1200px');
  });

  test('split mode: half-width scrollers map to the same scroll range', () => {
    const { container, code, proxy, spacer, controller } = setup();
    code.clientWidth = 400;
    const other = new FakeCode();
    other.scrollWidth = 1000;
    other.clientWidth = 400;
    container.shadowRoot?.codes.push(other);
    controller.refresh();
    // Proxy (800) + max overflow (1200 - 400) => max proxy scrollLeft 800,
    // equal to the widest scroller's max scrollLeft.
    expect(spacer.style.width).toBe(`${(proxy as FakeProxy).clientWidth + 800}px`);
    controller.dispose();
  });

  test('proxy scroll drives scrollers; scroller scroll drives the proxy', () => {
    const { code, proxy, controller } = setup();
    (proxy as FakeProxy).scrollLeft = 200;
    (proxy as FakeProxy).dispatchScroll();
    expect(code.scrollLeft).toBe(200);

    code.scrollLeft = 64;
    code.dispatchScroll();
    expect((proxy as FakeProxy).scrollLeft).toBe(64);
    controller.dispose();
  });

  test('hides when content fits and cleans up listeners on dispose', () => {
    const { code, proxy, visibility, controller } = setup();
    code.scrollWidth = 100;
    controller.refresh();
    expect(visibility).toEqual([true, false]);

    controller.refresh();
    controller.dispose();
    expect(proxy.listenerCount('scroll')).toBe(0);
    expect(code.listenerCount('scroll')).toBe(0);
  });

  test('re-discovers scrollers after Pierre re-renders the host', () => {
    const { host, proxy, controller } = setup();
    const replacement = new FakeContainer();
    const nextCode = new FakeCode();
    nextCode.scrollWidth = 500;
    replacement.shadowRoot?.codes.push(nextCode);
    host.containers.length = 0;
    host.containers.push(replacement);
    controller.refresh();

    (proxy as FakeProxy).scrollLeft = 77;
    (proxy as FakeProxy).dispatchScroll();
    expect(nextCode.scrollLeft).toBe(77);
    controller.dispose();
  });

  test('dispose removes every listener', () => {
    const { code, proxy, controller } = setup();
    controller.dispose();
    (proxy as FakeProxy).scrollLeft = 300;
    (proxy as FakeProxy).dispatchScroll();
    expect(code.scrollLeft).toBe(0);
    expect(proxy.listenerCount('scroll')).toBe(0);
    expect(code.listenerCount('scroll')).toBe(0);
  });
});
