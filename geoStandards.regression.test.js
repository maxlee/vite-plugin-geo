import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';
import {
  extractPageMetadata,
  generateLlmsTxt,
  generateRobotsTxt,
  generateSitemap,
  injectFeedLink,
} from './geoGenerator.js';
import {
  generateSkuMd,
  validateSkuMdOptions,
} from './geoBuildPipeline.js';

describe('standards regression coverage', () => {
  const testDir = join(process.cwd(), 'tempfiles', '__geo-standards__');

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('decodes HTML entities in page metadata', () => {
    const metadata = extractPageMetadata(
      '<html lang="en"><head><title>Tea &amp; Cake</title><meta content="Fresh &quot;daily&quot; &amp; local" name="description"></head></html>',
      { includeLang: true },
    );

    expect(metadata).toEqual({
      title: 'Tea & Cake',
      description: 'Fresh "daily" & local',
      lang: 'en',
    });
  });

  it('includes the route base path in split sitemap index URLs', () => {
    const htmlFiles = Array.from({ length: 4 }, (_, index) => {
      const filePath = join(testDir, `page-${index}.html`);
      writeFileSync(filePath, `<html><head><title>Page ${index}</title></head></html>`);
      return filePath;
    });

    const result = generateSitemap(
      'https://example.com',
      htmlFiles,
      testDir,
      '2026-07-29T00:00:00.000Z',
      {
        routeBasePath: '/store/',
        sitemapMaxBytes: 520,
      },
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
      '2026-07-29T00:00:00.000Z',
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

  it('rejects a single sitemap entry that exceeds the configured byte limit', () => {
    const filePath = join(testDir, 'index.html');
    writeFileSync(filePath, '<html><head><title>Home</title></head></html>');

    expect(() => generateSitemap(
      'https://example.com',
      [filePath],
      testDir,
      '2026-07-29T00:00:00.000Z',
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

  it('uses only site-derived llms.txt copy and can link the product catalog', () => {
    const filePath = join(testDir, 'index.html');
    writeFileSync(
      filePath,
      '<html><head><title>Tea Shop</title><meta name="description" content="Small batch tea"></head></html>',
    );

    const result = generateLlmsTxt(
      {
        url: 'https://example.com',
        title: 'Tea Shop',
        description: 'Small batch tea',
      },
      [filePath],
      testDir,
      {
        skuMd: {
          catalogUrl: 'https://example.com/collections/all',
        },
      },
    );

    expect(result).not.toMatch(/Shopify|SHOPLINE|NDJSON|client-side uploads/i);
    expect(result).toContain('## Product Catalog');
    expect(result).toContain('[Product Catalog](https://example.com/collections/all)');
  });

  it('generates a safe sku.md 1.8 manifest-basic document', () => {
    const options = {
      merchantName: 'Max: "Tea" & Co.',
      catalogUrl: 'https://example.com/collections/all',
      contentLanguage: 'zh-Hans',
      market: 'CN',
    };

    expect(validateSkuMdOptions(options, {
      siteUrl: 'https://example.com',
      routeBasePath: '/',
    })).toEqual(options);

    const result = generateSkuMd(options, {
      siteUrl: 'https://example.com',
    });

    expect(result).toContain('schema_version: "sku.md/1.8-draft"');
    expect(result).toContain('document_type: "catalog_manifest"');
    expect(result).toContain('profile: "manifest-basic"');
    expect(result).toContain('canonical: "https://example.com/sku.md"');
    expect(result).toContain('name: "Max: \\"Tea\\" & Co."');
    expect(result).toContain('url: "https://example.com/collections/all"');
    expect(result).not.toContain('checkout');

    const schema = JSON.parse(
      readFileSync(join(process.cwd(), 'test-fixtures', 'sku-md-1.8.schema.json'), 'utf-8'),
    );
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const frontmatter = parseYaml(result.split('---')[1]);

    expect(validate(frontmatter), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([
    [{ merchantName: 'Shop', catalogUrl: 'http://example.com/catalog' }, 'HTTPS'],
    [{ merchantName: 'Shop', catalogUrl: 'https://other.example/catalog' }, 'same origin'],
    [{ merchantName: 'Shop', catalogUrl: 'https://example.com/catalog', market: 'USA' }, 'ISO country'],
    [{ merchantName: 'Shop', catalogUrl: 'https://example.com/catalog', contentLanguage: 'INVALID' }, 'language'],
  ])('rejects invalid sku.md configuration %#', (options, message) => {
    expect(() => validateSkuMdOptions(options, {
      siteUrl: 'https://example.com',
      routeBasePath: '/',
    })).toThrow(message);
  });

  it('rejects sku.md when the site is deployed below the domain root', () => {
    expect(() => validateSkuMdOptions({
      merchantName: 'Shop',
      catalogUrl: 'https://example.com/catalog',
    }, {
      siteUrl: 'https://example.com',
      routeBasePath: '/store/',
    })).toThrow(/root/i);

    expect(() => validateSkuMdOptions({
      merchantName: 'Shop',
      catalogUrl: 'https://example.com/catalog',
    }, {
      siteUrl: 'https://example.com/store',
      routeBasePath: '/',
    })).toThrow(/root/i);
  });
});
