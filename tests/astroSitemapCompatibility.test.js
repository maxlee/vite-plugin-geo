import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveGeneratedSitemapUrl,
  resolveAstroSitemapCompatibility,
} from '../src/astroSitemapCompatibility.js';

describe('Astro sitemap compatibility detection', () => {
  const fixtureRoot = join(process.cwd(), 'tempfiles', '__astro-sitemap-compatibility__');
  const distDir = join(fixtureRoot, 'dist');

  beforeEach(() => {
    mkdirSync(distDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('detects a sitemap index from the final build output', () => {
    writeFileSync(
      join(distDir, 'sitemap-index.xml'),
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></sitemapindex>',
    );

    const result = resolveAstroSitemapCompatibility(fixtureRoot);

    expect(result.detected).toBe(true);
    expect(result.sitemapUrl).toBe('sitemap-index.xml');
    expect(result.shouldGenerateSitemap).toBe(false);
  });

  it('uses the actual custom filename found in the final output', () => {
    writeFileSync(
      join(distDir, 'site-map-index.xml'),
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></sitemapindex>',
    );

    const result = resolveAstroSitemapCompatibility(fixtureRoot);

    expect(result.detected).toBe(true);
    expect(result.sitemapUrl).toBe('site-map-index.xml');
    expect(result.shouldGenerateSitemap).toBe(false);
  });

  it('does not inspect Astro config source', () => {
    writeFileSync(join(fixtureRoot, 'astro.config.mjs'), `
      import sitemap from '@astrojs/sitemap';
      export default { integrations: [sitemap()] };
    `);

    const result = resolveAstroSitemapCompatibility(fixtureRoot);

    expect(result.detected).toBe(false);
    expect(result.sitemapUrl).toBe('sitemap.xml');
    expect(result.shouldGenerateSitemap).toBe(true);
  });

  it('lets explicit options override output detection', () => {
    writeFileSync(
      join(distDir, 'sitemap-index.xml'),
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></sitemapindex>',
    );

    const result = resolveAstroSitemapCompatibility(fixtureRoot, {
      generateSitemap: true,
      sitemapUrl: 'manual-sitemap.xml',
    });

    expect(result.detected).toBe(true);
    expect(result.sitemapUrl).toBe('manual-sitemap.xml');
    expect(result.shouldGenerateSitemap).toBe(true);
  });

  it('falls back to default behavior when no sitemap output exists', () => {
    const result = resolveAstroSitemapCompatibility(fixtureRoot);

    expect(existsSync(join(distDir, 'sitemap.xml'))).toBe(false);
    expect(result.detected).toBe(false);
    expect(result.sitemapUrl).toBe('sitemap.xml');
    expect(result.shouldGenerateSitemap).toBe(true);
  });
});

describe('generated sitemap URL resolution', () => {
  it('points references at the generated sitemap index when one exists', () => {
    expect(resolveGeneratedSitemapUrl([
      { filename: 'sitemap_1.xml', content: '' },
      { filename: 'sitemap_2.xml', content: '' },
      { filename: 'sitemap_index.xml', content: '' },
    ])).toBe('sitemap_index.xml');
  });

  it('points references at the single generated sitemap when no index exists', () => {
    expect(resolveGeneratedSitemapUrl([
      { filename: 'sitemap.xml', content: '' },
    ])).toBe('sitemap.xml');
  });
});
