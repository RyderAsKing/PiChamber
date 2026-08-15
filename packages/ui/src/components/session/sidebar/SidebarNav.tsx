import React from 'react';
import { Icon } from '@/components/icon/Icon';

// Primary sidebar action: starting a session is the one control worth its own
// row; it keeps the quiet text-row form so the top reads as content, while
// every other control lives in the icon toolbar below.
type Props = {
  onNewSession: () => void;
};

export function SidebarNav(props: Props): React.ReactNode {
  
  return (
    <div className="select-none flex-shrink-0 px-2 pt-1.5 pb-0.5">
      <button
        type="button"
        onClick={props.onNewSession}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left typography-ui-label font-normal text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 transition-colors"
      >
        <Icon name="chat-new" className="h-4 w-4 flex-shrink-0" />
        <span className="truncate">{"New session"}</span>
      </button>
    </div>
  );
}
