const TOOLCHAIN_SEGMENTS = ['/opt/homebrew/', '/opt/pkg/', '/opt/pmk/', '/snap/'];
const TOOLCHAIN_BASENAMES = new Set(['.cargo', '.bun', '.nvm', '.pyenv', '.rbenv', '.sdkman', '.asdf', '.volta', '.fnm', '.local', 'node_modules']);

export function pathLooksUserConfigured(value, home, delim) {
  if (typeof value !== 'string' || !value) return false;
  const normalizedHome = typeof home === 'string' ? home.replaceAll('\\', '/') : '';
  const homeWithSep = normalizedHome ? `${normalizedHome}/` : '';
  return value.split(delim).some((segment) => {
    if (!segment) return false;
    const normalizedSegment = segment.replaceAll('\\', '/');
    if (normalizedHome && (normalizedSegment === normalizedHome || normalizedSegment.startsWith(homeWithSep))) return true;
    if (TOOLCHAIN_SEGMENTS.some((prefix) => normalizedSegment.startsWith(prefix))) return true;
    return normalizedSegment.split('/').filter(Boolean).some((part) => TOOLCHAIN_BASENAMES.has(part));
  });
}

export function mergePathValues(primary, fallback, delim) {
  const seen = new Set();
  const result = [];
  for (const value of [primary, fallback]) {
    if (typeof value !== 'string' || !value) continue;
    for (const segment of value.split(delim)) {
      if (segment && !seen.has(segment)) { seen.add(segment); result.push(segment); }
    }
  }
  return result.join(delim);
}
