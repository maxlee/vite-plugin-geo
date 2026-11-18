import { describe, expect, it } from 'vitest';
import {
  composeMarkdownMirrorContent,
  convertHtmlToMarkdown,
  resolveMarkdownResourceBaseUrl,
} from '../src/geoGenerator.js';

describe('content-focused markdown extraction', () => {
  it('prefers <main> and drops site chrome outside it', () => {
    const markdown = convertHtmlToMarkdown(`
      <html><body>
        <header><a href="/">Acme</a><nav><a href="/about">About</a></nav></header>
        <main><h1>Docs</h1><p>Main body.</p></main>
        <aside>Sidebar</aside>
        <footer>© Acme</footer>
      </body></html>
    `);

    expect(markdown).toContain('# Docs');
    expect(markdown).toContain('Main body.');
    expect(markdown).not.toMatch(/Acme|About|Sidebar/);
  });

  it('removes chrome when falling back to <body>', () => {
    const markdown = convertHtmlToMarkdown(`
      <html><body>
        <header><a href="/">Acme</a><nav>Nav</nav></header>
        <div><p>Intro</p><aside>Aside</aside><footer>Footer</footer></div>
      </body></html>
    `);

    expect(markdown).toContain('Intro');
    expect(markdown).not.toMatch(/Acme|Nav|Aside|Footer/);
  });

  it('keeps a header that contains the page heading', () => {
    const markdown = convertHtmlToMarkdown(
      '<html><body><header><h1>Page Title</h1></header><p>Body</p><footer>Footer</footer></body></html>',
    );

    expect(markdown).toContain('# Page Title');
    expect(markdown).toContain('Body');
    expect(markdown).not.toContain('Footer');
  });

  it('recognizes role="main" when no <main> element exists', () => {
    const markdown = convertHtmlToMarkdown(
      '<html><body><div role="main"><p>Role body</p></div><footer>Footer</footer></body></html>',
    );

    expect(markdown).toContain('Role body');
    expect(markdown).not.toContain('Footer');
  });

  it('uses a single <article> as the content root', () => {
    const markdown = convertHtmlToMarkdown(
      '<html><body><nav>Nav</nav><article><h1>Post</h1><p>Article body</p></article><footer>Footer</footer></body></html>',
    );

    expect(markdown).toContain('# Post');
    expect(markdown).toContain('Article body');
    expect(markdown).not.toMatch(/Nav|Footer/);
  });

  it('falls back to body for listing pages with multiple articles', () => {
    const markdown = convertHtmlToMarkdown(`
      <html><body>
        <header><nav>Nav</nav></header>
        <article><h1>One</h1><p>First</p></article>
        <article><h1>Two</h1><p>Second</p></article>
        <footer>Footer</footer>
      </body></html>
    `);

    expect(markdown).toContain('# One');
    expect(markdown).toContain('First');
    expect(markdown).toContain('# Two');
    expect(markdown).toContain('Second');
    expect(markdown).not.toMatch(/Nav|Footer/);
  });

  it('retries with <body> when the semantic container is empty', () => {
    const markdown = convertHtmlToMarkdown(
      '<html><body><main></main><header><h1>Fallback</h1></header><p>Body</p></body></html>',
    );

    expect(markdown).toContain('# Fallback');
    expect(markdown).toContain('Body');
  });

  it('returns empty markdown when main and body have no readable content', () => {
    expect(convertHtmlToMarkdown('<html><body><main></main></body></html>')).toBe('');
  });

  it('strips inline SVG content', () => {
    const markdown = convertHtmlToMarkdown(
      '<html><body><main><p>Text</p><svg><text>icon</text></svg></main></body></html>',
    );

    expect(markdown).toContain('Text');
    expect(markdown).not.toContain('icon');
  });

  it('absolutizes relative image sources against the HTML file URL', () => {
    const markdown = convertHtmlToMarkdown(`
      <html><body><main>
        <p>Body</p>
        <img src="images/a.png" alt="A">
        <img src="/root.png" alt="R">
        <img src="https://cdn.test/x.png" alt="X">
        <img src="data:image/png;base64,abc" alt="D">
        <a href="next.html">Next</a>
      </main></body></html>
    `, { baseUrl: 'https://example.test/docs/index.html' });

    expect(markdown).toContain('![A](https://example.test/docs/images/a.png)');
    expect(markdown).toContain('![R](https://example.test/root.png)');
    expect(markdown).toContain('![X](https://cdn.test/x.png)');
    expect(markdown).toContain('![D](data:image/png;base64,abc)');
    expect(markdown).toContain('[Next](next.html)');
  });

  it('keeps relative image sources when no base URL is provided', () => {
    const markdown = convertHtmlToMarkdown(
      '<html><body><main><img src="images/a.png" alt="A"></main></body></html>',
    );

    expect(markdown).toContain('![A](images/a.png)');
  });

  it('honors a valid <base href> when resolving image sources', () => {
    const markdown = convertHtmlToMarkdown(
      '<html><head><base href="https://cdn.example.test/assets/"></head><body><main><img src="pic.png" alt="P"></main></body></html>',
      { baseUrl: 'https://example.test/docs/index.html' },
    );

    expect(markdown).toContain('![P](https://cdn.example.test/assets/pic.png)');
  });
});

describe('markdown resource base URL', () => {
  it('uses the built HTML file URL, including directory indexes', () => {
    const options = { prettyUrls: true, routeBasePath: '' };

    expect(resolveMarkdownResourceBaseUrl('index.html', 'https://example.test', options))
      .toBe('https://example.test/');
    expect(resolveMarkdownResourceBaseUrl('about.html', 'https://example.test', options))
      .toBe('https://example.test/about.html');
    expect(resolveMarkdownResourceBaseUrl('docs/index.html', 'https://example.test', options))
      .toBe('https://example.test/docs/index.html');
  });

  it('keeps routeBasePath semantics for home and nested pages', () => {
    const options = { prettyUrls: true, routeBasePath: '/docs/' };

    expect(resolveMarkdownResourceBaseUrl('index.html', 'https://example.test', options))
      .toBe('https://example.test/docs/');
    expect(resolveMarkdownResourceBaseUrl('about.html', 'https://example.test', options))
      .toBe('https://example.test/docs/about.html');
  });
});

describe('markdown mirror composition', () => {
  it('writes title, description, and body in order', () => {
    expect(composeMarkdownMirrorContent({
      title: 'Docs',
      description: 'Docs desc',
      markdown: 'Main body.',
    })).toBe('# Docs\n\n> Docs desc\n\nMain body.');
  });

  it('deduplicates a leading H1 that matches the title', () => {
    expect(composeMarkdownMirrorContent({
      title: 'Docs',
      description: 'Docs desc',
      markdown: '# Docs\n\nMain body.',
    })).toBe('# Docs\n\n> Docs desc\n\nMain body.');
  });

  it('downgrades a leading H1 that differs from the title to keep a single H1', () => {
    expect(composeMarkdownMirrorContent({
      title: 'Docs | Acme',
      description: '',
      markdown: '# Docs\n\nMain body.',
    })).toBe('# Docs | Acme\n\n## Docs\n\nMain body.');
  });

  it('omits a description equal to the title', () => {
    expect(composeMarkdownMirrorContent({
      title: 'Docs',
      description: 'Docs',
      markdown: '',
    })).toBe('# Docs');
  });

  it('returns an empty string when every part is empty', () => {
    expect(composeMarkdownMirrorContent({})).toBe('');
    expect(composeMarkdownMirrorContent({ title: '  ', description: '\n', markdown: ' ' }))
      .toBe('');
  });
});
