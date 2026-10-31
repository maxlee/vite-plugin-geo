import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { applyGeoGenerationPlanToDisk, buildGeoGenerationPlanFromDisk } from '../geoBuildPipeline.js';
import { verifyGeoOutput } from '../geoVerify.js';

const roots = [];
const siteUrl = 'https://example.test';

function page(title) {
  return `<html lang="en"><head><title>${title}</title><meta name="description" content="${title} desc"></head><body><h1>${title}</h1></body></html>`;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'geo-verify-'));
  roots.push(root);
  const distDir = join(root, 'dist');
  mkdirSync(join(distDir, 'src/pages'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'verify-fixture', domain: siteUrl }));
  writeFileSync(join(distDir, 'src/pages/index.html'), page('Home'));
  writeFileSync(join(distDir, 'src/pages/about.html'), page('About'));
  return { root, distDir };
}

async function generate(f, options = {}) {
  const plan = await buildGeoGenerationPlanFromDisk({
    projectRoot: f.root,
    distDir: f.distDir,
    currentDate: '2026-10-01T00:00:00.000Z',
    options,
  });
  applyGeoGenerationPlanToDisk(plan, { distDir: f.distDir });
  return plan;
}

function verify(f, options = {}) {
  return verifyGeoOutput({ projectRoot: f.root, distDir: f.distDir, options });
}

function snapshot(dir) {
  const files = new Map();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else files.set(relative(dir, entryPath), readFileSync(entryPath));
    }
  };
  visit(dir);
  return files;
}

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('geo verify', () => {
  it('accepts a healthy generated build and never writes to dist', async () => {
    const f = fixture();
    await generate(f);
    const before = snapshot(f.distDir);

    const result = verify(f);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.summary).toMatchObject({
      siteUrl,
      sitemapFile: 'sitemap.xml',
      sitemapLocCount: 2,
      pageCount: 2,
      errorCount: 0,
      warningCount: 0,
    });
    expect(snapshot(f.distDir)).toEqual(before);
  });

  it('catches a third-party sitemap that replaced the generated one', async () => {
    const f = fixture();
    await generate(f);
    const ghostLocs = Array.from(
      { length: 95 },
      (_, index) => `<url><loc>https://example.test/src/pages/ghost-${index}.html</loc></url>`,
    ).join('');
    writeFileSync(join(f.distDir, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?><urlset>${ghostLocs}<url><loc>https://example.test/src/pages/index.html</loc></url><url><loc>https://example.test/src/pages/index.html</loc></url></urlset>`);

    const result = verify(f);
    const rules = result.errors.map((item) => item.rule);

    expect(result.ok).toBe(false);
    expect(result.summary.sitemapLocCount).toBe(97);
    expect(rules).toEqual(expect.arrayContaining([
      'sitemap-intermediate-prefix',
      'sitemap-html-extension',
      'sitemap-unmapped-loc',
      'sitemap-duplicate-loc',
      'sitemap-homepage-missing',
      'sitemap-missing-page',
    ]));
  });

  it('reports a loc count below the number of pages', async () => {
    const f = fixture();
    await generate(f);
    writeFileSync(
      join(f.distDir, 'sitemap.xml'),
      `<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>${siteUrl}</loc></url></urlset>`,
    );

    const result = verify(f);

    expect(result.errors.map((item) => item.rule)).toContain('sitemap-url-count');
    expect(result.errors.map((item) => item.rule)).toContain('sitemap-missing-page');
  });

  it('follows sitemap indexes and counts child locs', async () => {
    const f = fixture();
    await generate(f);
    const generated = readFileSync(join(f.distDir, 'sitemap.xml'), 'utf-8');
    writeFileSync(join(f.distDir, 'sitemap-a.xml'), generated);
    unlinkSync(join(f.distDir, 'sitemap.xml'));
    writeFileSync(
      join(f.distDir, 'sitemap_index.xml'),
      `<?xml version="1.0" encoding="UTF-8"?><sitemapindex><sitemap><loc>${siteUrl}/sitemap-a.xml</loc></sitemap></sitemapindex>`,
    );

    const result = verify(f);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary.sitemapFile).toBe('sitemap_index.xml');
    expect(result.summary.sitemapLocCount).toBe(2);
    expect(result.checks.sitemapFiles).toEqual(expect.arrayContaining(['sitemap_index.xml', 'sitemap-a.xml']));
    // robots.txt still points at sitemap.xml
    expect(result.warnings.map((item) => item.rule)).toContain('robots-sitemap-mismatch');
  });

  it('warns about robots mismatches, missing mirrors, and broken llms links', async () => {
    const f = fixture();
    await generate(f);
    unlinkSync(join(f.distDir, 'about.md'));
    writeFileSync(join(f.distDir, 'robots.txt'), 'User-agent: *\nAllow: /\nSitemap: https://example.test/other.xml\n');

    const result = verify(f);
    const rules = result.warnings.map((item) => item.rule);

    expect(result.ok).toBe(true);
    expect(rules).toEqual(expect.arrayContaining([
      'robots-sitemap-mismatch',
      'markdown-mirror-missing',
      'llms-link-invalid',
    ]));
  });
});
