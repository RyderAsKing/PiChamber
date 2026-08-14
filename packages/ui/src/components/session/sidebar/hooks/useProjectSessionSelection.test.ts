import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/chat/types';
import type { SessionGroup, SessionNode } from '../types';

// ---------------------------------------------------------------------------
// Helper: simulate the projectSessionMeta computation from the hook
// ---------------------------------------------------------------------------

type ProjectSection = {
  project: { id: string; normalizedPath: string };
  groups: SessionGroup[];
};

function computeProjectMeta(projectSections: ProjectSection[]) {
  const metaByProject = new Map<string, Map<string, { directory: string | null }>>();
  const firstSessionByProject = new Map<string, { id: string; directory: string | null }>();

  const visitNodes = (
    projectId: string,
    projectRoot: string,
    fallbackDirectory: string | null,
    nodes: SessionNode[],
  ) => {
    if (!metaByProject.has(projectId)) {
      metaByProject.set(projectId, new Map());
    }
    const projectMap = metaByProject.get(projectId)!;
    nodes.forEach((node) => {
      const sessionDirectory = (
        (node.session as Session & { directory?: string | null }).directory
        ?? fallbackDirectory
        ?? projectRoot
      ).replace(/\\/g, '/').replace(/\/+$/, '');

      projectMap.set(node.session.id, { directory: sessionDirectory });
      if (!firstSessionByProject.has(projectId)) {
        firstSessionByProject.set(projectId, { id: node.session.id, directory: sessionDirectory });
      }
      if (node.children.length > 0) {
        visitNodes(projectId, projectRoot, sessionDirectory, node.children);
      }
    });
  };

  projectSections.forEach((section) => {
    section.groups.forEach((group) => {
      visitNodes(section.project.id, section.project.normalizedPath, group.directory, group.sessions);
    });
  });

  return { metaByProject, firstSessionByProject };
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const makeSession = (id: string, directory?: string): Session =>
  ({ id, directory } as unknown as Session);

const rootSession1 = makeSession('root-session-1', '/workspace/project');
const rootSession2 = makeSession('root-session-2', '/workspace/project');
const otherSession1 = makeSession('other-session-1', '/workspace/project/sub');

const project2Session1 = makeSession('project-2-session-1', '/workspace/project-2');
const project2Session2 = makeSession('project-2-session-2', '/workspace/project-2');

const SUB_PATH = '/workspace/project/sub';

const staleSections: ProjectSection[] = [
  {
    project: { id: 'project-1', normalizedPath: '/workspace/project' },
    groups: [
      {
        id: 'root',
        label: 'Main',
        branch: null,
        description: null,
        isMain: true,
        directory: '/workspace/project',
        sessions: [
          { session: rootSession1, children: [] },
          { session: rootSession2, children: [] },
        ],
      },
    ],
  },
];

const updatedSections: ProjectSection[] = [
  {
    project: { id: 'project-1', normalizedPath: '/workspace/project' },
    groups: [
      {
        id: 'root',
        label: 'Main',
        branch: null,
        description: null,
        isMain: true,
        directory: '/workspace/project',
        sessions: [
          { session: rootSession1, children: [] },
          { session: rootSession2, children: [] },
        ],
      },
      {
        id: 'sub-group',
        label: 'sub-folder',
        branch: null,
        description: null,
        isMain: false,
        directory: SUB_PATH,
        sessions: [
          { session: otherSession1, children: [] },
        ],
      },
    ],
  },
];

const project2Sections: ProjectSection[] = [
  {
    project: { id: 'project-2', normalizedPath: '/workspace/project-2' },
    groups: [
      {
        id: 'root',
        label: 'Main',
        branch: null,
        description: null,
        isMain: true,
        directory: '/workspace/project-2',
        sessions: [
          { session: project2Session1, children: [] },
          { session: project2Session2, children: [] },
        ],
      },
    ],
  },
];

describe('computeProjectMeta helper', () => {
  test('indexes all sessions in staleSections under project-1', () => {
    const { metaByProject, firstSessionByProject } = computeProjectMeta(staleSections);
    const p1Map = metaByProject.get('project-1')!;
    expect(p1Map).toBeDefined();
    expect(p1Map.has('root-session-1')).toBe(true);
    expect(p1Map.has('root-session-2')).toBe(true);
    expect(p1Map.has('other-session-1')).toBe(false);
    expect(firstSessionByProject.get('project-1')?.id).toBe('root-session-1');
  });

  test('indexes all sessions in updatedSections under project-1', () => {
    const { metaByProject } = computeProjectMeta(updatedSections);
    const p1Map = metaByProject.get('project-1')!;
    expect(p1Map).toBeDefined();
    expect(p1Map.has('root-session-1')).toBe(true);
    expect(p1Map.has('other-session-1')).toBe(true);
    expect(p1Map.get('other-session-1')?.directory).toBe(SUB_PATH);
  });

  test('indexes sessions under project-2', () => {
    const { metaByProject } = computeProjectMeta(project2Sections);
    const p2Map = metaByProject.get('project-2')!;
    expect(p2Map).toBeDefined();
    expect(p2Map.has('project-2-session-1')).toBe(true);
  });
});
