import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/chat/types';
import type { SessionGroup, SessionNode } from '../types';
import type { ProjectSection } from './useSessionSidebarSections';
import {
  deriveActiveDirectoriesByProject,
  deriveSectionsForSidebarRender,
  deriveSessionCountByProject,
  deriveTotalSessionCount,
  hasActiveSessionInProject,
  hasUnseenInProject,
} from './useSidebarProjectMetadata';

const createMockNode = (id: string, directory = '/workspace'): SessionNode => ({
  session: {
    id,
    directory,
    title: `Session ${id}`,
    time: { created: Date.now(), updated: Date.now() },
  } satisfies Session,
  children: [],
});

describe('useSidebarProjectMetadata pure functions', () => {
  const node1 = createMockNode('s1');
  const node2 = createMockNode('s2');
  const node3 = createMockNode('s3');

  const regularGroup: SessionGroup = {
    id: 'grp1',
    label: 'Active Group',
    branch: null,
    description: null,
    isMain: true,
    directory: '/workspace',
    sessions: [node1, node2],
    isArchivedBucket: false,
  };

  const archivedGroup: SessionGroup = {
    id: 'archived',
    label: 'Archived',
    branch: null,
    description: null,
    isMain: false,
    directory: '/workspace',
    sessions: [node3],
    isArchivedBucket: true,
  };

  const section: ProjectSection = {
    project: {
      id: 'proj1',
      path: '/workspace',
      normalizedPath: '/workspace',
      label: 'Main Project',
    },
    groups: [regularGroup, archivedGroup],
  };

  test('deriveTotalSessionCount ignores archived buckets', () => {
    expect(deriveTotalSessionCount([section])).toBe(2);
  });

  test('deriveSessionCountByProject counts only active sessions per project', () => {
    const counts = deriveSessionCountByProject([section]);
    expect(counts.get('proj1')).toBe(2);
  });

  test('deriveSectionsForSidebarRender removes archived groups', () => {
    const rendered = deriveSectionsForSidebarRender([section]);
    expect(rendered[0].groups.length).toBe(1);
    expect(rendered[0].groups[0].id).toBe('grp1');
  });

  test('hasActiveSessionInProject checks active session membership', () => {
    expect(hasActiveSessionInProject(section, new Set(['s1']))).toBe(true);
    expect(hasActiveSessionInProject(section, new Set(['s3']))).toBe(false); // in archived
    expect(hasActiveSessionInProject(section, new Set(['other']))).toBe(false);
  });

  test('hasUnseenInProject checks unseen session membership', () => {
    expect(hasUnseenInProject(section, new Set(['s2']))).toBe(true);
    expect(hasUnseenInProject(section, new Set(['none']))).toBe(false);
  });

  test('deriveActiveDirectoriesByProject maps active directory paths', () => {
    const activeDirs = deriveActiveDirectoriesByProject([section], new Set(['s1']));
    expect(activeDirs.get('proj1')?.has('/workspace')).toBe(true);
  });
});
