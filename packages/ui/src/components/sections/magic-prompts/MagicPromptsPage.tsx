import React from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import {
  fetchMagicPromptOverrides,
  getDefaultMagicPromptTemplate,
  getMagicPromptDefinition,
  resetAllMagicPromptOverrides,
  resetMagicPromptOverride,
  saveMagicPromptOverride,
  type MagicPromptId,
} from '@/lib/magicPrompts';
import { useMagicPromptsStore } from '@/stores/useMagicPromptsStore';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';

type PromptBlock = {
  id: MagicPromptId;
  title: string;
};

type PromptPageConfig = {
  title: string;
  description: string;
  blocks: PromptBlock[];
};

const PROMPT_PAGE_MAP: Record<string, PromptPageConfig> = {
  'git.commit.generate': {
    title: "Commit Generation",
    description: "Prompts used for commit message generation: visible user message + hidden instructions.",
    blocks: [
      { id: 'git.commit.generate.visible', title: "Visible Prompt" },
      { id: 'git.commit.generate.instructions', title: "Instructions" },
    ],
  },
  'git.pr.generate': {
    title: "PR Generation",
    description: "Prompts used for PR title/body generation: visible user message + hidden instructions.",
    blocks: [
      { id: 'git.pr.generate.visible', title: "Visible Prompt" },
      { id: 'git.pr.generate.instructions', title: "Instructions" },
    ],
  },
  'github.pr.review': {
    title: "PR Review",
    description: "Prompts used for PR review flow: visible user message + hidden instruction payload.",
    blocks: [
      { id: 'github.pr.review.visible', title: "Visible Prompt" },
      { id: 'github.pr.review.instructions', title: "Instructions" },
    ],
  },
  'github.issue.review': {
    title: "Issue Review",
    description: "Prompts used for issue review flow: visible user message + hidden instruction payload.",
    blocks: [
      { id: 'github.issue.review.visible', title: "Visible Prompt" },
      { id: 'github.issue.review.instructions', title: "Instructions" },
    ],
  },
  'github.pr.checks.review': {
    title: "PR Failed Checks Review",
    description: "Prompts used for PR failed checks analysis.",
    blocks: [
      { id: 'github.pr.checks.review.visible', title: "Visible Prompt" },
      { id: 'github.pr.checks.review.instructions', title: "Instructions" },
    ],
  },
  'github.pr.comments.review': {
    title: "PR Comments Review",
    description: "Prompts used for PR comments analysis.",
    blocks: [
      { id: 'github.pr.comments.review.visible', title: "Visible Prompt" },
      { id: 'github.pr.comments.review.instructions', title: "Instructions" },
    ],
  },
  'github.pr.comment.single': {
    title: "Single PR Comment Review",
    description: "Prompts used for single PR comment analysis.",
    blocks: [
      { id: 'github.pr.comment.single.visible', title: "Visible Prompt" },
      { id: 'github.pr.comment.single.instructions', title: "Instructions" },
    ],
  },
  'git.conflict.resolve': {
    title: "Merge/Rebase Conflict Resolution",
    description: "Prompts used when resolving merge/rebase conflicts with AI.",
    blocks: [
      { id: 'git.conflict.resolve.visible', title: "Visible Prompt" },
      { id: 'git.conflict.resolve.instructions', title: "Instructions" },
    ],
  },
  'git.integrate.cherrypick.resolve': {
    title: "Cherry-pick Conflict Resolution",
    description: "Prompts used when resolving cherry-pick conflicts in integrate flow.",
    blocks: [
      { id: 'git.integrate.cherrypick.resolve.visible', title: "Visible Prompt" },
      { id: 'git.integrate.cherrypick.resolve.instructions', title: "Instructions" },
    ],
  },
  'plan.improve': {
    title: "Improve Plan",
    description: "Hidden prompt used when sending a saved plan into an improve flow.",
    blocks: [
      { id: 'plan.improve.visible', title: "Visible Prompt" },
      { id: 'plan.improve.instructions', title: "Instructions" },
    ],
  },
  'plan.todo': {
    title: "Todo Planning",
    description: "Hidden prompt used when sending a todo into a new planning session.",
    blocks: [
      { id: 'plan.todo.visible', title: "Visible Prompt" },
      { id: 'plan.todo.instructions', title: "Instructions" },
    ],
  },
  'plan.implement': {
    title: "Implement Plan",
    description: "Hidden prompt used when sending a saved plan into an implement flow.",
    blocks: [
      { id: 'plan.implement.visible', title: "Visible Prompt" },
      { id: 'plan.implement.instructions', title: "Instructions" },
    ],
  },
  'session.summary': {
    title: "Session Summary",
    description: "Prompts used by the /summary slash command: visible user message + hidden instructions. Non-destructive - does not compact session history.",
    blocks: [
      { id: 'session.summary.visible', title: "Visible Prompt" },
      { id: 'session.summary.instructions', title: "Instructions" },
    ],
  },
  'session.plan': {
    title: "Feature Planning",
    description: "Prompts used by the /plan-feature slash command: visible user message + hidden instructions. Runs a guided dialogue that researches the code and asks clarifying questions in small batches before producing an implementation plan.",
    blocks: [
      { id: 'session.plan.visible', title: "Visible Prompt" },
      { id: 'session.plan.instructions', title: "Instructions" },
    ],
  },
  'session.catchup': {
    title: "Catch Up",
    description: "Prompts used by the /catch-up slash command: visible user message + hidden instructions. Builds branch-aware context — the branch's commits, its PR, and uncommitted work together — to understand what you were doing, then gives a digestible summary and a product-focused next step.",
    blocks: [
      { id: 'session.catchup.visible', title: "Visible Prompt" },
      { id: 'session.catchup.instructions', title: "Instructions" },
    ],
  },
  'session.debug': {
    title: "Debugging",
    description: "Prompts used by the /debug slash command: visible user message + hidden instructions. Runs a guided root-cause investigation — captures the symptom, forms hypotheses, checks them against the code, and confirms the cause before proposing a fix.",
    blocks: [
      { id: 'session.debug.visible', title: "Visible Prompt" },
      { id: 'session.debug.instructions', title: "Instructions" },
    ],
  },
  'session.weigh': {
    title: "Weigh Options",
    description: "Prompts used by the /weigh slash command: visible user message + hidden instructions. Investigates the code, then lays out 2-3 distinct approaches with trade-offs and a recommendation — without writing a plan or code.",
    blocks: [
      { id: 'session.weigh.visible', title: "Visible Prompt" },
      { id: 'session.weigh.instructions', title: "Instructions" },
    ],
  },
  'session.explore': {
    title: "Codebase Tour",
    description: "Prompts used by the /explore slash command: visible user message + hidden instructions. Investigates the repository and gives a structured orientation — the big picture, main modules, how they connect, and where to start — rather than a file-by-file dump.",
    blocks: [
      { id: 'session.explore.visible', title: "Visible Prompt" },
      { id: 'session.explore.instructions', title: "Instructions" },
    ],
  },
  'session.fusion': {
    title: "Fusion",
    description: "Prompts used when combining multi-run outputs into one final answer: visible user message + hidden instructions before source results.",
    blocks: [
      { id: 'session.fusion.visible', title: "Visible Prompt" },
      { id: 'session.fusion.instructions', title: "Instructions" },
    ],
  },
};

const hasOwn = (input: Record<string, string>, key: string) => Object.prototype.hasOwnProperty.call(input, key);
const isVisiblePromptId = (id: MagicPromptId): boolean => id.endsWith('.visible');

export const MagicPromptsPage: React.FC = () => {
  const selectedPromptId = useMagicPromptsStore((state) => state.selectedPromptId);
  const [loading, setLoading] = React.useState(true);
  const [overrides, setOverrides] = React.useState<Record<string, string>>({});
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [savingIds, setSavingIds] = React.useState<Record<string, boolean>>({});
  const [resettingIds, setResettingIds] = React.useState<Record<string, boolean>>({});
  const [resettingAll, setResettingAll] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      try {
        const nextOverrides = await fetchMagicPromptOverrides();
        if (!active) return;
        setOverrides(nextOverrides);
      } catch (error) {
        console.warn('Failed to load magic prompts:', error);
        toast.error("Failed to load PiChamber Utility Prompts");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  const pageConfig = PROMPT_PAGE_MAP[selectedPromptId] ?? PROMPT_PAGE_MAP['git.commit.generate'];
  const getBaseline = React.useCallback((id: MagicPromptId) => {
    return hasOwn(overrides, id) ? overrides[id] : getDefaultMagicPromptTemplate(id);
  }, [overrides]);

  const getDraft = React.useCallback((id: MagicPromptId) => {
    return drafts[id] ?? getBaseline(id);
  }, [drafts, getBaseline]);

  const setDraft = React.useCallback((id: MagicPromptId, value: string) => {
    setDrafts((current) => {
      if (current[id] === value) {
        return current;
      }
      return { ...current, [id]: value };
    });
  }, []);

  const savePrompt = React.useCallback(async (id: MagicPromptId) => {
    const value = getDraft(id);
    if (isVisiblePromptId(id) && value.trim().length === 0) {
      toast.error("Visible prompt cannot be empty");
      return;
    }
    setSavingIds((current) => ({ ...current, [id]: true }));
    try {
      const payload = value === getDefaultMagicPromptTemplate(id)
        ? await resetMagicPromptOverride(id)
        : await saveMagicPromptOverride(id, value);
      setOverrides(payload.overrides);
      toast.success("Utility prompt saved");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error("Failed to save utility prompt", { description: message });
    } finally {
      setSavingIds((current) => ({ ...current, [id]: false }));
    }
  }, [getDraft]);

  const resetPrompt = React.useCallback(async (id: MagicPromptId) => {
    setResettingIds((current) => ({ ...current, [id]: true }));
    try {
      const payload = await resetMagicPromptOverride(id);
      setOverrides(payload.overrides);
      setDrafts((current) => ({
        ...current,
        [id]: getDefaultMagicPromptTemplate(id),
      }));
      toast.success("Prompt reset to default");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error("Failed to reset utility prompt", { description: message });
    } finally {
      setResettingIds((current) => ({ ...current, [id]: false }));
    }
  }, []);

  const handleResetAll = React.useCallback(async () => {
    setResettingAll(true);
    try {
      const payload = await resetAllMagicPromptOverrides();
      setOverrides(payload.overrides);
      setDrafts({});
      toast.success("All prompt overrides reset");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error("Failed to reset all prompts", { description: message });
    } finally {
      setResettingAll(false);
    }
  }, []);

  if (loading) {
    return (
      <div className="py-6 px-6 flex items-center gap-2 text-muted-foreground">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-busy-pulse" aria-label={"Loading"} />
        <span className="typography-ui">{"Loading PiChamber Utility Prompts..."}</span>
      </div>
    );
  }

  return (
    <SettingsPageLayout
      title={pageConfig.title}
      titleAccessory={(
        <SettingsInfoHint contentClassName="max-w-xs">{pageConfig.description}</SettingsInfoHint>
      )}
      headerEnd={(
        <Button
          data-settings-item="magic-prompts.reset-overrides"
          variant="outline"
          size="sm"
          onClick={() => {
            void handleResetAll();
          }}
          disabled={resettingAll || Object.keys(overrides).length === 0}
        >
          {resettingAll ? "Resetting..." : "Reset All Overrides"}
        </Button>
      )}
    >
      {pageConfig.blocks.map((block, index) => {
        const definition = getMagicPromptDefinition(block.id);
        const baseline = getBaseline(block.id);
        const draft = getDraft(block.id);
        const isOverridden = hasOwn(overrides, block.id);
        const isDirty = draft !== baseline;
        const isInvalidEmptyVisiblePrompt = isVisiblePromptId(block.id) && draft.trim().length === 0;
        const saving = savingIds[block.id] === true;
        const resetting = resettingIds[block.id] === true;

        return (
          <SettingsSection
            key={block.id}
            title={block.title}
            info={definition.description}
            description={
              definition.placeholders && definition.placeholders.length > 0
                ? `${"Placeholders:"} ${definition.placeholders.map((item) => `{{${item.key}}}`).join(', ')}`
                : undefined
            }
            divider={index > 0}
            settingsItem={isVisiblePromptId(block.id) ? 'magic-prompts.visible-prompt' : 'magic-prompts.instructions'}
            contentClassName="space-y-3"
          >
            <Textarea
              value={draft}
              onChange={(event) => setDraft(block.id, event.target.value)}
              className="min-h-[220px] font-mono text-sm"
            />
            {isInvalidEmptyVisiblePrompt && (
              <div className="typography-micro text-[var(--status-error)]">{"Visible prompt cannot be empty."}</div>
            )}

            <div className="flex items-center justify-between gap-2">
              <span className="typography-micro text-muted-foreground">
                {isDirty
                  ? "Unsaved changes"
                  : isOverridden
                    ? "Using saved override"
                    : "Using built-in default"}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void resetPrompt(block.id);
                  }}
                  disabled={!isOverridden || saving || resetting}
                >
                  {resetting ? "Resetting..." : "Reset to Default"}
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    void savePrompt(block.id);
                  }}
                  disabled={!isDirty || saving || resetting || isInvalidEmptyVisiblePrompt}
                >
                  {saving ? "Saving..." : "Save"}
                </Button>
              </div>
            </div>
          </SettingsSection>
        );
      })}
    </SettingsPageLayout>
  );
};
