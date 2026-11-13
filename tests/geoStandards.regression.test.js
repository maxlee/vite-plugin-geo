import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  extractPageMetadata,
  generateLlmsTxt,
  generateRobotsTxt,
  generateSitemap,
  injectFeedLink,
} from '../src/geoGenerator.js';
import {
  generateSkuMd,
  validateSkuMdOptions,
} from '../src/geoBuildPipeline.js';

describe('standards regression coverage', () => {
  const testDir = join(process.cwd(), 'tempfiles', '__geo-standards__');

  beforeEach(() => mkdirSync(testDir, { recursive: true }));
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  it('decodes HTML entities in page metadata', () => {
    expect(extractPageMetadata(
      '<html lang="en"><head><title>Tea &amp; Cake</title><meta content="Fresh &quot;daily&quot; &amp; local" name="description"></head></html>',
      { includeLang: true },
    )).toEqual({
      title: 'Tea & Cake',
      description: 'Fresh "daily" & local',
      lang: 'en',
    });
  });

  it('includes routeBasePath in split sitemap index URLs', () => {
    const htmlFiles = Array.from({ length: 4 }, (_, index) => {
      const filePath = join(testDir, `page-${index}.html`);
      writeFileSync(filePath, `<html><head><title>Page ${index}</title></head></html>`);
      return filePath;
    });

    const result = generateSitemap(
      'https://example.com',
      htmlFiles,
      testDir,
      '2026-08-12T00:00:00.000Z',
      { routeBasePath: '/store/', sitemapMaxBytes: 260 },
    );
    const index = result.find(({ filename }) => filename === 'sitemap_index.xml');

    expect(index?.content).toContain('<loc>https://example.com/store/sitemap_1.xml</loc>');
  });

  it('accepts x-default and BCP 47 script-region hreflang values', () => {
    const filePath = join(testDir, 'index.html');
    writeFileSync(filePath, '<html><head><title>Home</title></head></html>');

    const [sitemap] = generateSitemap(
      'https://example.com',
      [filePath],
      testDir,
      '2026-08-12T00:00:00.000Z',
      {
        hreflang: {
          'x-default': 'https://example.com/{path}',
          'zh-Hans': 'https://example.com/zh/{path}',
          'zh-Hans-CN': 'https://example.com/cn/{path}',
        },
      },
    );

    expect(sitemap.content).toContain('hreflang="x-default"');
    expect(sitemap.content).toContain('hreflang="zh-Hans"');
    expect(sitemap.content).toContain('hreflang="zh-Hans-CN"');
  });

  it('rejects a single sitemap entry above the configured byte limit', () => {
    const filePath = join(testDir, 'index.html');
    writeFileSync(filePath, '<html><head><title>Home</title></head></html>');

    expect(() => generateSitemap(
      'https://example.com',
      [filePath],
      testDir,
      '2026-08-12T00:00:00.000Z',
      { sitemapMaxBytes: 100 },
    )).toThrow(/single sitemap entry.*byte limit/i);
  });

  it('replaces an existing RSS or Atom discovery link regardless of attribute order', () => {
    const html = '<html><head><link title="Atom Feed" href="/old.xml" type="application/atom+xml" rel="alternate"></head><body></body></html>';
    const updated = injectFeedLink(html, '/store/feed.xml');

    expect(updated.match(/rel="alternate"/g)).toHaveLength(1);
    expect(updated).toContain('type="application/rss+xml"');
    expect(updated).toContain('href="/store/feed.xml"');
    expect(updated).not.toContain('/old.xml');
  });

  it('rejects robots directives containing control characters', () => {
    expect(() => generateRobotsTxt('https://example.com', {
      robotsDirectives: ['Disallow: /private\u0000admin'],
    })).toThrow(/control character/i);
  });

  it('uses only source-backed llms.txt copy and links configured catalogs', () => {
    const filePath = join(testDir, 'index.html');
    writeFileSync(filePath, '<html><head><title>Tea Shop</title><meta name="description" content="Small batch tea"></head></html>');

    const result = generateLlmsTxt(
      { url: 'https://example.com', title: 'Tea Shop', description: 'Small batch tea' },
      [filePath],
      testDir,
      {
        skuMd: {
          catalog: [{ label: 'All teas', url: 'https://example.com/collections/all' }],
        },
      },
    );

    expect(result).not.toMatch(/Shopify|SHOPLINE|NDJSON|client-side uploads/i);
    expect(result).toContain('## Product Catalog');
    expect(result).toContain('[All teas](https://example.com/collections/all)');
  });

  it('keeps SKU.md at the HTTPS domain root', () => {
    const options = {
      merchantName: 'Tea Store',
      summary: 'Small batch tea.',
      catalog: [{ label: 'All teas', url: 'https://example.com/catalog' }],
    };

    const normalized = validateSkuMdOptions(options, {
      siteUrl: 'https://example.com',
      routeBasePath: '/',
    });
    expect(generateSkuMd(normalized, { siteUrl: 'https://example.com' }))
      .toContain('SKU.md: [1.0.0-beta](https://sku.md/spec/1.0.0-beta/)');

    expect(() => validateSkuMdOptions(options, {
      siteUrl: 'https://example.com',
      routeBasePath: '/store/',
    })).toThrow(/root/i);
  });
});
