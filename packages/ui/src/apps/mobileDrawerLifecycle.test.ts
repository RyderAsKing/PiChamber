import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mobileAppSource = readFileSync(join(__dirname, 'MobileApp.tsx'), 'utf8');
const sessionsSheetSource = readFileSync(join(__dirname, 'MobileSessionsSheet.tsx'), 'utf8');
const workspaceDrawerSource = readFileSync(join(__dirname, 'MobileWorkspaceDrawer.tsx'), 'utf8');
const drawerSwipeSource = readFileSync(join(__dirname, 'useDrawerSwipe.ts'), 'utf8');
const edgeSwipeSource = readFileSync(join(__dirname, 'useEdgeSwipe.ts'), 'utf8');

describe('mobile drawer lifecycle', () => {
  test('the session drawer gates live sidebar work while it is closed', () => {
    expect(sessionsSheetSource).toContain('mobileVariant={!isTabletSidebar}\n      isVisible={open}');
  });

  test('both drawers share one drag implementation without enabling tablet sidebars', () => {
    expect(sessionsSheetSource).toContain('useDrawerSwipe({');
    expect(workspaceDrawerSource).toContain('useDrawerSwipe({');
    expect(sessionsSheetSource).toContain("enabled: variant === 'drawer'");
    expect(workspaceDrawerSource).toContain("enabled: variant === 'drawer'");
  });

  test('closed drawers can start on content while preserving controls and horizontal scroll', () => {
    expect(edgeSwipeSource).toContain('isSwipeExcludedTarget(event.target, element)');
    expect(edgeSwipeSource).toContain('side = null;');
    expect(edgeSwipeSource).toContain('side = dx > 0 ? \'left\' : \'right\';');
    expect(edgeSwipeSource).toContain('scrollWidth > node.clientWidth');
  });

  test('closed overlays are inert instead of hiding a focused descendant', () => {
    expect(sessionsSheetSource).toContain('inert={!open}');
    expect(workspaceDrawerSource).toContain('inert={!open}');
    expect(sessionsSheetSource).not.toContain('aria-hidden={!open}');
    expect(workspaceDrawerSource).not.toContain('aria-hidden={!open}');
  });

  test('close handlers clear focus before hiding the drawer', () => {
    expect(sessionsSheetSource).toContain('rootRefElement.current?.contains(activeElement)');
    expect(workspaceDrawerSource).toContain('rootElementRef.current?.contains(activeElement)');
  });

  test('close-settle cleanup does not clear React-owned closed styles', () => {
    expect(drawerSwipeSource).not.toContain('drawer.style.transform = \'\';');
    expect(drawerSwipeSource).not.toContain('scrim.style.opacity = \'\';');
    expect(drawerSwipeSource).not.toContain('drawer.style.transition = \'\';');
    expect(drawerSwipeSource).not.toContain('scrim.style.transition = \'\';');

    const settleStart = mobileAppSource.indexOf('const settlePhoneDrawer = (');
    const settleEnd = mobileAppSource.indexOf('\n\nconst MobileShell', settleStart);
    expect(settleStart).toBeGreaterThan(-1);
    expect(settleEnd).toBeGreaterThan(settleStart);
    expect(mobileAppSource.slice(settleStart, settleEnd)).not.toContain("style.transition = '';");
  });

  test('touchend listeners can suppress synthesized clicks after a drag', () => {
    expect(drawerSwipeSource).toContain("drawer.addEventListener('touchend', onTouchEnd, { passive: false });");
    expect(drawerSwipeSource).toContain('event.preventDefault()');
  });
});
