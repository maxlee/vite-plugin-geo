import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  analyzeHtmlPage,
  composeMarkdownMirrorContent,
  composePageUrl,
  convertHtmlToMarkdown,
  generateFeedXml,
  generateSitemap,
  matchesPagePatterns,
  shouldGenerateMarkdownMirror,
  validateMarkdownStripSelectors,
} from '../src/geoGenerator.js';

describe('v0.4.0 HTML -> Markdown quality upgrades (#3)', () => {
  it('converts HTML tables with thead to GFM pipe tables and escapes pipes/newlines', () => {
    const markdown = convertHtmlToMarkdown(`
      <main>
        <p>Comparison:</p>
        <table>
          <thead>
            <tr>
              <th>Format</th>
              <th>Notes | Caveats</th>
              <th>Example</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>WebP</td>
              <td>Line 1<br>Line 2</td>
              <td><code>a | b</code></td>
            </tr>
            <tr>
              <td>AVIF</td>
              <td><p>Para one</p><p>Para   two</p></td>
              <td></td>
            </tr>
          </tbody>
        </table>
        <p>After table.</p>
      </main>
    `);

    expect(markdown).toContain('Comparison:\n\n| Format | Notes \\| Caveats | Example |\n| --- | --- | --- |\n| WebP | Line 1 Line 2 | `a \\| b` |\n| AVIF | Para one Para two |  |\n\nAfter table.');
  });

  it('uses the first row as header when table has no thead', () => {
    const markdown = convertHtmlToMarkdown(`
      <main>
        <table>
          <tbody>
            <tr><td>Extension</td><td>Mime Type</td></tr>
            <tr><td>.md</td><td>text/markdown</td></tr>
          </tbody>
        </table>
      </main>
    `);

    expect(markdown).toBe('| Extension | Mime Type |\n| --- | --- |\n| .md | text/markdown |');
  });

  it('handles direct tr children without tbody and pads uneven column counts', () => {
    const markdown = convertHtmlToMarkdown(`
      <main>
        <table>
          <tr><th>Col 1</th></tr>
          <tr><td>A</td><td>B</td></tr>
        </table>
      </main>
    `);

    expect(markdown).toBe('| Col 1 |  |\n| --- | --- |\n| A | B |');
  });

  it('formats block-level <a> cards without multi-line broken CommonMark links', () => {
    const markdown = convertHtmlToMarkdown(`
      <main>
        <a href="/compress/">
          <h3>Compress image</h3>
          <p>Shrink JPG, PNG, WebP and GIF files with the best balance of quality and size.</p>
          <span>Open</span>
        </a>
        <a href="/resize/">
          <img src="/thumb.png" alt="Thumb">
          <div>Resize image</div>
          <p>Change pixel dimensions quickly.</p>
        </a>
      </main>
    `);

    expect(markdown).toContain('### [Compress image](/compress/)');
    expect(markdown).toContain('Shrink JPG, PNG, WebP and GIF files with the best balance of quality and size.\n\nOpen');
    expect(markdown).toContain('![Thumb](/thumb.png)\n\n[Resize image](/resize/)\n\nChange pixel dimensions quickly.');
    expect(markdown).not.toMatch(/\[[^\]]*\n\s*\n[^\]]*\]/);
  });

  it('prevents text gluing between adjacent elements without breaking punctuation or code', () => {
    const markdown = convertHtmlToMarkdown(`
      <main>
        <p><strong>Title</strong><span>Description</span></p>
        <p>Select images<span>or drop images here</span></p>
        <p><a href="/tools">Explore all tools</a><span>Search tools<kbd>Ctrl K</kbd></span></p>
        <p><a href="/card"><strong>Title</strong><span>Description</span></a></p>
        <p><strong>Bold</strong>, <em>italic</em>, <code>code()</code>, (<a href="/x">docs</a>) and [<em>note</em>]!</p>
        <pre><code><span>const</span><span> </span><span>x</span><span>=</span><span>1</span></code></pre>
        <p><code><span>foo</span><span>(</span><span>bar</span><span>)</span></code></p>
      </main>
    `);

    expect(markdown).toContain('**Title** Description');
    expect(markdown).toContain('Select images or drop images here');
    expect(markdown).toContain('[Explore all tools](/tools) Search tools Ctrl K');
    expect(markdown).toContain('[**Title** Description](/card)');
    expect(markdown).toContain('**Bold**, *italic*, `code()`, ([docs](/x)) and \\[*note*\\]!');
    expect(markdown).toContain('```\nconst x=1\n```');
    expect(markdown).toContain('`foo(bar)`');
  });

  it('strips noise inside <main> and <article> while honoring markdownStripSelectors', () => {
    const markdown = convertHtmlToMarkdown(`
      <body class="docs-page">
        <main>
          <nav aria-label="Breadcrumb"><a href="/">Home</a> / Docs</nav>
          <div role="navigation"><a href="#sec">Table of contents</a></div>
          <ol aria-label="Site Breadcrumb Trail"><li>Home</li></ol>
          <form>
            <input type="search" placeholder="Search">
            <select><option>v1</option></select>
            <textarea>draft</textarea>
            <button type="submit">Search</button>
          </form>
          <button type="button">Copy</button>
          <p hidden>Hidden text</p>
          <p aria-hidden="true">Screen reader hidden</p>
          <p aria-hidden="false">Visible aria text</p>
          <div data-geo-ignore>Ignored block</div>
          <aside class="promo">Promo banner</aside>
          <section id="content">
            <div class="ad-slot" data-kind="top-banner">Ad</div>
            <p>Core documentation.</p>
          </section>
        </main>
      </body>
    `, {
      markdownStripSelectors: ['aside.promo', 'body.docs-page > main #content > [data-kind^="top-"]'],
    });

    expect(markdown).toContain('Visible aria text');
    expect(markdown).toContain('Core documentation.');
    expect(markdown).not.toMatch(/Breadcrumb|Table of contents|Search|Copy|Hidden text|Screen reader hidden|Ignored block|Promo banner|Ad/);
  });

  it('formats <details>/<summary> clearly with bold summary separated from body', () => {
    const markdown = convertHtmlToMarkdown(`
      <main>
        <details>
          <summary>Question?</summary>
          <p>Answer</p>
        </details>
        <details>
          <summary><strong>Second</strong> question?</summary>
          Inline answer text
        </details>
      </main>
    `);

    expect(markdown).toBe('**Question?**\n\nAnswer\n\n**Second question?**\n\nInline answer text');
  });

  it('enforces a single H1 in composeMarkdownMirrorContent while preserving fenced code comments', () => {
    const composed = composeMarkdownMirrorContent({
      title: 'Docs | Acme',
      description: 'Guide summary',
      markdown: [
        '# Docs',
        '',
        'Intro.',
        '',
        '```bash',
        '# shell comment inside backticks',
        'echo ok',
        '```',
        '',
        '~~~~python',
        '~~~',
        '# python comment inside tildes',
        '~~~~',
        '',
        '# Second H1',
        '',
        '## Existing H2',
        '',
        '#hashtag stays intact',
      ].join('\n'),
    });

    expect(composed).toBe([
      '# Docs | Acme',
      '',
      '> Guide summary',
      '',
      '## Docs',
      '',
      'Intro.',
      '',
      '```bash',
      '# shell comment inside backticks',
      'echo ok',
      '```',
      '',
      '~~~~python',
      '~~~',
      '# python comment inside tildes',
      '~~~~',
      '',
      '## Second H1',
      '',
      '## Existing H2',
      '',
      '#hashtag stays intact',
    ].join('\n'));
  });
});

describe('v0.4.0 validateMarkdownStripSelectors (#3)', () => {
  it('accepts supported CSS selectors', () => {
    expect(validateMarkdownStripSelectors(undefined)).toEqual([]);
    expect(validateMarkdownStripSelectors([])).toEqual([]);
    expect(validateMarkdownStripSelectors([
      'nav',
      '*',
      '#sidebar',
      '.toc-list',
      'div#main.card[data-geo-ignore]',
      '[aria-hidden="true"]',
      '[href^="https://"]',
      '[href$=".pdf"]',
      '[aria-label*="Breadcrumb" i]',
      '[data-kind=\'promo\']',
      '[data-id=widget_1]',
      '[alt=""]',
      'main > nav.toc, article .ad-box',
    ])).toEqual([]);
  });

  it('returns descriptive errors for invalid or unsupported selectors', () => {
    expect(validateMarkdownStripSelectors('div')).toHaveLength(1);
    expect(validateMarkdownStripSelectors([123, '', '   '])).toHaveLength(3);
    expect(validateMarkdownStripSelectors(['> div'])).toHaveLength(1);
    expect(validateMarkdownStripSelectors(['div >'])).toHaveLength(1);
    expect(validateMarkdownStripSelectors(['div, '])).toHaveLength(1);
    expect(validateMarkdownStripSelectors(['.123'])).toHaveLength(1);
    expect(validateMarkdownStripSelectors(['[attr'])).toHaveLength(1);
    expect(validateMarkdownStripSelectors(['[attr=]'])).toHaveLength(1);
    expect(validateMarkdownStripSelectors(['[attr!="x"]'])).toHaveLength(1);
    expect(validateMarkdownStripSelectors(['[attr="x" bad]'])).toHaveLength(1);
    expect(validateMarkdownStripSelectors(['div + p'])).toHaveLength(1);
    expect(validateMarkdownStripSelectors(['div:hover'])).toHaveLength(1);
  });
});

describe('v0.4.0 trailingSlash & analyzeHtmlPage (#5)', () => {
  const testDir = join(process.cwd(), 'tempfiles', '__v040-trailing-slash__');

  beforeEach(() => mkdirSync(testDir, { recursive: true }));
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  it('applies trailingSlash: "always" to directory/extensionless URLs and never to static files', () => {
    expect(composePageUrl('https://example.com', '', '', { trailingSlash: 'always' }))
      .toBe('https://example.com/');
    expect(composePageUrl('https://example.com/', '', '/docs/', { trailingSlash: 'always' }))
      .toBe('https://example.com/docs/');
    expect(composePageUrl('https://example.com', '', '/v1.0/', { trailingSlash: 'always' }))
      .toBe('https://example.com/v1.0/');
    expect(composePageUrl('https://example.com', 'about', '', { trailingSlash: 'always' }))
      .toBe('https://example.com/about/');
    expect(composePageUrl('https://example.com', 'guide/intro', '/docs/', { trailingSlash: 'always' }))
      .toBe('https://example.com/docs/guide/intro/');

    for (const staticFile of [
      'llms.txt',
      'robots.txt',
      'feed.xml',
      'sitemap.xml',
      'sitemap_1.xml',
      'about.md',
      'about.html',
    ]) {
      expect(composePageUrl('https://example.com', staticFile, '', { trailingSlash: 'always' }))
        .toBe(`https://example.com/${staticFile}`);
    }

    expect(composePageUrl('https://example.com', 'about', '', { trailingSlash: 'never' }))
      .toBe('https://example.com/about');
    expect(composePageUrl('https://example.com', '', '', { trailingSlash: 'preserve' }))
      .toBe('https://example.com');
  });

  it('passes trailingSlash options through generateSitemap while keeping sitemap_index loc clean', () => {
    const indexHtml = join(testDir, 'index.html');
    const guideHtml = join(testDir, 'guide.html');
    writeFileSync(indexHtml, '<html><head><title>Home</title></head></html>');
    writeFileSync(guideHtml, '<html><head><title>Guide</title></head></html>');

    const [single] = generateSitemap(
      'https://example.com',
      [indexHtml, guideHtml],
      testDir,
      '2026-08-12T00:00:00.000Z',
      { trailingSlash: 'always' },
    );
    expect(single.content).toContain('<loc>https://example.com/</loc>');
    expect(single.content).toContain('<loc>https://example.com/guide/</loc>');

    const split = generateSitemap(
      'https://example.com',
      [indexHtml, guideHtml],
      testDir,
      '2026-08-12T00:00:00.000Z',
      { trailingSlash: 'always', sitemapMaxBytes: 210 },
    );
    const indexFile = split.find(({ filename }) => filename === 'sitemap_index.xml');
    expect(indexFile?.content).toContain('<loc>https://example.com/sitemap_1.xml</loc>');
    expect(indexFile?.content).not.toContain('sitemap_1.xml/');
  });

  it('extracts canonicalHref in analyzeHtmlPage even when audit is false and skips markdown on noindex', () => {
    const analyzed = analyzeHtmlPage(`
      <html>
        <head>
          <title>Page</title>
          <link rel="canonical" href="">
          <link rel="canonical" href="  https://example.com/page/  ">
        </head>
        <body><main><div class="drop-me">Noise</div><p>Body</p></main></body>
      </html>
    `, {
      audit: false,
      markdownStripSelectors: ['.drop-me'],
    });
    expect(analyzed.canonicalHref).toBe('https://example.com/page/');
    expect(analyzed.audit).toBeUndefined();
    expect(analyzed.markdown).toBe('Body');

    const noindexAnalyzed = analyzeHtmlPage(`
      <html>
        <head>
          <title>Hidden</title>
          <meta name="robots" content="noindex, follow">
          <link rel="canonical" href="https://example.com/hidden/">
        </head>
        <body><main><p>Should not convert</p></main></body>
      </html>
    `);
    expect(noindexAnalyzed.noindex).toBe(true);
    expect(noindexAnalyzed.canonicalHref).toBe('https://example.com/hidden/');
    expect(noindexAnalyzed.markdown).toBe('');
  });
});

describe('v0.4.0 mirror pattern helpers & feed maxItems (#6, #4)', () => {
  it('matches page patterns across root, directory indexes, globs, and relative paths', () => {
    expect(matchesPagePatterns(['/'], { pagePath: '', relativePath: 'index.html' })).toBe(true);
    expect(matchesPagePatterns(['index'], { pagePath: '', relativePath: 'index.html' })).toBe(true);
    expect(matchesPagePatterns(['/'], { relativePath: 'about.html' })).toBe(false);
    expect(matchesPagePatterns(['/guides/**'], { pagePath: 'guides', relativePath: 'guides/index.html' })).toBe(true);
    expect(matchesPagePatterns(['guides/**'], { pagePath: 'guides/setup', relativePath: 'guides/setup.html' })).toBe(true);
    expect(matchesPagePatterns(['guides/**'], { pagePath: 'guides-extra', relativePath: 'guides-extra.html' })).toBe(false);
    expect(matchesPagePatterns(['*.html'], { pagePath: 'about', relativePath: 'about.html' })).toBe(true);
    expect(matchesPagePatterns([], { pagePath: 'about', relativePath: 'about.html' })).toBe(false);
  });

  it('evaluates shouldGenerateMarkdownMirror include/exclude precedence', () => {
    const guideIntro = { pagePath: 'guides/intro', relativePath: 'guides/intro.html' };
    const guideDraft = { pagePath: 'guides/draft', relativePath: 'guides/draft.html' };
    const about = { pagePath: 'about', relativePath: 'about.html' };

    expect(shouldGenerateMarkdownMirror(guideIntro, { llmsMdMirror: false })).toBe(false);
    expect(shouldGenerateMarkdownMirror(guideIntro, { llmsMdMirrorInclude: [] })).toBe(false);
    expect(shouldGenerateMarkdownMirror(guideIntro, {
      llmsMdMirrorInclude: ['/guides/**'],
      llmsMdMirrorExclude: ['guides/draft*'],
    })).toBe(true);
    expect(shouldGenerateMarkdownMirror(guideDraft, {
      llmsMdMirrorInclude: ['/guides/**'],
      llmsMdMirrorExclude: ['guides/draft*'],
    })).toBe(false);
    expect(shouldGenerateMarkdownMirror(about, {
      llmsMdMirrorInclude: ['/guides/**'],
    })).toBe(false);
    expect(shouldGenerateMarkdownMirror(about, {})).toBe(true);
  });

  it('truncates sorted RSS items when generateFeedXml receives positive integer maxItems', () => {
    const pages = [
      { url: 'https://example.com/oldest', title: 'Oldest', description: 'D1', mtime: '2026-01-01T00:00:00Z' },
      { url: 'https://example.com/newest', title: 'Newest', description: 'D2', mtime: '2026-03-01T00:00:00Z' },
      { url: 'https://example.com/middle', title: 'Middle', description: 'D3', mtime: '2026-02-01T00:00:00Z' },
    ];
    const site = { url: 'https://example.com', title: 'Site', description: 'Desc', lang: 'en' };
    const buildDate = '2026-03-01T12:00:00Z';

    const limited = generateFeedXml(pages, site, buildDate, { maxItems: 2 });
    expect(limited).toContain('<title>Newest</title>');
    expect(limited).toContain('<title>Middle</title>');
    expect(limited).not.toContain('<title>Oldest</title>');
    expect(limited.match(/<item>/g)).toHaveLength(2);

    const unlimited = generateFeedXml(pages, site, buildDate, { maxItems: 0 });
    expect(unlimited.match(/<item>/g)).toHaveLength(3);

    const threeArgs = generateFeedXml(pages, site, buildDate);
    expect(threeArgs.match(/<item>/g)).toHaveLength(3);
  });
});
