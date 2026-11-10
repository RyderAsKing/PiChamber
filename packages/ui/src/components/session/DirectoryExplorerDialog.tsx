import React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { MiddleTruncate } from '@/components/ui/MiddleTruncate';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';
import { childDisplayPath, folderNameProblem, repositoryFolderName } from './addFolderNames';
import { type KeyHint, Kbd, KeyHints } from '@/components/ui/KeyHints';
import { PaletteRow } from './AddFolderPaletteParts';
import { normalizeDirectoryPath, normalizeSeparators, trimTrailingSeparators } from './directoryExplorerPaths';
import {
  type BrowseRow,
  type DirectoryExplorerDialogProps,
  focusPathInput,
  isPrimaryModifierPressed,
  primaryModifierLabel,
} from './directoryExplorerTypes';
import { useAddFolderSubmit } from './useAddFolderSubmit';
import { useDirectoryBrowser } from './useDirectoryBrowser';

/**
 * The dialog keeps one frame, a field over a list over key hints, and each
 * step only changes what the field holds and what the list shows. Clone and
 * New project ask their question first, then pick the location.
 */
type Step = 'source' | 'folder' | 'clone-url' | 'clone-location' | 'new-name' | 'new-location';
type BrowseStep = Extract<Step, 'folder' | 'clone-location' | 'new-location'>;

const PREVIOUS_STEP: Record<Exclude<Step, 'source'>, Step> = {
  folder: 'source',
  'clone-url': 'source',
  'clone-location': 'clone-url',
  'new-name': 'source',
  'new-location': 'new-name',
};

const isBrowseStep = (step: Step): step is BrowseStep =>
  step === 'folder' || step === 'clone-location' || step === 'new-location';

const SOURCES: ReadonlyArray<{ step: Step; icon: IconName; title: string; description: string }> = [
  {
    step: 'folder',
    icon: 'folder-6',
    title: 'Folder on this server',
    description: 'Pick a folder that’s already here.',
  },
  {
    step: 'clone-url',
    icon: 'download-cloud',
    title: 'Clone a repository',
    description: 'Copy a Git repository from a URL.',
  },
  {
    step: 'new-name',
    icon: 'folder-add',
    title: 'New project',
    description: 'Start an empty folder, with Git if you want it.',
  },
];

/** The task a step belongs to, kept in the header so each step says what it is for. */
const STEP_TASK: Record<Exclude<Step, 'source'>, string> = {
  folder: 'Open folder',
  'clone-url': 'Clone',
  'clone-location': 'Clone',
  'new-name': 'New project',
  'new-location': 'New project',
};

const STEP_DESCRIPTION: Record<Step, string> = {
  source: 'Choose where the project comes from, type a folder path, or paste a Git URL.',
  folder: 'Pick a folder on this server or type its path.',
  'clone-url': 'Paste the URL of the repository to clone.',
  'clone-location': 'Pick the folder the repository is cloned into.',
  'new-name': 'Name the new project.',
  'new-location': 'Pick the folder the new project goes in.',
};

const INPUT_LABEL: Record<Step, string> = {
  source: 'Filter sources, type a folder path, or paste a Git URL',
  folder: 'Folder path',
  'clone-url': 'Repository URL',
  'clone-location': 'Location',
  'new-name': 'Project name',
  'new-location': 'Location',
};

const INPUT_PLACEHOLDER: Record<Step, string> = {
  source: 'Choose a source, type a path, or paste a Git URL',
  folder: '~/',
  'clone-url': 'https://github.com/owner/repo.git',
  'clone-location': '~/',
  'new-name': 'Project name',
  'new-location': '~/',
};

/** Typing one of these into the first step skips straight to that source. */
const looksLikePath = (value: string) => /^(~|\/|[a-zA-Z]:[\\/])/.test(value);
const looksLikeGitUrl = (value: string) =>
  /^(https?:\/\/|ssh:\/\/|git:\/\/|git@)/i.test(value) || /^[\w.-]+@[\w.-]+:/.test(value);

type Item = {
  key: string;
  kind: 'source' | 'toggle' | 'parent' | 'directory';
  select: () => void;
  content: React.ReactNode;
  ariaLabel?: string;
  ariaChecked?: boolean;
};

const folderNameOf = (path: string) => trimTrailingSeparators(normalizeSeparators(path)).split('/').pop() ?? '';

export const DirectoryExplorerDialog: React.FC<DirectoryExplorerDialogProps> = ({ open, onOpenChange }) => {
  const projects = useProjectsStore((s) => s.projects);
  const { isMobile, isTablet } = useDeviceInfo();
  const isTouchLayout = isMobile || isTablet;

  const [step, setStep] = React.useState<Step>('source');
  const [sourceFilter, setSourceFilter] = React.useState('');
  const [remoteUrl, setRemoteUrl] = React.useState('');
  const [projectName, setProjectName] = React.useState('');
  const [initGit, setInitGit] = React.useState(true);
  const [highlightKey, setHighlightKey] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const rowRefs = React.useRef(new Map<string, HTMLDivElement>());
  const listId = React.useId();

  const addedProjectPaths = React.useMemo(
    () =>
      new Set(
        projects
          .map((project) => normalizeDirectoryPath(project.path))
          .filter((path): path is string => Boolean(path)),
      ),
    [projects],
  );

  const handleClose = React.useCallback(() => onOpenChange(false), [onOpenChange]);

  const browser = useDirectoryBrowser({ open, addedProjectPaths });
  const { pending, error, clearError, addFolder, cloneRepository, createProject } = useAddFolderSubmit({
    open,
    onClose: handleClose,
    isMobile,
  });

  React.useEffect(() => {
    if (!open) return;
    setStep('source');
    setSourceFilter('');
    setRemoteUrl('');
    setProjectName('');
    setInitGit(true);
    setHighlightKey(null);
  }, [open]);

  // An error answers the input that caused it; editing anything retires it.
  React.useEffect(() => {
    clearError();
  }, [browser.query, clearError, projectName, remoteUrl, step]);

  // The field stays put across steps; each step hands it focus again. On a
  // touch screen only the steps that need typing raise the keyboard.
  React.useLayoutEffect(() => {
    if (!open) return;
    if (isTouchLayout && step !== 'clone-url' && step !== 'new-name') return;
    focusPathInput(inputRef.current);
  }, [isTouchLayout, open, step]);

  const goTo = React.useCallback((next: Step) => {
    setStep(next);
    setHighlightKey(null);
  }, []);

  const goBack = React.useCallback(() => {
    if (pending || step === 'source') return;
    goTo(PREVIOUS_STEP[step]);
  }, [goTo, pending, step]);

  const { navigate } = browser;
  const openRow = React.useCallback(
    (row: BrowseRow) => {
      // Going up lands on the folder just left, so Enter goes back into it.
      const landOn = row.type === 'parent' ? `dir:${folderNameOf(row.path)}` : null;
      void navigate(row.target).then((committed) => {
        if (committed) setHighlightKey(landOn);
      });
    },
    [navigate],
  );

  // What the step would do, and whether it can.
  const existingNames = React.useMemo(() => new Set(browser.entries.map((entry) => entry.name)), [browser.entries]);
  const location = browser.browseDirectoryDisplayPath;
  const locationProblem: string | null = browser.browseErrorReason === 'not-found'
    ? 'This folder doesn’t exist. Pick a location that does.'
    : browser.browseErrorReason
      ? 'PiChamber can’t read this location.'
      : null;
  const browsing = !browser.isSettled || browser.isPickingLocation;

  const cloneName = repositoryFolderName(remoteUrl);
  const newName = projectName.trim();
  const newNameProblem = folderNameProblem(newName);

  let canSubmit = false;
  let submitVerb = '';
  let pendingLabel = '';
  /** Location steps: what finishing does, or why it can't. */
  let summary: { tone: 'outcome' | 'problem'; text: string; path?: string } | null = null;

  if (step === 'folder') {
    pendingLabel = 'Adding…';
    // Named like the other location steps, so the highlighted folder in the
    // list never reads as the one being added.
    const target = trimTrailingSeparators(browser.query.trim()) || browser.query.trim();
    if (browser.isAlreadyAdded) {
      submitVerb = 'Added';
      if (target) summary = { tone: 'outcome', text: 'Already added:', path: target };
    } else {
      submitVerb = browser.shouldCreateTarget ? 'Create and add' : 'Add';
      const unreadable = browser.browseErrorReason && browser.browseErrorReason !== 'not-found';
      canSubmit = Boolean(browser.targetPath) && !unreadable && !browsing;
      if (target && !unreadable) {
        summary = { tone: 'outcome', text: browser.shouldCreateTarget ? 'Creates and adds' : 'Adds', path: target };
      }
    }
  } else if (step === 'clone-location') {
    submitVerb = 'Clone';
    pendingLabel = 'Cloning…';
    const target = childDisplayPath(location, cloneName);
    if (locationProblem) {
      summary = { tone: 'problem', text: locationProblem };
    } else if (existingNames.has(cloneName)) {
      summary = { tone: 'problem', text: 'Already exists:', path: target };
    } else {
      summary = { tone: 'outcome', text: 'Clones into', path: target };
      canSubmit = Boolean(cloneName) && !browsing;
    }
  } else if (step === 'new-location') {
    submitVerb = 'Create';
    pendingLabel = 'Creating…';
    const target = childDisplayPath(location, newName);
    if (locationProblem) {
      summary = { tone: 'problem', text: locationProblem };
    } else if (newNameProblem) {
      summary = { tone: 'problem', text: newNameProblem, path: target };
    } else if (existingNames.has(newName)) {
      summary = { tone: 'problem', text: 'Already exists:', path: target };
    } else {
      summary = { tone: 'outcome', text: 'Creates', path: target };
      canSubmit = !browsing;
    }
  }
  canSubmit = canSubmit && pending === null;

  const submit = () => {
    if (!canSubmit) return;
    if (step === 'folder') {
      void addFolder(browser.targetPath, {
        create: browser.shouldCreateTarget,
        location: browser.browseDirectoryAbsolutePath,
      });
    } else if (step === 'clone-location') {
      void cloneRepository(remoteUrl, browser.browseDirectoryAbsolutePath);
    } else if (step === 'new-location') {
      void createProject(browser.browseDirectoryAbsolutePath, newName, initGit);
    }
  };

  const canContinue = step === 'clone-url'
    ? Boolean(cloneName)
    : step === 'new-name'
      ? Boolean(newName) && !newNameProblem
      : false;
  const continueToLocation = () => {
    if (!canContinue) return;
    goTo(step === 'clone-url' ? 'clone-location' : 'new-location');
  };

  // The list: sources, or the folders under the path field.
  const items: Item[] = [];
  if (step === 'source') {
    const filter = sourceFilter.trim().toLowerCase();
    for (const source of SOURCES) {
      if (filter && !`${source.title} ${source.description}`.toLowerCase().includes(filter)) continue;
      items.push({
        key: `source:${source.step}`,
        kind: 'source',
        select: () => goTo(source.step),
        content: (
          <>
            <Icon name={source.icon} className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col py-0.5">
              <span className="truncate">{source.title}</span>
              <span className="truncate typography-meta text-muted-foreground">{source.description}</span>
            </span>
          </>
        ),
      });
    }
  } else if (isBrowseStep(step)) {
    if (step === 'new-location') {
      items.push({
        key: 'toggle:git',
        kind: 'toggle',
        select: () => setInitGit((value) => !value),
        ariaChecked: initGit,
        ariaLabel: 'Initialize a Git repository',
        content: (
          <>
            <span className="pointer-events-none flex size-4 shrink-0 items-center justify-center">
              <Checkbox checked={initGit} onChange={setInitGit} />
            </span>
            <span className="flex-1 truncate">{'Initialize a Git repository'}</span>
          </>
        ),
      });
    }
    for (const row of browser.rows) {
      const isParent = row.type === 'parent';
      items.push({
        key: isParent ? 'browse:up' : `dir:${row.name}`,
        kind: isParent ? 'parent' : 'directory',
        select: () => openRow(row),
        ariaLabel: isParent
          ? `Up to ${row.target}`
          : `${row.name}${row.alreadyAdded ? ', already added' : ''}`,
        content: (
          <>
            <Icon
              name={isParent ? 'arrow-up-s' : 'folder-6'}
              className="size-4 shrink-0 text-muted-foreground"
            />
            {isParent ? (
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="shrink-0">{'Up to'}</span>
                <MiddleTruncate value={row.target} className="min-w-0 font-mono typography-meta text-muted-foreground" />
              </span>
            ) : (
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
            )}
            {!isParent && row.alreadyAdded ? (
              <span className="shrink-0 typography-micro text-muted-foreground">{'Added'}</span>
            ) : null}
          </>
        ),
      });
    }
  }

  const defaultIndex = isBrowseStep(step)
    ? items.findIndex((item) => item.kind === 'directory')
    : items.length > 0 ? 0 : -1;
  const explicitIndex = highlightKey ? items.findIndex((item) => item.key === highlightKey) : -1;
  const activeIndex = explicitIndex >= 0 ? explicitIndex : defaultIndex;
  const activeItem = activeIndex >= 0 ? items[activeIndex] : undefined;
  const activeKey = activeItem?.key;
  const optionId = (index: number) => `${listId}-option-${index}`;

  React.useLayoutEffect(() => {
    if (!activeKey) return;
    rowRefs.current.get(activeKey)?.scrollIntoView({ block: 'nearest' });
  }, [activeKey]);

  const moveHighlight = (delta: number) => {
    if (items.length === 0) return;
    const from = activeIndex >= 0 ? activeIndex : delta > 0 ? -1 : items.length;
    const next = Math.min(items.length - 1, Math.max(0, from + delta));
    setHighlightKey(items[next]?.key ?? null);
  };

  const inputValue = step === 'source'
    ? sourceFilter
    : step === 'clone-url'
      ? remoteUrl
      : step === 'new-name'
        ? projectName
        : browser.query;

  const handleChange = (value: string) => {
    setHighlightKey(null);
    if (step === 'source') {
      const typed = value.trimStart();
      if (looksLikeGitUrl(typed)) {
        setSourceFilter('');
        setRemoteUrl(typed);
        goTo('clone-url');
        return;
      }
      if (looksLikePath(typed)) {
        setSourceFilter('');
        browser.setQuery(typed === '~' ? '~/' : normalizeSeparators(typed));
        goTo('folder');
        return;
      }
      setSourceFilter(value);
      return;
    }
    if (step === 'clone-url') {
      setRemoteUrl(value);
      return;
    }
    if (step === 'new-name') {
      setProjectName(value);
      return;
    }
    browser.setQuery(normalizeSeparators(value).replace(/\/{2,}/g, '/'));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (items.length === 0) return;
      event.preventDefault();
      moveHighlight(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (pending) return;
      if (isBrowseStep(step) && isPrimaryModifierPressed(event)) {
        submit();
        return;
      }
      if (step === 'clone-url' || step === 'new-name') {
        continueToLocation();
        return;
      }
      if (activeItem) activeItem.select();
      else if (isBrowseStep(step)) submit();
      return;
    }
    if (event.key === 'Tab' && !event.shiftKey && activeItem?.kind === 'directory') {
      // Tab completes the path to the highlighted folder.
      event.preventDefault();
      activeItem.select();
      return;
    }
    if (event.key === 'Backspace' && inputValue === '' && step !== 'source') {
      event.preventDefault();
      goBack();
    }
  };

  // Key hints say what the keys do right now.
  const mod = primaryModifierLabel();
  const hints: KeyHint[] = [];
  if (items.length > 1) hints.push({ keys: ['↑', '↓'], label: 'Navigate' });
  if (step === 'source') {
    if (activeItem) hints.push({ keys: ['↵'], label: 'Select' });
  } else if (step === 'clone-url' || step === 'new-name') {
    hints.push({ keys: ['↵'], label: 'Continue' });
  } else if (activeItem) {
    // The finishing button carries its own shortcut, so the footer only
    // explains the list keys.
    hints.push({ keys: ['↵'], label: activeItem.kind === 'toggle' ? 'Toggle' : 'Open' });
  } else {
    hints.push({ keys: ['↵'], label: submitVerb });
  }
  if (step !== 'source' && inputValue === '') hints.push({ keys: ['⌫'], label: 'Back' });
  hints.push({ keys: ['Esc'], label: 'Close', onSelect: () => onOpenChange(false) });

  const submitKeys = isBrowseStep(step) && activeItem ? [mod, '↵'] : ['↵'];

  let actionButton: React.ReactNode = null;
  if (isBrowseStep(step)) {
    // The step that finishes the flow gets the primary button.
    actionButton = (
      <Button
        variant="solid"
        size="sm"
        className="shrink-0 gap-1.5"
        disabled={!canSubmit}
        onMouseDown={(event) => event.preventDefault()}
        onClick={submit}
      >
        {pending ? pendingLabel : submitVerb}
        {!isMobile && !pending && canSubmit ? (
          <span className="flex items-center gap-0.5">
            {submitKeys.map((key) => (
              <Kbd key={key} className="border-current/30 bg-transparent text-current">{key}</Kbd>
            ))}
          </span>
        ) : null}
      </Button>
    );
  } else if (step === 'clone-url' || step === 'new-name') {
    // The only way forward from this step, so it is primary as well.
    actionButton = (
      <Button
        variant="solid"
        size="sm"
        className="shrink-0 gap-1.5"
        disabled={!canContinue}
        onMouseDown={(event) => event.preventDefault()}
        onClick={continueToLocation}
      >
        {'Continue'}
        {!isMobile && canContinue ? <Kbd className="border-current/30 bg-transparent text-current">{'↵'}</Kbd> : null}
      </Button>
    );
  }

  // What the list area says when it has no rows, or after the last folder.
  let notice: { tone: 'quiet' | 'problem'; text: React.ReactNode; actions?: React.ReactNode } | null = null;
  const directoryCount = items.filter((item) => item.kind === 'directory').length;
  if (step === 'source' && items.length === 0) {
    notice = { tone: 'quiet', text: 'Nothing matches. Type a folder path, or paste a Git URL.' };
  } else if (step === 'clone-url') {
    if (!remoteUrl.trim()) {
      notice = { tone: 'quiet', text: 'Paste the repository’s HTTPS or SSH URL, then press Enter to choose where it goes.' };
    } else if (!cloneName) {
      notice = { tone: 'problem', text: 'This URL doesn’t name a repository.' };
    } else {
      notice = { tone: 'quiet', text: <>{'Clones as '}<span className="font-mono text-foreground">{cloneName}</span>{'. Press Enter to choose where it goes.'}</> };
    }
  } else if (step === 'new-name') {
    if (!newName) {
      notice = { tone: 'quiet', text: 'Name the project, then press Enter to choose where it goes.' };
    } else if (newNameProblem) {
      notice = { tone: 'problem', text: newNameProblem };
    } else {
      notice = { tone: 'quiet', text: <>{'Press Enter to choose where '}<span className="font-mono text-foreground">{newName}</span>{' goes.'}</> };
    }
  } else if (isBrowseStep(step)) {
    if (browser.browseErrorReason === 'not-found') {
      notice = step === 'folder'
        ? { tone: 'quiet', text: 'This folder doesn’t exist yet. Adding it creates it.' }
        : { tone: 'problem', text: 'This folder doesn’t exist. Pick a location that does.' };
    } else if (browser.browseErrorReason) {
      notice = {
        tone: 'problem',
        text: browser.browseErrorReason === 'os-permission'
          ? 'PiChamber needs access to this folder.'
          : 'Couldn’t read this folder.',
        actions: (
          <>
            {browser.browseErrorReason === 'os-permission' && browser.canRequestAccess ? (
              <Button size="xs" onClick={() => void browser.handleBrowseLocation()} disabled={browser.isPickingLocation}>
                {'Grant access'}
              </Button>
            ) : null}
            <Button variant="outline" size="xs" onClick={browser.reload}>
              {'Try again'}
            </Button>
          </>
        ),
      };
    } else if (browser.showLoading && directoryCount === 0) {
      notice = { tone: 'quiet', text: 'Loading folders…' };
    } else if (browser.isSettled && directoryCount === 0) {
      notice = {
        tone: 'quiet',
        text: browser.browseFilterQuery
          ? step === 'folder'
            ? <>{'No folder named '}<span className="font-mono text-foreground">{browser.browseFilterQuery}</span>{' here. Adding it creates it.'}</>
            : 'No folders match.'
          : 'No folders in here.',
      };
    }
  }

  const status = error ? (
    <p role="alert" className="border-b border-border/60 px-4 py-2 typography-meta text-[var(--status-error)] text-pretty">
      {error}
    </p>
  ) : null;

  // The answer from the step before stays editable from here: its line ends
  // in a button that goes back to it.
  const editEarlierAnswer = (label: string, ariaLabel: string) => (
    <button
      type="button"
      onClick={goBack}
      disabled={pending !== null}
      aria-label={ariaLabel}
      className="ml-auto shrink-0 rounded px-1 typography-ui-label text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:pointer-events-none disabled:opacity-50"
    >
      {label}
    </button>
  );

  const summaryStrip = summary ? (
    <div className="flex flex-col gap-1 border-b border-border/60 px-4 py-2">
      {/* The new folder's name stays a field here, labeled, above where it ends up. */}
      {step === 'new-location' ? (
        <div className="flex min-w-0 items-center gap-2 typography-ui-label">
          <label htmlFor="new-project-name" className="shrink-0 text-muted-foreground">{'Name'}</label>
          <input
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
            id="new-project-name"
            spellCheck={false}
            autoComplete="off"
            disabled={pending !== null}
            className="h-7 min-w-0 flex-1 rounded-md border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-1.5 font-mono text-foreground outline-none focus-visible:border-[var(--interactive-focus)] focus-visible:ring-2 focus-visible:ring-primary/30"
          />
        </div>
      ) : null}
      <p
        className={cn(
          'flex min-w-0 items-baseline gap-1.5 typography-ui-label',
          summary.tone === 'problem' ? 'text-[var(--status-error)]' : 'text-muted-foreground',
        )}
      >
        <span className="shrink-0">{summary.text}</span>
        {summary.path ? <MiddleTruncate value={summary.path} className="min-w-0 font-mono text-foreground" /> : null}
      </p>
      {/* The repository reads like the destination above it: a label, then the value. */}
      {step === 'clone-location' ? (
        <p className="flex min-w-0 items-baseline gap-1.5 typography-ui-label text-muted-foreground">
          <span className="shrink-0">{'From'}</span>
          <MiddleTruncate value={remoteUrl.trim()} className="min-w-0 font-mono text-foreground" />
          {editEarlierAnswer('Change', 'Change the repository URL')}
        </p>
      ) : null}
    </div>
  ) : null;

  const usesMono = step !== 'source' && step !== 'new-name';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        initialFocus={isTouchLayout ? false : inputRef}
        className={cn(
          'group/palette w-full max-w-xl gap-0 self-start overflow-hidden rounded-2xl p-0',
          // Anchored near the top: when the list grows, only the bottom edge moves.
          'mt-[max(env(safe-area-inset-top),0.25rem)] max-h-[calc(100%-0.5rem)] sm:mt-[10vh] sm:max-h-[80vh]',
        )}
      >
        <DialogTitle className="sr-only">{'Add folder'}</DialogTitle>
        <DialogDescription className="sr-only">{STEP_DESCRIPTION[step]}</DialogDescription>

        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 pl-2.5 pr-2">
          {step === 'source' ? (
            <span className="flex size-7 shrink-0 items-center justify-center text-muted-foreground">
              <Icon name="folder-add" className="size-4" />
            </span>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onMouseDown={(event) => event.preventDefault()}
              onClick={goBack}
              disabled={pending !== null}
              aria-label={'Back'}
              title={'Back'}
            >
              <Icon name="arrow-left-s" className="size-4" />
            </Button>
          )}
          {step !== 'source' ? (
            <span className="flex shrink-0 items-center gap-2 typography-ui-label font-medium text-foreground" aria-hidden="true">
              {STEP_TASK[step]}
              <span className="h-4 w-px bg-border" />
            </span>
          ) : null}
          <input
            ref={inputRef}
            value={inputValue}
            onChange={(event) => handleChange(event.target.value)}
            onKeyDown={handleKeyDown}
            readOnly={pending !== null}
            aria-busy={pending !== null || undefined}
            aria-label={INPUT_LABEL[step]}
            placeholder={INPUT_PLACEHOLDER[step]}
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            aria-invalid={notice?.tone === 'problem' && !isBrowseStep(step) ? true : undefined}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            className={cn(
              'min-w-0 flex-1 text-foreground outline-none placeholder:text-muted-foreground',
              // Past the source list the field is something you type into, so it
              // looks like a field rather than a breadcrumb.
              step === 'source'
                ? 'h-full bg-transparent'
                : 'h-8 rounded-md border border-[var(--interactive-border)] bg-[var(--surface-muted)] px-2',
              'typography-markdown md:typography-ui-label',
              usesMono && 'font-mono',
            )}
          />
          {actionButton}
        </div>

        {summaryStrip}
        {status}

        <div className="min-h-0 overflow-y-auto overscroll-contain sm:max-h-[min(24rem,52vh)]">
          {items.length > 0 ? (
            <div id={listId} role="listbox" aria-label={step === 'source' ? 'Sources' : 'Folders'} className="flex flex-col gap-px p-1.5">
              {items.map((item, index) => (
                <React.Fragment key={item.key}>
                  {index > 0 && items[index - 1]?.kind === 'toggle' ? (
                    <div role="presentation" className="mx-2.5 my-1 h-px bg-border/60" />
                  ) : null}
                  <PaletteRow
                    ref={(node) => {
                      if (node) rowRefs.current.set(item.key, node);
                      else rowRefs.current.delete(item.key);
                    }}
                    id={optionId(index)}
                    active={index === activeIndex}
                    onSelect={item.select}
                    onHover={() => setHighlightKey(item.key)}
                    ariaLabel={item.ariaLabel}
                    ariaChecked={item.ariaChecked}
                    className={item.kind === 'source' ? 'py-2' : undefined}
                    quiet={isBrowseStep(step)}
                  >
                    {item.content}
                  </PaletteRow>
                </React.Fragment>
              ))}
            </div>
          ) : null}
          {notice ? (
            <div className={cn('flex flex-col items-center gap-3 px-6 text-center', items.length > 0 ? 'pb-6 pt-3' : 'py-8')}>
              <p
                className={cn(
                  'typography-meta text-balance',
                  notice.tone === 'problem' ? 'text-[var(--status-error)]' : 'text-muted-foreground',
                )}
              >
                {notice.text}
              </p>
              {notice.actions ? <div className="flex items-center gap-2">{notice.actions}</div> : null}
            </div>
          ) : null}
        </div>

        {!isMobile || isBrowseStep(step) ? (
          <div className="flex min-h-10 shrink-0 items-center justify-between gap-3 border-t border-border/60 bg-[var(--surface-muted)]/40 px-3 py-2 typography-micro text-muted-foreground">
            {!isMobile ? <KeyHints hints={hints} /> : <span />}
            {isBrowseStep(step) ? (
              <span className="flex shrink-0 items-center gap-3">
                <label className="flex cursor-pointer items-center gap-1.5">
                  <Checkbox checked={browser.showHidden} onChange={browser.setShowHidden} ariaLabel={'Show hidden folders'} />
                  {'Hidden'}
                </label>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={pending !== null || browser.isPickingLocation}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void browser.handleBrowseLocation()}
                  title={'Pick a folder with the system dialog'}
                >
                  {browser.isPickingLocation ? 'Opening…' : 'Browse…'}
                </Button>
              </span>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
