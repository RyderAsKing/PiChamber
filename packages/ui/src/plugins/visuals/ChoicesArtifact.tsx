import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { PluginQuestion, TurnArtifactProps } from '@/plugins/types';
import {
  choiceLetter,
  choicesFromInput,
  choicesFromQuestion,
  choicesInputSize,
  parseChoiceDetails,
  shownChoice,
  type ChoiceDetails,
  type ChoiceOption,
} from './choices';
import { useAllowNetwork } from './useAllowNetwork';
import { useNearViewport, usePageDocument } from './frameHooks';
import { PageFrame, VisualDrawing, VisualExpandDialog, type FrameView } from './VisualFrame';

/**
 * A variant's page is as tall as it asks for, within these bounds. One
 * variant shows at a time at the chat's full width.
 */
const MIN_PAGE_HEIGHT = 120;
const MAX_PAGE_HEIGHT = 560;
const PLACEHOLDER_HEIGHT = 240;
const MAX_NOTE_CHARS = 2_000;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const optionName = (option: ChoiceOption): string => `${choiceLetter(option.id)}: ${option.label}`;

/** A variant written as a page, in the same sandboxed frame `render_html` uses. */
function OptionPage({
  option,
  allowNetwork,
  expanded,
  onExpandedChange,
}: {
  option: ChoiceOption & { html: string };
  allowNetwork: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const srcDoc = usePageDocument(option.html, allowNetwork);
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const mounted = useNearViewport(hostRef);
  const [view, setView] = React.useState<FrameView>('page');
  // Null until the page reports its height.
  const [fitted, setFitted] = React.useState<number | null>(null);
  const height = fitted ?? PLACEHOLDER_HEIGHT;
  const name = optionName(option);
  const handleHeight = React.useCallback((next: number) => {
    setFitted(clamp(next, MIN_PAGE_HEIGHT, MAX_PAGE_HEIGHT));
  }, []);

  return (
    <div ref={hostRef} style={{ height }} data-choice-page={fitted === null ? 'loading' : 'fitted'}>
      {mounted ? <PageFrame title={name} srcDoc={srcDoc} style={{ height }} onHeight={handleHeight} /> : null}
      <VisualExpandDialog
        details={{ title: name, html: option.html }}
        srcDoc={srcDoc}
        open={expanded}
        onOpenChange={onExpandedChange}
        view={view}
        onViewChange={setView}
      />
    </div>
  );
}

/** A variant given as an image file. */
function OptionImage({
  option,
  expanded,
  onExpandedChange,
}: {
  option: ChoiceOption & { image: string };
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const name = optionName(option);
  return (
    <>
      <img
        src={option.image}
        alt={option.description ? `${name}. ${option.description}` : name}
        className="block w-full bg-[var(--surface-muted)] object-contain"
        style={{ maxHeight: MAX_PAGE_HEIGHT }}
      />
      <Dialog open={expanded} onOpenChange={onExpandedChange}>
        <DialogContent
          showCloseButton={false}
          className="h-[calc(100dvh-2rem)] w-[min(1200px,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden bg-background p-0"
        >
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 pl-4 pr-2">
            <DialogTitle className="min-w-0 flex-1 truncate typography-ui-header font-medium leading-normal">
              {name}
            </DialogTitle>
            <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => onExpandedChange(false)} aria-label="Close" title="Close">
              <Icon name="close" className="size-3.5" />
            </Button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[var(--surface-muted)] p-4">
            <img src={option.image} alt={name} className="max-h-full max-w-full object-contain" />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** What one variant shows: its page, its image, or a note that neither was sent. */
function OptionBody({
  option,
  allowNetwork,
  expanded,
  onExpandedChange,
}: {
  option: ChoiceOption;
  allowNetwork: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  if (option.html !== undefined) {
    return (
      <OptionPage
        option={option as ChoiceOption & { html: string }}
        allowNetwork={allowNetwork}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
      />
    );
  }
  if (option.image !== undefined) {
    return (
      <OptionImage
        option={option as ChoiceOption & { image: string }}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
      />
    );
  }
  // A file whose content this client was not sent (the session was opened
  // while the question waited). The choice still works.
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-4 py-8 text-center text-muted-foreground" style={{ minHeight: MIN_PAGE_HEIGHT }}>
      <span className="typography-meta">{'Preview not loaded'}</span>
      {option.path ? <span className="max-w-full truncate font-mono typography-micro text-subtle-foreground">{option.path}</span> : null}
    </div>
  );
}

/** What the header says beside the question. */
const statusLine = (details: ChoiceDetails, waiting: boolean): string | null => {
  if (waiting) return 'Waiting for your choice';
  if (details.answer === null) return 'No choice made';
  if (details.answer) return `You chose ${choiceLetter(details.answer.id)}`;
  return null;
};

function ChoiceView({
  details,
  question,
  allowNetwork,
}: {
  details: ChoiceDetails;
  question: PluginQuestion | undefined;
  allowNetwork: boolean;
}) {
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  // The variant the user switched to, if they have.
  const [picked, setPicked] = React.useState<string | null>(null);
  const noteId = React.useId();
  const chosenId = details.answer?.id;
  const shown = shownChoice(details.options, { picked, chosenId, offered: question?.choices.map((choice) => choice.id) });
  const shownLetter = choiceLetter(shown.id);

  // One request at a time; a failure leaves the question open to try again.
  const send = (request: Promise<void>) => {
    setBusy(true);
    setFailed(false);
    request.catch(() => setFailed(true)).finally(() => setBusy(false));
  };

  const status = statusLine(details, Boolean(question));
  // Only a choice the pending question offers can be sent.
  const canChoose = Boolean(question?.choices.some((choice) => choice.id === shown.id));
  const canExpand = shown.html !== undefined || shown.image !== undefined;

  // Left and Right step through the variants from the switcher.
  const handleSwitcherKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const index = details.options.findIndex((option) => option.id === shown.id);
    const next = details.options[(index + (event.key === 'ArrowRight' ? 1 : -1) + details.options.length) % details.options.length];
    event.preventDefault();
    setPicked(next.id);
    event.currentTarget.querySelector<HTMLElement>(`[data-choice-tab="${next.id}"]`)?.focus();
  };

  return (
    <section className="my-3 space-y-2" data-plugin-artifact="visuals-choices" aria-label={details.title}>
      <header className="flex min-h-7 flex-wrap items-baseline gap-x-2">
        <h3 className="min-w-0 typography-ui-label font-medium text-foreground [text-wrap:balance]">{details.title}</h3>
        {status ? <span className="typography-micro text-subtle-foreground">{status}</span> : null}
      </header>

      <figure className="overflow-hidden rounded-xl border border-border/60 bg-background" data-choice={shown.id}>
        <div className="flex h-11 items-center gap-2 border-b border-border/60 pl-2 pr-1.5">
          <div
            role="group"
            aria-label="Options"
            className="scrollbar-none flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-1"
            onKeyDown={handleSwitcherKey}
          >
            {details.options.map((option) => {
              const letter = choiceLetter(option.id);
              const active = option.id === shown.id;
              return (
                <Button
                  key={option.id}
                  variant="chip"
                  size="xs"
                  className="max-w-[14rem] shrink-0 gap-1.5"
                  aria-pressed={active}
                  tabIndex={active ? 0 : -1}
                  data-choice-tab={option.id}
                  data-chosen={option.id === chosenId || undefined}
                  title={option.label}
                  onClick={() => setPicked(option.id)}
                >
                  <span aria-hidden="true" className="typography-micro font-medium text-muted-foreground">{letter}</span>
                  <span className="sr-only">{`${letter}: `}</span>
                  <span className="min-w-0 truncate">{option.label}</span>
                  {option.id === chosenId ? (
                    <>
                      <Icon name="check" aria-hidden="true" className="size-3.5 shrink-0" />
                      <span className="sr-only">{', chosen'}</span>
                    </>
                  ) : null}
                </Button>
              );
            })}
          </div>
          {canExpand ? (
            <Button
              variant="ghost"
              size="xs"
              className="shrink-0 text-muted-foreground"
              onClick={() => setExpanded(true)}
              aria-label={`Expand ${shownLetter}`}
              title="Expand"
            >
              <Icon name="fullscreen" className="size-3.5" />
            </Button>
          ) : null}
        </div>

        {/* Every variant is laid out in the same cell, so the frame is as
            tall as the tallest and does not move when the shown one changes. */}
        <div className="grid">
          {details.options.map((option) => {
            const active = option.id === shown.id;
            return (
              <div
                key={option.id}
                className={cn('min-w-0 [grid-area:1/1]', active ? null : 'pointer-events-none invisible')}
                aria-hidden={active ? undefined : true}
                data-choice-panel={option.id}
              >
                <OptionBody
                  option={option}
                  allowNetwork={allowNetwork}
                  expanded={active && expanded}
                  onExpandedChange={setExpanded}
                />
              </div>
            );
          })}
        </div>

        {shown.description || canChoose ? (
          <figcaption className="flex min-h-11 items-center gap-3 border-t border-border/60 px-3 py-2">
            <p className="min-w-0 flex-1 typography-meta text-muted-foreground [text-wrap:pretty]">
              {shown.description ?? ''}
            </p>
            {canChoose && question ? (
              <Button size="sm" className="shrink-0" onClick={() => send(question.answer(shown.id, note))} disabled={busy}>
                {`Choose ${shownLetter}`}
              </Button>
            ) : null}
          </figcaption>
        ) : null}
      </figure>

      {question ? (
        <div className="flex items-center gap-2">
          {question.allowNote ? (
            <>
              <label htmlFor={noteId} className="sr-only">{'Note to send with your choice'}</label>
              <Input
                id={noteId}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Add a note for the agent (optional)"
                maxLength={MAX_NOTE_CHARS}
                disabled={busy}
                className="h-8 flex-1"
              />
            </>
          ) : <span className="flex-1" />}
          <Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground" onClick={() => send(question.dismiss())} disabled={busy}>
            {'Skip'}
          </Button>
        </div>
      ) : details.answer?.note ? (
        <p className="typography-meta text-muted-foreground [text-wrap:pretty]">
          <span className="text-foreground">{'Your note: '}</span>
          {details.answer.note}
        </p>
      ) : null}

      {failed ? (
        <p role="alert" className="typography-meta text-[var(--status-error)]">
          {'Could not send your answer. Check your connection and try again.'}
        </p>
      ) : null}
    </section>
  );
}

/**
 * A `render_choices` call: one variant at a time at the chat's full width,
 * with a row of buttons to switch between them. While the call waits, the
 * shown variant has a Choose button and a note goes with the choice;
 * afterwards the chosen one is marked and shown first. Drawn for any
 * finished call with this shape, also after the plugin was turned off.
 */
export default function ChoicesArtifact({ part, directory, question }: TurnArtifactProps) {
  const allowNetwork = useAllowNetwork(directory);
  const status = part.state?.status;
  const metadata = part.state?.metadata;
  const input = part.state?.input;
  const working = status === 'pending' || status === 'running';
  const details = React.useMemo(
    // Input stands in only while a question waits: before that the call is
    // still being written and its options are incomplete. Failing both, the
    // question's own choices: a waiting question is always answerable here.
    () => parseChoiceDetails(metadata)
      ?? (working && question ? choicesFromInput(input) ?? choicesFromQuestion(question) : null),
    [input, metadata, question, working],
  );

  if (working && !details) {
    const title = (input as { title?: unknown } | undefined)?.title;
    return <VisualDrawing title={typeof title === 'string' ? title : undefined} size={choicesInputSize(input)} label="Drawing options" />;
  }
  if (!details || (!working && status !== 'completed')) return null;
  return <ChoiceView details={details} question={working ? question : undefined} allowNetwork={allowNetwork} />;
}
