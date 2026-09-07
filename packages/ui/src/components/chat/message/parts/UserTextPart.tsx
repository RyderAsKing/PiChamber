import React from 'react';
import { cn } from '@/lib/utils';
import type { Part } from '@/lib/chat/types';
import type { AgentMentionInfo } from '../types';
import { SimpleMarkdownRenderer } from '../../MarkdownRenderer';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { Icon } from "@/components/icon/Icon";
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { openSkillSettings } from '@/lib/skills/openSkillSettings';
import { parseSkillHref } from '@/lib/messages/inlineMessageLinks';
import { prepareUserMarkdownContent } from './userTextPartContent';

type PartWithText = Part & { text?: string; content?: string; value?: string };

type UserTextPartProps = {
    part: Part;
    messageId: string;
    isMobile: boolean;
    agentMention?: AgentMentionInfo;
};

const UserTextPart: React.FC<UserTextPartProps> = ({ part, messageId, agentMention }) => {
    const partWithText = part as PartWithText;
    const rawText = partWithText.text;
    const serializedText = typeof rawText === 'string' ? rawText : partWithText.content || partWithText.value || '';
    const textContent = serializedText;

    const [isExpanded, setIsExpanded] = React.useState(false);
    const [isTruncated, setIsTruncated] = React.useState(false);
    const skills = useSkillsStore((state) => state.skills);
    const mobileActions = useMobileAppActions();

    const isCollapsed = !isExpanded;
    const textRef = React.useRef<HTMLDivElement>(null);
    const skillByName = React.useMemo(() => new Map(skills.map((skill) => [skill.name, skill])), [skills]);

    const openSkill = React.useCallback((name: string) => {
        if (!skillByName.has(name)) return;
        openSkillSettings(name, mobileActions);
    }, [mobileActions, skillByName]);

    const hasActiveSelectionInElement = React.useCallback((element: HTMLElement): boolean => {
        if (typeof window === 'undefined') {
            return false;
        }

        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
            return false;
        }

        const range = selection.getRangeAt(0);
        return element.contains(range.startContainer) || element.contains(range.endContainer);
    }, []);

    React.useEffect(() => {
        const el = textRef.current;
        if (!el) return;

        const checkTruncation = () => {
            if (!isExpanded) {
                setIsTruncated(el.scrollHeight > el.clientHeight);
            }
        };

        checkTruncation();

        const resizeObserver = new ResizeObserver(checkTruncation);
        resizeObserver.observe(el);

        return () => resizeObserver.disconnect();
    }, [textContent, isExpanded]);

    const handleClick = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement | null;
        const skillLink = target?.closest<HTMLElement>('[data-skill-name]');
        const skillName = skillLink?.dataset.skillName
            ?? parseSkillHref(target?.closest<HTMLAnchorElement>('a[href]')?.getAttribute('href'));
        if (skillName) {
            event.preventDefault();
            event.stopPropagation();
            openSkill(skillName);
            return;
        }

        const element = textRef.current;
        if (!element) {
            return;
        }

        if (hasActiveSelectionInElement(element)) {
            return;
        }

        if (!isExpanded && isTruncated) {
            setIsExpanded(true);
        }
    }, [hasActiveSelectionInElement, isExpanded, isTruncated, openSkill]);

    const handleCollapse = React.useCallback((event: React.MouseEvent) => {
        event.stopPropagation();
        setIsExpanded(false);
    }, []);

    const processedMarkdownContent = React.useMemo(() => {
        return prepareUserMarkdownContent({
            textContent,
            agentMention,
            skillNames: new Set(skillByName.keys()),
        });
    }, [agentMention, skillByName, textContent]);

    if (!textContent || textContent.trim().length === 0) {
        return null;
    }

    return (
        <div className="relative" key={part.id || `${messageId}-user-text`}>
            {isExpanded && (
                <button
                    type="button"
                    onClick={handleCollapse}
                    className="absolute top-0 right-0 z-10 flex items-center justify-center rounded-sm bg-[var(--surface-elevated)] p-0.5 text-[var(--surface-mutedForeground)] hover:text-[var(--surface-foreground)] hover:bg-[var(--interactive-hover)] transition-colors"
                    aria-label={"Collapse user message"}
                >
                    <Icon name="arrow-up-s" className="h-3.5 w-3.5" />
                </button>
            )}
            <div
                className={cn(
                    "break-words font-sans typography-markdown-body",
                    isExpanded && "pb-3",
                    isCollapsed && "line-clamp-2",
                    isTruncated && !isExpanded && "cursor-pointer"
                )}
                ref={textRef}
                onClick={handleClick}
            >
                <SimpleMarkdownRenderer
                    content={processedMarkdownContent}
                    className={cn(
                        "[&_.markdown-content>*:first-child]:mt-0 [&_.markdown-content>*:last-child]:mb-0",
                        isCollapsed && [
                            "[&_.markdown-content>*]:my-0",
                            "[&_[data-component='markdown-code']]:my-0",
                            "[&_[data-component='markdown-code']]:inline",
                            "[&_[data-component='markdown-code']]:border-0",
                            "[&_[data-component='markdown-code']]:bg-transparent",
                            "[&_[data-component='markdown-code']>*:first-child]:hidden",
                            "[&_[data-component='markdown-code']>div]:inline",
                             "[&_[data-component='markdown-code']>div]:p-0",
                             "[&_[data-component='markdown-code']_pre]:inline",
                             "[&_[data-component='markdown-code']_code]:inline",
                             "[&_[data-md-code-line]]:!inline",
                             "[&_[data-md-code-line-number]]:hidden",
                             "[&_[data-md-code-line-break]]:!inline",
                         ]
                    )}
                    disableLinkSafety
                    enableFileReferences={false}
                />
            </div>
        </div>
    );
};

export default React.memo(UserTextPart);
