import React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/icon/Icon";
import { useUIStore } from "@/stores/useUIStore";
import {
  getEffectiveShortcutCombo,
  getShortcutAction,
  getModifierLabel,
  formatShortcutForDisplay,
} from "@/lib/shortcuts";
import type { IconName } from "@/components/icon/icons";

type ShortcutItem = {
  id?: string;
  keys: string | string[];
  descriptionKey: string;
  icon: IconName | null;
};

type ShortcutSection = {
  categoryKey: string;
  items: ShortcutItem[];
};

const renderShortcut = (id: string, fallbackCombo: string, overrides: Record<string, string>) => {
  const action = getShortcutAction(id);
  return action ? formatShortcutForDisplay(getEffectiveShortcutCombo(id, overrides)) : fallbackCombo;
};

export const HelpDialog: React.FC = () => {
  const isHelpDialogOpen = useUIStore((state) => state.isHelpDialogOpen);
  const setHelpDialogOpen = useUIStore((state) => state.setHelpDialogOpen);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const mod = getModifierLabel();

  const shortcuts: ShortcutSection[] = [
    {
      categoryKey: "Navigation & Commands",
      items: [
        {
          id: 'open_command_palette',
          descriptionKey: "Open Command Palette",
          icon: "command",
          keys: '',
        },
        {
          id: 'open_help',
          descriptionKey: "Show Keyboard Shortcuts (this dialog)",
          icon: "question",
          keys: '',
        },
        {
          id: 'toggle_sidebar',
          descriptionKey: "Toggle Session Sidebar",
          icon: "layout-left",
          keys: '',
        },
        {
          id: 'add_selection_to_chat',
          descriptionKey: "Add Selection to Chat",
          icon: "add",
          keys: '',
        },
        {
          id: 'open_model_selector',
          descriptionKey: "Open Model Selector",
          icon: "ai-generate-2",
          keys: '',
        },
        {
          keys: ["↑↓"],
          descriptionKey: "Navigate Models (in picker)",
          icon: "ai-generate-2",
        },
        {
          keys: ["←→"],
          descriptionKey: "Adjust Thinking Mode (in picker, when supported)",
          icon: "brain-ai-3",
        },
        {
          id: 'cycle_thinking_variant',
          descriptionKey: "Cycle Thinking Variant (global shortcut)",
          icon: "brain-ai-3",
          keys: '',
        },
        {
          keys: [`Shift + Alt + ${mod} + N`],
          descriptionKey: "New Window (desktop only)",
          icon: "window",
        },
      ],
    },
    {
      categoryKey: "Session Management",
      items: [
        {
          id: 'new_chat',
          descriptionKey: "Create New Session",
          icon: "add",
          keys: '',
        },
        { id: 'focus_input', descriptionKey: "Focus Chat Input", icon: "text", keys: '' },
        {
          id: 'toggle_prompt_navigator',
          descriptionKey: "Toggle Prompt Navigator",
          icon: "list-unordered",
          keys: '',
        },
        {
          id: 'abort_run',
          descriptionKey: "Abort active run (double press)",
          icon: "close-circle",
          keys: '',
        },
      ],
    },
    {
      categoryKey: "Panels",
      items: [
        {
          id: 'toggle_right_sidebar',
          descriptionKey: 'helpDialog.item.toggleRightSidebar',
          icon: "layout-right",
          keys: '',
        },
        {
          id: 'open_right_sidebar_git',
          descriptionKey: 'helpDialog.item.openRightSidebarGitTab',
          icon: "git-branch",
          keys: '',
        },
        {
          id: 'open_right_sidebar_files',
          descriptionKey: 'helpDialog.item.openRightSidebarFilesTab',
          icon: "layout-right",
          keys: '',
        },
        {
          id: 'toggle_terminal',
          descriptionKey: 'helpDialog.item.toggleTerminalDock',
          icon: "window",
          keys: '',
        },
        {
          id: 'toggle_terminal_expanded',
          descriptionKey: 'helpDialog.item.toggleTerminalExpanded',
          icon: "window",
          keys: '',
        },
        {
          keys: [`${mod} + 1...0`],
          descriptionKey: "Switch Context Panel Surface (number key)",
          icon: "layout-right",
        },
      ],
    },
    {
      categoryKey: "Interface",
      items: [
        {
          id: 'cycle_theme',
          descriptionKey: "Cycle Theme (Light → Dark → System)",
          icon: "palette",
          keys: '',
        },
        {
          id: 'toggle_services_menu',
          descriptionKey: 'helpDialog.item.toggleServicesMenu',
          icon: "stack",
          keys: '',
        },
        {
          id: 'cycle_services_tab',
          descriptionKey: 'helpDialog.item.cycleServicesTab',
          icon: "stack",
          keys: '',
        },
        {
          id: 'open_settings',
          descriptionKey: "Open Settings",
          icon: "settings-3",
          keys: '',
        },
      ],
    },
  ];

  return (
      <Dialog open={isHelpDialogOpen} onOpenChange={setHelpDialogOpen}>
      <DialogContent className="max-w-2xl w-[min(42rem,calc(100vw-1.5rem))] max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="command" className="h-5 w-5" />
            {"Keyboard Shortcuts"}
          </DialogTitle>
          <DialogDescription>
            {"Use these keyboard shortcuts to navigate PiChamber efficiently"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto mt-3 pr-1">
          <div className="space-y-4">
            {shortcuts.map((section) => (
              <div key={section.categoryKey}>
                <h3 className="typography-meta font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  {section.categoryKey}
                </h3>
                <div className="space-y-1">
                  {section.items
                    .map((shortcut) => {
                    const displayKeys = shortcut.id
                      ? renderShortcut(shortcut.id, Array.isArray(shortcut.keys) ? shortcut.keys[0] : shortcut.keys, shortcutOverrides)
                      : (Array.isArray(shortcut.keys) ? shortcut.keys : shortcut.keys.split(" / "));

                    return (
                      <div
                        key={shortcut.id || shortcut.descriptionKey}
                        className="flex items-center justify-between py-1 px-2"
                      >
                        <div className="flex items-center gap-2">
                          {shortcut.icon && (
                            <Icon name={shortcut.icon} className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                          <span className="typography-meta">
                            {shortcut.descriptionKey}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          {(Array.isArray(displayKeys) ? displayKeys : [displayKeys]).map((keyCombo: string, i: number) => (
                            <React.Fragment key={`${keyCombo}-${i}`}>
                              {i > 0 && (
                                <span className="typography-meta text-muted-foreground mx-1">
                                  {"or"}
                                </span>
                              )}
                              <kbd className="inline-flex items-center gap-1 px-1.5 py-0.5 typography-meta font-mono bg-muted rounded border border-border/20">
                                {keyCombo}
                              </kbd>
                            </React.Fragment>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 p-2 bg-muted/30 rounded-xl">
            <div className="flex items-start gap-2">
              <Icon name="question" className="h-3.5 w-3.5 text-muted-foreground mt-0.5" />
              <div className="typography-meta text-muted-foreground">
                <p className="font-medium mb-1">{"Pro Tips:"}</p>
                <ul className="space-y-0.5 typography-meta">
                  <li>
                    • {`Use Command Palette (${renderShortcut('open_command_palette', `${mod} P`, shortcutOverrides)}) to quickly access all actions`}
                  </li>
                  <li>
                    • {"The 5 most recent sessions appear in the Command Palette"}
                  </li>
                  <li>
                    • {"Theme cycling remembers your preference across sessions"}
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
