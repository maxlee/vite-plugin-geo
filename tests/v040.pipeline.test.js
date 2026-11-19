import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';
import { build as buildAstro } from 'astro';
import {
  applyGeoGenerationPlanToDisk,
  buildGeoGenerationPlan,
  buildGeoGenerationPlanFromDisk,
  formatGeoDebugSummary,
  logFileCompatibility,
  validateGeoOptions,
} from '../src/geoBuildPipeline.js';
import { verifyGeoOutput } from '../src/geoVerify.js';
import { parseCliArgs, runCli } from '../src/cli.js';

const roots = [];

function createFixture(files = {}, packageJson = { name: 'v040-fixture', domain: 'https://example.test' }) {
  const root = mkdtempSync(join(tmpdir(), 'geo-v040-pipeline-'));
  roots.push(root);
  const distDir = join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify(packageJson, null, 2));
  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = join(distDir, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content, 'utf-8');
  }
  return { root, distDir };
}

function writeProjectFile(root, relativePath, content) {
  const targetPath = join(root, relativePath);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content, 'utf-8');
}

function makeHtml({
  lang = 'en',
  title = 'Page',
  description = 'Page description',
  canonical = '',
  body = '<h1>Page</h1><p>Body copy.</p>',
} = {}) {
  const canonicalTag = canonical ? `<link rel="canonical" href="${canonical}">` : '';
  return `<!doctype html><html lang="${lang}"><head><title>${title}</title><meta name="description" content="${description}">${canonicalTag}</head><body><main>${body}</main></body></html>`;
}

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('v0.4.0 option validation', () => {
  it('validates all 9 new options cleanly', () => {
    expect(() => validateGeoOptions({
      trailingSlash: 'always',
      markdownStripSelectors: ['.toc', 'nav[aria-label*="breadcrumb" i]'],
      llmsMdMirrorInclude: ['guides/**'],
      llmsMdMirrorExclude: ['guides/draft*'],
      feedIncludePatterns: ['blog/**'],
      feedExcludePatterns: ['blog/private/**'],
      feedMaxItems: 25,
      feedLanguage: 'en-US',
      feedByLocale: true,
    })).not.toThrow();

    expect(() => validateGeoOptions({ trailingSlash: 'invalid' })).toThrow(/trailingSlash/);
    expect(() => validateGeoOptions({ markdownStripSelectors: '.toc' })).toThrow(/markdownStripSelectors/);
    expect(() => validateGeoOptions({ markdownStripSelectors: ['div + p'] })).toThrow(/Invalid CSS selector/);
    expect(() => validateGeoOptions({ llmsMdMirrorInclude: 'guides/**' })).toThrow(/llmsMdMirrorInclude/);
    expect(() => validateGeoOptions({ llmsMdMirrorExclude: [123] })).toThrow(/llmsMdMirrorExclude/);
    expect(() => validateGeoOptions({ feedIncludePatterns: 'blog/**' })).toThrow(/feedIncludePatterns/);
    expect(() => validateGeoOptions({ feedExcludePatterns: [false] })).toThrow(/feedExcludePatterns/);
    expect(() => validateGeoOptions({ feedMaxItems: 0 })).toThrow(/feedMaxItems/);
    expect(() => validateGeoOptions({ feedMaxItems: -3 })).toThrow(/feedMaxItems/);
    expect(() => validateGeoOptions({ feedMaxItems: 1.5 })).toThrow(/feedMaxItems/);
    expect(() => validateGeoOptions({ feedMaxItems: '10' })).toThrow(/feedMaxItems/);
    expect(() => validateGeoOptions({ feedLanguage: '' })).toThrow(/feedLanguage/);
    expect(() => validateGeoOptions({ feedLanguage: 'en_US' })).toThrow(/feedLanguage/);
    expect(() => validateGeoOptions({ feedByLocale: 'true' })).toThrow(/feedByLocale/);
  });
});

describe('v0.4.0 trailingSlash integration (#5)', () => {
  it('aligns Astro trailingSlash: always build outputs in sitemap.xml and feed.xml while keeping .md mirrors slashless', async () => {
    const astroFixtureBase = join(process.cwd(), 'tempfiles', '__v040-astro-trailing__');
    roots.push(astroFixtureBase);
    const root = join(astroFixtureBase, 'site');
    mkdirSync(root, { recursive: true });
    const astroEntryUrl = pathToFileURL(join(process.cwd(), 'src', 'astro.js')).href;

    writeProjectFile(root, 'package.json', JSON.stringify({ name: 'astro-trailing-always' }));
    writeProjectFile(
      root,
      'src/pages/index.astro',
      '<html lang="en"><head><title>Home</title><meta name="description" content="Home desc"><link rel="canonical" href="https://example.test/"></head><body><main><h1>Home</h1><a href="/about/">About</a><a href="/zh/">中文</a></main></body></html>',
    );
    writeProjectFile(
      root,
      'src/pages/about.astro',
      '<html lang="en"><head><title>About</title><meta name="description" content="About desc"><link rel="canonical" href="https://example.test/about/"></head><body><main><h1>About</h1><a href="/">Home</a></main></body></html>',
    );
    writeProjectFile(
      root,
      'src/pages/zh/index.astro',
      '<html lang="zh"><head><title>中文首页</title><meta name="description" content="中文描述"><link rel="canonical" href="https://example.test/zh/"></head><body><main><h1>中文首页</h1><a href="/">Home</a></main></body></html>',
    );
    writeProjectFile(root, 'astro.config.mjs', `
      import { defineConfig } from 'astro/config';
      import geo from ${JSON.stringify(astroEntryUrl)};
      export default defineConfig({
        site: 'https://example.test',
        trailingSlash: 'always',
        integrations: [geo()],
      });
    `);

    await buildAstro({ root, logLevel: 'silent' });

    const distDir = join(root, 'dist');
    const sitemap = readFileSync(join(distDir, 'sitemap.xml'), 'utf-8');
    const feed = readFileSync(join(distDir, 'feed.xml'), 'utf-8');
    const llms = readFileSync(join(distDir, 'llms.txt'), 'utf-8');

    expect(sitemap).toContain('<loc>https://example.test/</loc>');
    expect(sitemap).toContain('<loc>https://example.test/about/</loc>');
    expect(sitemap).toContain('<loc>https://example.test/zh/</loc>');
    expect(feed).toContain('<link>https://example.test/</link>');
    expect(feed).toContain('<link>https://example.test/about/</link>');
    expect(feed).toContain('<link>https://example.test/zh/</link>');

    expect(existsSync(join(distDir, 'index.md'))).toBe(true);
    expect(existsSync(join(distDir, 'about.md'))).toBe(true);
    expect(existsSync(join(distDir, 'zh.md'))).toBe(true);
    expect(llms).toContain('https://example.test/about.md');
    expect(llms).toContain('https://example.test/zh.md');

    const verified = verifyGeoOutput({
      projectRoot: root,
      distDir,
      options: { trailingSlash: 'always' },
    });
    expect(verified.ok).toBe(true);
    expect(verified.errors).toEqual([]);
    expect(verified.warnings).toEqual([]);
  }, 30_000);

  it('respects canonical trailing-slash style under trailingSlash: preserve even when audit is false', async () => {
    const f = createFixture({
      'index.html': makeHtml({
        title: 'Home',
        canonical: 'https://example.test/',
        body: '<h1>Home</h1><a href="/with-slash/">A</a><a href="/no-slash">B</a><a href="/cross">C</a>',
      }),
      'with-slash/index.html': makeHtml({
        title: 'With Slash',
        canonical: 'https://example.test/with-slash/',
      }),
      'no-slash/index.html': makeHtml({
        title: 'No Slash',
        canonical: 'https://example.test/no-slash',
      }),
      'cross.html': makeHtml({
        title: 'Cross Origin',
        canonical: 'https://other.example/external/',
      }),
    });

    const plan = await buildGeoGenerationPlanFromDisk({
      projectRoot: f.root,
      distDir: f.distDir,
      currentDate: '2026-10-01T00:00:00.000Z',
      options: {
        trailingSlash: 'preserve',
        audit: false,
        llmsMdMirror: false,
      },
    });
    expect(plan.report.audit).toBeUndefined();

    const sitemap = plan.files.find(({ filename }) => filename === 'sitemap.xml')?.content || '';
    const feed = plan.files.find(({ filename }) => filename === 'feed.xml')?.content || '';
    const llms = plan.files.find(({ filename }) => filename === 'llms.txt')?.content || '';

    for (const content of [sitemap, feed, llms]) {
      expect(content).toContain('https://example.test/');
      expect(content).toContain('https://example.test/with-slash/');
      expect(content).toContain('https://example.test/no-slash');
      expect(content).not.toContain('https://example.test/no-slash/');
      expect(content).toContain('https://example.test/cross');
      expect(content).not.toContain('https://example.test/cross/');
    }

    applyGeoGenerationPlanToDisk(plan, { distDir: f.distDir });
    const verified = verifyGeoOutput({
      projectRoot: f.root,
      distDir: f.distDir,
      options: { trailingSlash: 'preserve', llmsMdMirror: false },
    });
    expect(verified.ok).toBe(true);
    expect(verified.errors).toEqual([]);
    expect(verified.warnings).toEqual([]);
  });

  it('handles trailingSlash: always with routeBasePath and flags canonical mismatches in audit', async () => {
    const f = createFixture({
      'index.html': makeHtml({
        title: 'Docs Home',
        canonical: 'https://example.test/docs/',
        body: '<h1>Docs</h1><a href="/docs/about/">About</a>',
      }),
      'about.html': makeHtml({
        title: 'About Docs',
        canonical: 'https://example.test/docs/about',
        body: '<h1>About</h1><a href="/docs/">Home</a>',
      }),
    });
    const options = {
      routeBasePath: '/docs/',
      trailingSlash: 'always',
      llmsMdMirror: false,
      generateFeed: false,
    };
    const plan = await buildGeoGenerationPlanFromDisk({
      projectRoot: f.root,
      distDir: f.distDir,
      currentDate: '2026-10-01T00:00:00.000Z',
      options,
    });
    const sitemap = plan.files.find(({ filename }) => filename === 'sitemap.xml')?.content || '';
    expect(sitemap).toContain('<loc>https://example.test/docs/</loc>');
    expect(sitemap).toContain('<loc>https://example.test/docs/about/</loc>');
    expect(plan.report.audit.diagnostics.some(
      (d) => d.path === 'about.html' && d.rule === 'canonical-sitemap-mismatch',
    )).toBe(true);
  });
});

describe('v0.4.0 mirror filtering & handwritten llms.txt preservation (#6)', () => {
  it('scopes .md mirrors and discovery links with llmsMdMirrorInclude/Exclude and falls back to HTML URLs in llms.txt', async () => {
    const f = createFixture({
      'index.html': makeHtml({
        title: 'Home',
        canonical: 'https://example.test/',
        body: '<h1>Home</h1><a href="/guides/setup/">Setup</a><a href="/guides/draft/">Draft</a><a href="/pricing/">Pricing</a>',
      }),
      'guides/setup/index.html': makeHtml({
        title: 'Setup Guide',
        canonical: 'https://example.test/guides/setup/',
        body: '<h1>Setup Guide</h1><p>Install steps.</p><a href="/">Home</a>',
      }),
      'guides/draft/index.html': makeHtml({
        title: 'Draft Guide',
        canonical: 'https://example.test/guides/draft/',
        body: '<h1>Draft Guide</h1><p>Draft.</p><a href="/">Home</a>',
      }),
      'pricing/index.html': makeHtml({
        title: 'Pricing',
        canonical: 'https://example.test/pricing/',
        body: '<h1>Pricing</h1><p>Free.</p><a href="/">Home</a>',
      }),
    });

    const options = {
      trailingSlash: 'always',
      llmsMdMirrorInclude: ['guides/**'],
      llmsMdMirrorExclude: ['guides/draft*'],
      generateFeed: false,
    };

    const plan = await buildGeoGenerationPlanFromDisk({
      projectRoot: f.root,
      distDir: f.distDir,
      currentDate: '2026-10-01T00:00:00.000Z',
      options,
    });

    const emittedFiles = plan.files.map(({ filename }) => filename);
    expect(emittedFiles).toContain('guides/setup.md');
    expect(emittedFiles).not.toContain('index.md');
    expect(emittedFiles).not.toContain('guides/draft.md');
    expect(emittedFiles).not.toContain('pricing.md');

    const llms = plan.files.find(({ filename }) => filename === 'llms.txt')?.content || '';
    expect(llms).toContain('[Setup Guide](https://example.test/guides/setup.md)');
    expect(llms).toContain('[Home](https://example.test/)');
    expect(llms).toContain('[Draft Guide](https://example.test/guides/draft/)');
    expect(llms).toContain('[Pricing](https://example.test/pricing/)');

    const setupHtml = plan.htmlUpdates.find(({ filename }) => filename === 'guides/setup/index.html')?.content || '';
    const pricingHtml = plan.htmlUpdates.find(({ filename }) => filename === 'pricing/index.html')?.content || '';
    expect(setupHtml).toContain('rel="alternate" type="text/markdown" href="https://example.test/guides/setup.md"');
    expect(pricingHtml).not.toContain('rel="alternate" type="text/markdown"');
    expect(pricingHtml).toContain('rel="describedby" type="text/markdown" href="https://example.test/llms.txt"');

    expect(plan.report.audit.diagnostics.filter((d) => d.severity === 'warning')).toEqual([]);

    applyGeoGenerationPlanToDisk(plan, { distDir: f.distDir });
    const verified = verifyGeoOutput({ projectRoot: f.root, distDir: f.distDir, options });
    expect(verified.ok).toBe(true);
    expect(verified.errors).toEqual([]);
    expect(verified.warnings).toEqual([]);
  });

  it('records and warns when preserving handwritten llms.txt alongside unreferenced generated .md mirrors', async () => {
    const f = createFixture({
      'index.html': makeHtml({ title: 'Home', body: '<h1>Home</h1><a href="/about">About</a>' }),
      'about.html': makeHtml({ title: 'About', body: '<h1>About</h1><a href="/">Home</a>' }),
      'llms.txt': [
        '# Handwritten llms.txt',
        '',
        '<!-- [About](https://example.test/about.md) -->',
        '- [Home](https://example.test/index.md)',
      ].join('\n'),
    });

    const plan = await buildGeoGenerationPlanFromDisk({
      projectRoot: f.root,
      distDir: f.distDir,
      currentDate: '2026-10-01T00:00:00.000Z',
      options: { generateFeed: false },
    });

    expect(plan.report.fileCompatibility).toEqual({
      policy: 'preserve',
      decisions: [{ filename: 'llms.txt', decision: 'preserve' }],
      preservedLlmsMirrorCount: 2,
      unreferencedMirrorCount: 1,
    });

    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    logFileCompatibility(plan.report.fileCompatibility, logger);
    const warningText = logger.warn.mock.calls.flat().join('\n');
    expect(warningText).toContain('2 HTML page(s) received <link rel="alternate" type="text/markdown">');
    expect(warningText).toContain('1 of 2 generated .md mirror(s)');
    expect(warningText).toContain('/llms.txt');
    expect(warningText).toContain("fileConflict: 'overwrite'");

    // When all generated mirrors are referenced in handwritten llms.txt, unreferencedMirrorCount is 0 and no mirror mismatch warning is logged.
    const syncedFixture = createFixture({
      'index.html': makeHtml({ title: 'Home', body: '<h1>Home</h1><a href="/about">About</a>' }),
      'about.html': makeHtml({ title: 'About', body: '<h1>About</h1><a href="/">Home</a>' }),
      'llms.txt': '# Handwritten\n- [Home](/index.md)\n- [About](https://example.test/about.md)\n',
    });
    const syncedPlan = await buildGeoGenerationPlanFromDisk({
      projectRoot: syncedFixture.root,
      distDir: syncedFixture.distDir,
      currentDate: '2026-10-01T00:00:00.000Z',
      options: { generateFeed: false },
    });
    expect(syncedPlan.report.fileCompatibility.unreferencedMirrorCount).toBe(0);
    const syncedLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    logFileCompatibility(syncedPlan.report.fileCompatibility, syncedLogger);
    expect(syncedLogger.warn.mock.calls.flat().join('\n')).not.toContain('lacks links to');
  });
});

describe('v0.4.0 feed scoping, feedByLocale, and debug summary (#4)', () => {
  it('filters feed items by pattern, maxItems, and language in single-feed mode and detects single shared locale', async () => {
    const plan = await buildGeoGenerationPlan({
      projectRoot: process.cwd(),
      distDir: join(process.cwd(), 'dist'),
      currentDate: '2026-10-10T00:00:00.000Z',
      htmlInputs: [
        {
          relativePath: 'index.html',
          htmlContent: makeHtml({ lang: 'en', title: 'Home', canonical: 'https://example.test' }),
          mtime: '2026-10-01T00:00:00.000Z',
        },
        {
          relativePath: 'blog/a.html',
          htmlContent: makeHtml({ lang: 'en-US', title: 'Post A', canonical: 'https://example.test/blog/a' }),
          mtime: '2026-10-02T00:00:00.000Z',
        },
        {
          relativePath: 'blog/b.html',
          htmlContent: makeHtml({ lang: 'en', title: 'Post B', canonical: 'https://example.test/blog/b' }),
          mtime: '2026-10-05T00:00:00.000Z',
        },
        {
          relativePath: 'blog/draft.html',
          htmlContent: makeHtml({ lang: 'en', title: 'Draft', canonical: 'https://example.test/blog/draft' }),
          mtime: '2026-10-09T00:00:00.000Z',
        },
        {
          relativePath: 'zh/blog/c.html',
          htmlContent: makeHtml({ lang: 'zh-CN', title: '中文文章', canonical: 'https://example.test/zh/blog/c' }),
          mtime: '2026-10-08T00:00:00.000Z',
        },
      ],
      options: {
        domain: 'https://example.test',
        llmsMdMirror: false,
        lastmodStrategy: 'build',
        feedIncludePatterns: ['blog/**', 'zh/blog/**'],
        feedExcludePatterns: ['blog/draft*'],
        feedLanguage: 'en',
        feedMaxItems: 1,
      },
    });

    const feed = plan.files.find(({ filename }) => filename === 'feed.xml')?.content || '';
    expect(feed).toContain('<language>en</language>');
    expect(feed).toContain('<title>Post B</title>');
    expect(feed).not.toContain('<title>Post A</title>');
    expect(feed).not.toContain('<title>Draft</title>');
    expect(feed).not.toContain('<title>中文文章</title>');

    // Non-matching language HTML omits mismatched RSS link and passes audit cleanly.
    const zhUpdate = plan.htmlUpdates.find(({ filename }) => filename === 'zh/blog/c.html')?.content || '';
    expect(zhUpdate).not.toContain('application/rss+xml');
    const enUpdate = plan.htmlUpdates.find(({ filename }) => filename === 'blog/a.html')?.content || '';
    expect(enUpdate).toContain('application/rss+xml');
    expect(plan.report.audit.diagnostics.filter((d) => d.rule === 'discovery-feed')).toEqual([]);

    // Auto-detects single shared language when filtered items are all zh-CN without feedLanguage.
    const zhOnlyPlan = await buildGeoGenerationPlan({
      projectRoot: process.cwd(),
      distDir: join(process.cwd(), 'dist'),
      currentDate: '2026-10-10T00:00:00.000Z',
      htmlInputs: [
        { relativePath: 'index.html', htmlContent: makeHtml({ lang: 'en', title: 'Home' }) },
        { relativePath: 'zh/blog/post.html', htmlContent: makeHtml({ lang: 'zh-CN', title: '中文' }) },
      ],
      options: {
        domain: 'https://example.test',
        llmsMdMirror: false,
        feedIncludePatterns: ['zh/blog/**'],
      },
    });
    expect(zhOnlyPlan.files.find(({ filename }) => filename === 'feed.xml')?.content)
      .toContain('<language>zh-CN</language>');
  });

  it('generates per-locale feeds with feedByLocale: true, injects locale RSS links, passes audit/verify, and regenerates cleanly', async () => {
    const f = createFixture({
      'index.html': makeHtml({
        lang: 'en',
        title: 'Home',
        canonical: 'https://example.test/',
        body: '<h1>Home</h1><a href="/blog/launch/">Launch</a><a href="/zh/">中文</a><a href="/fr/">FR</a>',
      }),
      'blog/launch/index.html': makeHtml({
        lang: 'en',
        title: 'Launch',
        canonical: 'https://example.test/blog/launch/',
        body: '<h1>Launch</h1><a href="/">Home</a>',
      }),
      'zh/index.html': makeHtml({
        lang: 'zh',
        title: '中文首页',
        canonical: 'https://example.test/zh/',
        body: '<h1>中文首页</h1><a href="/zh/blog/post/">Post</a><a href="/">Home</a>',
      }),
      'zh/blog/post/index.html': makeHtml({
        lang: 'zh',
        title: '中文博文',
        canonical: 'https://example.test/zh/blog/post/',
        body: '<h1>中文博文</h1><a href="/zh/">中文</a>',
      }),
      'fr/index.html': makeHtml({
        lang: 'fr',
        title: 'Accueil',
        canonical: 'https://example.test/fr/',
        body: '<h1>Accueil</h1><a href="/">Home</a>',
      }),
    });

    const options = {
      trailingSlash: 'always',
      llmsMdMirror: false,
      feedIncludePatterns: ['blog/**', 'zh/blog/**'],
      feedByLocale: true,
      feedLanguage: 'en',
    };

    const plan = await buildGeoGenerationPlanFromDisk({
      projectRoot: f.root,
      distDir: f.distDir,
      currentDate: '2026-10-10T00:00:00.000Z',
      options,
    });

    const rootFeed = plan.files.find(({ filename }) => filename === 'feed.xml')?.content || '';
    const zhFeed = plan.files.find(({ filename }) => filename === 'zh/feed.xml')?.content || '';
    expect(rootFeed).toContain('<language>en</language>');
    expect(rootFeed).toContain('https://example.test/blog/launch/');
    expect(rootFeed).not.toContain('zh/blog/post');
    expect(zhFeed).toContain('<language>zh</language>');
    expect(zhFeed).toContain('<atom:link href="https://example.test/zh/feed.xml" rel="self" type="application/rss+xml" />');
    expect(zhFeed).toContain('https://example.test/zh/blog/post/');
    expect(zhFeed).not.toContain('blog/launch');
    expect(plan.files.some(({ filename }) => filename === 'fr/feed.xml')).toBe(false);

    expect(plan.report.audit.diagnostics.filter((d) => d.severity === 'warning')).toEqual([]);

    applyGeoGenerationPlanToDisk(plan, { distDir: f.distDir });
    expect(readFileSync(join(f.distDir, 'index.html'), 'utf-8'))
      .toContain('href="/feed.xml"');
    expect(readFileSync(join(f.distDir, 'zh/index.html'), 'utf-8'))
      .toContain('href="/zh/feed.xml"');
    expect(readFileSync(join(f.distDir, 'fr/index.html'), 'utf-8'))
      .not.toContain('application/rss+xml');

    const verified = verifyGeoOutput({ projectRoot: f.root, distDir: f.distDir, options });
    expect(verified.ok).toBe(true);
    expect(verified.errors).toEqual([]);
    expect(verified.warnings).toEqual([]);

    // Re-running generation recognizes zh/feed.xml as managed instead of user-owned.
    const secondPlan = await buildGeoGenerationPlanFromDisk({
      projectRoot: f.root,
      distDir: f.distDir,
      currentDate: '2026-10-11T00:00:00.000Z',
      options,
    });
    expect(secondPlan.report.preservedFiles).toEqual([]);
    expect(secondPlan.files.map(({ filename }) => filename)).toContain('zh/feed.xml');
  });

  it('includes RSS pubDate guidance in formatGeoDebugSummary when lastmodStrategy is none', () => {
    const withFeedAndNone = formatGeoDebugSummary({
      projectRoot: '/app',
      distDir: '/app/dist',
      sourceHtmlDir: '/app/src/pages',
      report: { lastmodStrategy: 'none', generateFeed: true, generatedFiles: [] },
    });
    expect(withFeedAndNone).toContain('<pubDate>');
    expect(withFeedAndNone).toContain('feedIncludePatterns');

    const withoutFeed = formatGeoDebugSummary({
      projectRoot: '/app',
      distDir: '/app/dist',
      sourceHtmlDir: '/app/src/pages',
      report: { lastmodStrategy: 'none', generateFeed: false, generatedFiles: [] },
    });
    expect(withoutFeed).not.toContain('<pubDate>');

    const withGitLastmod = formatGeoDebugSummary({
      projectRoot: '/app',
      distDir: '/app/dist',
      sourceHtmlDir: '/app/src/pages',
      report: { lastmodStrategy: 'git', generateFeed: true, generatedFiles: [] },
    });
    expect(withGitLastmod).not.toContain('<pubDate>');
  });
});

describe('v0.4.0 CLI flags and end-to-end HTML->Markdown mirror quality (#3, #7)', () => {
  it('parses all 9 new v0.4.0 CLI flags and rejects invalid feedMaxItems', async () => {
    const parsed = parseCliArgs([
      'generate',
      '--trailing-slash', 'always',
      '--markdown-strip-selectors', '.toc, [data-promo]',
      '--llms-md-mirror-include', 'guides/**,blog/**',
      '--llms-md-mirror-exclude', 'guides/draft*',
      '--feed-include-patterns', 'blog/**',
      '--feed-exclude-patterns', 'blog/internal/**',
      '--feed-max-items', '20',
      '--feed-language', 'en-US',
      '--feed-by-locale',
    ]);
    expect(parsed.options).toMatchObject({
      trailingSlash: 'always',
      markdownStripSelectors: ['.toc', '[data-promo]'],
      llmsMdMirrorInclude: ['guides/**', 'blog/**'],
      llmsMdMirrorExclude: ['guides/draft*'],
      feedIncludePatterns: ['blog/**'],
      feedExcludePatterns: ['blog/internal/**'],
      feedMaxItems: 20,
      feedLanguage: 'en-US',
      feedByLocale: true,
    });

    expect(parseCliArgs(['--no-feed-by-locale']).options.feedByLocale).toBe(false);
    expect(parseCliArgs(['--feed-by-locale=false']).options.feedByLocale).toBe(false);
    expect(parseCliArgs(['--feed-max-items=15']).options.feedMaxItems).toBe(15);

    const f = createFixture({ 'index.html': makeHtml({ title: 'Home' }) });
    const logs = [];
    const logger = { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };

    expect(await runCli(['generate', '--dist-dir', f.distDir, '--feed-max-items', 'abc'], { cwd: f.root, logger })).toBe(1);
    expect(logs.at(-2)).toContain('feedMaxItems');

    expect(await runCli(['generate', '--dist-dir', f.distDir, '--feed-max-items', '0'], { cwd: f.root, logger })).toBe(1);
    expect(await runCli(['generate', '--dist-dir', f.distDir, '--feed-max-items=-5'], { cwd: f.root, logger })).toBe(1);
    expect(await runCli(['generate', '--dist-dir', f.distDir, '--feed-max-items', '1.5'], { cwd: f.root, logger })).toBe(1);

    const helpLogs = [];
    expect(await runCli(['--help'], { cwd: f.root, logger: { log: (m) => helpLogs.push(m), warn: () => {}, error: () => {} } })).toBe(0);
    const help = helpLogs.join('\n');
    expect(help).toContain('--trailing-slash');
    expect(help).toContain('--markdown-strip-selectors');
    expect(help).toContain('--llms-md-mirror-include');
    expect(help).toContain('--llms-md-mirror-exclude');
    expect(help).toContain('--feed-include-patterns');
    expect(help).toContain('--feed-exclude-patterns');
    expect(help).toContain('--feed-max-items');
    expect(help).toContain('--feed-language');
    expect(help).toContain('--feed-by-locale');
  });

  it('produces clean single-H1 GFM Markdown mirrors end-to-end from complex real-world HTML', async () => {
    const f = createFixture({
      'index.html': `<!doctype html>
<html lang="en">
  <head>
    <title>Compress Images Online Free | Imgto</title>
    <meta name="description" content="Shrink JPG, PNG, WebP and AVIF in your browser.">
    <link rel="canonical" href="https://example.test/">
  </head>
  <body>
    <header><nav><a href="/">Home</a></nav></header>
    <main>
      <nav aria-label="Breadcrumb"><a href="/">Home</a> / <span>Compress</span></nav>
      <h1>Compress image</h1>
      <div class="upload-widget" data-geo-ignore>Drop files here</div>
      <div class="toc-box"><a href="#formats">Jump to formats</a></div>
      <form><input type="search" placeholder="Search tools"><button type="submit">Go</button></form>
      <section>
        <h2>Related tools</h2>
        <a href="/resize/">
          <h3>Resize image</h3>
          <p>Change pixel dimensions quickly.</p>
          <span>Open</span>
        </a>
      </section>
      <section>
        <h2>Format comparison</h2>
        <table>
          <thead><tr><th>Format</th><th>Notes | Limits</th></tr></thead>
          <tbody><tr><td>WebP</td><td>Great compression</td></tr></tbody>
        </table>
      </section>
      <section>
        <h2>FAQ</h2>
        <details>
          <summary>Is it private?</summary>
          <p>Yes, everything runs locally in your browser.</p>
        </details>
      </section>
      <pre><code class="language-bash"># shell comment stays unchanged\necho ok</code></pre>
    </main>
    <footer>Copyright Imgto</footer>
  </body>
</html>`,
    });

    const options = {
      trailingSlash: 'always',
      markdownStripSelectors: ['.toc-box'],
      generateFeed: false,
    };
    const plan = await buildGeoGenerationPlanFromDisk({
      projectRoot: f.root,
      distDir: f.distDir,
      currentDate: '2026-10-01T00:00:00.000Z',
      options,
    });
    applyGeoGenerationPlanToDisk(plan, { distDir: f.distDir });

    const md = readFileSync(join(f.distDir, 'index.md'), 'utf-8');
    expect(md).toContain('# Compress Images Online Free | Imgto');
    expect(md).toContain('## Compress image');
    expect(md).toContain('### [Resize image](/resize/)');
    expect(md).toContain('Change pixel dimensions quickly.\n\nOpen');
    expect(md).toContain('| Format | Notes \\| Limits |\n| --- | --- |\n| WebP | Great compression |');
    expect(md).toContain('**Is it private?**\n\nYes, everything runs locally in your browser.');
    expect(md).toContain('# shell comment stays unchanged');
    expect(md).not.toMatch(/Breadcrumb|Drop files here|Jump to formats|Search tools|Copyright Imgto/);
    expect(md).not.toMatch(/\[[^\]]*\n\s*\n[^\]]*\]/);

    // Count top-level `# ` headings outside fenced code blocks: must be exactly 1.
    let inFence = false;
    const h1Headings = [];
    for (const line of md.split('\n')) {
      if (/^```|^~~~/.test(line.trim())) {
        inFence = !inFence;
        continue;
      }
      if (!inFence && /^#\s+/.test(line)) {
        h1Headings.push(line);
      }
    }
    expect(h1Headings).toEqual(['# Compress Images Online Free | Imgto']);

    const verified = verifyGeoOutput({ projectRoot: f.root, distDir: f.distDir, options });
    expect(verified.ok).toBe(true);
    expect(verified.errors).toEqual([]);
    expect(verified.warnings).toEqual([]);
  });
});
