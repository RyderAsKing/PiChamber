import { posix, win32 } from 'node:path';

const pathApiFor = (platform) => platform === 'win32' ? win32 : posix;

const pathKey = (filePath, platform = process.platform) => {
  const normalized = pathApiFor(platform).normalize(filePath);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
};

/**
 * Build the runtime-local lookup used to distinguish Pi skill loads from
 * ordinary read calls. Skill names come from Pi's resource loader rather than
 * from the SKILL.md parent directory because Pi allows those names to differ.
 */
export function createSkillReadClassifier({ cwd, skills, platform = process.platform }) {
  const skillsByPath = new Map();
  const pathApi = pathApiFor(platform);
  for (const skill of Array.isArray(skills) ? skills : []) {
    if (!skill || typeof skill.name !== 'string' || typeof skill.filePath !== 'string') continue;
    const name = skill.name.trim();
    if (!name || !skill.filePath.trim()) continue;
    const absolutePath = pathApi.isAbsolute(skill.filePath) ? skill.filePath : pathApi.resolve(cwd, skill.filePath);
    skillsByPath.set(pathKey(absolutePath, platform), { name });
  }

  return (toolName, args) => {
    if (typeof toolName !== 'string' || toolName.toLowerCase() !== 'read' || !args || typeof args !== 'object') {
      return undefined;
    }
    const rawPath = typeof args.path === 'string'
      ? args.path
      : typeof args.file_path === 'string'
        ? args.file_path
        : undefined;
    if (!rawPath?.trim()) return undefined;
    const absolutePath = pathApi.isAbsolute(rawPath) ? rawPath : pathApi.resolve(cwd, rawPath);
    return skillsByPath.get(pathKey(absolutePath, platform));
  };
}
