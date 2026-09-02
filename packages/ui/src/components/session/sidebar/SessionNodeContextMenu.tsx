import React from 'react';
import type { Session } from '@/lib/chat/types';
import { ContextMenu } from '@base-ui/react/context-menu';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import {
  dropdownMenuItemClass,
  dropdownMenuPopupClass,
  dropdownMenuSeparatorClass,
  dropdownMenuSubTriggerClass,
} from '@/components/ui/dropdown-menu.styles';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';

export interface SessionNodeMenuItemsProps {
  session: Session;
  sessionTitle: string;
  sessionDirectory: string | null;
  isPinnedSession: boolean;
  archivedBucket?: boolean;
  isElectron: boolean;
  renamingFolderId: string | null;
  editingIdRef: React.RefObject<string | null>;
  pendingRenameRef: React.MutableRefObject<{ id: string; title: string } | null>;
  handleCopySessionId: (sessionId: string) => void;
  togglePinnedSession: (target: { directory: string; sessionId: string }) => void;
  handleExportSession: () => Promise<void>;
  handleOpenMiniChatWindow: () => void;
  handleDeleteSession: (
    session: Session,
    source?: { archivedBucket?: boolean; hardDelete?: boolean; skipConfirm?: boolean }
  ) => void;
  handleRestoreSession: (session: Session) => void;
}

export function renderSessionMenuItems(
  props: SessionNodeMenuItemsProps,
  components: {
    Item: React.ElementType;
    Separator: React.ElementType;
    Sub: React.ElementType;
    SubTrigger: React.ElementType;
    SubContent: React.ElementType;
  }
) {
  const {
    session,
    sessionTitle,
    sessionDirectory,
    isPinnedSession,
    archivedBucket,
    isElectron,
    pendingRenameRef,
    handleCopySessionId,
    togglePinnedSession,
    handleExportSession,
    handleOpenMiniChatWindow,
    handleDeleteSession,
    handleRestoreSession,
  } = props;
  const { Item, Separator } = components;

  return (
    <>
      <Item
        onClick={() => {
          pendingRenameRef.current = { id: session.id, title: sessionTitle };
        }}
        className="[&>svg]:mr-1"
      >
        <Icon name="pencil-ai" className="mr-1 h-4 w-4" />
        {'Rename'}
      </Item>
      <Item
        onClick={() => handleCopySessionId(session.id)}
        className="[&>svg]:mr-1"
      >
        <Icon name="file-copy" className="mr-1 h-4 w-4" />
        {'Copy session ID'}
      </Item>
      <Item
        onClick={() =>
          sessionDirectory &&
          togglePinnedSession({
            directory: sessionDirectory,
            sessionId: session.id,
          })
        }
        className="[&>svg]:mr-1"
      >
        {isPinnedSession ? (
          <Icon name="unpin" className="mr-1 h-4 w-4" />
        ) : (
          <Icon name="pushpin" className="mr-1 h-4 w-4" />
        )}
        {isPinnedSession ? 'Unpin session' : 'Pin session'}
      </Item>

      <Item
        onClick={() => {
          void handleExportSession();
        }}
        className="[&>svg]:mr-1"
      >
        <Icon name="download" className="mr-1 h-4 w-4" />
        {'Export Markdown'}
      </Item>

      {isElectron ? (
        <Item
          disabled={!sessionDirectory}
          onClick={handleOpenMiniChatWindow}
          className="[&>svg]:mr-1"
        >
          <Icon name="window" className="mr-1 h-4 w-4" />
          <span className="truncate">{'Open in Mini Chat Window'}</span>
        </Item>
      ) : null}

      <Separator />
      {!archivedBucket ? (
        <Item
          className="[&>svg]:mr-1"
          onClick={() => handleDeleteSession(session, { archivedBucket })}
        >
          <Icon name="inbox-archive" className="mr-1 h-4 w-4" />
          {'Archive'}
        </Item>
      ) : null}
      {archivedBucket ? (
        <Item
          className="[&>svg]:mr-1"
          onClick={() => handleRestoreSession(session)}
        >
          <Icon name="inbox-unarchive" className="mr-1 h-4 w-4" />
          {'Restore'}
        </Item>
      ) : null}
      <Item
        className="text-destructive focus:text-destructive [&>svg]:mr-1"
        onClick={() =>
          handleDeleteSession(session, {
            archivedBucket,
            hardDelete: true,
          })
        }
      >
        <Icon name="delete-bin" className="mr-1 h-4 w-4" />
        {'Delete'}
      </Item>
    </>
  );
}

export function SessionNodeDropdownMenuContent(props: SessionNodeMenuItemsProps) {
  const { renamingFolderId, editingIdRef } = props;
  return (
    <DropdownMenuContent
      align="end"
      className="min-w-[180px]"
      finalFocus={() => (renamingFolderId || editingIdRef.current ? false : true)}
    >
      {renderSessionMenuItems(props, {
        Item: DropdownMenuItem,
        Separator: DropdownMenuSeparator,
        Sub: DropdownMenuSub,
        SubTrigger: DropdownMenuSubTrigger,
        SubContent: DropdownMenuSubContent,
      })}
    </DropdownMenuContent>
  );
}

export function SessionNodeContextMenuContent(props: SessionNodeMenuItemsProps) {
  const { renamingFolderId, editingIdRef } = props;
  return (
    <ContextMenu.Portal>
      <ContextMenu.Positioner className="app-region-no-drag z-50">
        <ContextMenu.Popup
          data-slot="dropdown-menu-content"
          finalFocus={() => (renamingFolderId || editingIdRef.current ? false : true)}
          style={{
            color: 'var(--surface-elevated-foreground)',
          }}
          className={cn(dropdownMenuPopupClass, 'min-w-[180px]')}
        >
          {renderSessionMenuItems(props, {
            Item: ({
              className,
              ...itemProps
            }: React.ComponentProps<typeof ContextMenu.Item>) => (
              <ContextMenu.Item
                className={cn(dropdownMenuItemClass, className)}
                {...itemProps}
              />
            ),
            Separator: ({
              className,
              ...separatorProps
            }: React.ComponentProps<typeof ContextMenu.Separator>) => (
              <ContextMenu.Separator
                className={cn(dropdownMenuSeparatorClass, className)}
                {...separatorProps}
              />
            ),
            Sub: ContextMenu.SubmenuRoot,
            SubTrigger: ({
              className,
              children,
              ...triggerProps
            }: React.ComponentProps<typeof ContextMenu.SubmenuTrigger>) => (
              <ContextMenu.SubmenuTrigger
                className={cn(dropdownMenuSubTriggerClass, className)}
                {...triggerProps}
              >
                {children}
                <Icon name="arrow-right-s" className="ml-auto size-3.5" />
              </ContextMenu.SubmenuTrigger>
            ),
            SubContent: ({
              className,
              children,
              ...popupProps
            }: React.ComponentProps<typeof ContextMenu.Popup>) => (
              <ContextMenu.Portal>
                <ContextMenu.Positioner className="app-region-no-drag z-50">
                  <ContextMenu.Popup
                    data-slot="dropdown-menu-sub-content"
                    style={{
                      backgroundColor: 'var(--surface-elevated)',
                      color: 'var(--surface-elevated-foreground)',
                    }}
                    className={cn(dropdownMenuPopupClass, className)}
                    {...popupProps}
                  >
                    {children}
                  </ContextMenu.Popup>
                </ContextMenu.Positioner>
              </ContextMenu.Portal>
            ),
          })}
        </ContextMenu.Popup>
      </ContextMenu.Positioner>
    </ContextMenu.Portal>
  );
}
