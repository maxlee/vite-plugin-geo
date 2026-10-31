import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  applyGeoGenerationPlanToDisk,
  buildGeoGenerationPlanFromDisk,
} from '../geoBuildPipeline.js';

describe('shared GEO generation pipeline', () => {
  const fixtureRoot = join(process.cwd(), 'tempfiles', '__geo-build-pipeline__');
  const distDir = join(fixtureRoot, 'dist');

  beforeEach(() => {
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify({
      name: 'pipeline-fixture',
      domain: 'https://example.com',
    }));
    writeFileSync(
      join(distDir, 'index.html'),
      '<!doctype html><html lang="en"><head><title>Home &amp; Store</title><meta name="description" content="Catalog &amp; guides"></head><body><h1>Home</h1></body></html>',
    );
    writeFileSync(
      join(distDir, 'about.html'),
      '<!doctype html><html lang="en"><head><title>About</title></head><body><h1>About</h1></body></html>',
    );
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('builds every output and HTML update before writing anything', async () => {
    const plan = await buildGeoGenerationPlanFromDisk({
      projectRoot: fixtureRoot,
      distDir,
      options: {},
      currentDate: '2026-07-29T00:00:00.000Z',
    });

    expect(plan.files.map(({ filename }) => filename)).toEqual(expect.arrayContaining([
      'sitemap.xml',
      'llms.txt',
      'robots.txt',
      'feed.xml',
      'index.md',
      'about.md',
    ]));
    expect(plan.htmlUpdates).toHaveLength(2);
    expect(existsSync(join(distDir, 'llms.txt'))).toBe(false);
    expect(readFileSync(join(distDir, 'index.html'), 'utf-8')).not.toContain('application/rss+xml');

    applyGeoGenerationPlanToDisk(plan, { distDir });

    expect(readFileSync(join(distDir, 'llms.txt'), 'utf-8')).toContain('# Home & Store');
    expect(readFileSync(join(distDir, 'index.html'), 'utf-8')).toContain('application/rss+xml');
  });

  it('reuses a sitemap found in the final build output unless explicitly overridden', async () => {
    writeFileSync(join(distDir, 'catalog-index.xml'), '<sitemapindex></sitemapindex>');

    const plan = await buildGeoGenerationPlanFromDisk({
      projectRoot: fixtureRoot,
      distDir,
      options: { llmsMdMirror: false, generateFeed: false },
      currentDate: '2026-07-29T00:00:00.000Z',
    });

    expect(plan.files.map(({ filename }) => filename)).not.toContain('sitemap.xml');
    expect(plan.files.find(({ filename }) => filename === 'robots.txt')?.content)
      .toContain('Sitemap: https://example.com/catalog-index.xml');
  });

  it('generates sku.md only when the option is enabled', async () => {
    const defaultPlan = await buildGeoGenerationPlanFromDisk({
      projectRoot: fixtureRoot,
      distDir,
      options: { llmsMdMirror: false, generateFeed: false },
      currentDate: '2026-07-29T00:00:00.000Z',
    });
    expect(defaultPlan.files.map(({ filename }) => filename)).not.toContain('sku.md');

    const skuPlan = await buildGeoGenerationPlanFromDisk({
      projectRoot: fixtureRoot,
      distDir,
      options: {
        llmsMdMirror: false,
        generateFeed: false,
        skuMd: {
          merchantName: 'Example Store',
          summary: 'Example catalog.',
          catalog: [{ label: 'Catalog', url: 'https://example.com/catalog' }],
        },
      },
      currentDate: '2026-07-29T00:00:00.000Z',
    });

    expect(skuPlan.files.map(({ filename }) => filename)).toContain('sku.md');
    expect(skuPlan.files.find(({ filename }) => filename === 'llms.txt')?.content)
      .toContain('https://example.com/catalog');
  });

  it('fails before writing when any enabled output is invalid', async () => {
    await expect(buildGeoGenerationPlanFromDisk({
      projectRoot: fixtureRoot,
      distDir,
      options: {
        robotsDirectives: ['Disallow: /bad\u0000path'],
      },
      currentDate: '2026-07-29T00:00:00.000Z',
    })).rejects.toThrow(/control character/i);

    expect(existsSync(join(distDir, 'sitemap.xml'))).toBe(false);
    expect(existsSync(join(distDir, 'llms.txt'))).toBe(false);
    expect(readFileSync(join(distDir, 'index.html'), 'utf-8')).not.toContain('application/rss+xml');
  });
});
