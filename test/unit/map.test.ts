import { describe, expect, it } from 'vitest';
import { absoluteUrl, bodyFor } from '../../src/provider/pf2e/map.js';
import { MAX_BODY_CHARS } from '../../src/constants.js';
import type { AonDocument } from '../../src/provider/pf2e/client.js';

describe('bodyFor', () => {
  it('returns text exactly MAX_BODY_CHARS long unchanged', () => {
    const text = 'a'.repeat(MAX_BODY_CHARS);
    const doc = { text } as AonDocument;
    const result = bodyFor(doc);
    expect(result).toBe(text);
    expect(result.length).toBe(MAX_BODY_CHARS);
  });

  it('truncates text longer than MAX_BODY_CHARS and appends marker without exceeding MAX_BODY_CHARS', () => {
    const text = 'a'.repeat(MAX_BODY_CHARS + 100);
    const doc = { text } as AonDocument;
    const result = bodyFor(doc);
    
    expect(result.length).toBe(MAX_BODY_CHARS);
    expect(result.endsWith(`\n\n[truncated at ${MAX_BODY_CHARS} characters]`)).toBe(true);
  });

  it('prefers text over markdown, but falls back to markdown if text is absent', () => {
    const doc1 = { text: 'plain text', markdown: '*markdown*' } as AonDocument;
    expect(bodyFor(doc1)).toBe('plain text');

    const doc2 = { markdown: '*markdown*' } as AonDocument;
    expect(bodyFor(doc2)).toBe('*markdown*');
  });
});

describe('absoluteUrl', () => {
  it('rewrites HTTP URLs from the same hostname to HTTPS', () => {
    expect(absoluteUrl('http://2e.aonprd.com/Spells.aspx?ID=1')).toBe('https://2e.aonprd.com/Spells.aspx?ID=1');
  });

  it('keeps HTTPS URLs from the same hostname unchanged', () => {
    expect(absoluteUrl('https://2e.aonprd.com/Spells.aspx?ID=1')).toBe('https://2e.aonprd.com/Spells.aspx?ID=1');
  });

  it('rejects URLs from other hostnames', () => {
    expect(absoluteUrl('https://evil.example.com/Spells.aspx')).toBeUndefined();
    expect(absoluteUrl('http://evil.example.com/Spells.aspx')).toBeUndefined();
  });

  it('prepends the base URL to relative paths', () => {
    expect(absoluteUrl('/Spells.aspx?ID=1')).toBe('https://2e.aonprd.com/Spells.aspx?ID=1');
    expect(absoluteUrl('Spells.aspx?ID=1')).toBe('https://2e.aonprd.com/Spells.aspx?ID=1');
  });

  it('rejects malicious schemes', () => {
    // javascript: parses as a URL but its hostname is empty, so it won't match 2e.aonprd.com
    expect(absoluteUrl('javascript:alert(1)')).toBeUndefined();
  });

  it('returns undefined for empty or undefined input', () => {
    expect(absoluteUrl(undefined)).toBeUndefined();
    expect(absoluteUrl('   ')).toBeUndefined();
  });
});
