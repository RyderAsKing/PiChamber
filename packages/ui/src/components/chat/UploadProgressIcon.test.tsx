import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UploadProgressIcon } from './UploadProgressIcon';

describe('UploadProgressIcon', () => {
  test('exposes an indeterminate progressbar while preparing', () => {
    const markup = renderToStaticMarkup(
      <UploadProgressIcon filename="notes.zip" progress={null} />,
    );
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('Uploading notes.zip');
    expect(markup).not.toContain('aria-valuenow');
  });

  test('lights up with the progress value and no progress text', () => {
    const markup = renderToStaticMarkup(
      <UploadProgressIcon filename="photo.png" progress={42} />,
    );
    expect(markup).toContain('aria-valuenow="42"');
    expect(markup).not.toContain('Uploading…');
    expect(markup).not.toContain('Uploading 42%');
  });

  test('clamps out-of-range progress into 0-100', () => {
    const low = renderToStaticMarkup(
      <UploadProgressIcon filename="photo.png" progress={-5} />,
    );
    expect(low).toContain('aria-valuenow="0"');
    const high = renderToStaticMarkup(
      <UploadProgressIcon filename="photo.png" progress={140} />,
    );
    expect(high).toContain('aria-valuenow="100"');
  });

  test('dims and desaturates an empty upload', () => {
    const markup = renderToStaticMarkup(
      <UploadProgressIcon filename="photo.png" progress={0} />,
    );
    expect(markup).toContain('aria-valuenow="0"');
    expect(markup).toContain('opacity:0.35');
    expect(markup).toContain('saturate(0)');
  });
});
