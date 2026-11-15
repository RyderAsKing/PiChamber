import * as React from 'react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { copyTextToClipboard } from '@/lib/clipboard';
import type { PiExtensionSurfaceState } from '@/lib/pi/reducers/customSurfaceReducers';
import { SurfaceKeyBar } from './SurfaceKeyBar';
import { focusSurfaceElement, surfaceFrameText, surfaceSelector } from './surfaceDom';

/**
 * Whether typing reaches the surface: the browser's focus is on its lines or
 * on its key bar. The daemon's own focus (`surface.focused`) says which
 * component inside gets keys, not whether the page sends any.
 */
const useTypingReachesSurface = (surfaceId: string): boolean => {
  const [reaches, setReaches] = React.useState(false);
  React.useEffect(() => {
    const selector = `${surfaceSelector(surfaceId)}, [data-extension-keybar="${CSS.escape(surfaceId)}"]`;
    const update = () => setReaches(document.activeElement?.closest(selector) != null);
    // `focusout` fires before focus lands anywhere; read it once it has.
    const later = () => window.setTimeout(update, 0);
    update();
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', later);
    return () => {
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', later);
    };
  }, [surfaceId]);
  return reaches;
};

const KEY_BAR_STORAGE_KEY = 'pichamber.extensionSurface.keyBar';

const readKeyBarPreference = (): boolean => {
  try {
    return window.localStorage.getItem(KEY_BAR_STORAGE_KEY) === 'shown';
  } catch {
    return false;
  }
};

const writeKeyBarPreference = (shown: boolean): void => {
  try {
    if (shown) window.localStorage.setItem(KEY_BAR_STORAGE_KEY, 'shown');
    else window.localStorage.removeItem(KEY_BAR_STORAGE_KEY);
  } catch {
    // The bar still toggles for this surface; it just will not be remembered.
  }
};

const CopyTextButton: React.FC<{ surface: PiExtensionSurfaceState }> = ({ surface }) => {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const text = surface.frame ? surfaceFrameText(surface.frame.lines) : '';
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="shrink-0 px-1.5 font-sans text-muted-foreground hover:text-foreground"
      disabled={text === ''}
      aria-label={`Copy the text of ${surface.title}`}
      // A click keeps focus (and the keys) where it is.
      onPointerDown={(event) => event.preventDefault()}
      onClick={async () => {
        const result = await copyTextToClipboard(text);
        if (result.ok) setCopied(true);
        else toast.error('Could not copy the text.');
      }}
    >
      {copied ? 'Copied' : 'Copy text'}
    </Button>
  );
};

/**
 * The bottom of an inline surface on a device with a pointer: whether typing
 * reaches the extension (and a way to send it there when it does not), the
 * frame's text to copy, and Show key buttons, which adds the touch key bar
 * (Esc, Tab, arrows, Enter) for people who would rather click keys. Nothing here reads what the extension
 * drew; every key goes through as typed.
 */
export const SurfaceFooter: React.FC<{ sessionId: string; surface: PiExtensionSurfaceState }> = ({ sessionId, surface }) => {
  const reaches = useTypingReachesSurface(surface.surfaceId);
  const [keyBar, setKeyBar] = React.useState(readKeyBarPreference);
  const interactive = surface.capturing || surface.focused;
  const keyBarId = React.useId();
  return (
    <div className="border-t border-border/40">
      {interactive && keyBar ? (
        <SurfaceKeyBar
          id={keyBarId}
          sessionId={sessionId}
          surfaceId={surface.surfaceId}
          keyboardButton={false}
          className="border-b border-border/40 px-3 py-1.5"
        />
      ) : null}
      <div className="flex min-h-8 items-center gap-2 px-3 py-1">
        <div className="min-w-0 flex-1 typography-micro text-muted-foreground">
          {!interactive ? null : reaches ? (
            'Keys go to the extension. Your draft is kept when it closes.'
          ) : (
            <button
              type="button"
              className="text-left text-foreground underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
              onClick={() => focusSurfaceElement(surface.surfaceId)}
            >
              Click here to type to the extension.
            </button>
          )}
        </div>
        <CopyTextButton surface={surface} />
        {interactive ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0 px-1.5 font-sans text-muted-foreground hover:text-foreground"
            aria-expanded={keyBar}
            aria-controls={keyBar ? keyBarId : undefined}
            title="Buttons for Esc, Tab, the arrows and Enter, to answer with the mouse"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              writeKeyBarPreference(!keyBar);
              setKeyBar(!keyBar);
            }}
          >
            {keyBar ? 'Hide key buttons' : 'Show key buttons'}
          </Button>
        ) : null}
      </div>
    </div>
  );
};
