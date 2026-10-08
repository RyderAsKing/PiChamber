import { toast } from '@/components/ui';
import { saveOrShareFile } from '@/lib/nativeFileSave';
import i18n from '@/i18n';

export async function shareMessageAsImage(
  messageId: string,
  requestedSourceElement?: HTMLElement | null,
): Promise<void> {
  const sourceElement = requestedSourceElement;
  if (!sourceElement) return;

  let wrapper: HTMLDivElement | null = null;
  try {
    const { toPng } = await import('html-to-image');
    const originalElement = sourceElement;
    const computedStyle = window.getComputedStyle(originalElement);
    const rootStyle = window.getComputedStyle(document.documentElement);
    const resolvedBackgroundColor =
      rootStyle.getPropertyValue('--surface-background').trim() ||
      computedStyle.backgroundColor ||
      window.getComputedStyle(document.body).backgroundColor;
    const paddingSize = 24;

    wrapper = document.createElement('div');
    wrapper.setAttribute('data-message-image-export', 'true');
    wrapper.style.cssText = `
      padding: ${paddingSize}px;
      background-color: ${resolvedBackgroundColor};
      display: inline-block;
    `;

    const clone = originalElement.cloneNode(true) as HTMLElement;
    clone.style.cssText = `
      ${computedStyle.cssText}
      transform: none;
      contain: none;
    `;

    const actionRows = clone.querySelectorAll<HTMLElement>('[data-message-actions="true"]');
    actionRows.forEach((row) => {
      row.style.display = 'none';
    });
    const actionGroups = clone.querySelectorAll<HTMLElement>('[data-message-action-group="true"]');
    actionGroups.forEach((group) => {
      group.style.display = 'none';
    });

    // The timestamp aria-label is localized, so derive the active prefix at
    // call time instead of hardcoding the English string.
    const timestampPrefix = i18n.t('Message time: {{timestamp}}', { timestamp: '' }).trimEnd();
    const timestampElements = clone.querySelectorAll<HTMLElement>(`[aria-label^="${timestampPrefix}"]`);
    const footerRowsAdjusted = new Set<HTMLElement>();
    timestampElements.forEach((element) => {
      const label = element.getAttribute('aria-label');
      const timestamp = label?.slice(timestampPrefix.length).trim();
      if (!timestamp || element.textContent?.includes(timestamp)) {
        return;
      }

      const timestampText = document.createElement('span');
      timestampText.style.marginLeft = '4px';
      timestampText.textContent = timestamp;
      element.appendChild(timestampText);

      const metaGroup = element.parentElement;
      const footerRow = metaGroup?.parentElement as HTMLElement | null;
      if (!footerRow || footerRowsAdjusted.has(footerRow)) {
        return;
      }

      footerRow.style.justifyContent = 'flex-start';
      footerRowsAdjusted.add(footerRow);
    });

    wrapper.appendChild(clone);
    document.body.appendChild(wrapper);

    const dataUrl = await toPng(wrapper, {
      quality: 1,
      pixelRatio: 2,
      backgroundColor: resolvedBackgroundColor,
    });

    const fileName = `message-${messageId}.png`;

    const result = await saveOrShareFile({
      filename: fileName,
      mimeType: 'image/png',
      data: dataUrl,
    });

    if (result === 'downloaded') {
      toast.success(i18n.t('Image saved'));
    } else if (result === 'shared') {
      toast.success(i18n.t('Image shared'));
    }
  } catch (error) {
    console.error('Failed to generate image:', error);
    toast.error(i18n.t('Failed to generate image'));
  } finally {
    if (wrapper && wrapper.parentNode) {
      wrapper.parentNode.removeChild(wrapper);
    }
  }
}
