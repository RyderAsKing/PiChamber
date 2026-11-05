import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpClient, createPageTarget, evaluateValue, launchChrome, reservePort } from './perf/cdp.mjs';

// Browser geometry regression for #203. Desktop engines cannot reproduce iOS
// standalone chrome, so supply its reported viewport split explicitly. See
// https://bugs.webkit.org/show_bug.cgi?id=313800 and bug 301994 comment 6.
const chrome = process.argv[process.argv.indexOf('--chrome') + 1];
assert(process.argv.includes('--chrome') && chrome, 'Usage: node scripts/test-pwa-layout.mjs --chrome /path/to/chrome');
const mobileCss = readFileSync(new URL('../packages/ui/src/styles/mobile.css', import.meta.url), 'utf8');
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'pichamber-pwa-layout-'));
const port = await reservePort();
const browser = launchChrome({ chrome, profileDir: temporaryDirectory, port, headless: true, extraArgs: ['--no-sandbox'] });
let client;
try {
  const target = await createPageTarget(port);
  client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  const { frameTree } = await client.send('Page.getFrameTree');
  const collectorBundle = join(temporaryDirectory, 'viewport-layout.cjs');
  const build = spawnSync('bun', ['build', fileURLToPath(new URL('../packages/ui/src/lib/perf/viewportLayout.ts', import.meta.url)), '--target=browser', '--format=cjs', '--outfile', collectorBundle], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const collectorSource = readFileSync(collectorBundle, 'utf8');
  for (const { viewport, large, dynamic, strip } of [
    { viewport: 874, large: 874, dynamic: 874, strip: 0 },
    // Before standaloneViewportInsets has measured the short web view.
    { viewport: 812, large: 874, dynamic: 812, strip: 0 },
    // Measured: iOS draws a 62px strip below the page that already covers the
    // home indicator, so the bottom inset must not be reserved again.
    { viewport: 812, large: 874, dynamic: 812, strip: 62 },
    // After keyboard dismissal, dvh can remain shrunk. The layout viewport
    // has recovered, so the shell must fill it without depending on dvh.
    { viewport: 874, large: 874, dynamic: 500, strip: 0 },
  ]) {
    for (const safeBottom of [0, 21, 34]) {
      const css = mobileCss
        .replaceAll('(display-mode: standalone)', '(min-width: 0px)')
        // Activate the iOS-only blocks; their negated fallbacks stay inactive.
        .replaceAll('(-webkit-touch-callout: none)', '(display: block)')
        .replaceAll('100lvh', `${large}px`)
        .replaceAll('100dvh', `${dynamic}px`)
        .replace(/env\(safe-area-inset-bottom,\s*0(?:px)?\)/g, `${safeBottom}px`);
      await client.send('Emulation.setDeviceMetricsOverride', { width: 402, height: viewport, deviceScaleFactor: 1, mobile: true });
      await client.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html: `<!doctype html>
<html class="device-mobile mobile-pointer"${strip ? ` style="--oc-viewport-bottom-strip: ${strip}px"` : ''}><head>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; overflow: hidden; }
:root { --background: white; }
.oc-mobile-app-shell { height: ${dynamic}px; display: flex; flex-direction: column; }
.feed { flex: 1; min-height: 0; }
form { margin: 0; flex-shrink: 0; }
.card { padding: 12px; }
.editor { height: 60px; }
.footer { height: 36px; }
</style><style>${css}</style></head><body><div id="root">
<div class="oc-mobile-app-shell"><div class="feed"></div>
<form class="bottom-safe-area oc-mobile-composer"><div class="card" data-composer-card="true">
<div class="editor">PRIVATE_TEST_PROMPT</div><div class="footer" data-chat-input-footer="true">Model / thinking / send</div>
</div></form></div></div><pre id="result"></pre>
<script>
(() => {
const shell = document.querySelector('.oc-mobile-app-shell').getBoundingClientRect();
const footer = document.querySelector('.footer').getBoundingClientRect();
const overlay = getComputedStyle(document.body, '::after');
const card = document.querySelector('.card').getBoundingClientRect();
document.querySelector('#result').textContent = JSON.stringify({
  viewport: innerHeight, shellHeight: shell.height, footerBottom: footer.bottom,
  cardBottom: card.bottom, bottomGap: shell.bottom - card.bottom,
  overlayHeight: parseFloat(overlay.height) || 0
});
})();
</script></body></html>` });
      const result = await evaluateValue(client, "JSON.parse(document.querySelector('#result').textContent)");
      assert.equal(result.viewport, viewport, 'Fixture viewport must match the requested geometry');
      console.log({ large, dynamic, strip, safeBottom, ...result });
      assert.equal(result.shellHeight, result.viewport, 'PWA shell must fit its layout viewport');
      assert.equal(result.bottomGap, Math.max(16, safeBottom - strip), 'Composer must reserve only the bottom safe area inside the web view, once');
      assert(result.footerBottom <= result.viewport - result.overlayHeight, 'Composer footer must remain above bottom clipping and overlay');
      const measured = await evaluateValue(client, `(() => {
        const module = { exports: {} };
        ${collectorSource}
        const childrenBefore = document.body.childElementCount;
        const snapshot = module.exports.captureViewportLayout();
        return {
          snapshot, childrenBefore, childrenAfter: document.body.childElementCount,
          shellHeightAfter: document.querySelector('.oc-mobile-app-shell').getBoundingClientRect().height,
          cardBottomAfter: document.querySelector('.card').getBoundingClientRect().bottom,
        };
      })()`);
      assert(measured?.snapshot, 'Diagnostic collector must return a snapshot in the browser');
      assert.equal(measured.childrenAfter, measured.childrenBefore, 'Measurement probe must be removed');
      assert.equal(measured.shellHeightAfter, result.shellHeight, 'Measurement must not change shell layout');
      assert.equal(measured.cardBottomAfter, result.cardBottom, 'Measurement must not move the composer card');
      assert.equal(measured.snapshot.client.height, viewport);
      assert.equal(measured.snapshot.shell.height, result.shellHeight);
      assert.equal(measured.snapshot.card.bottom, result.cardBottom);
      assert.equal(measured.snapshot.footer.bottom, result.footerBottom);
      assert.equal(measured.snapshot.gaps.cardToShellBottom, result.bottomGap);
      assert.equal(measured.snapshot.composerStyle.paddingBottom, result.bottomGap);
      assert.equal(measured.snapshot.css.dynamicHeight, viewport);
      assert(Math.abs((measured.snapshot.bottomOverlay.height ?? 0) - result.overlayHeight) < 0.01);
      assert.equal(JSON.stringify(measured.snapshot).includes('PRIVATE_TEST_PROMPT'), false, 'Diagnostics must not capture prompt content');
    }
  }
  const unavailable = await evaluateValue(client, `(() => {
    const module = { exports: {} };
    ${collectorSource}
    document.querySelector('form').style.marginBottom = '80px';
    const withOffset = module.exports.captureViewportLayout();
    document.querySelector('form').remove();
    const missing = module.exports.captureViewportLayout();
    const original = window.getComputedStyle;
    const childrenBefore = document.body.childElementCount;
    let failed = false;
    window.getComputedStyle = (element, pseudo) => {
      if (element.getAttribute('aria-hidden') === 'true') throw new Error('Injected measurement failure');
      return original.call(window, element, pseudo);
    };
    try { module.exports.captureViewportLayout(); } catch { failed = true; }
    finally { window.getComputedStyle = original; }
    return { withOffset, missing, failed, childrenBefore, childrenAfter: document.body.childElementCount };
  })()`);
  assert.equal(unavailable.withOffset.composerStyle.marginBottom, 80, 'Capture explicit user offset separately from padding');
  assert.equal(unavailable.withOffset.gaps.cardToShellBottom, 114);
  assert.equal(unavailable.missing.composer, null, 'A missing composer is unknown, not a zero-sized rectangle');
  assert.equal(unavailable.missing.gaps.cardToShellBottom, null);
  assert.equal(unavailable.failed, true);
  assert.equal(unavailable.childrenAfter, unavailable.childrenBefore, 'Probe cleanup must also run on failure');
} finally {
  client?.close();
  const exited = new Promise((resolve) => browser.once('exit', resolve));
  browser.kill();
  await exited;
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
