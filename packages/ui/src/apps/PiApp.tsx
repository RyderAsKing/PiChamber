import React from 'react';
import { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { bytesToBase64, normalizeAttachmentMime, validateAttachmentUpload } from '@/lib/pi/attachments';
import type { PiSessionTreeNode } from '@/lib/pi/protocol';
import type { PiProjectedMessage, PiProjectedSession } from '@/lib/pi/event-reducer';
import { PiSessionStore } from './pi-session-store';
import { parsePiResourceSettingsPage, type PiResourceSettingsPage } from './pi-resource-settings-page';
import { PiResourceSettings } from './PiResourceSettings';

const THINKING = ['off', 'low', 'medium', 'high', 'xhigh'] as const;

const Message = ({ message }: { message: PiProjectedMessage }) => {
  const { t } = useI18n();
  return <article className={`rounded-lg border p-3 ${message.role === 'assistant' ? 'border-[var(--interactive-border)] bg-[var(--surface-elevated)]' : 'border-transparent bg-[var(--surface-muted)]'}`}>
    {message.thinking ? <details className="mb-2 text-sm text-muted-foreground"><summary>{t('chat.reasoningTrace.thinking')}</summary><pre className="mt-2 whitespace-pre-wrap font-sans">{message.thinking}</pre></details> : null}
    <p className="whitespace-pre-wrap break-words text-sm leading-6">{message.text}</p>
    {message.parts.filter((part) => part.type === 'tool').map((part) => <details key={part.id} className="mt-2 rounded border border-[var(--interactive-border)] p-2 text-xs"><summary>{part.tool?.name}</summary>{part.tool?.output !== undefined ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap">{JSON.stringify(part.tool.output, null, 2)}</pre> : null}</details>)}
    {message.error ? <p className="mt-2 text-xs text-[var(--status-error-foreground)]">{message.error.code}</p> : null}
  </article>;
};

const Tree = ({ nodes, onNavigate }: { nodes: PiSessionTreeNode[]; onNavigate: (entryId: string) => void }) => (
  <ul className="space-y-1 pl-3">{nodes.map((node) => <li key={node.entryId}><button type="button" onClick={() => onNavigate(node.entryId)} className="rounded px-2 py-1 text-left text-xs hover:bg-interactive-hover">{node.title || node.entryId}</button>{node.children.length > 0 ? <Tree nodes={node.children} onNavigate={onNavigate} /> : null}</li>)}</ul>
);

const Composer = ({ store, session }: { store: PiSessionStore; session: PiProjectedSession }) => {
  const { t } = useI18n();
  const [text, setText] = React.useState('');
  const [delivery, setDelivery] = React.useState<'prompt' | 'steer' | 'followUp'>('prompt');
  const [attachments, setAttachments] = React.useState<Array<{ id: string; name: string }>>([]);
  const upload = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      const validation = validateAttachmentUpload({ filename: file.name, mime: file.type, size: file.size });
      if (!validation.ok) throw new Error(validation.message);
      const attachment = await store.upload({ filename: file.name, mime: normalizeAttachmentMime(file.type), base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())) });
      setAttachments((current) => [...current, { id: attachment.id, name: attachment.name }]);
    }
  };
  return <form className="border-t border-[var(--interactive-border)] p-3" onSubmit={(event) => { event.preventDefault(); const outgoing = text.trim(); if (!outgoing) return; setText(''); void store.prompt(session.sessionId, outgoing, delivery, attachments).then(() => setAttachments([])).catch(store.reportError); }}>
    <textarea value={text} onChange={(event) => setText(event.target.value)} className="min-h-24 w-full rounded border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-2 text-sm" placeholder={t('chat.emptyState.draftTitle')} />
    {attachments.length > 0 ? <div className="mt-2 flex flex-wrap gap-1">{attachments.map((attachment) => <button key={attachment.id} type="button" className="rounded bg-[var(--surface-muted)] px-2 py-1 text-xs hover:bg-interactive-hover" onClick={() => setAttachments((current) => current.filter((candidate) => candidate.id !== attachment.id))}>{attachment.name}</button>)}</div> : null}
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><input type="file" multiple aria-label={t('chat.chatInput.actions.attachFiles')} onChange={(event) => void upload(event.target.files).catch(store.reportError)} /><select value={delivery} onChange={(event) => setDelivery(event.target.value as typeof delivery)} className="rounded border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-1 text-sm"><option value="prompt">{t('chat.chatInput.actions.sendMessageAria')}</option><option value="steer">{t('chat.chatInput.actions.stopGeneratingAria')}</option><option value="followUp">{t('settings.pichamber.visual.option.followUpBehavior.queue.label')}</option></select><Button type="submit" disabled={!text.trim()}>{t('chat.chatInput.actions.sendMessageAria')}</Button></div>
  </form>;
};

const Transcript = ({ store, session }: { store: PiSessionStore; session: PiProjectedSession | null }) => {
  const { t } = useI18n();
  const [tree, setTree] = React.useState<PiSessionTreeNode[] | null>(null);
  const [models, setModels] = React.useState<Array<{ providerId: string; id: string; label: string }>>([]);
  React.useEffect(() => {
    void store.providers().then((response) => {
      const next = response.providers.flatMap((provider) => provider.models.map((model) => ({ providerId: provider.id, id: model.id, label: model.label || model.id })));
      next.sort((a, b) => a.label.localeCompare(b.label));
      setModels(next);
    }).catch(store.reportError);
  }, [store]);
  if (!session) return <main className="flex flex-1 items-center justify-center text-muted-foreground">{t('common.loading')}</main>;
  const run = (action: () => Promise<unknown>) => void action().catch(store.reportError);
  return <main className="flex min-w-0 flex-1 flex-col"><header className="flex flex-wrap items-center gap-2 border-b border-[var(--interactive-border)] p-3"><span className="mr-auto text-sm text-muted-foreground">{session.queue.steering + session.queue.followUp}</span><select value={session.model ? `${session.model.providerId}/${session.model.modelId}` : ''} onChange={(event) => { const [providerId, modelId] = event.target.value.split('/'); if (providerId && modelId) run(() => store.setModel(session.sessionId, providerId, modelId)); }} className="max-w-48 rounded border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-1 text-xs"><option value="">{session.model ? `${session.model.providerId}/${session.model.modelId}` : t('common.loading')}</option>{models.map((model) => <option key={`${model.providerId}/${model.id}`} value={`${model.providerId}/${model.id}`}>{model.label}</option>)}</select><select value={session.thinking ?? 'off'} onChange={(event) => run(() => store.setThinking(session.sessionId, event.target.value as typeof THINKING[number]))} className="rounded border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-1 text-xs">{THINKING.map((level) => <option key={level}>{level}</option>)}</select><Button size="xs" variant="outline" onClick={() => run(() => store.compact(session.sessionId))}>{t('chat.commandAutocomplete.command.compactDescription')}</Button><Button size="xs" variant="outline" onClick={() => run(() => store.fork(session.sessionId))}>{t('chat.messageBody.actions.fork')}</Button><Button size="xs" variant="outline" onClick={() => run(() => store.clone(session.sessionId))}>{t('directoryExplorerDialog.actions.cloneRepository')}</Button><Button size="xs" variant="outline" onClick={() => run(async () => setTree((await store.tree(session.sessionId)).nodes))}>{t('chat.timeline.title')}</Button>{session.lifecycle === 'busy' || session.lifecycle === 'retry' ? <Button size="xs" variant="destructive" onClick={() => run(() => store.abort(session.sessionId))}>{t('chat.chatInput.actions.stopGeneratingAria')}</Button> : null}</header>{tree ? <div className="max-h-36 overflow-auto border-b border-[var(--interactive-border)] p-2"><Tree nodes={tree} onNavigate={(entryId) => run(() => store.navigate(session.sessionId, entryId))} /></div> : null}<section className="min-h-0 flex-1 space-y-3 overflow-auto p-3">{session.messages.map((message) => <Message key={message.id} message={message} />)}</section><Composer store={store} session={session} /></main>;
};

export const PiApp = () => {
  const { t } = useI18n();
  const [store] = React.useState(() => new PiSessionStore());
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const [title, setTitle] = React.useState('');
  const [rename, setRename] = React.useState<string | null>(null);
  const [settingsPage, setSettingsPage] = React.useState<PiResourceSettingsPage | null>(() => (
    typeof window === 'undefined' ? null : parsePiResourceSettingsPage(new URLSearchParams(window.location.search).get('settings'))
  ));
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const directory = params.get('directory');
    const sessionId = params.get('sessionId');
    void store.start({
      ...(directory ? { directory } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
    return store.dispose;
  }, [store]);
  if (settingsPage) {
    return <PiResourceSettings page={settingsPage} onPageChange={setSettingsPage} onClose={() => setSettingsPage(null)} />;
  }
  const sessions = state.sessions.filter((item) => state.showArchived ? item.session.archived : !item.session.archived);
  return <div className="flex h-full min-h-0 bg-[var(--surface-background)]"><aside className="flex w-64 shrink-0 flex-col border-r border-[var(--interactive-border)] bg-[var(--surface-muted)]"><div className="p-3"><p className="truncate text-xs text-muted-foreground">{state.directory || t('common.loading')}</p><div className="mt-2 flex items-center justify-between gap-1"><form className="flex min-w-0 flex-1 gap-1" onSubmit={(event) => { event.preventDefault(); void store.create(title.trim() || undefined).then(() => setTitle('')).catch(store.reportError); }}><input value={title} onChange={(event) => setTitle(event.target.value)} className="min-w-0 flex-1 rounded border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2 text-sm" /><Button size="xs" type="submit">+</Button></form><Button size="xs" variant="ghost" onClick={() => setSettingsPage('providers')}>{t('settings.providers.sidebar.title')}</Button></div></div>{state.error ? <div className="mx-2 rounded bg-[var(--status-error-background)] p-2 text-xs text-[var(--status-error-foreground)]">{state.error.code}</div> : null}<div className="min-h-0 flex-1 overflow-auto p-2">{sessions.map((item) => <div key={item.session.id} className={`mb-1 rounded ${item.session.id === state.selectedSessionId ? 'bg-interactive-selection text-interactive-selection-foreground' : 'hover:bg-interactive-hover'}`}><button type="button" className="w-full px-2 py-2 text-left text-sm" onClick={() => void store.select(item.session.id)}>{item.session.title || item.session.id}</button>{rename === item.session.id ? <form className="flex gap-1 p-1" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const value = new FormData(form).get('title'); if (typeof value === 'string') void store.rename(item.session.id, value).then(() => setRename(null)).catch(store.reportError); }}><input name="title" defaultValue={item.session.title} className="min-w-0 flex-1 rounded text-foreground" /><Button size="xs">{t('sessions.sidebar.session.rename.save')}</Button></form> : <div className="flex gap-1 px-1 pb-1"><Button size="xs" variant="ghost" onClick={() => setRename(item.session.id)}>{t('sessions.sidebar.session.menu.rename')}</Button><Button size="xs" variant="ghost" onClick={() => void store.archive(item.session.id, !item.session.archived).catch(store.reportError)}>{item.session.archived ? t('sessions.sidebar.bulkActions.restore') : t('sessions.sidebar.bulkActions.archive')}</Button><Button size="xs" variant="ghost" onClick={() => void store.remove(item.session.id).catch(store.reportError)}>{t('sessions.sidebar.bulkActions.delete')}</Button></div>}</div>)}</div><label className="p-2 text-xs"><input type="checkbox" checked={state.showArchived} onChange={(event) => store.setShowArchived(event.target.checked)} /> {t('sessions.sidebar.header.displayMode.showArchived')}</label></aside><Transcript store={store} session={store.selected()} /></div>;
};
