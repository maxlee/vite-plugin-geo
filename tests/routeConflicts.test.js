import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { buildGeoGenerationPlanFromDisk } from '../geoBuildPipeline.js';
import { dedupeHtmlFilesByPagePath, findHtmlFiles } from '../geoGenerator.js';

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
});
