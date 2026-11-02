import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  for (const { viewport, large, dynamic } of [
    { viewport: 874, large: 874, dynamic: 874 },
    { viewport: 812, large: 874, dynamic: 812 },
    // After keyboard dismissal, dvh can remain shrunk. The layout viewport
    // has recovered, so the shell must fill it without depending on dvh.
    { viewport: 874, large: 874, dynamic: 500 },
  ]) {
    for (const safeBottom of [0, 34]) {
      const css = mobileCss
        .replaceAll('(display-mode: standalone)', '(min-width: 0px)')
        .replaceAll('100lvh', `${large}px`)
        .replaceAll('100dvh', `${dynamic}px`)
        .replace(/env\(safe-area-inset-bottom,\s*0(?:px)?\)/g, `${safeBottom}px`);
      await client.send('Emulation.setDeviceMetricsOverride', { width: 402, height: viewport, deviceScaleFactor: 1, mobile: true });
      await client.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html: `<!doctype html>
<html class="device-mobile mobile-pointer"><head>
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
<form class="bottom-safe-area oc-mobile-composer"><div class="card">
<div class="editor">Prompt</div><div class="footer">Model / thinking / send</div>
</div></form></div></div><pre id="result"></pre>
<script>
(() => {
const shell = document.querySelector('.oc-mobile-app-shell').getBoundingClientRect();
const footer = document.querySelector('.footer').getBoundingClientRect();
const overlay = getComputedStyle(document.body, '::after');
document.querySelector('#result').textContent = JSON.stringify({
  viewport: innerHeight, shellHeight: shell.height, footerBottom: footer.bottom,
  overlayHeight: parseFloat(overlay.height) || 0
});
})();
</script></body></html>` });
      const result = await evaluateValue(client, "JSON.parse(document.querySelector('#result').textContent)");
      assert.equal(result.viewport, viewport, 'Fixture viewport must match the requested geometry');
      console.log({ large, dynamic, safeBottom, ...result });
      assert.equal(result.shellHeight, result.viewport, 'PWA shell must fit its layout viewport');
      assert(result.footerBottom <= result.viewport - result.overlayHeight, 'Composer footer must remain above bottom clipping and overlay');
    }
  }
} finally {
  client?.close();
  const exited = new Promise((resolve) => browser.once('exit', resolve));
  browser.kill();
  await exited;
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
