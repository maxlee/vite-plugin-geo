/**
 * Unit tests for llms.txt optimization features
 * Tests: Markdown conversion, mirror file generation, and full site Markdown
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  convertHtmlToMarkdown,
  generateLlmsContextTxt,
  generateMarkdownMirrors,
  generateLlmsFullMd,
  generateLlmsTxt,
} from './geoGenerator.js';

describe('llms.txt Optimization Tests', () => {
  const testDir = join(process.cwd(), 'test-llms-temp');
  
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('convertHtmlToMarkdown', () => {
    it('should convert headings correctly', () => {
      const html = `
        <html>
          <body>
            <h1>Main Title</h1>
            <h2>Section Title</h2>
            <h3>Subsection</h3>
          </body>
        </html>
      `;
      
      const markdown = convertHtmlToMarkdown(html);
      
      expect(markdown).toContain('# Main Title');
      expect(markdown).toContain('## Section Title');
      expect(markdown).toContain('### Subsection');
    });

    it('should convert paragraphs and line breaks', () => {
      const html = `
        <html>
          <body>
            <p>First paragraph</p>
            <p>Second paragraph</p>
          </body>
        </html>
      `;
      
      const markdown = convertHtmlToMarkdown(html);
      
      expect(markdown).toContain('First paragraph');
      expect(markdown).toContain('Second paragraph');
    });

    it('should convert unordered lists', () => {
      const html = `
        <html>
          <body>
            <ul>
              <li>Item 1</li>
              <li>Item 2</li>
              <li>Item 3</li>
            </ul>
          </body>
        </html>
      `;
      
      const markdown = convertHtmlToMarkdown(html);
      
      expect(markdown).toContain('- Item 1');
      expect(markdown).toContain('- Item 2');
      expect(markdown).toContain('- Item 3');
    });

    it('should convert ordered lists', () => {
      const html = `
        <html>
          <body>
            <ol>
              <li>First</li>
              <li>Second</li>
              <li>Third</li>
            </ol>
          </body>
        </html>
      `;
      
      const markdown = convertHtmlToMarkdown(html);
      
      expect(markdown).toContain('1. First');
      expect(markdown).toContain('2. Second');
      expect(markdown).toContain('3. Third');
    });

    it('should convert links', () => {
      const html = `
        <html>
          <body>
            <a href="https://example.com">Example Link</a>
          </body>
        </html>
      `;
      
      const markdown = convertHtmlToMarkdown(html);
      
      expect(markdown).toContain('[Example Link](https://example.com)');
    });

    it('should convert strong and emphasis', () => {
      const html = `
        <html>
          <body>
            <strong>Bold text</strong>
            <em>Italic text</em>
          </body>
        </html>
      `;
      
      const markdown = convertHtmlToMarkdown(html);
      
      expect(markdown).toContain('**Bold text**');
      expect(markdown).toContain('*Italic text*');
    });

    it('should convert inline code', () => {
      const html = `
        <html>
          <body>
            <code>const x = 1;</code>
          </body>
        </html>
      `;
      
      const markdown = convertHtmlToMarkdown(html);
      
      expect(markdown).toContain('`const x = 1;`');
    });

    it('should convert code blocks', () => {
      const html = `
        <html>
          <body>
            <pre><code>function test() {
  return true;
}</code></pre>
          </body>
        </html>
      `;
      
      const markdown = convertHtmlToMarkdown(html);
      
      expect(markdown).toContain('```');
      expect(markdown).toContain('function test()');
    });

    it('should remove script and style tags', () => {
      const html = `
        <html>
          <head>
            <style>body { color: red; }</style>
            <script>console.log('test');</script>
          </head>
          <body>
            <p>Content</p>
          </body>
        </html>
      `;
      
      const markdown = convertHtmlToMarkdown(html);
      
      expect(markdown).not.toContain('color: red');
      expect(markdown).not.toContain('console.log');
      expect(markdown).toContain('Content');
    });

    it('should decode HTML entities', () => {
      const html = `
        <html>
          <body>
            <p>&lt;tag&gt; &amp; &quot;quotes&quot;</p>
          </body>
        </html>
      `;
      
      const markdown = convertHtmlToMarkdown(html);
      
      expect(markdown).toContain('<tag>');
      expect(markdown).toContain('&');
      expect(markdown).toContain('"quotes"');
    });

    it('should clean up excessive whitespace', () => {
      const html = `
        <html>
          <body>
            <p>Line 1</p>


            <p>Line 2</p>
          </body>
        </html>
      `;
      
      const markdown = convertHtmlToMarkdown(html);
      
      // Should not have more than 2 consecutive newlines
      expect(markdown).not.toMatch(/\n{3,}/);
    });
  });

  describe('generateMarkdownMirrors', () => {
    it('should generate .html.md files for HTML files', () => {
      const indexHtml = join(testDir, 'index.html');
      const aboutHtml = join(testDir, 'about.html');
      
      writeFileSync(indexHtml, `
        <html>
          <head><title>Home</title></head>
          <body><h1>Welcome</h1><p>Home page content</p></body>
        </html>
      `);
      
      writeFileSync(aboutHtml, `
        <html>
          <head><title>About</title></head>
          <body><h1>About Us</h1><p>About page content</p></body>
        </html>
      `);
      
      const mirrorMap = generateMarkdownMirrors([indexHtml, aboutHtml], testDir, {
        llmsMdMirror: true,
      });
      
      expect(mirrorMap.size).toBe(2);
      expect(existsSync(`${indexHtml}.md`)).toBe(true);
      expect(existsSync(`${aboutHtml}.md`)).toBe(true);
      
      const indexMd = readFileSync(`${indexHtml}.md`, 'utf-8');
      expect(indexMd).toContain('# Welcome');
      expect(indexMd).toContain('Home page content');
    });

    it('should skip generation when llmsMdMirror is false', () => {
      const testFile = join(testDir, 'test.html');
      writeFileSync(testFile, '<html><body>Test</body></html>');
      
      const mirrorMap = generateMarkdownMirrors([testFile], testDir, {
        llmsMdMirror: false,
      });
      
      expect(mirrorMap.size).toBe(0);
      expect(existsSync(`${testFile}.md`)).toBe(false);
    });

    it('should handle errors gracefully', () => {
      const nonExistentFile = join(testDir, 'nonexistent.html');
      
      // Should not throw error
      expect(() => {
        generateMarkdownMirrors([nonExistentFile], testDir, {
          llmsMdMirror: true,
        });
      }).not.toThrow();
    });
  });

  describe('generateLlmsFullMd', () => {
    it('should generate complete site Markdown with table of contents', () => {
      const indexHtml = join(testDir, 'index.html');
      const docsHtml = join(testDir, 'docs.html');
      
      writeFileSync(indexHtml, `
        <html>
          <head><title>Home Page</title></head>
          <body><h1>Welcome</h1><p>Home content</p></body>
        </html>
      `);
      
      writeFileSync(docsHtml, `
        <html>
          <head><title>Documentation</title></head>
          <body><h1>Docs</h1><p>Documentation content</p></body>
        </html>
      `);
      
      const fullMd = generateLlmsFullMd([indexHtml, docsHtml], testDir, {
        llmsFull: true,
        url: 'https://example.com',
        prettyUrls: false,
      });
      
      expect(fullMd).toContain('# Complete Site Content');
      expect(fullMd).toContain('## Table of Contents');
      expect(fullMd).toContain('[Home Page]');
      expect(fullMd).toContain('[Documentation]');
      expect(fullMd).toContain('<!-- Page 1 -->');
      expect(fullMd).toContain('<!-- Title: Home Page -->');
      expect(fullMd).toContain('<!-- URL: https://example.com -->');
      expect(fullMd).toContain('---');
    });

    it('should return empty string when llmsFull is false', () => {
      const testFile = join(testDir, 'test.html');
      writeFileSync(testFile, '<html><body>Test</body></html>');
      
      const fullMd = generateLlmsFullMd([testFile], testDir, {
        llmsFull: false,
        url: 'https://example.com',
      });
      
      expect(fullMd).toBe('');
    });

    it('should include metadata comments for each page', () => {
      const testFile = join(testDir, 'test.html');
      writeFileSync(testFile, `
        <html>
          <head><title>Test Page</title></head>
          <body><p>Content</p></body>
        </html>
      `);
      
      const fullMd = generateLlmsFullMd([testFile], testDir, {
        llmsFull: true,
        url: 'https://example.com',
        prettyUrls: false,
      });
      
      expect(fullMd).toContain('<!-- Title: Test Page -->');
      expect(fullMd).toContain('<!-- URL: https://example.com/test.html -->');
      expect(fullMd).toContain('<!-- Last Modified:');
    });

    it('should handle Pretty URLs correctly', () => {
      const testFile = join(testDir, 'about.html');
      writeFileSync(testFile, `
        <html>
          <head><title>About</title></head>
          <body><p>About content</p></body>
        </html>
      `);
      
      const fullMd = generateLlmsFullMd([testFile], testDir, {
        llmsFull: true,
        url: 'https://example.com',
        prettyUrls: true,
      });
      
      expect(fullMd).toContain('<!-- URL: https://example.com/about -->');
      expect(fullMd).not.toContain('.html');
    });
  });

  describe('generateLlmsTxt format optimization', () => {
    it('should not invent site-specific feature copy', () => {
      const testFile = join(testDir, 'index.html');
      writeFileSync(testFile, `
        <html>
          <head>
            <title>Test Site</title>
            <meta name="description" content="Test description">
          </head>
          <body>Content</body>
        </html>
      `);
      
      const llmsTxt = generateLlmsTxt(
        {
          url: 'https://example.com',
          title: 'Test Site',
          description: 'Test description',
        },
        [testFile],
        testDir,
        { prettyUrls: false }
      );
      
      expect(llmsTxt).not.toContain('## Key Features');
      expect(llmsTxt).not.toContain('Key Features:');
      expect(llmsTxt).not.toMatch(/Shopify|SHOPLINE|NDJSON/i);
      // Verify it comes before the H2 sections
      const keyFeaturesIndex = llmsTxt.indexOf('Key Features:');
      const h2Index = llmsTxt.indexOf('## Docs');
      expect(keyFeaturesIndex).toBeLessThan(h2Index);
    });

    it('should group llms.txt links into strict proposal-style sections', () => {
      const docsFile = join(testDir, 'docs', 'index.html');
      const exampleFile = join(testDir, 'examples', 'basic.html');
      const apiFile = join(testDir, 'api', 'reference.html');
      mkdirSync(join(testDir, 'docs'), { recursive: true });
      mkdirSync(join(testDir, 'examples'), { recursive: true });
      mkdirSync(join(testDir, 'api'), { recursive: true });

      writeFileSync(docsFile, `
        <html>
          <head><title>Docs Home</title><meta name="description" content="Main documentation"></head>
          <body>Docs</body>
        </html>
      `);
      writeFileSync(exampleFile, `
        <html>
          <head><title>Basic Example</title><meta name="description" content="A practical example"></head>
          <body>Example</body>
        </html>
      `);
      writeFileSync(apiFile, `
        <html>
          <head><title>API Reference</title><meta name="description" content="API details"></head>
          <body>API</body>
        </html>
      `);
      
      const llmsTxt = generateLlmsTxt(
        {
          url: 'https://example.com',
          title: 'Test Site',
          description: 'Test description',
        },
        [docsFile, exampleFile, apiFile],
        testDir,
        { prettyUrls: true, llmsMdMirror: true }
      );

      expect(llmsTxt).toMatch(/^# Test Site\n\n> Test description/m);
      expect(llmsTxt).toContain('## Docs');
      expect(llmsTxt).toContain('- [Docs Home](https://example.com/docs/index.html.md): Main documentation');
      expect(llmsTxt).toContain('## Examples');
      expect(llmsTxt).toContain('- [Basic Example](https://example.com/examples/basic.html.md): A practical example');
      expect(llmsTxt).toContain('## API');
      expect(llmsTxt).toContain('- [API Reference](https://example.com/api/reference.html.md): API details');
      expect(llmsTxt).toContain('## Optional');
      expect(llmsTxt).toContain('- [Sitemap](https://example.com/sitemap.xml): Complete list of all indexed pages');
      expect(llmsTxt).not.toContain(') :');
    });

    it('should include page descriptions under 80 characters', () => {
      const testFile = join(testDir, 'index.html');
      const longDescription = 'A'.repeat(150); // Very long description
      
      writeFileSync(testFile, `
        <html>
          <head>
            <title>Test Page</title>
            <meta name="description" content="${longDescription}">
          </head>
          <body>Content</body>
        </html>
      `);
      
      const llmsTxt = generateLlmsTxt(
        {
          url: 'https://example.com',
          title: 'Test Site',
          description: 'Test description',
        },
        [testFile],
        testDir,
        { prettyUrls: false }
      );
      
      // Find the description in the output
      const lines = llmsTxt.split('\n');
      const pageLines = lines.filter(line => line.includes('[Test Page]'));
      
      expect(pageLines.length).toBeGreaterThan(0);
      
      // Check that descriptions are truncated
      pageLines.forEach(line => {
        const descMatch = line.match(/: (.+)$/);
        if (descMatch) {
          const desc = descMatch[1];
          expect(desc.length).toBeLessThanOrEqual(83); // 80 + "..."
        }
      });
    });

    it('should link to .md versions when llmsMdMirror is enabled', () => {
      const testFile = join(testDir, 'docs.html');
      writeFileSync(testFile, `
        <html>
          <head><title>Docs</title></head>
          <body>Content</body>
        </html>
      `);
      
      const llmsTxt = generateLlmsTxt(
        {
          url: 'https://example.com',
          title: 'Test Site',
          description: 'Test description',
        },
        [testFile],
        testDir,
        {
          prettyUrls: false,
          llmsMdMirror: true,
        }
      );
      
      // Should link to .html.md version
      expect(llmsTxt).toContain('.html.md');
      expect(llmsTxt).toContain('[Docs](https://example.com/docs.html.md)');
    });

    it('should link to HTML versions when llmsMdMirror is disabled', () => {
      const testFile = join(testDir, 'docs.html');
      writeFileSync(testFile, `
        <html>
          <head><title>Docs</title></head>
          <body>Content</body>
        </html>
      `);
      
      const llmsTxt = generateLlmsTxt(
        {
          url: 'https://example.com',
          title: 'Test Site',
          description: 'Test description',
        },
        [testFile],
        testDir,
        {
          prettyUrls: false,
          llmsMdMirror: false,
        }
      );
      
      // Should NOT link to .md version
      expect(llmsTxt).not.toContain('.html.md');
      expect(llmsTxt).toContain('[Docs](https://example.com/docs.html)');
    });

    it('should generate valid mirror links for index and nested index pages', () => {
      const homeFile = join(testDir, 'index.html');
      const docsIndexFile = join(testDir, 'docs', 'index.html');
      mkdirSync(join(testDir, 'docs'), { recursive: true });

      writeFileSync(homeFile, `
        <html>
          <head><title>Home</title></head>
          <body>Home content</body>
        </html>
      `);

      writeFileSync(docsIndexFile, `
        <html>
          <head><title>Docs Home</title></head>
          <body>Docs content</body>
        </html>
      `);

      const llmsTxt = generateLlmsTxt(
        {
          url: 'https://example.com',
          title: 'Test Site',
          description: 'Test description',
        },
        [homeFile, docsIndexFile],
        testDir,
        {
          prettyUrls: true,
          llmsMdMirror: true,
        }
      );

      expect(llmsTxt).toContain('[Home](https://example.com/index.html.md)');
      expect(llmsTxt).toContain('[Docs Home](https://example.com/docs/index.html.md)');
    });

    it('should use prettyUrls=true by default when llmsMdMirror is disabled', () => {
      const testFile = join(testDir, 'docs.html');
      writeFileSync(testFile, `
        <html>
          <head><title>Docs</title></head>
          <body>Content</body>
        </html>
      `);

      const llmsTxt = generateLlmsTxt(
        {
          url: 'https://example.com',
          title: 'Test Site',
          description: 'Test description',
        },
        [testFile],
        testDir,
        { llmsMdMirror: false },
      );

      expect(llmsTxt).toContain('[Docs](https://example.com/docs)');
      expect(llmsTxt).not.toContain('[Docs](https://example.com/docs.html)');
    });

    it('should allow custom llms section classification', () => {
      const guideFile = join(testDir, 'guide.html');
      writeFileSync(guideFile, `
        <html>
          <head><title>Guide</title><meta name="description" content="A custom guide"></head>
          <body>Guide</body>
        </html>
      `);

      const llmsTxt = generateLlmsTxt(
        {
          url: 'https://example.com',
          title: 'Test Site',
          description: 'Test description',
        },
        [guideFile],
        testDir,
        {
          prettyUrls: true,
          llmsMdMirror: false,
          llmsClassify: () => 'Guides',
        }
      );

      expect(llmsTxt).toContain('## Guides');
      expect(llmsTxt).toContain('- [Guide](https://example.com/guide): A custom guide');
    });

    it('should generate llms context files with optional links controlled by mode', () => {
      const docsFile = join(testDir, 'docs.html');
      writeFileSync(docsFile, `
        <html>
          <head><title>Docs</title><meta name="description" content="Docs description"></head>
          <body><h1>Docs</h1><p>Readable documentation.</p></body>
        </html>
      `);

      const compactContext = generateLlmsContextTxt(
        {
          url: 'https://example.com',
          title: 'Test Site',
          description: 'Test description',
        },
        [docsFile],
        testDir,
        {
          prettyUrls: false,
          llmsMdMirror: true,
          sitemapUrl: 'sitemap.xml',
          includeOptional: false,
        }
      );
      const fullContext = generateLlmsContextTxt(
        {
          url: 'https://example.com',
          title: 'Test Site',
          description: 'Test description',
        },
        [docsFile],
        testDir,
        {
          prettyUrls: false,
          llmsMdMirror: true,
          sitemapUrl: 'sitemap.xml',
          includeOptional: true,
        }
      );

      expect(compactContext).toContain('# Test Site Context');
      expect(compactContext).toContain('Readable documentation.');
      expect(compactContext).not.toContain('## Optional');
      expect(fullContext).toContain('## Optional');
      expect(fullContext).toContain('[Sitemap](https://example.com/sitemap.xml)');
    });
  });
});
