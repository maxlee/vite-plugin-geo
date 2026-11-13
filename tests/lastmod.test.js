import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildGeoGenerationPlanFromDisk, validateGeoOptions } from '../src/geoBuildPipeline.js';

const roots = [];

function page(title) {
  return `<html lang="en"><head><title>${title}</title><meta name="description" content="${title} desc"></head><body><h1>${title}</h1></body></html>`;
}

function fixture(pages) {
  const root = mkdtempSync(join(tmpdir(), 'geo-lastmod-'));
  roots.push(root);
  const distDir = join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'lastmod-fixture', domain: 'https://example.test' }));
  for (const [name, source] of Object.entries(pages)) {
    mkdirSync(join(distDir, name, '..'), { recursive: true });
    writeFileSync(join(distDir, name), source);
  }
  return { root, distDir };
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

describe('lastmod resolution', () => {
  it('resolves sourceHtmlDir against projectRoot and honors ignore globs', async () => {
    const f = fixture({ 'index.html': page('Home'), 'about.html': page('About') });
    mkdirSync(join(f.root, 'src/pages'), { recursive: true });
    const sourceIndex = join(f.root, 'src/pages/index.html');
    const sourceAbout = join(f.root, 'src/pages/about.html');
    writeFileSync(sourceIndex, page('Home source'));
    writeFileSync(sourceAbout, page('About source'));
    const indexTime = new Date('2024-01-02T03:04:05.000Z');
    const aboutTime = new Date('2024-02-03T04:05:06.000Z');
    utimesSync(sourceIndex, indexTime, indexTime);
    utimesSync(sourceAbout, aboutTime, aboutTime);

    const sitemap = sitemapOf(await planFor(f, {
      sourceHtmlDir: 'src/pages',
      lastmodStrategy: 'file-mtime',
    }));
    expect(sitemap).toContain(`<lastmod>${indexTime.toISOString()}</lastmod>`);
    expect(sitemap).toContain(`<lastmod>${aboutTime.toISOString()}</lastmod>`);

    const ignored = sitemapOf(await planFor(f, {
      sourceHtmlDir: 'src/pages',
      lastmodStrategy: 'file-mtime',
      lastmodIgnore: ['about.html'],
    }));
    expect(ignored).toContain(`<lastmod>${indexTime.toISOString()}</lastmod>`);
    expect((ignored.match(/<lastmod>/g) || [])).toHaveLength(1);
  });

  it('lets lastmodResolver override the strategy, with null omitting lastmod', async () => {
    const f = fixture({ 'index.html': page('Home'), 'about.html': page('About') });
    const sitemap = sitemapOf(await planFor(f, {
      lastmodStrategy: 'build',
      lastmodResolver: (model) => (model.relativePath === 'index.html'
        ? new Date('2025-05-05T00:00:00.000Z')
        : null),
    }));

    expect(sitemap).toContain('<lastmod>2025-05-05T00:00:00.000Z</lastmod>');
    expect((sitemap.match(/<lastmod>/g) || [])).toHaveLength(1);
  });

  it('honors lastmodResolver under the default none strategy', async () => {
    const f = fixture({ 'index.html': page('Home'), 'about.html': page('About') });
    const sitemap = sitemapOf(await planFor(f, {
      lastmodResolver: (model) => (model.relativePath === 'index.html'
        ? new Date('2025-05-05T00:00:00.000Z')
        : null),
    }));

    expect(sitemap).toContain('<lastmod>2025-05-05T00:00:00.000Z</lastmod>');
    expect((sitemap.match(/<lastmod>/g) || [])).toHaveLength(1);
  });

  it('falls through to the strategy when lastmodResolver returns undefined', async () => {
    const f = fixture({ 'index.html': page('Home') });
    const sitemap = sitemapOf(await planFor(f, {
      lastmodStrategy: 'build',
      lastmodResolver: () => undefined,
    }));

    expect(sitemap).toContain('<lastmod>2026-10-01T00:00:00.000Z</lastmod>');
  });

  it('accepts W3C Datetime strings and normalizes them to ISO', async () => {
    const f = fixture({ 'index.html': page('Home'), 'about.html': page('About') });
    const sitemap = sitemapOf(await planFor(f, {
      lastmodResolver: (model) => (model.relativePath === 'index.html'
        ? '2025-05-05'
        : '2025-05-05T00:00:00+08:00'),
    }));

    expect(sitemap).toContain('<lastmod>2025-05-05T00:00:00.000Z</lastmod>');
    expect(sitemap).toContain('<lastmod>2025-05-04T16:00:00.000Z</lastmod>');
  });

  it('rejects invalid lastmodResolver values while planning', async () => {
    const f = fixture({ 'index.html': page('Home') });
    const invalidValues = [
      'May 5, 2025',
      '2025-02-30',
      '',
      new Date('invalid'),
      123,
      true,
    ];

    for (const value of invalidValues) {
      await expect(planFor(f, { lastmodResolver: () => value }))
        .rejects.toThrow(/lastmodResolver.*invalid lastmod for index\.html/);
    }
  });

  it('aggregates git warnings into one summary outside debug mode', async () => {
    const f = fixture({ 'index.html': page('Home'), 'about.html': page('About') });
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
      await planFor(f, { sourceHtmlDir: 'src/pages', lastmodStrategy: 'git' });
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Lastmod unavailable for 2 page\(s\) \(strategy=git\)/);
    expect(warnings[0]).toContain('index.html');
  });

  it('validates the new option surface', () => {
    expect(() => validateGeoOptions({ lastmodResolver: 'nope' })).toThrow(/lastmodResolver/);
    expect(() => validateGeoOptions({ sitemapConflict: 'nope' })).toThrow(/sitemapConflict/);
    expect(() => validateGeoOptions({ routeConflict: 'nope' })).toThrow(/routeConflict/);
    expect(() => validateGeoOptions({ auditFailOn: 'nope' })).toThrow(/auditFailOn/);
    expect(() => validateGeoOptions({ lastmodIgnore: 'about.html' })).toThrow(/lastmodIgnore/);
  });

  it('passes populated pageUrl to lastmodResolver and skips excluded pages', async () => {
    const f = fixture({
      'index.html': page('Home'),
      '404.html': page('Missing'),
      'secret.html': '<html><head><meta name="robots" content="noindex"></head><body>Hidden</body></html>',
    });
    const seen = [];
    await planFor(f, {
      lastmodResolver: (model) => {
        seen.push({ relativePath: model.relativePath, pageUrl: model.pageUrl, filePageUrl: model.filePageUrl });
        return '2026-05-01';
      },
    });

    expect(seen).toEqual([
      {
        relativePath: 'index.html',
        pageUrl: 'https://example.test',
        filePageUrl: 'https://example.test/',
      },
    ]);
  });
});
