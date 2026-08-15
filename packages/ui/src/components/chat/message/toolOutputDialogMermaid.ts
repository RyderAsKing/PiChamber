export class MermaidLoadFailure extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MermaidLoadFailure';
    }
}

const mermaidLoadFailure = (message: string): MermaidLoadFailure => new MermaidLoadFailure(message);

export const isMermaidLoadFailure = (value: unknown): value is MermaidLoadFailure => value instanceof MermaidLoadFailure;

export const nextMermaidLoadRequestId = (current: number): number => current + 1;

export const isCurrentMermaidLoadRequest = (current: number, requestId: number): boolean => current === requestId;

const decodeMermaidDataUrl = (value: string): string => {
    const commaIndex = value.indexOf(',');
    if (commaIndex < 0) {
        throw mermaidLoadFailure('The Mermaid data URL is malformed.');
    }

    const metadata = value.slice(0, commaIndex).toLowerCase();
    const payload = value.slice(commaIndex + 1);
    if (metadata.includes(';base64')) {
        return atob(payload);
    }
    return decodeURIComponent(payload);
};

export const getMermaidDataUrlSourcePromise = (value: string): Promise<string> => Promise.resolve().then(() => decodeMermaidDataUrl(value));
