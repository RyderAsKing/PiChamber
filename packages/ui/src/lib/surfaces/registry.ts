import type { IconName } from '@/components/icon/icons';
import type { ContextPanelMode } from '@/stores/useUIStore';

export type ContextSurfaceId =
  | 'editor'
  | 'git'
  | 'pr'
  | 'diff'
  | 'walkthrough'
  | 'terminal'
  | 'notes'
  | 'context'
  | 'browser'
  | 'preview'
  | 'chat';

export type ContextSurfaceDescriptor = {
  id: ContextSurfaceId;
  /** The context panel tab mode this surface activates. 1:1 in the current model. */
  mode: ContextPanelMode;
  icon: IconName;
  label: string;
  /**
   * 'always' surfaces can be opened empty from the rail.
   * 'has-content' surfaces are content-driven: they need an existing tab of
   * their mode (a preview URL emitted, a split session) and stay hidden on
   * the rail until one exists.
   */
  availability: 'always' | 'has-content';
  /** Short tooltip explanation shown on the rail. */
  description: string;
  /**
   * Default panel width as a fraction of the available content area, used
   * until the user manually resizes this surface.
   */
  defaultWidthFraction: number;
};

export const CONTEXT_SURFACES: readonly ContextSurfaceDescriptor[] = [
  {
    id: 'context',
    description: "Session context and token usage",
    defaultWidthFraction: 0.45,
    mode: 'context',
    icon: 'donut-chart-fill',
    label: "Context",
    availability: 'always',
  },
  {
    id: 'git',
    description: "Commits, branches, and pull requests",
    defaultWidthFraction: 2 / 5,
    mode: 'git',
    icon: 'git-branch',
    label: "Git",
    availability: 'always',
  },
  {
    id: 'pr',
    description: "Create, review, and merge the pull request for the current branch",
    defaultWidthFraction: 0.45,
    mode: 'pr',
    icon: 'github',
    label: "Pull Request",
    availability: 'always',
  },
  {
    id: 'diff',
    description: "Review working changes",
    defaultWidthFraction: 3 / 5,
    mode: 'diff',
    icon: 'arrow-left-right',
    label: "Changes",
    availability: 'always',
  },
  {
    id: 'walkthrough',
    description: "An AI-guided walkthrough of your changes",
    defaultWidthFraction: 3 / 5,
    mode: 'walkthrough',
    icon: 'route',
    label: "Walkthrough",
    availability: 'always',
  },
  {
    id: 'editor',
    description: "Edit project files",
    defaultWidthFraction: 3 / 5,
    mode: 'file',
    icon: 'braces',
    label: "Files",
    availability: 'always',
  },
  {
    id: 'terminal',
    description: "Built-in terminal",
    defaultWidthFraction: 3 / 5,
    mode: 'terminal',
    icon: 'terminal-box',
    label: "Terminal",
    availability: 'always',
  },
  {
    id: 'notes',
    description: "Notes, todos, and plans for the project",
    defaultWidthFraction: 1 / 3,
    mode: 'notes',
    icon: 'sticky-note',
    label: "Project notes",
    availability: 'always',
  },

  {
    id: 'browser',
    description: "Built-in web browser",
    defaultWidthFraction: 0.45,
    mode: 'browser',
    icon: 'global',
    label: "Browser",
    availability: 'always',
  },
  {
    id: 'preview',
    description: "Dev server preview",
    defaultWidthFraction: 0.45,
    mode: 'preview',
    icon: 'window',
    label: "Preview",
    availability: 'has-content',
  },
  {
    id: 'chat',
    description: "Session opened side by side",
    defaultWidthFraction: 0.45,
    mode: 'chat',
    icon: 'chat-4',
    label: "Chat",
    availability: 'has-content',
  },
];

const SURFACE_BY_ID = new Map(CONTEXT_SURFACES.map((surface) => [surface.id, surface]));
const FRACTION_BY_MODE = new Map(CONTEXT_SURFACES.map((surface) => [surface.mode, surface.defaultWidthFraction]));

// Tablet width and up: below this the walkthrough cannot show a stop and its
// code side by side, which is the whole point of the surface.

export const getContextSurfaceWidthFraction = (mode: ContextPanelMode): number => {
  return FRACTION_BY_MODE.get(mode) ?? 1 / 2;
};

const isContextSurfaceId = (value: unknown): value is ContextSurfaceId => {
  return typeof value === 'string' && SURFACE_BY_ID.has(value as ContextSurfaceId);
};

/**
 * Applies a persisted user reorder on top of the default registry order:
 * unknown ids are dropped, missing surfaces are appended in default order.
 */
export const sortContextSurfaces = (railOrder: readonly string[]): ContextSurfaceDescriptor[] => {
  const ordered: ContextSurfaceDescriptor[] = [];
  const seen = new Set<ContextSurfaceId>();

  for (const id of railOrder) {
    if (!isContextSurfaceId(id) || seen.has(id)) {
      continue;
    }
    const surface = SURFACE_BY_ID.get(id);
    if (surface) {
      seen.add(id);
      ordered.push(surface);
    }
  }

  for (const surface of CONTEXT_SURFACES) {
    if (!seen.has(surface.id)) {
      ordered.push(surface);
    }
  }

  return ordered;
};

type VisibleRailSurfacesOptions = {
  railOrder: readonly string[];
  screenWidth: number;
  tabs: readonly { mode: ContextPanelMode }[];
};

/**
 * The context panel rail's visible, user-ordered surfaces. Shared by the rail
 * (for rendering and number badges) and the global surface-switch shortcut so
 * both agree on which surface each digit maps to.
 *
 * Content-driven surfaces are hidden (not disabled) until content exists; an
 * existing tab keeps them visible even if the content source went away.
 */
export const getVisibleContextRailSurfaces = (options: VisibleRailSurfacesOptions): ContextSurfaceDescriptor[] => {
  return sortContextSurfaces(options.railOrder).filter((surface) => {
    if (surface.id === 'walkthrough') {
      return false;
    }
    if (surface.availability === 'has-content') {
      return options.tabs.some((tab) => tab.mode === surface.mode);
    }
    return true;
  });
};
