import React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { MiddleTruncate } from '@/components/ui/MiddleTruncate';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';
import { childDisplayPath, folderNameProblem, repositoryFolderName } from './addFolderNames';
import { DirectoryBrowserPane } from './DirectoryBrowserPane';
import { normalizeDirectoryPath, trimTrailingSeparators } from './directoryExplorerPaths';
import { type DirectoryExplorerDialogProps, focusPathInput, isPrimaryModifierPressed } from './directoryExplorerTypes';
import { useAddFolderSubmit } from './useAddFolderSubmit';
import { useDirectoryBrowser } from './useDirectoryBrowser';

type Step = 'source' | 'folder' | 'clone' | 'new';

const SOURCES: ReadonlyArray<{ step: Exclude<Step, 'source'>; icon: IconName; title: string; description: string }> = [
  {
    step: 'folder',
    icon: 'folder-6',
    title: 'Folder on this server',
    description: 'Add a folder that’s already here.',
  },
  {
    step: 'clone',
    icon: 'git-repository',
    title: 'Clone a repository',
    description: 'Copy a Git repository from a URL.',
  },
  {
    step: 'new',
    icon: 'folder-add',
    title: 'New project',
    description: 'Create an empty folder, with Git if you want it.',
  },
];

const STEP_TEXT: Record<Step, { title: string; description: string }> = {
  source: { title: 'Add folder', description: 'Where does the project come from?' },
  folder: {
    title: 'Folder on this server',
    description: 'Pick a folder or type its path. A folder that doesn’t exist yet is created.',
  },
  clone: {
    title: 'Clone a repository',
    description: 'The repository is cloned into a new folder inside the location you pick.',
  },
  new: { title: 'New project', description: 'The project gets a new folder inside the location you pick.' },
};

/** What the footer says about the step: the outcome, a hint, or what's wrong. */
type Outcome = { tone: 'outcome' | 'hint' | 'problem'; text: string; path?: string };

export const DirectoryExplorerDialog: React.FC<DirectoryExplorerDialogProps> = ({ open, onOpenChange }) => {
  const projects = useProjectsStore((s) => s.projects);
  const { isMobile, isTablet } = useDeviceInfo();
  const shouldSuppressAutoFocus = isMobile || isTablet;

  const [step, setStep] = React.useState<Step>('source');
  const [remoteUrl, setRemoteUrl] = React.useState('');
  const [projectName, setProjectName] = React.useState('');
  const [initGit, setInitGit] = React.useState(true);
  const sourceRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

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
    setRemoteUrl('');
    setProjectName('');
    setInitGit(true);
  }, [open]);

  // An error answers the input that caused it; editing anything retires it.
  React.useEffect(() => {
    clearError();
  }, [browser.query, clearError, projectName, remoteUrl, step]);

  React.useLayoutEffect(() => {
    if (!open || step !== 'source' || shouldSuppressAutoFocus) return;
    sourceRefs.current[0]?.focus({ preventScroll: true });
  }, [open, shouldSuppressAutoFocus, step]);

  const goBack = React.useCallback(() => {
    if (pending) return;
    setStep('source');
  }, [pending]);

  const existingNames = React.useMemo(() => new Set(browser.entries.map((entry) => entry.name)), [browser.entries]);
  const location = browser.browseDirectoryDisplayPath;
  const locationProblem: string | null = browser.browseErrorReason === 'not-found'
    ? 'Pick a location that exists.'
    : browser.browseErrorReason
      ? 'PiChamber can’t read this location.'
      : null;
  const browsing = browser.isLoading || browser.isPickingLocation;

  const cloneName = repositoryFolderName(remoteUrl);
  const newName = projectName.trim();
  const newNameProblem = newName ? folderNameProblem(newName) : null;

  let outcome: Outcome | null = null;
  let canSubmit = false;
  if (step === 'folder') {
    const display = trimTrailingSeparators(browser.query.trim());
    if (!browser.targetPath) {
      outcome = { tone: 'hint', text: 'Type a folder path.' };
    } else if (browser.isAlreadyAdded) {
      outcome = { tone: 'hint', text: 'Already added:', path: display };
    } else if (browser.browseErrorReason && browser.browseErrorReason !== 'not-found') {
      outcome = { tone: 'problem', text: 'PiChamber can’t read this folder.' };
    } else {
      outcome = { tone: 'outcome', text: browser.shouldCreateTarget ? 'Creates and adds' : 'Adds', path: display };
      canSubmit = !browsing;
    }
  } else if (step === 'clone') {
    if (!remoteUrl.trim()) {
      outcome = { tone: 'hint', text: 'Paste the repository’s HTTPS or SSH URL.' };
    } else if (!cloneName) {
      outcome = { tone: 'problem', text: 'This URL doesn’t name a repository.' };
    } else if (locationProblem) {
      outcome = { tone: 'problem', text: locationProblem };
    } else if (existingNames.has(cloneName)) {
      outcome = { tone: 'problem', text: 'Already exists:', path: childDisplayPath(location, cloneName) };
    } else {
      outcome = { tone: 'outcome', text: 'Clones into', path: childDisplayPath(location, cloneName) };
      canSubmit = !browsing;
    }
  } else if (step === 'new') {
    if (!newName) {
      outcome = { tone: 'hint', text: 'Name the project.' };
    } else if (newNameProblem) {
      outcome = { tone: 'problem', text: newNameProblem };
    } else if (locationProblem) {
      outcome = { tone: 'problem', text: locationProblem };
    } else if (existingNames.has(newName)) {
      outcome = { tone: 'problem', text: 'Already exists:', path: childDisplayPath(location, newName) };
    } else {
      outcome = {
        tone: 'outcome',
        text: initGit ? 'Creates a Git repository at' : 'Creates',
        path: childDisplayPath(location, newName),
      };
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
    } else if (step === 'clone') {
      void cloneRepository(remoteUrl, browser.browseDirectoryAbsolutePath);
    } else if (step === 'new') {
      void createProject(browser.browseDirectoryAbsolutePath, newName, initGit);
    }
  };

  const submitLabel = step === 'clone'
    ? pending ? 'Cloning…' : 'Clone and add'
    : step === 'new'
      ? pending ? 'Creating…' : 'Create project'
      : pending
        ? 'Adding…'
        : browser.shouldCreateTarget ? 'Create and add' : 'Add folder';
  const submitHint = step === 'clone' ? 'Clone' : step === 'new' ? 'Create' : 'Add';

  // In the URL and name fields Enter moves on to the location; the modifier
  // plus Enter finishes, as it does in the path field.
  const handleFieldKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (isPrimaryModifierPressed(event)) submit();
    else focusPathInput(browser.inputRef.current);
  };

  const handleSourceKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = sourceRefs.current.filter((button): button is HTMLButtonElement => Boolean(button));
    const index = buttons.findIndex((button) => button === document.activeElement);
    const next = event.key === 'ArrowDown'
      ? Math.min(buttons.length - 1, index + 1)
      : Math.max(0, index - 1);
    buttons[next]?.focus();
  };

  const sourceList = (
    <div className="-mx-2 flex flex-col gap-0.5" onKeyDown={handleSourceKeyDown}>
      {SOURCES.map((source, index) => (
        <button
          key={source.step}
          ref={(node) => {
            sourceRefs.current[index] = node;
          }}
          type="button"
          onClick={() => setStep(source.step)}
          className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-interactive-hover/50 focus-visible:bg-interactive-hover/50 focus-visible:outline-none"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--surface-muted)] text-muted-foreground">
            <Icon name={source.icon} className="size-4" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="typography-ui-label font-medium text-foreground">{source.title}</span>
            <span className="typography-meta text-muted-foreground">{source.description}</span>
          </span>
          <Icon name="arrow-right-s" className="size-4 shrink-0 text-subtle-foreground" />
        </button>
      ))}
    </div>
  );

  const pane = (inputLabel: string, autoFocus: boolean) => (
    <DirectoryBrowserPane
      browser={browser}
      inputLabel={inputLabel}
      submitHint={submitHint}
      onSubmit={submit}
      onBack={goBack}
      autoFocus={autoFocus && !shouldSuppressAutoFocus}
      disabled={pending !== null}
    />
  );

  const fieldLabelClass = 'typography-meta font-medium text-foreground';

  let body: React.ReactNode;
  if (step === 'source') {
    body = sourceList;
  } else if (step === 'folder') {
    body = pane('Folder path', true);
  } else if (step === 'clone') {
    body = (
      <>
        <label htmlFor="add-folder-remote-url" className={fieldLabelClass}>{'Repository URL'}</label>
        <Input
          id="add-folder-remote-url"
          value={remoteUrl}
          onChange={(event) => setRemoteUrl(event.target.value)}
          onKeyDown={handleFieldKeyDown}
          placeholder={'https://github.com/owner/repo.git'}
          autoFocus={!shouldSuppressAutoFocus}
          disabled={pending !== null}
          aria-invalid={outcome?.tone === 'problem' && !cloneName ? true : undefined}
          className="mt-1.5 font-mono md:typography-meta typography-meta"
        />
        <div className={cn(fieldLabelClass, 'mb-1.5 mt-4')}>{'Clone into'}</div>
        {pane('Location', false)}
      </>
    );
  } else {
    body = (
      <>
        <label htmlFor="add-folder-project-name" className={fieldLabelClass}>{'Name'}</label>
        <Input
          id="add-folder-project-name"
          value={projectName}
          onChange={(event) => setProjectName(event.target.value)}
          onKeyDown={handleFieldKeyDown}
          placeholder={'my-project'}
          autoFocus={!shouldSuppressAutoFocus}
          disabled={pending !== null}
          aria-invalid={newNameProblem ? true : undefined}
          className="mt-1.5"
        />
        <label className="mt-2.5 flex w-fit cursor-pointer items-center gap-2 typography-meta text-muted-foreground">
          <Checkbox checked={initGit} onChange={setInitGit} disabled={pending !== null} />
          {'Initialize a Git repository'}
        </label>
        <div className={cn(fieldLabelClass, 'mb-1.5 mt-4')}>{'Location'}</div>
        {pane('Location', false)}
      </>
    );
  }

  const status = error ? (
    <p role="alert" className="min-w-0 flex-1 typography-meta text-[var(--status-error)] text-pretty">{error}</p>
  ) : outcome ? (
    <p
      className={cn(
        'flex min-w-0 flex-1 items-baseline gap-1.5 typography-meta',
        outcome.tone === 'problem' ? 'text-[var(--status-error)]' : 'text-muted-foreground',
      )}
    >
      <span className="shrink-0">{outcome.text}</span>
      {outcome.path ? (
        <MiddleTruncate value={outcome.path} className="min-w-0 font-mono text-foreground" />
      ) : null}
    </p>
  ) : null;

  const submitButton = (
    <Button
      size={isMobile ? 'sm' : 'default'}
      onClick={submit}
      disabled={!canSubmit}
      className={cn('shrink-0', isMobile && 'w-full')}
    >
      {submitLabel}
    </Button>
  );

  const text = STEP_TEXT[step];
  const backButton = step !== 'source' ? (
    <Button
      variant="ghost"
      size="icon"
      className="-ml-1.5 size-7 shrink-0"
      onClick={goBack}
      disabled={pending !== null}
      aria-label={'Back to sources'}
      title={'Back'}
    >
      <Icon name="arrow-left-s" className="size-4" />
    </Button>
  ) : null;

  if (isMobile) {
    return (
      <MobileOverlayPanel
        open={open}
        onClose={handleClose}
        title={text.title}
        className="h-[88dvh] max-h-[720px]"
        contentMaxHeightClassName="flex-1"
        footer={step !== 'source' ? <div className="flex flex-col gap-2">{status}{submitButton}</div> : undefined}
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="mb-3 flex items-start gap-1.5">
            {backButton}
            <p className="typography-meta text-muted-foreground text-pretty">{text.description}</p>
          </div>
          {body}
        </div>
      </MobileOverlayPanel>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex w-full max-w-xl flex-col gap-0 overflow-hidden p-0 sm:max-h-[85vh]" initialFocus={false}>
        <div className="flex items-start gap-1.5 px-5 pb-3 pt-4">
          {backButton ? <div className="pt-0.5">{backButton}</div> : null}
          <div className="min-w-0 flex-1 pr-6">
            <DialogTitle className="typography-ui-header leading-7">{text.title}</DialogTitle>
            <DialogDescription className="typography-meta text-pretty">{text.description}</DialogDescription>
          </div>
        </div>
        <div className={cn('flex min-h-0 flex-1 flex-col px-5', step === 'source' ? 'pb-4' : 'pb-3')}>{body}</div>
        {step !== 'source' ? (
          <div className="flex items-center gap-3 border-t border-border/60 px-5 py-3">
            {status ?? <span className="flex-1" />}
            {submitButton}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
