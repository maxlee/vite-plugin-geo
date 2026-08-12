import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { build as buildVite7 } from 'vite7';
import { build as buildVite8 } from 'vite8';
import { createGeoGeneratorPlugin } from './viteGeoGeneratorPlugin.js';

const fixtureRoot = join(process.cwd(), 'tempfiles', '__real-vite-builds__');

function writeFixture(root, relativePath, content) {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('real Vite builds', () => {
  it.each([
    ['Vite 7', buildVite7],
    ['Vite 8', buildVite8],
  ])('generates the same core outputs with %s', async (_label, viteBuild) => {
    const root = join(fixtureRoot, _label.replace(/\s+/g, '-').toLowerCase());
    const distDir = join(root, 'dist');
    writeFixture(root, 'package.json', JSON.stringify({
      name: 'vite-real-build',
      domain: 'https://example.com',
    }));
    writeFixture(
      root,
      'index.html',
      '<!doctype html><html lang="en"><head><title>Real Vite</title><meta name="description" content="Real build"></head><body><h1>Home</h1></body></html>',
    );

    await viteBuild({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [createGeoGeneratorPlugin({
        packageJsonPath: join(root, 'package.json'),
        lastmodStrategy: 'git',
        skuMd: {
          merchantName: 'Real Store',
          summary: 'Real storefront catalog.',
          catalog: [{ label: 'Catalog', url: 'https://example.com/catalog' }],
        },
      })],
      build: {
        outDir: distDir,
        emptyOutDir: true,
      },
    });

    expect(readFileSync(join(distDir, 'index.html'), 'utf-8')).toContain('application/rss+xml');
    expect(existsSync(join(distDir, 'sitemap.xml'))).toBe(true);
    expect(existsSync(join(distDir, 'robots.txt'))).toBe(true);
    expect(existsSync(join(distDir, 'llms.txt'))).toBe(true);
    expect(existsSync(join(distDir, 'index.html.md'))).toBe(true);
    expect(existsSync(join(distDir, 'sku.md'))).toBe(true);
    expect(readFileSync(join(distDir, 'sitemap.xml'), 'utf-8')).not.toContain('<lastmod>');
  }, 20_000);
});
