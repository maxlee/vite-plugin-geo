import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { buildGeoGenerationPlanFromDisk } from '../src/geoBuildPipeline.js';
import { dedupeHtmlFilesByPagePath, findHtmlFiles } from '../src/geoGenerator.js';

const roots = [];

function page(title) {
  return `<html lang="en"><head><title>${title}</title><meta name="description" content="${title} desc"></head><body><h1>${title}</h1></body></html>`;
}

function fixture(pages) {
  const root = mkdtempSync(join(tmpdir(), 'geo-route-conflict-'));
  roots.push(root);
  const distDir = join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'route-fixture', domain: 'https://example.test' }));
  for (const [name, source] of Object.entries(pages)) {
    mkdirSync(join(distDir, name, '..'), { recursive: true });
    writeFileSync(join(distDir, name), source);
  }
  return { root, distDir };
}

function planFor(f, options = {}) {
  return buildGeoGenerationPlanFromDisk({
    projectRoot: f.root,
    distDir: f.distDir,
    currentDate: '2026-10-01T00:00:00.000Z',
    options,
  });
}

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('duplicate public routes', () => {
  const pages = {
    'index.html': page('Home'),
    'fonts.html': page('Fonts'),
    'fonts/index.html': page('Fonts Index'),
  };

  it('throws by default and lists every conflicting file', async () => {
    const f = fixture(pages);
    await expect(planFor(f)).rejects.toThrow(
      /Route conflict: 2 files map to the same public page "\/fonts": fonts\.html、fonts\/index\.html/,
    );
  });

  it('resolves deterministically with first and reports the choice', async () => {
    const f = fixture(pages);
    const plan = await planFor(f, { routeConflict: 'first' });

    expect(plan.report.routeConflicts).toEqual([{
      pagePath: 'fonts',
      route: '/fonts',
      files: ['fonts.html', 'fonts/index.html'],
      chosen: 'fonts.html',
    }]);
    const sitemap = plan.files.find(({ filename }) => filename === 'sitemap.xml')?.content || '';
    expect((sitemap.match(/<loc>/g) || [])).toHaveLength(2);
  });

  it('resolves deterministically with last', async () => {
    const f = fixture(pages);
    const plan = await planFor(f, { routeConflict: 'last' });

    expect(plan.report.routeConflicts[0].chosen).toBe('fonts/index.html');
  });

  it('uses the same policy in the sitemap/llms dedupe helper', () => {
    const f = fixture(pages);
    const htmlFiles = findHtmlFiles(f.distDir);

    const first = dedupeHtmlFilesByPagePath(htmlFiles, f.distDir, { routeConflict: 'first' })
      .map((filePath) => relative(f.distDir, filePath).replace(/\\/g, '/'));
    const last = dedupeHtmlFilesByPagePath(htmlFiles, f.distDir, { routeConflict: 'last' })
      .map((filePath) => relative(f.distDir, filePath).replace(/\\/g, '/'));

    expect(first).toEqual(['fonts.html', 'index.html']);
    expect(last).toEqual(['fonts/index.html', 'index.html']);
    expect(() => dedupeHtmlFilesByPagePath(htmlFiles, f.distDir, {}))
      .toThrow(/Route conflict/);
  });

  it('ignores excluded and noindex localized 404 duplicates under default routeConflict: error', async () => {
    const noindexPage = (title) => (
      `<html lang="ar"><head><title>${title}</title><meta name="robots" content="noindex,follow"></head><body><h1>${title}</h1></body></html>`
    );
    const f = fixture({
      'index.html': page('Home'),
      'ar/404.html': noindexPage('404 Flat'),
      'ar/404/index.html': noindexPage('404 Dir'),
    });

    const plan = await planFor(f);
    expect(plan.report.routeConflicts).toEqual([]);
    expect(plan.report.totalHtmlFiles).toBe(3);
    expect(plan.report.includedHtmlFiles).toBe(1);
    expect(plan.report.excludedHtmlFiles).toBe(2);
    expect(plan.report.excludedDetails).toEqual([
      { path: 'ar/404.html', reason: 'default exclude' },
      { path: 'ar/404/index.html', reason: 'contains noindex meta tag' },
    ]);

    const files = plan.files.map(({ filename }) => filename);
    expect(files).not.toContain('ar/404.md');
    expect(plan.files.find(({ filename }) => filename === 'sitemap.xml')?.content).not.toContain('404');
    expect(plan.files.find(({ filename }) => filename === 'llms.txt')?.content).not.toContain('404');
    expect(plan.files.find(({ filename }) => filename === 'feed.xml')?.content).not.toContain('404');
  });

  it('resolves mixed public and noindex or pattern-excluded pages on the same route without throwing', async () => {
    const f = fixture({
      'index.html': '<html lang="en"><head><title>Home</title><meta name="description" content="Home desc"></head><body><h1>Home</h1><a href="/guide">Public Guide</a><a href="/guide/index.html">Old Guide</a></body></html>',
      'guide.html': page('Public Guide'),
      'guide/index.html': '<html lang="en"><head><title>Old Guide</title><meta name="robots" content="noindex"></head><body><h1>Old Guide</h1></body></html>',
      'private.html': page('Private Flat'),
      'private/index.html': page('Public Private Dir'),
    });

    const plan = await planFor(f, {
      excludePatterns: ['private.html'],
    });

    expect(plan.report.routeConflicts).toEqual([]);
    expect(plan.report.includedHtmlFiles).toBe(3);
    expect(plan.report.excludedHtmlFiles).toBe(2);

    const sitemap = plan.files.find(({ filename }) => filename === 'sitemap.xml')?.content || '';
    expect(sitemap).toContain('<loc>https://example.test/guide</loc>');
    expect(sitemap).toContain('<loc>https://example.test/private</loc>');

    // Excluded noindex page still triggers anchor-noindex when linked directly,
    // while public /guide route stays non-noindex.
    const noindexWarnings = plan.report.audit.diagnostics
      .filter((item) => item.rule === 'anchor-noindex')
      .map((item) => item.evidence);
    expect(noindexWarnings).toHaveLength(1);
    expect(noindexWarnings[0]).toContain('/guide/index.html');
  });
});
