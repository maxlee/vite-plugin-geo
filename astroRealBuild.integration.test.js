import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';
import { build as buildAstro } from 'astro';
import { runSeoCliGenerate } from './cli.js';

const fixtureRoot = join(process.cwd(), 'tempfiles', '__real-astro-builds__');

function writeFixture(root, relativePath, content) {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('real Astro builds', () => {
  it('runs after Astro sitemap when integrations are ordered sitemap() then geo()', async () => {
    const root = join(fixtureRoot, 'astro-native');
    const astroEntryUrl = pathToFileURL(join(process.cwd(), 'astro.js')).href;
    writeFixture(root, 'package.json', JSON.stringify({
      name: 'astro-native-real-build',
      domain: 'https://example.com',
    }));
    writeFixture(root, 'src/pages/index.astro', '<html lang="en"><head><title>Astro Native</title><meta name="description" content="Native build"></head><body><h1>Home</h1></body></html>');
    writeFixture(root, 'astro.config.mjs', `
      import { defineConfig } from 'astro/config';
      import sitemap from '@astrojs/sitemap';
      import geo from ${JSON.stringify(astroEntryUrl)};
      export default defineConfig({
        site: 'https://example.com',
        integrations: [
          sitemap(),
          geo({ llmsMdMirror: false, generateFeed: false }),
        ],
      });
    `);

    await buildAstro({ root, logLevel: 'silent' });

    const distDir = join(root, 'dist');
    const sitemapIndex = readdirSync(distDir).find((name) => /sitemap.*index\.xml$/i.test(name));
    expect(sitemapIndex).toBeDefined();
    expect(readFileSync(join(distDir, 'robots.txt'), 'utf-8'))
      .toContain(`Sitemap: https://example.com/${sitemapIndex}`);
    expect(existsSync(join(distDir, 'sitemap.xml'))).toBe(false);
  }, 20_000);

  it('supports the Astro build then standalone CLI workflow', async () => {
    const root = join(fixtureRoot, 'astro-cli');
    writeFixture(root, 'package.json', JSON.stringify({
      name: 'astro-cli-real-build',
      domain: 'https://example.com',
    }));
    writeFixture(root, 'src/pages/index.astro', '<html lang="en"><head><title>Astro CLI</title><meta name="description" content="CLI build"></head><body><h1>Home</h1></body></html>');
    writeFixture(root, 'astro.config.mjs', `
      import { defineConfig } from 'astro/config';
      export default defineConfig({ site: 'https://example.com' });
    `);

    await buildAstro({ root, logLevel: 'silent' });
    await runSeoCliGenerate(
      { llmsMdMirror: false },
      {
        cwd: root,
        logger: { log() {}, warn() {}, error() {} },
      },
    );

    const distDir = join(root, 'dist');
    expect(existsSync(join(distDir, 'sitemap.xml'))).toBe(true);
    expect(existsSync(join(distDir, 'robots.txt'))).toBe(true);
    expect(existsSync(join(distDir, 'feed.xml'))).toBe(true);
  }, 20_000);
});
