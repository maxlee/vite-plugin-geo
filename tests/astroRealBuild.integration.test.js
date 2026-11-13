import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';
import { build as buildAstro } from 'astro';
import { runSeoCliGenerate } from '../src/cli.js';

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
    const astroEntryUrl = pathToFileURL(join(process.cwd(), 'src', 'astro.js')).href;
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

  it.each(['/', '/docs/'])('preserves user-owned llms/feed/robots/sitemap routes at base %s across repeated builds', async base => {
    const root = join(fixtureRoot, base === '/' ? 'user-geo-routes-root' : 'user-geo-routes-subpath');
    const astroEntryUrl = pathToFileURL(join(process.cwd(), 'src', 'astro.js')).href;
    const userLlms = '# User llms\n';
    const userFeed = '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>User</title></channel></rss>';
    const userRobots = 'User-agent: *\nAllow: /\n';
    const userSitemap = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/</loc></url></urlset>';
    const endpoint = (body, type) => (
      `export function GET() { return new Response(${JSON.stringify(body)}, `
      + `{ headers: { 'content-type': ${JSON.stringify(type)} } }); }`
    );

    writeFixture(root, 'package.json', JSON.stringify({ name: 'astro-user-geo-routes' }));
    writeFixture(root, 'src/pages/index.astro', '<html lang="en"><head><title>User routes</title><meta name="description" content="User routes"></head><body><h1>Home</h1></body></html>');
    writeFixture(root, 'src/pages/llms.txt.js', endpoint(userLlms, 'text/plain; charset=utf-8'));
    writeFixture(root, 'src/pages/feed.xml.js', endpoint(userFeed, 'application/xml'));
    writeFixture(root, 'src/pages/robots.txt.js', endpoint(userRobots, 'text/plain; charset=utf-8'));
    writeFixture(root, 'src/pages/sitemap.xml.js', endpoint(userSitemap, 'application/xml'));
    writeFixture(root, 'astro.config.mjs', `
      import { defineConfig } from 'astro/config';
      import geo from ${JSON.stringify(astroEntryUrl)};
      export default defineConfig({
        site: 'https://example.com', base: ${JSON.stringify(base)},
        integrations: [geo({ llmsMdMirror: false })],
      });
    `);

    for (let build = 0; build < 2; build += 1) {
      await buildAstro({ root, logLevel: 'silent' });
      const distDir = join(root, 'dist');
      expect(readFileSync(join(distDir, 'llms.txt'), 'utf-8')).toBe(userLlms);
      expect(readFileSync(join(distDir, 'feed.xml'), 'utf-8')).toBe(userFeed);
      expect(readFileSync(join(distDir, 'robots.txt'), 'utf-8')).toBe(userRobots);
      expect(readFileSync(join(distDir, 'sitemap.xml'), 'utf-8')).toBe(userSitemap);
      expect(existsSync(join(distDir, 'index.md'))).toBe(false);
      const home = readFileSync(join(distDir, 'index.html'), 'utf-8');
      expect(home).toContain('application/rss+xml');
      expect(home).toContain(`${base}llms.txt`);
      expect(home).not.toContain('Generated by vite-plugin-geo');
    }
  }, 30_000);

  it.each(['/', '/docs/'])('preserves public robots with sitemap and default geo at base %s across repeated builds', async base => {
    const root = join(fixtureRoot, base === '/' ? 'public-robots-root' : 'public-robots-subpath');
    const astroEntryUrl = pathToFileURL(join(process.cwd(), 'src', 'astro.js')).href;
    const robots = Buffer.from(`User-agent: *\nAllow: /\nSitemap: https://example.com${base}sitemap-index.xml\n`);
    writeFixture(root, 'package.json', JSON.stringify({ name: 'astro-public-robots' }));
    writeFixture(root, 'public/robots.txt', robots);
    writeFixture(root, 'src/pages/index.astro', '<html lang="en"><head><title>Astro robots</title><meta name="description" content="Astro preservation"></head><body><h1>Home</h1></body></html>');
    writeFixture(root, 'astro.config.mjs', `
      import { defineConfig } from 'astro/config';
      import sitemap from '@astrojs/sitemap';
      import geo from ${JSON.stringify(astroEntryUrl)};
      export default defineConfig({
        site: 'https://example.com', base: ${JSON.stringify(base)},
        integrations: [sitemap(), geo()],
      });
    `);
    for (let build = 0; build < 2; build += 1) {
      await buildAstro({ root, logLevel: 'silent' });
      const distDir = join(root, 'dist');
      expect(readFileSync(join(distDir, 'robots.txt'))).toEqual(robots);
      const sitemapIndex = readdirSync(distDir).find(name => /sitemap.*index\.xml$/i.test(name));
      expect(sitemapIndex).toBeDefined();
      const llms = readFileSync(join(distDir, 'llms.txt'), 'utf-8');
      expect(llms).toContain(`https://example.com${base}${sitemapIndex}`);
      expect(llms).toContain('https://example.com/robots.txt');
      expect(existsSync(join(distDir, 'sitemap.xml'))).toBe(false);
      expect(existsSync(join(distDir, 'feed.xml'))).toBe(true);
      expect(existsSync(join(distDir, 'index.md'))).toBe(true);
      expect(readFileSync(join(distDir, 'index.html'), 'utf-8')).toContain('application/rss+xml');
    }
  }, 30_000);

  it('excludes Astro redirect HTML stubs from sitemap, llms.txt, feed.xml, and Markdown mirrors', async () => {
    const root = join(fixtureRoot, 'astro-redirects');
    const astroEntryUrl = pathToFileURL(join(process.cwd(), 'src', 'astro.js')).href;
    writeFixture(root, 'package.json', JSON.stringify({ name: 'astro-redirects-real-build' }));
    writeFixture(root, 'src/pages/index.astro', '<html lang="en"><head><title>Home</title><meta name="description" content="Home page"></head><body><h1>Home</h1></body></html>');
    writeFixture(root, 'src/pages/blog/[slug].astro', '---\nexport function getStaticPaths() { return [{ params: { slug: "launch" } }]; }\n---\n<html lang="en"><head><title>Launch</title><meta name="description" content="Launch post"></head><body><h1>Launch</h1></body></html>');
    writeFixture(root, 'astro.config.mjs', `
      import { defineConfig } from 'astro/config';
      import geo from ${JSON.stringify(astroEntryUrl)};
      export default defineConfig({
        site: 'https://example.com',
        redirects: {
          '/old': '/blog/launch',
          '/legacy/[slug]': '/blog/[slug]',
        },
        integrations: [geo()],
      });
    `);

    await buildAstro({ root, logLevel: 'silent' });

    const distDir = join(root, 'dist');
    expect(existsSync(join(distDir, 'old', 'index.html'))).toBe(true);
    expect(existsSync(join(distDir, 'legacy', 'launch', 'index.html'))).toBe(true);
    expect(existsSync(join(distDir, 'old.md'))).toBe(false);
    expect(existsSync(join(distDir, 'legacy', 'launch.md'))).toBe(false);
    expect(existsSync(join(distDir, 'blog', 'launch.md'))).toBe(true);

    const sitemap = readFileSync(join(distDir, 'sitemap.xml'), 'utf-8');
    expect(sitemap).toContain('<loc>https://example.com/blog/launch</loc>');
    expect(sitemap).not.toContain('/old');
    expect(sitemap).not.toContain('/legacy');

    const llms = readFileSync(join(distDir, 'llms.txt'), 'utf-8');
    expect(llms).toContain('https://example.com/blog/launch');
    expect(llms).not.toContain('/old');
    expect(llms).not.toContain('/legacy');

    const feed = readFileSync(join(distDir, 'feed.xml'), 'utf-8');
    expect(feed).not.toContain('/old');
    expect(feed).not.toContain('/legacy');
  }, 30_000);

  it("matches Astro build.format: 'file' HTML filenames and emits .html URLs by default", async () => {
    const root = join(fixtureRoot, 'astro-file-format');
    const astroEntryUrl = pathToFileURL(join(process.cwd(), 'src', 'astro.js')).href;
    writeFixture(root, 'package.json', JSON.stringify({ name: 'astro-file-format-real-build' }));
    writeFixture(root, 'src/pages/index.astro', '<html lang="en"><head><title>Home</title><meta name="description" content="Home"></head><body><h1>Home</h1></body></html>');
    writeFixture(root, 'src/pages/about.astro', '<html lang="en"><head><title>About</title><meta name="description" content="About page"></head><body><h1>About</h1></body></html>');
    writeFixture(root, 'astro.config.mjs', `
      import { defineConfig } from 'astro/config';
      import geo from ${JSON.stringify(astroEntryUrl)};
      export default defineConfig({
        site: 'https://example.com',
        build: { format: 'file' },
        integrations: [geo({ generateFeed: false })],
      });
    `);

    await buildAstro({ root, logLevel: 'silent' });

    const distDir = join(root, 'dist');
    expect(existsSync(join(distDir, 'about.html'))).toBe(true);
    expect(existsSync(join(distDir, 'about.html.md'))).toBe(true);
    expect(readFileSync(join(distDir, 'sitemap.xml'), 'utf-8')).toContain('<loc>https://example.com/about.html</loc>');
    expect(readFileSync(join(distDir, 'llms.txt'), 'utf-8')).toContain('https://example.com/about.html');
  }, 30_000);

});
