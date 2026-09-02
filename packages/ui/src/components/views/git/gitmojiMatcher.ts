import type { GitmojiEntry } from '@/hooks/useGitmojiList';

export const KEYWORD_MAP: Record<string, string> = {
  feat: ':sparkles:',
  feature: ':sparkles:',
  fix: ':bug:',
  bug: ':bug:',
  hotfix: ':ambulance:',
  docs: ':memo:',
  documentation: ':memo:',
  style: ':lipstick:',
  refactor: ':recycle:',
  perf: ':zap:',
  performance: ':zap:',
  test: ':white_check_mark:',
  tests: ':white_check_mark:',
  build: ':construction_worker:',
  ci: ':green_heart:',
  chore: ':wrench:',
  revert: ':rewind:',
  wip: ':construction:',
  security: ':lock:',
  release: ':bookmark:',
  merge: ':twisted_rightwards_arrows:',
  mv: ':truck:',
  move: ':truck:',
  rename: ':truck:',
  remove: ':fire:',
  delete: ':fire:',
  add: ':sparkles:',
  create: ':sparkles:',
  implement: ':sparkles:',
  update: ':recycle:',
  improve: ':zap:',
  optimize: ':zap:',
  upgrade: ':arrow_up:',
  downgrade: ':arrow_down:',
  deploy: ':rocket:',
  init: ':tada:',
  initial: ':tada:',
};

export function matchGitmojiFromSubject(subject: string, gitmojis: GitmojiEntry[]): GitmojiEntry | null {
  const lowerSubject = subject.toLowerCase();

  // 1. Check for conventional commit prefix (e.g. "feat:", "fix(scope):")
  const conventionalRegex = /^([a-z]+)(?:\(.*\))?!?:/;
  const match = lowerSubject.match(conventionalRegex);

  if (match) {
    const type = match[1];
    const mappedCode = KEYWORD_MAP[type];
    if (mappedCode) {
      return gitmojis.find((g) => g.code === mappedCode) || null;
    }
  }

  // 2. Check for starting words (e.g. "Add", "Fix")
  const firstWord = lowerSubject.split(' ')[0];
  const mappedCode = KEYWORD_MAP[firstWord];
  if (mappedCode) {
    return gitmojis.find((g) => g.code === mappedCode) || null;
  }

  return null;
}
