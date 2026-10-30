import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

const fixtureRoot = join(process.cwd(), 'tempfiles', '__astro-geo-integration__');
const astroEntryUrl = pathToFileURL(join(process.cwd(), 'astro.js')).href;

function writeFixtureFile(relativePath, content) {
  const fullPath = join(fixtureRoot, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

function createLogger() {
  const messages = [];
  return {
    messages,
    logger: {
      info(message) {
        messages.push(`info:${message}`);
      },
      warn(message) {
        messages.push(`warn:${message}`);
      },
      error(message) {
        messages.push(`error:${message}`);
      },
    },
  };
}

async function loadAstroEntry() {
  const loaded = await import(astroEntryUrl).then(
    (module) => ({ module }),
    (error) => ({ error }),
  );
  expect(loaded.error?.message).toBeUndefined();
  return loaded.module;
}

async function runIntegration(options, configOverrides = {}, buildOutput = 'static') {
  const { default: geo } = await loadAstroEntry();
  const integration = geo(options);
  const { logger, messages } = createLogger();
  const rootUrl = pathToFileURL(`${fixtureRoot}/`);
  const distUrl = pathToFileURL(`${join(fixtureRoot, 'dist')}/`);

  await integration.hooks['astro:config:done']({
    config: {
      root: rootUrl,
      site: new URL('https://site.example'),
      base: '/docs',
      ...configOverrides,
    },
    buildOutput,
    logger,
  });
  await integration.hooks['astro:build:done']({
    dir: distUrl,
    pages: [],
    assets: new Map(),
    logger,
  });

  return { integration, messages };
}

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('Astro integration', () => {
  it('generates GEO files from Astro final output using explicit domain and base', async () => {
    writeFixtureFile('package.json', JSON.stringify({
      name: 'astro-fixture',
      domain: 'https://package.example',
    }));
    const indexPath = writeFixtureFile('dist/index.html', '<!doctype html><html lang="en"><head><title>Home</title><meta name="description" content="Home page"></head><body><h1>Home</h1></body></html>');
    writeFixtureFile('dist/ja/index.html', '<!doctype html><html lang="ja"><head><title>Japanese</title></head><body><h1>Japanese</h1></body></html>');

    const { integration } = await runIntegration({
      domain: 'https://option.example',
      llmsMdMirror: false,
    });

    expect(integration.name).toBe('vite-plugin-geo');
    expect(readFileSync(join(fixtureRoot, 'dist', 'sitemap.xml'), 'utf-8')).toContain('<loc>https://option.example/docs</loc>');
    expect(readFileSync(join(fixtureRoot, 'dist', 'sitemap.xml'), 'utf-8')).toContain('<loc>https://option.example/docs/ja</loc>');
    expect(existsSync(join(fixtureRoot, 'dist', 'robots.txt'))).toBe(false);
    expect(readFileSync(join(fixtureRoot, 'dist', 'llms.txt'), 'utf-8')).toContain('https://option.example/docs/ja');
    expect(existsSync(join(fixtureRoot, 'dist', 'feed.xml'))).toBe(true);
    expect(readFileSync(indexPath, 'utf-8')).toContain('href="/docs/feed.xml"');
  });

  it('uses Astro site before package.json domain', async () => {
    writeFixtureFile('package.json', JSON.stringify({
      name: 'astro-fixture',
      domain: 'https://package.example',
    }));
    writeFixtureFile('dist/index.html', '<!doctype html><html><head><title>Home</title></head><body></body></html>');

    await runIntegration({ llmsMdMirror: false }, {
      site: new URL('https://site-preferred.example'),
      base: '/',
    });

    expect(readFileSync(join(fixtureRoot, 'dist', 'sitemap.xml'), 'utf-8')).toContain('<loc>https://site-preferred.example</loc>');
  });

  it('falls back to package.json domain when Astro site is absent', async () => {
    writeFixtureFile('package.json', JSON.stringify({
      name: 'astro-fixture',
      domain: 'https://package.example',
    }));
    writeFixtureFile('dist/index.html', '<!doctype html><html><head><title>Home</title></head><body></body></html>');

    await runIntegration({ llmsMdMirror: false }, {
      site: undefined,
      base: '/',
    });

    expect(readFileSync(join(fixtureRoot, 'dist', 'sitemap.xml'), 'utf-8')).toContain('<loc>https://package.example</loc>');
  });

  it('explains when server output contains no final static HTML', async () => {
    writeFixtureFile('package.json', JSON.stringify({
      name: 'astro-server-fixture',
      domain: 'https://package.example',
    }));
    mkdirSync(join(fixtureRoot, 'dist'), { recursive: true });

    const { messages } = await runIntegration({}, { site: undefined }, 'server');

    expect(messages).toEqual([
      expect.stringMatching(/^info:.*GEO audit.*未检查/),
      expect.stringMatching(/^warn:.*server output.*no final static HTML/i),
    ]);
  });

  it('passes sitemap size limits through the shared post-build generator', async () => {
    writeFixtureFile('package.json', JSON.stringify({
      name: 'astro-sitemap-fixture',
      domain: 'https://package.example',
    }));
    for (let index = 0; index < 4; index += 1) {
      const fileName = index === 0 ? 'index.html' : `page-${index}.html`;
      writeFixtureFile(`dist/${fileName}`, `<!doctype html><html><head><title>Page ${index}</title></head><body></body></html>`);
    }

    await runIntegration({
      generateFeed: false,
      llmsMdMirror: false,
      sitemapMaxBytes: 260,
    }, {
      site: undefined,
      base: '/',
    });

    expect(existsSync(join(fixtureRoot, 'dist', 'sitemap_index.xml'))).toBe(true);
    expect(readFileSync(join(fixtureRoot, 'dist', 'robots.txt'), 'utf-8')).toContain('Sitemap: https://package.example/sitemap_index.xml');
  });
});
