/**
 * Whether this browser draws without the graphics card: hardware acceleration
 * turned off, blocked, or a driver it will not use. Nothing is turned off
 * because of it; Settings only says that animated drawing costs more there.
 *
 * Read from WebGL, which is the one place a page can see the renderer: no
 * context at all, or a CPU renderer by name (SwiftShader, llvmpipe, Microsoft
 * Basic Render Driver). Worked out once per page load.
 */
const SOFTWARE_RENDERERS = /swiftshader|llvmpipe|softpipe|software|basic render/i;

let cached: boolean | undefined;

export function isSoftwareRendering(): boolean {
  if (cached !== undefined) return cached;
  cached = detect();
  return cached;
}

function detect(): boolean {
  if (typeof document === 'undefined') return false;
  const canvas = document.createElement('canvas');
  let gl: WebGLRenderingContext | null = null;
  try {
    gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
  } catch {
    gl = null;
  }
  if (!gl) return true;
  try {
    // Firefox reports the real renderer here; Chrome and Safari say "WebKit
    // WebGL" and keep the real one behind the debug extension.
    let renderer = String(gl.getParameter(gl.RENDERER) ?? '');
    if (/^webkit webgl$/i.test(renderer)) {
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      if (info) renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? '');
    }
    return SOFTWARE_RENDERERS.test(renderer);
  } catch {
    return false;
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
