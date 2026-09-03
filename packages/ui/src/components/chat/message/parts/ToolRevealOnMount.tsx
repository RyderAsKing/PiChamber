import React from 'react';
import { cn } from '@/lib/utils';

interface ToolRevealOnMountProps {
    children: React.ReactNode;
    animate: boolean;
    className?: string;
}

export const ToolRevealOnMount: React.FC<ToolRevealOnMountProps> = ({
    children,
    animate,
    className,
}) => (
    <div className={cn(animate && 'oc-step-in', className)}>
        {children}
    </div>
);
