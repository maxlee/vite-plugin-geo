import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  applyGeoGenerationPlanToDisk,
  buildGeoGenerationPlan,
  buildGeoGenerationPlanFromDisk,
  validateGeoOptions,
} from '../src/geoBuildPipeline.js';

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

  it('rejects path traversal in htmlInputs and applyGeoGenerationPlanToDisk', async () => {
    await expect(buildGeoGenerationPlan({
      projectRoot: fixtureRoot,
      distDir,
      htmlInputs: [{ relativePath: '../../evil.html', htmlContent: '<html></html>' }],
      options: {},
      currentDate: '2026-07-29T00:00:00.000Z',
    })).rejects.toThrow(/escapes the output directory/i);

    expect(() => applyGeoGenerationPlanToDisk({
      files: [{ filename: '../escaped.txt', content: 'x' }],
      htmlUpdates: [],
    }, { distDir })).toThrow(/escapes the output directory/i);
  });

  it('validates invalid option shapes upfront in validateGeoOptions', () => {
    expect(() => validateGeoOptions(null)).toThrow(/object/i);
    expect(() => validateGeoOptions({ robotsDirectives: 'Disallow: /' })).toThrow(/must be an array/i);
    expect(() => validateGeoOptions({ sitemapUrl: 'https://example.com/sitemap.xml\nDisallow: /' })).toThrow(/control characters/i);
    expect(() => validateGeoOptions({ sitemapUrl: 'javascript:alert(1)' })).toThrow(/http:\/\/ or https:\/\//i);
    expect(() => validateGeoOptions({ sitemapMaxBytes: 60_000_000 })).toThrow(/52,428,800/);
    expect(() => validateGeoOptions({ llmsSections: { Docs: 123 } })).toThrow(/string or an array/i);
    expect(() => validateGeoOptions({ skuMd: { catalog: [] } })).toThrow(/skuMd\.catalog/i);
  });

  it('surfaces malformed package.json errors and non-directory distDir errors', async () => {
    writeFileSync(join(fixtureRoot, 'package.json'), '{ invalid json');
    await expect(buildGeoGenerationPlanFromDisk({
      projectRoot: fixtureRoot,
      distDir,
      options: {},
      currentDate: '2026-07-29T00:00:00.000Z',
    })).rejects.toThrow(/Invalid package\.json/i);

    const fileAsDist = join(fixtureRoot, 'not-a-dir.txt');
    writeFileSync(fileAsDist, 'oops');
    await expect(buildGeoGenerationPlanFromDisk({
      projectRoot: fixtureRoot,
      distDir: fileAsDist,
      options: {},
      currentDate: '2026-07-29T00:00:00.000Z',
    })).rejects.toThrow(/not a directory/i);
  });

  it('escapes sku.md Markdown links and resolves relative markdown alternates on nested index pages', async () => {
    mkdirSync(join(distDir, 'docs'), { recursive: true });
    writeFileSync(
      join(distDir, 'docs', 'index.html'),
      '<!doctype html><html lang="en"><head><title>Docs</title><meta name="description" content="Docs desc"><link rel="alternate" type="text/markdown" href="index.md"></head><body><h1>Docs</h1></body></html>',
    );
    writeFileSync(join(distDir, 'docs', 'index.md'), '<!-- custom user markdown -->\n');

    const plan = await buildGeoGenerationPlanFromDisk({
      projectRoot: fixtureRoot,
      distDir,
      options: {
        generateFeed: false,
        skuMd: {
          merchantName: 'Shop [Best]',
          summary: 'Store summary',
          catalog: [{ label: 'Deals', url: 'https://example.com/a)b' }],
        },
      },
      currentDate: '2026-07-29T00:00:00.000Z',
    });

    const skuMd = plan.files.find(({ filename }) => filename === 'sku.md')?.content;
    expect(skuMd).toContain('Website: [Shop \\[Best\\]](https://example.com/)');
    expect(skuMd).toContain('- [Deals](https://example.com/a%29b)');

    const docsUpdate = plan.htmlUpdates.find(({ filename }) => filename === 'docs/index.html')?.content;
    expect(docsUpdate).not.toContain('href="https://example.com/docs/index.md"');
    expect(plan.files.find(({ filename }) => filename === 'llms.txt')?.content)
      .toContain('https://example.com/docs/index.md');
  });
});
