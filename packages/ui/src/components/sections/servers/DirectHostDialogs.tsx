import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SettingsGroupTitle } from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { Icon } from "@/components/icon/Icon";
import type { HeaderDraft } from '@/components/servers/serverHeaderDrafts';
import { createHeaderDraft } from '@/components/servers/serverHeaderDrafts';

export interface EditDirectHostDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  onLabelChange: (val: string) => void;
  url: string;
  onUrlChange: (val: string) => void;
  token: string;
  onTokenChange: (val: string) => void;
  headers: HeaderDraft[];
  onHeadersChange: React.Dispatch<React.SetStateAction<HeaderDraft[]>>;
  saving: boolean;
  error?: string | null;
  onSave: () => void;
}

export const EditDirectHostDialog: React.FC<EditDirectHostDialogProps> = ({
  open,
  onOpenChange,
  label,
  onLabelChange,
  url,
  onUrlChange,
  token,
  onTokenChange,
  headers,
  onHeadersChange,
  saving,
  error = null,
  onSave,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{"Edit"}</DialogTitle>
          <DialogDescription>
            {"Servers this app can switch to. Import a pairing link from the other server, or add one by address."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <Input
            className="h-8"
            value={label}
            onChange={(event) => onLabelChange(event.target.value)}
            placeholder={"Label (optional)"}
            disabled={saving}
          />
          <Input
            className="h-8"
            value={url}
            onChange={(event) => onUrlChange(event.target.value)}
            placeholder={"https://host:port"}
            disabled={saving}
            autoFocus
          />
          <Input
            className="h-8"
            value={token}
            onChange={(event) => onTokenChange(event.target.value)}
            placeholder={"Connection token (optional for trusted local servers)"}
            type="password"
            disabled={saving}
          />
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <SettingsGroupTitle>{"Additional headers"}</SettingsGroupTitle>
              <SettingsInfoHint>
                {"Optional HTTP headers for desktop API requests. Authorization is reserved for the connection token."}
              </SettingsInfoHint>
            </div>
            {headers.map((header) => (
              <div key={header.id} className="flex w-full gap-2">
                <Input
                  className="h-8 font-mono text-xs"
                  value={header.name}
                  onChange={(event) =>
                    onHeadersChange((items) =>
                      items.map((item) =>
                        item.id === header.id ? { ...item, name: event.target.value } : item
                      )
                    )
                  }
                  placeholder={"Header name"}
                  disabled={saving}
                />
                <Input
                  className="h-8 font-mono text-xs"
                  value={header.value}
                  onChange={(event) =>
                    onHeadersChange((items) =>
                      items.map((item) =>
                        item.id === header.id ? { ...item, value: event.target.value } : item
                      )
                    )
                  }
                  placeholder={"Header value"}
                  type="password"
                  disabled={saving}
                />
                <button
                  type="button"
                  onClick={() =>
                    onHeadersChange((items) => items.filter((item) => item.id !== header.id))
                  }
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--status-error-background)] hover:text-[var(--status-error)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
                  aria-label={"Remove header"}
                  disabled={saving}
                >
                  <Icon name="close" className="h-4 w-4" />
                </button>
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="!font-normal"
              onClick={() => onHeadersChange((items) => [...items, createHeaderDraft()])}
              disabled={saving}
            >
              <Icon name="add" className="h-3.5 w-3.5" />
              {"Add header"}
            </Button>
          </div>
          {error ? (
            <p className="typography-meta text-[var(--status-error)]" role="alert">{error}</p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              {"Cancel"}
            </Button>
            <Button type="submit" size="xs" className="!font-normal" disabled={saving}>
              {"Save Changes"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
