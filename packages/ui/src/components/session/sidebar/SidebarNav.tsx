import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { sidebarRowIconClassName, sidebarRowLabelClassName } from './utils';

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
        className="flex w-full min-w-0 items-center gap-1.5 rounded-xl px-2.5 py-2 text-left typography-ui-label font-normal text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-colors"
      >
        <Icon name="chat-new" className={sidebarRowIconClassName} />
        <span className={sidebarRowLabelClassName}>{"New session"}</span>
      </button>
    </div>
  );
}
