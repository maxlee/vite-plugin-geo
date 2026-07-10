import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveGeneratedSitemapUrl,
  resolveAstroSitemapCompatibility,
} from './astroSitemapCompatibility.js';

describe('Astro sitemap compatibility detection', () => {
  const fixtureRoot = join(process.cwd(), 'tempfiles', '__astro-sitemap-compatibility__');

  beforeEach(() => {
    mkdirSync(fixtureRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function writePackageJson(manifest) {
    writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify(manifest, null, 2));
  }

  it('detects standard Astro sitemap usage and points to sitemap-index.xml', () => {
    writePackageJson({
      dependencies: {
        astro: '^6.0.0',
        '@astrojs/sitemap': '^3.7.3',
      },
    });
    writeFileSync(join(fixtureRoot, 'astro.config.mjs'), `
      import { defineConfig } from 'astro/config';
      import sitemap from '@astrojs/sitemap';

      export default defineConfig({
        site: 'https://example.com',
        integrations: [sitemap()],
      });
    `);

    const result = resolveAstroSitemapCompatibility(fixtureRoot);

    expect(result.detected).toBe(true);
    expect(result.sitemapUrl).toBe('sitemap-index.xml');
    expect(result.shouldGenerateSitemap).toBe(false);
  });

  it('uses a static Astro filenameBase when one is configured', () => {
    writePackageJson({
      devDependencies: {
        astro: '^6.0.0',
        '@astrojs/sitemap': '^3.7.3',
      },
    });
    writeFileSync(join(fixtureRoot, 'astro.config.ts'), `
      import sitemap from '@astrojs/sitemap';

      export default {
        integrations: [
          sitemap({
            filenameBase: 'site-map',
          }),
        ],
      };
    `);

    const result = resolveAstroSitemapCompatibility(fixtureRoot);

    expect(result.detected).toBe(true);
    expect(result.sitemapUrl).toBe('site-map-index.xml');
    expect(result.shouldGenerateSitemap).toBe(false);
  });

  it('does not detect Astro sitemap when the package is installed but not configured', () => {
    writePackageJson({
      dependencies: {
        astro: '^6.0.0',
        '@astrojs/sitemap': '^3.7.3',
      },
    });
    writeFileSync(join(fixtureRoot, 'astro.config.mjs'), `
      export default {
        site: 'https://example.com',
        integrations: [],
      };
    `);

    const result = resolveAstroSitemapCompatibility(fixtureRoot);

    expect(result.detected).toBe(false);
    expect(result.sitemapUrl).toBe('sitemap.xml');
    expect(result.shouldGenerateSitemap).toBe(true);
  });

  it('lets explicit options override automatic Astro detection', () => {
    writePackageJson({
      dependencies: {
        astro: '^6.0.0',
        '@astrojs/sitemap': '^3.7.3',
      },
    });
    writeFileSync(join(fixtureRoot, 'astro.config.mjs'), `
      import sitemap from '@astrojs/sitemap';
      export default { integrations: [sitemap()] };
    `);

    const result = resolveAstroSitemapCompatibility(fixtureRoot, {
      generateSitemap: true,
      sitemapUrl: 'manual-sitemap.xml',
    });

    expect(result.detected).toBe(true);
    expect(result.sitemapUrl).toBe('manual-sitemap.xml');
    expect(result.shouldGenerateSitemap).toBe(true);
  });

  it('falls back to default behavior when no Astro config exists', () => {
    writePackageJson({
      dependencies: {
        vite: '^7.0.0',
      },
    });

    const result = resolveAstroSitemapCompatibility(fixtureRoot);

    expect(existsSync(join(fixtureRoot, 'astro.config.mjs'))).toBe(false);
    expect(result.detected).toBe(false);
    expect(result.sitemapUrl).toBe('sitemap.xml');
    expect(result.shouldGenerateSitemap).toBe(true);
  });
});

describe('generated sitemap URL resolution', () => {
  it('points references at the generated sitemap index when one exists', () => {
    const result = resolveGeneratedSitemapUrl([
      { filename: 'sitemap_1.xml', content: '' },
      { filename: 'sitemap_2.xml', content: '' },
      { filename: 'sitemap_index.xml', content: '' },
    ]);

    expect(result).toBe('sitemap_index.xml');
  });

  it('points references at the single generated sitemap when no index exists', () => {
    const result = resolveGeneratedSitemapUrl([
      { filename: 'sitemap.xml', content: '' },
    ]);

    expect(result).toBe('sitemap.xml');
  });
});
