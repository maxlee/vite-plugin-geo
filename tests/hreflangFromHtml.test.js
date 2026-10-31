import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildGeoGenerationPlanFromDisk } from '../geoBuildPipeline.js';

const roots = [];

function fixture(pages) {
  const root = mkdtempSync(join(tmpdir(), 'geo-hreflang-'));
  roots.push(root);
  const distDir = join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'hreflang-fixture', domain: 'https://example.test' }));
  for (const [name, source] of Object.entries(pages)) {
    mkdirSync(join(distDir, name, '..'), { recursive: true });
    writeFileSync(join(distDir, name), source);
  }
  return { root, distDir };
}

function html(lang, title, alternates = []) {
  const links = alternates
    .map(({ hreflang, href }) => `<link rel="alternate" hreflang="${hreflang}" href="${href}">`)
    .join('');
  return `<html lang="${lang}"><head><title>${title}</title>${links}</head><body><h1>${title}</h1></body></html>`;
}

function sitemapOf(plan) {
  return plan.files.find(({ filename }) => filename === 'sitemap.xml')?.content || '';
}

function planFor(f, options = {}) {
  return buildGeoGenerationPlanFromDisk({
    projectRoot: f.root,
    distDir: f.distDir,
    currentDate: '2026-10-01T00:00:00.000Z',
    options: { generateFeed: false, ...options },
  });
}

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('hreflangFromHtml', () => {
  it('emits declared alternates, synthesizes self, and never invents x-default', async () => {
    const f = fixture({
      'en/index.html': html('en', 'English', [
        { hreflang: 'en', href: 'https://example.test/en' },
        { hreflang: 'zh', href: 'https://example.test/zh' },
      ]),
      'zh/index.html': html('zh', '中文', [
        { hreflang: 'en', href: 'https://example.test/en' },
      ]),
    });
    const sitemap = sitemapOf(await planFor(f, { hreflangFromHtml: true }));

    expect(sitemap).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(sitemap).toContain('<loc>https://example.test/en</loc>');
    expect(sitemap).toContain('<loc>https://example.test/zh</loc>');
    expect(sitemap).toContain('hreflang="zh" href="https://example.test/zh"');
    expect(sitemap).toContain('hreflang="en" href="https://example.test/en"');
    expect(sitemap).not.toContain('x-default');
  });

  it('falls back to global patterns for pages without declarations', async () => {
    const f = fixture({
      'en/index.html': html('en', 'English', [
        { hreflang: 'zh', href: 'https://example.test/zh' },
      ]),
      'zh/index.html': html('zh', '中文', [
        { hreflang: 'en', href: 'https://example.test/en' },
      ]),
      'about.html': html('en', 'About'),
    });
    const sitemap = sitemapOf(await planFor(f, {
      hreflangFromHtml: true,
      hreflang: { en: 'https://example.test/{path}' },
    }));

    expect(sitemap).toContain('hreflang="en" href="https://example.test/about"');
    expect(sitemap).toContain('hreflang="en" href="https://example.test/en"');
  });

  it('does not emit hreflang markup when nothing is declared or configured', async () => {
    const f = fixture({ 'about.html': html('en', 'About') });
    const sitemap = sitemapOf(await planFor(f, { hreflangFromHtml: true }));

    expect(sitemap).not.toContain('xhtml:link');
    expect(sitemap).not.toContain('xmlns:xhtml');
  });
});
