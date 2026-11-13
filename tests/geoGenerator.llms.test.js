import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  convertHtmlToMarkdown,
  generateLlmsTxt,
} from '../src/geoGenerator.js';

describe('llms.txt and Markdown generation', () => {
  const testDir = join(process.cwd(), 'tempfiles', '__geo-llms__');

  beforeEach(() => mkdirSync(testDir, { recursive: true }));
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  it('converts readable HTML content to clean Markdown', () => {
    const markdown = convertHtmlToMarkdown(`
      <html><head><style>body { color: red }</style><script>alert('x')</script></head>
      <body><h1>Main &amp; Title</h1><p>First paragraph</p><ul><li>One</li><li>Two</li></ul>
      <p><strong>Bold</strong>, <em>italic</em>, <code>code()</code>, and <a href="https://example.com">a link</a>.</p></body></html>
    `);

    expect(markdown).toContain('# Main & Title');
    expect(markdown).toContain('First paragraph');
    expect(markdown).toContain('- One');
    expect(markdown).toContain('**Bold**');
    expect(markdown).toContain('*italic*');
    expect(markdown).toContain('`code()`');
    expect(markdown).toContain('[a link](https://example.com)');
    expect(markdown).not.toMatch(/alert|color: red|\n{3,}/);
  });

  it('uses proposal-style sections and append mirrors by default', () => {
    const docsFile = join(testDir, 'docs', 'index.html');
    const exampleFile = join(testDir, 'examples', 'basic.html');
    const apiFile = join(testDir, 'api', 'reference.html');
    mkdirSync(join(testDir, 'docs'), { recursive: true });
    mkdirSync(join(testDir, 'examples'), { recursive: true });
    mkdirSync(join(testDir, 'api'), { recursive: true });
    writeFileSync(docsFile, '<html><head><title>Docs Home</title><meta name="description" content="Main documentation"></head></html>');
    writeFileSync(exampleFile, '<html><head><title>Basic Example</title><meta name="description" content="A practical example"></head></html>');
    writeFileSync(apiFile, '<html><head><title>API Reference</title><meta name="description" content="API details"></head></html>');

    const result = generateLlmsTxt(
      { url: 'https://example.com', title: 'Test Site', description: 'Test description' },
      [docsFile, exampleFile, apiFile],
      testDir,
      { llmsMdMirror: true },
    );

    expect(result).toMatch(/^# Test Site\n\n> Test description/m);
    expect(result).toContain('## Docs');
    expect(result).toContain('[Docs Home](https://example.com/docs.md)');
    expect(result).toContain('## Examples');
    expect(result).toContain('[Basic Example](https://example.com/examples/basic.md)');
    expect(result).toContain('## API');
    expect(result).toContain('[API Reference](https://example.com/api/reference.md)');
    expect(result).toContain('## Optional');
    expect(result).not.toMatch(/Shopify|SHOPLINE|NDJSON|## Key Features/i);
  });

  it('uses replace-style Markdown URLs when configured', () => {
    const filePath = join(testDir, 'guide.html');
    writeFileSync(filePath, '<html><head><title>Guide</title><meta name="description" content="Guide content"></head></html>');

    const result = generateLlmsTxt(
      { url: 'https://example.com', title: 'Test', description: 'Description' },
      [filePath],
      testDir,
      { llmsMdMirror: true, llmsMdMirrorStyle: 'replace' },
    );

    expect(result).toContain('[Guide](https://example.com/guide.md)');
    expect(result).not.toContain('guide.html.md');
  });

  it('links HTML pages when Markdown mirrors are disabled', () => {
    const filePath = join(testDir, 'guide.html');
    writeFileSync(filePath, '<html><head><title>Guide</title></head></html>');

    const result = generateLlmsTxt(
      { url: 'https://example.com', title: 'Test', description: 'Description' },
      [filePath],
      testDir,
      { llmsMdMirror: false },
    );

    expect(result).toContain('[Guide](https://example.com/guide)');
    expect(result).not.toContain('.md)');
  });

  it('supports custom section classification and truncates descriptions', () => {
    const filePath = join(testDir, 'guide.html');
    writeFileSync(filePath, `<html><head><title>Guide</title><meta name="description" content="${'A'.repeat(150)}"></head></html>`);

    const result = generateLlmsTxt(
      { url: 'https://example.com', title: 'Test', description: 'Description' },
      [filePath],
      testDir,
      { llmsMdMirror: false, llmsClassify: () => 'Guides' },
    );

    expect(result).toContain('## Guides');
    const description = result.split('\n').find((line) => line.includes('[Guide]')).split(': ').at(-1);
    expect(description.length).toBeLessThanOrEqual(80);
  });

  it('preserves whitespace inside fenced code blocks during HTML->Markdown conversion', () => {
    const markdown = convertHtmlToMarkdown(
      '<main><pre><code>const a = 1;  \n\n\n  const b = 2;  </code></pre></main>',
    );
    expect(markdown).toContain('const a = 1;  \n\n\n  const b = 2;');
  });

  it('sanitizes control characters, escapes Markdown links, and truncates safely by code point', () => {
    const filePath = join(testDir, 'doc.html');
    const emojiDesc = `${'A'.repeat(76)}😀${'B'.repeat(20)}`;
    writeFileSync(
      filePath,
      `<html><head><title>Doc [v2]\nInjected</title><meta name="description" content="${emojiDesc}"></head></html>`,
    );

    const result = generateLlmsTxt(
      { url: 'https://example.com', title: 'Site\n## FakeHeading', description: 'Line1\nLine2' },
      [filePath],
      testDir,
      {
        llmsMdMirror: false,
        skuMd: { catalog: [{ label: 'Store [EU]', url: 'https://example.com/shop(1)' }] },
      },
    );

    expect(result).toContain('# Site ## FakeHeading');
    expect(result).toContain('> Line1 Line2');
    expect(result).toContain('- [Doc \\[v2\\] Injected](https://example.com/doc): ');
    expect(result).toContain('- [Store \\[EU\\]](https://example.com/shop%281%29):');
    expect(result).not.toMatch(/\uFFFD/);
    expect(result).toContain(`${'A'.repeat(76)}😀...`);
  });
});
