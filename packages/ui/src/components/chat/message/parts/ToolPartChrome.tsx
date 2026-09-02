import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { TOOL_ROW_DESCRIPTION_CLASS } from './toolPartStyles';

interface ToolScrollableSectionProps {
    children: React.ReactNode;
    maxHeightClass?: string;
    className?: string;
    outerClassName?: string;
    disableHorizontal?: boolean;
    followKey?: string;
}

export const ToolScrollableSection: React.FC<ToolScrollableSectionProps> = ({
    children,
    maxHeightClass = 'max-h-[60vh]',
    className,
    outerClassName,
    disableHorizontal = false,
    followKey,
}) => {
    const scrollRef = React.useRef<HTMLElement>(null);
    const isFollowingRef = React.useRef(true);

    React.useLayoutEffect(() => {
        const element = scrollRef.current;
        if (followKey === undefined) {
            isFollowingRef.current = true;
            return;
        }
        if (!element || !isFollowingRef.current) {
            return;
        }
        element.scrollTop = element.scrollHeight;
    }, [followKey]);

    return (
        <div className={cn('w-full min-w-0 flex-none overflow-hidden', outerClassName)}>
            <ScrollShadow
                ref={scrollRef}
                data-scrollable="true"
                onWheelCapture={(event) => {
                    if (followKey !== undefined && event.deltaY < 0) {
                        isFollowingRef.current = false;
                    }
                }}
                onScroll={(event) => {
                    if (followKey === undefined) {
                        return;
                    }
                    const element = event.currentTarget;
                    isFollowingRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
                }}
                className={cn(
                    'tool-output-surface p-2 rounded-xl w-full min-w-0',
                    maxHeightClass,
                    disableHorizontal ? 'overflow-y-auto overflow-x-hidden' : 'overflow-auto',
                    className,
                )}
            >
                <div className="w-full min-w-0">{children}</div>
            </ScrollShadow>
        </div>
    );
};

export const ToolGitPath: React.FC<{ path: string; grow?: boolean }> = ({ path, grow = true }) => {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash === -1) {
        return (
            <span
                className={cn('min-w-0 truncate typography-ui-label text-foreground', grow && 'flex-1')}
                style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}
                title={path}
            >
                {path}
            </span>
        );
    }

    const dir = path.slice(0, lastSlash);
    const name = path.slice(lastSlash + 1);
    const hasAbsoluteRoot = dir.startsWith('/');
    const displayDir = hasAbsoluteRoot ? dir.slice(1) : dir;

    return (
        <span className={cn('min-w-0 flex items-baseline overflow-hidden typography-ui-label', grow && 'flex-1')} title={path}>
            {hasAbsoluteRoot ? <span className="flex-shrink-0 text-muted-foreground">/</span> : null}
            <span className="min-w-0 truncate text-muted-foreground" style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}>
                {displayDir}
            </span>
            <span className="flex-shrink-0">
                <span className="text-muted-foreground">/</span>
                <span className="text-foreground">{name}</span>
            </span>
        </span>
    );
};

export const AnimatedToolPath: React.FC<{
    path: string;
    animate?: boolean;
    grow?: boolean;
    showFileIcons?: boolean;
}> = ({ path, animate = true, grow = true, showFileIcons = true }) => {
    const lastSlash = path.lastIndexOf('/');

    if (lastSlash === -1) {
        return (
            <span className={cn('min-w-0 inline-flex items-center gap-1 overflow-hidden', grow && 'flex-1')} title={path}>
                {showFileIcons ? <FileTypeIcon filePath={path} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
                <Text
                    variant={animate ? 'generate-effect' : 'static'}
                    className={cn('min-w-0 truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS, grow && 'flex-1')}
                    style={{ color: 'var(--tools-title)' }}
                >
                    {path}
                </Text>
            </span>
        );
    }

    const dir = path.slice(0, lastSlash);
    const name = path.slice(lastSlash + 1);
    const hasAbsoluteRoot = dir.startsWith('/');
    const displayDir = hasAbsoluteRoot ? dir.slice(1) : dir;

    return (
        <span className={cn('min-w-0 inline-flex items-center gap-1 overflow-hidden', grow && 'flex-1')} title={path}>
            {showFileIcons ? <FileTypeIcon filePath={path} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
            <span className={cn('min-w-0 inline-flex max-w-full items-baseline overflow-hidden', TOOL_ROW_DESCRIPTION_CLASS, grow && 'flex-1')}>
                {hasAbsoluteRoot ? <span className="flex-shrink-0" style={{ color: 'var(--tools-description)' }}>/</span> : null}
                <span
                    className="min-w-0 shrink truncate whitespace-nowrap"
                    style={{
                        color: 'var(--tools-description)',
                        direction: 'rtl',
                        textAlign: 'left',
                        unicodeBidi: 'plaintext',
                    }}
                >
                    {displayDir}
                </span>
                <span className="flex-shrink-0" style={{ color: 'var(--tools-description)' }}>/</span>
                <Text
                    variant={animate ? 'generate-effect' : 'static'}
                    className="flex-shrink-0"
                    style={{ color: 'var(--tools-title)' }}
                >
                    {name}
                </Text>
            </span>
        </span>
    );
};
