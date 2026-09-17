import { readFileSync } from 'node:fs';

const KNOWN_DISTRIBUTIONS = new Set(['ubuntu', 'arch', 'nixos', 'fedora', 'debian', 'centos']);

const DISTRIBUTION_ALIASES = new Map([
  ['archlinux', 'arch'],
  ['endeavouros', 'arch'],
  ['manjaro', 'arch'],
  ['pop', 'ubuntu'],
  ['linuxmint', 'ubuntu'],
  ['elementary', 'ubuntu'],
  ['rhel', 'fedora'],
  ['rocky', 'centos'],
  ['almalinux', 'centos'],
]);

const normalizeDistribution = (value) => {
  const id = String(value || '').trim().toLowerCase();
  return KNOWN_DISTRIBUTIONS.has(id) ? id : DISTRIBUTION_ALIASES.get(id) || null;
};

export const parseLinuxDistribution = (content) => {
  const values = new Map();
  for (const line of String(content || '').split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const raw = match[2].trim();
    values.set(match[1], raw.replace(/^(["'])(.*)\1$/, '$2'));
  }

  const direct = normalizeDistribution(values.get('ID'));
  if (direct) return direct;
  for (const related of String(values.get('ID_LIKE') || '').split(/\s+/)) {
    const normalized = normalizeDistribution(related);
    if (normalized) return normalized;
  }
  return null;
};

export const detectLinuxDistribution = ({ platform = process.platform, readFile = readFileSync } = {}) => {
  if (platform !== 'linux') return null;
  try {
    return parseLinuxDistribution(readFile('/etc/os-release', 'utf8'));
  } catch {
    return null;
  }
};
