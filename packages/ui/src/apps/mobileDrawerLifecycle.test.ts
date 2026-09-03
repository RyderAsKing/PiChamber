import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mobileAppSource = `${readFileSync(join(__dirname, 'MobileApp.tsx'), 'utf8')}\n${readFileSync(join(__dirname, 'MobileShell.tsx'), 'utf8')}`;
const sessionsSheetSource = readFileSync(join(__dirname, 'MobileSessionsSheet.tsx'), 'utf8');
const workspaceDrawerSource = readFileSync(join(__dirname, 'MobileWorkspaceDrawer.tsx'), 'utf8');
const titlebarControlsSource = readFileSync(join(__dirname, '../components/layout/TitlebarLeftControls.tsx'), 'utf8');
const drawerSwipeSource = readFileSync(join(__dirname, 'useDrawerSwipe.ts'), 'utf8');
const edgeSwipeSource = readFileSync(join(__dirname, 'useEdgeSwipe.ts'), 'utf8');
const drawerSurfaceSource = readFileSync(join(__dirname, 'drawerSurface.ts'), 'utf8');

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
    // Shared predicate lives in gestureMath, used by edgeSwipe for both open and closed states
    const gestureMathSource = readFileSync(join(__dirname, 'gestureMath.ts'), 'utf8');
    expect(edgeSwipeSource).toContain('isSwipeExcludedTarget');
    expect(edgeSwipeSource).toContain('side = null;');
    expect(edgeSwipeSource).toContain('side = dx > 0 ? \'left\' : \'right\';');
    expect(gestureMathSource).toContain('scrollWidth > node.clientWidth');
  });

  test('closed overlays are inert instead of hiding a focused descendant', () => {
    expect(sessionsSheetSource).toContain('inert={!open}');
    expect(workspaceDrawerSource).toContain('inert={!open}');
    expect(sessionsSheetSource).not.toContain('aria-hidden={!open}');
    expect(workspaceDrawerSource).not.toContain('aria-hidden={!open}');
  });

  test('tablet sidebars use inert instead of aria-hidden while closed', () => {
    expect(mobileAppSource).toContain('inert={!sidebarOpen}');
    expect(mobileAppSource).toContain('inert={!workspacePanelWidth}');
    expect(mobileAppSource).not.toContain('aria-hidden={!sidebarOpen}');
    expect(mobileAppSource).not.toContain('aria-hidden={!workspacePanelWidth}');
  });

  test('tablet panel toggles do not rerender the chat tree', () => {
    expect(mobileAppSource).toContain('const MobileChatView = React.memo(ChatView);');
    expect(mobileAppSource).toContain('<MobileChatView />');
  });

  test('toggle-only titlebar controls do not measure layout', () => {
    expect(titlebarControlsSource).toContain('const hasVariableWidthControls = showWindowControls || showAppMenu;');
    expect(titlebarControlsSource).toContain('if (!hasVariableWidthControls) {\n      return;\n    }');
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

    // Phone drawer settle is now in drawerSurface adapter; ensure it does not
    // clear the React-owned closed styles with empty string (inner panel cleanup is separate)
    expect(mobileAppSource).not.toContain("drawer.style.transition = '';");
    expect(mobileAppSource).not.toContain("scrim.style.transition = '';");
    expect(mobileAppSource).not.toContain("drawer.style.transform = '';");
  });

  test('touchend listeners can suppress synthesized clicks after a drag', () => {
    expect(drawerSwipeSource).toContain("drawer.addEventListener('touchend', onTouchEnd, { passive: false });");
    expect(drawerSwipeSource).toContain('event.preventDefault()');
  });

  test('drawer-local horizontal scroll is excluded from close gestures', () => {
    expect(drawerSwipeSource).toContain('isSwipeExcludedTarget');
    expect(drawerSwipeSource).toContain('isSwipeExcludedTarget(event.target, drawer, { excludeInteractive: false })');
  });

  test('settled close cleanup does not restore the drawer to open styles', () => {
    expect(drawerSwipeSource).toContain('const gestureWasActive = tracking || isDragging;');
    expect(drawerSwipeSource).not.toContain("drawer.style.transition === 'none' || drawer.style.transform !== 'none'");
    const settleStart = drawerSwipeSource.indexOf('const settle =');
    const clearIndex = drawerSwipeSource.indexOf('clearTransientState();', settleStart);
    const closeIndex = drawerSwipeSource.indexOf('if (shouldClose) onClose();', settleStart);
    expect(clearIndex).toBeGreaterThan(settleStart);
    expect(clearIndex).toBeLessThan(closeIndex);
  });

  test('tablet settle does not animate layout width on every frame', () => {
    expect(mobileAppSource).not.toContain("width 200ms cubic-bezier(0.22, 1, 0.36, 1), min-width 200ms");
    expect(mobileAppSource).not.toContain("transitionProperty: rightResize.isResizing ? 'none' : 'width, min-width, max-width'");
  });

  test('phone drawer hot path uses refs, not querySelector per touchmove', () => {
    // MobileApp's edge swipe progress handlers must use refs; no per-frame DOM queries
    expect(mobileAppSource).not.toContain("document.querySelector('[data-mobile-sessions-drawer]')");
    expect(mobileAppSource).not.toContain("document.querySelector('[data-mobile-workspace-drawer]')");
    expect(mobileAppSource).toContain('phoneLeftDrawerRef');
    expect(mobileAppSource).toContain('applyPhoneDrawerProgress');
    expect(mobileAppSource).toContain('phoneRightDrawerRef');
  });

  test('tablet swipe previews use two-layer shell+inner without per-move reflow', () => {
    expect(mobileAppSource).toContain('leftPanelInnerRef');
    expect(mobileAppSource).toContain('rightPanelInnerRef');
    expect(mobileAppSource).toContain('applyTabletPanelProgress');
    // Inner transform, shell overflow visible during drag
    expect(drawerSurfaceSource).toContain("shell.style.overflow = 'visible'");
    expect(drawerSurfaceSource).toContain("inner.style.transform");
  });

  test('git view is rendered only when the mobile right drawer is active', () => {
    const mainLayoutSource = readFileSync(join(__dirname, '../components/layout/MainLayout.tsx'), 'utf8');
    // Should not mount GitView eagerly; condition on drawer visible
    expect(mainLayoutSource).toContain('(mobileRightSidebarOpen || mobileRightDrawerVisible) ?');
    expect(mainLayoutSource).toContain("activeMainTab === 'git' && mobileGitDrawerVisible");
    expect(mainLayoutSource).toContain('URLs such as ?tab=git would leave the main area blank');
    expect(mainLayoutSource).not.toContain("<GitView isActive={!mobileRightSidebarOpen}");
  });
});
