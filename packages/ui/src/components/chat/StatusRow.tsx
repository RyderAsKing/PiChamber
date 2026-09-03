import React from "react";
import { useSessionUIStore } from '@/sync/session-ui-store';
import { cn } from "@/lib/utils";
import { useDirectorySync } from "@/sync/sync-context";
import type { Todo } from "@/lib/chat/types";

// Compat aliases for old TodoItem shape
type TodoItem = Todo & { id?: string };
type TodoStatus = string;
type TodoPriority = string;
import { useUIStore } from "@/stores/useUIStore";
import { useTabletLayout } from '@/lib/device';
import { WorkingPlaceholder } from "./message/parts/WorkingPlaceholder";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Icon } from "@/components/icon/Icon";

const STATUS_ROW_CONTAINER_STYLE = { containerType: "inline-size" as const, containerName: "status-row" };

const statusConfig: Record<TodoStatus, { textClassName: string }> = {
  in_progress: {
    textClassName: "text-foreground",
  },
  pending: {
    textClassName: "text-foreground",
  },
  completed: {
    textClassName: "text-muted-foreground line-through",
  },
  cancelled: {
    textClassName: "text-muted-foreground line-through",
  },
};

const priorityClassName: Record<TodoPriority, string> = {
  high: "text-[var(--status-warning)]",
  medium: "text-muted-foreground",
  low: "text-muted-foreground/70",
};

const priorityIcon: Record<TodoPriority, React.ReactNode> = {
  high: <Icon name="arrow-up-double" className="h-3.5 w-3.5"  aria-hidden="true"/>,
  medium: <Icon name="arrow-up-s" className="h-3.5 w-3.5"  aria-hidden="true"/>,
  low: <Icon name="arrow-down-s" className="h-3.5 w-3.5"  aria-hidden="true"/>,
};

const statusLabel: Record<TodoStatus, string> = {
  in_progress: "In progress",
  pending: "Pending",
  completed: "Completed",
  cancelled: "Cancelled",
};

const priorityLabel: Record<TodoPriority, string> = {
  high: "High priority",
  medium: "Medium priority",
  low: "Low priority",
};

interface TodoItemRowProps {
  todo: TodoItem;
}

const TodoItemRow: React.FC<TodoItemRowProps> = ({ todo }) => {
  const status = String(todo.status || 'pending');
  const priority = String(todo.priority || 'medium');
  const config = statusConfig[status] || statusConfig.pending;
  const statusKey = statusLabel[status] ?? statusLabel.pending;
  const priorityKey = priorityLabel[priority] ?? priorityLabel.medium;

  const statusIcon =
    status === "in_progress" ? (
      <Icon name="record-circle" className="h-3.5 w-3.5 text-[var(--status-info)]"  aria-hidden="true"/>
    ) : status === "completed" ? (
      <Icon name="checkbox-circle" className="h-3.5 w-3.5 text-[var(--status-success)]"  aria-hidden="true"/>
    ) : (
      <Icon name="time" className="h-3.5 w-3.5 text-muted-foreground"  aria-hidden="true"/>
    );

  return (
    <div className="flex items-center min-w-0 py-0.5 gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex-shrink-0">{statusIcon}</span>
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={6}>
          {statusKey}
        </TooltipContent>
      </Tooltip>
      <span
        className={cn(
          "flex-1 typography-ui-label",
          config.textClassName
        )}
      >
        {todo.content}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "typography-meta flex items-center justify-center flex-shrink-0 leading-none",
              priorityClassName[priority as TodoPriority] ?? priorityClassName.medium
            )}
          >
            {priorityIcon[priority as TodoPriority] ?? priorityIcon.medium}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={6}>
          {priorityKey}
        </TooltipContent>
      </Tooltip>
    </div>
  );
};

const EMPTY_TODOS: TodoItem[] = [];

interface StatusRowProps {
  // Working state
  isWorking?: boolean;
  statusText?: string | null;
  isGenericStatus?: boolean;
  isWaitingForPermission?: boolean;
  wasAborted?: boolean;
  abortActive?: boolean;
  retryInfo?: { attempt?: number; next?: number } | null;
  // Abort state (for mobile)
  showAbort?: boolean;
  onAbort?: () => void;
  // Abort status display
  showAbortStatus?: boolean;
  showAssistantStatus?: boolean;
  showTodos?: boolean;
  agentName?: string;
  modelName?: string | null;
  providerId?: string | null;
  leftAccessory?: React.ReactNode;
}

export const StatusRow: React.FC<StatusRowProps> = ({
  isWorking = false,
  statusText = null,
  isGenericStatus,
  isWaitingForPermission,
  wasAborted,
  abortActive,
  retryInfo,
  showAbort,
  onAbort,
  showAbortStatus,
  showAssistantStatus = true,
  showTodos = true,
  agentName,
  modelName,
  providerId,
  leftAccessory,
}) => {
  const [isExpanded, setIsExpanded] = React.useState(false);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const liveTodos = useDirectorySync(
    React.useCallback(
      (state) => {
        if (!showTodos || !currentSessionId) return EMPTY_TODOS;
        return state.todo[currentSessionId] ?? EMPTY_TODOS;
      },
      [currentSessionId, showTodos],
    ),
  );
  const todos: TodoItem[] = currentSessionId ? liveTodos : EMPTY_TODOS;
  const isMobileRaw = useUIStore((state) => state.isMobile);
  const { enabled: isTabletLayout } = useTabletLayout();
  const isMobile = isMobileRaw && !isTabletLayout;
  const isCompact = isMobile;

  // Filter out cancelled todos for display and keep original order.
  // This prevents items from jumping around when status changes.
  const visibleTodos = React.useMemo(() => {
    return todos.filter((todo) => todo.status !== "cancelled");
  }, [todos]);

  // Find the current active todo (first in_progress, or first pending)
  const activeTodo = React.useMemo(() => {
    return (
      visibleTodos.find((t) => t.status === "in_progress") ||
      visibleTodos.find((t) => t.status === "pending") ||
      null
    );
  }, [visibleTodos]);

  // Calculate progress
  const progress = React.useMemo(() => {
    const total = todos.filter((t) => t.status !== "cancelled").length;
    const completed = todos.filter((t) => t.status === "completed").length;
    return { completed, total };
  }, [todos]);

  const statusSummary = React.useMemo(() => {
    const active = visibleTodos.filter((t) => t.status === "in_progress").length;
    const left = visibleTodos.filter((t) => t.status === "in_progress" || t.status === "pending").length;
    return { active, left };
  }, [visibleTodos]);

  const hasTodoContent = showTodos && statusSummary.left > 0;
  const hasAssistantContent = showAssistantStatus && (
    isWorking ||
    Boolean(wasAborted) ||
    Boolean(showAbortStatus)
  );
  const hasLeftAccessory = Boolean(leftAccessory);
  // Original logic from ChatInput
  const shouldRenderPlaceholder = !showAbortStatus && (wasAborted || !abortActive);

  const hasContent = hasAssistantContent || hasTodoContent || hasLeftAccessory;

  // Close popover when clicking outside
  const popoverRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!isExpanded) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setIsExpanded(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isExpanded]);

  const toggleExpanded = () => setIsExpanded((prev) => !prev);
  const todoSummaryLabel = `${statusSummary.active} active · ${statusSummary.left} left`;

  // Abort button for mobile
  const abortButton = showAbort && onAbort ? (
    <button
      type="button"
      onClick={onAbort}
      className="flex items-center justify-center h-[1.2rem] w-[1.2rem] text-[var(--status-error)] transition-opacity hover:opacity-80 focus-visible:outline-none flex-shrink-0"
      aria-label={"Stop generating"}
    >
      <Icon name="close-circle" aria-hidden="true"/>
    </button>
  ) : null;

  // Todo trigger button
  const todoTrigger = hasTodoContent ? (
    <button
      type="button"
      onClick={toggleExpanded}
      className="flex items-center gap-1 flex-shrink-0 text-muted-foreground"
      aria-label={todoSummaryLabel}
      title={todoSummaryLabel}
    >
      {/* Desktop: show task text; Mobile: just "Tasks" */}
      {!isCompact && activeTodo ? (
        <span className="status-row__active-todo typography-ui-label text-foreground truncate max-w-[200px]">
          {activeTodo.content}
        </span>
      ) : (
        <span className="typography-ui-label">{"Tasks"}</span>
      )}
      <span className="typography-meta flex items-center gap-1 tabular-nums" aria-hidden="true">
        <span className="flex items-center gap-0.5">
          <Icon name="record-circle" className="h-3.5 w-3.5 text-[var(--status-info)]" />
          {statusSummary.active}
        </span>
        <span>·</span>
        <span className="flex items-center gap-0.5">
          <Icon name="time" className="h-3.5 w-3.5" />
          {statusSummary.left}
        </span>
      </span>
      {isExpanded ? (
        <Icon name="arrow-up-s" className="h-3.5 w-3.5" />
      ) : (
        <Icon name="arrow-down-s" className="h-3.5 w-3.5" />
      )}
    </button>
  ) : null;

  // Don't render if nothing to show
  if (!hasContent) {
    return null;
  }

  return (
    <div
      // Mobile: breathing room between the last message and the agent status
      // line — without it the "<model> is running…" row sits flush against
      // the message above.
      className={cn("mb-1", isMobile && "mt-2", !hasLeftAccessory && "chat-column")}
      style={STATUS_ROW_CONTAINER_STYLE}
    >
      <div className={cn("flex min-h-5 items-center justify-between gap-2 py-0.5", hasLeftAccessory && "px-0.5")}>
        {/* Left: Abort status | Working placeholder | leftAccessory */}
        <div className={cn("flex min-w-0 flex-1 items-center gap-2", hasLeftAccessory ? "pl-1.5" : "overflow-x-hidden")}>
          {showAssistantStatus && showAbortStatus ? (
            <div className="flex h-full items-center text-[var(--status-error)] pl-0.5">
              <span className="flex items-center gap-1.5 typography-ui-label">
                <Icon name="close-circle" aria-hidden="true"/>
                {"Aborted"}
              </span>
            </div>
          ) : showAssistantStatus && shouldRenderPlaceholder ? (
            <WorkingPlaceholder
              key={currentSessionId ?? "no-session"}
              isWorking={isWorking}
              statusText={statusText}
              isGenericStatus={isGenericStatus}
              isWaitingForPermission={isWaitingForPermission}
              retryInfo={retryInfo}
              agentName={agentName}
              modelName={modelName}
              providerId={providerId}
            />
          ) : leftAccessory ? (
            leftAccessory
          ) : null}
        </div>

        {/* Right: Abort (mobile only) + Todo */}
        <div className={cn("relative flex items-center gap-2 flex-shrink-0", hasLeftAccessory ? "pr-1.5" : "-mr-3")} ref={popoverRef}>
          {abortButton}
          {todoTrigger}

          {/* Popover dropdown */}
          {isExpanded && hasTodoContent && (
            <div
              style={{
                maxWidth: "min(28rem, calc(100cqw - 4ch))",
                backgroundColor: "var(--surface-elevated)",
                color: "var(--surface-elevated-foreground)",
              }}
              className={cn(
                "absolute right-0 bottom-full mb-1 z-50",
                "w-max min-w-[200px] rounded-xl p-1",
                "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.8),inset_0_0_0_1px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.10),0_1px_2px_-0.5px_rgba(0,0,0,0.08),0_4px_8px_-2px_rgba(0,0,0,0.08),0_12px_20px_-4px_rgba(0,0,0,0.08)]",
                "dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_0_0_1px_rgba(255,255,255,0.08),0_0_0_1px_rgba(0,0,0,0.36),0_1px_1px_-0.5px_rgba(0,0,0,0.22),0_3px_3px_-1.5px_rgba(0,0,0,0.20),0_6px_6px_-3px_rgba(0,0,0,0.16)]",
                "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2",
                "duration-150"
              )}
            >
              {/* Header */}
              <div className="flex items-center gap-1.5 px-2 py-1 typography-ui-label font-medium text-muted-foreground">
                <span>{"Tasks"}</span>
                <span className="typography-meta tabular-nums">
                  {progress.completed}/{progress.total}
                </span>
              </div>

              {/* Todo list */}
              <div className="px-1 max-h-[200px] overflow-y-auto">
                {visibleTodos.map((todo, index) => (
                  <TodoItemRow key={todo.id ?? `todo-${index}`} todo={todo} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
