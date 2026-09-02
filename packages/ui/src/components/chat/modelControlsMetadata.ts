import type { IconName } from '@/components/icon/icons';
import type { ModelMetadata } from '@/types';

interface CapabilityDefinition {
    key: 'tool_call' | 'reasoning';
    icon: IconName;
    label: string;
    isActive: (metadata?: ModelMetadata) => boolean;
}

const CAPABILITY_DEFINITIONS: CapabilityDefinition[] = [
    {
        key: 'tool_call',
        icon: 'tools',
        label: 'Tool calling',
        isActive: (metadata) => metadata?.tool_call === true,
    },
    {
        key: 'reasoning',
        icon: 'brain-ai-3',
        label: 'Reasoning',
        isActive: (metadata) => metadata?.reasoning === true,
    },
];

interface ModalityIconDefinition {
    icon: IconName;
    label: string;
}

export type ModelMetadataIcon = {
    key: string;
    icon: IconName;
    label: string;
};

const MODALITY_ICON_MAP: Record<string, ModalityIconDefinition> = {
    text: { icon: 'text', label: 'Text' },
    image: { icon: 'file-image', label: 'Image' },
    video: { icon: 'file-video', label: 'Video' },
    audio: { icon: 'file-music', label: 'Audio' },
    pdf: { icon: 'file-pdf', label: 'PDF' },
};

const normalizeModality = (value: string) => value.trim().toLowerCase();

export const getModalityIcons = (
    metadata: ModelMetadata | undefined,
    direction: 'input' | 'output',
): ModelMetadataIcon[] => {
    const modalityList = direction === 'input' ? metadata?.modalities?.input : metadata?.modalities?.output;
    if (!Array.isArray(modalityList) || modalityList.length === 0) return [];

    const uniqueValues = Array.from(new Set(modalityList.map((item) => normalizeModality(item))));
    const result: ModelMetadataIcon[] = [];
    for (const modality of uniqueValues) {
        const definition = MODALITY_ICON_MAP[modality];
        if (!definition) continue;
        result.push({ key: modality, icon: definition.icon, label: definition.label });
    }
    return result;
};

const formatCompactNumber = (value: number) => new Intl.NumberFormat('en-US', {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
}).format(value);

const formatUsdCurrency = (value: number) => new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
    minimumFractionDigits: 2,
}).format(value);

const formatKnowledgeDate = (value: Date) => new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(value);

const formatReleaseDate = (value: Date) => new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
}).format(value);

export const formatTokens = (value?: number | null) => {
    if (typeof value !== 'number' || Number.isNaN(value)) return '—';
    if (value === 0) return '0';
    const formatted = formatCompactNumber(value);
    return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
};

export const formatCost = (value?: number | null) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    return formatUsdCurrency(value);
};

export const getCapabilityIcons = (metadata?: ModelMetadata): ModelMetadataIcon[] => {
    const result: ModelMetadataIcon[] = [];
    for (const definition of CAPABILITY_DEFINITIONS) {
        if (definition.isActive(metadata)) {
            result.push({ key: definition.key, icon: definition.icon, label: definition.label });
        }
    }
    return result;
};

export const formatKnowledge = (knowledge?: string) => {
    if (!knowledge) return '—';

    const match = knowledge.match(/^(\d{4})-(\d{2})$/);
    if (match) {
        const year = Number.parseInt(match[1], 10);
        const monthIndex = Number.parseInt(match[2], 10) - 1;
        const knowledgeDate = new Date(Date.UTC(year, monthIndex, 1));
        if (!Number.isNaN(knowledgeDate.getTime())) return formatKnowledgeDate(knowledgeDate);
    }
    return knowledge;
};

export const formatDate = (value?: string) => {
    if (!value) return '—';
    const parsedDate = new Date(value);
    if (Number.isNaN(parsedDate.getTime())) return value;
    return formatReleaseDate(parsedDate);
};
