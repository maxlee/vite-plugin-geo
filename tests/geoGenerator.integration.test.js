/**
 * Integration tests for SEO Generator - Full workflow validation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, utimesSync, statSync } from 'fs';
import { join } from 'path';
import {
  findHtmlFiles,
  filterHtmlFiles,
  generateSitemap,
  generateLlmsTxt,
  generateRobotsTxt,
} from '../geoGenerator.js';

describe('Integration Tests - Core Functionality Workflow', () => {
  const testDir = join(process.cwd(), 'test-integration-temp');
  
  beforeEach(() => {
    // Create test directory structure
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, 'docs'), { recursive: true });
    mkdirSync(join(testDir, 'blog'), { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  it('should complete full SEO generation workflow with Pretty URLs', async () => {
    // Step 1: Create test HTML files
    const indexHtml = join(testDir, 'index.html');
    const docsHtml = join(testDir, 'docs', 'index.html');
    const aboutHtml = join(testDir, 'about.html');
    const notFoundHtml = join(testDir, '404.html');
    const noindexHtml = join(testDir, 'private.html');
    
    writeFileSync(indexHtml, `
      <html>
        <head>
          <title>Home Page</title>
          <meta name="description" content="Welcome to our site">
        </head>
        <body>Content</body>
      </html>
    `);
    
    writeFileSync(docsHtml, `
      <html>
        <head>
          <title>Documentation</title>
          <meta name="description" content="Read our docs">
        </head>
        <body>Docs content</body>
      </html>
    `);
    
    writeFileSync(aboutHtml, `
      <html>
        <head>
          <title>About Us</title>
          <meta name="description" content="Learn about us">
        </head>
        <body>About content</body>
      </html>
    `);
    
    writeFileSync(notFoundHtml, '<html><head><title>404</title></head></html>');
    
    writeFileSync(noindexHtml, `
      <html>
        <head>
          <title>Private Page</title>
          <meta name="robots" content="noindex">
        </head>
        <body>Private content</body>
      </html>
    `);

    // Step 2: Find all HTML files
    const allHtmlFiles = findHtmlFiles(testDir);
    expect(allHtmlFiles).toHaveLength(5);

    // Step 3: Filter HTML files (should exclude 404.html and noindex page)
    const { included, excluded } = await filterHtmlFiles(allHtmlFiles, {
      distDir: testDir,
    });
    
    expect(included).toHaveLength(3); // index, docs, about
    expect(excluded).toHaveLength(2); // 404, private

    // Step 4: Generate sitemap with Pretty URLs
    const sitemapFiles = generateSitemap(
      'https://example.com',
      included,
      testDir,
      '2026-02-28T00:00:00.000Z',
      {
        prettyUrls: true,
        lastmodStrategy: 'build',
      }
    );
    const sitemapContent = sitemapFiles[0].content;

    expect(sitemapContent).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(sitemapContent).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(sitemapContent).toContain('<loc>https://example.com</loc>'); // index.html -> /
    expect(sitemapContent).toContain('<loc>https://example.com/docs</loc>'); // docs/index.html -> /docs
    expect(sitemapContent).toContain('<loc>https://example.com/about</loc>'); // about.html -> /about
    expect(sitemapContent).toContain('<lastmod>2026-02-28T00:00:00.000Z</lastmod>');
    expect(sitemapContent).not.toContain('404.html');
    expect(sitemapContent).not.toContain('private.html');

    // Step 5: Generate llms.txt with Pretty URLs
    const siteMetadata = {
      url: 'https://example.com',
      title: 'Test Site',
      description: 'A test website',
    };

    const llmsTxtContent = generateLlmsTxt(
      siteMetadata,
      included,
      testDir,
      { prettyUrls: true, llmsMdMirror: false }
    );
    
    expect(llmsTxtContent).toContain('# Test Site');
    expect(llmsTxtContent).toContain('> A test website');
    expect(llmsTxtContent).toContain('## Docs');
    expect(llmsTxtContent).toContain('[Home Page](https://example.com)');
    expect(llmsTxtContent).toContain('[Documentation](https://example.com/docs)');
    expect(llmsTxtContent).toContain('[About Us](https://example.com/about)');
    expect(llmsTxtContent).not.toMatch(/Shopify|SHOPLINE|NDJSON|Key Features:/i);
    expect(llmsTxtContent).toContain('## Optional');
    expect(llmsTxtContent).toContain('[Sitemap](https://example.com/sitemap.xml)');
    expect(llmsTxtContent).toContain('[robots.txt](https://example.com/robots.txt)');

    // Step 6: Generate robots.txt with Pretty URLs
    const robotsTxtContent = generateRobotsTxt('https://example.com', {
      prettyUrls: true,
    });
    
    expect(robotsTxtContent).toContain('User-agent: *');
    expect(robotsTxtContent).toContain('Allow: /');
    expect(robotsTxtContent).toContain('Sitemap: https://example.com/sitemap.xml');
  });

  it('should use the configured sitemap URL in llms.txt and robots.txt', async () => {
    const indexFile = join(testDir, 'index.html');
    writeFileSync(indexFile, '<html><head><title>Home</title><meta name="description" content="Home desc"></head></html>');

    const htmlFiles = findHtmlFiles(testDir);
    const { included } = await filterHtmlFiles(htmlFiles, { distDir: testDir });
    const siteMetadata = {
      url: 'https://example.com',
      title: 'Test Site',
      description: 'A test website',
    };

    const llmsTxtContent = generateLlmsTxt(siteMetadata, included, testDir, {
      sitemapUrl: 'sitemap-index.xml',
    });
    const robotsTxtContent = generateRobotsTxt('https://example.com', {
      sitemapUrl: 'sitemap-index.xml',
    });

    expect(llmsTxtContent).toContain('[Sitemap](https://example.com/sitemap-index.xml)');
    expect(llmsTxtContent).not.toContain('[Sitemap](https://example.com/sitemap.xml)');
    expect(robotsTxtContent).toContain('Sitemap: https://example.com/sitemap-index.xml');
    expect(robotsTxtContent).not.toContain('Sitemap: https://example.com/sitemap.xml');
  });

  it('should handle file-mtime strategy correctly', async () => {
    // Create a test file
    const testFile = join(testDir, 'test.html');
    writeFileSync(testFile, '<html><head><title>Test</title></head></html>');
    
    // Wait a bit to ensure mtime is different from build date
    await new Promise(resolve => setTimeout(resolve, 10));
    
    const htmlFiles = findHtmlFiles(testDir);
    const { included } = await filterHtmlFiles(htmlFiles, { distDir: testDir });
    
    // Generate sitemap with file-mtime strategy
    const sitemapFiles = generateSitemap(
      'https://example.com',
      included,
      testDir,
      '2026-01-01T00:00:00.000Z',
      {
        lastmodStrategy: 'file-mtime',
        prettyUrls: false,
      }
    );
    const sitemapContent = sitemapFiles[0].content;

    // The lastmod should be the file's actual mtime, not the build date
    expect(sitemapContent).toContain('<lastmod>');
    expect(sitemapContent).toContain('<loc>https://example.com/test.html</loc>');
    expect(sitemapContent).not.toContain('<lastmod>2026-01-01T00:00:00.000Z</lastmod>');
    
    // Verify it's a valid ISO 8601 timestamp
    const lastmodMatch = sitemapContent.match(/<lastmod>([^<]+)<\/lastmod>/);
    expect(lastmodMatch).toBeTruthy();
    const timestamp = lastmodMatch[1];
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('should prefer source html mtime over dist html mtime for file-mtime strategy', () => {
    const distHtmlFile = join(testDir, 'about.html');
    const sourceHtmlDir = join(testDir, 'source-pages');
    const sourceHtmlFile = join(sourceHtmlDir, 'about.html');
    mkdirSync(sourceHtmlDir, { recursive: true });

    writeFileSync(distHtmlFile, '<html><head><title>About</title></head></html>');
    writeFileSync(sourceHtmlFile, '<html><head><title>About Source</title></head></html>');

    const sourceDate = new Date('2025-01-01T01:00:00.000Z');
    const distDate = new Date('2026-03-03T03:00:00.000Z');
    utimesSync(sourceHtmlFile, sourceDate, sourceDate);
    utimesSync(distHtmlFile, distDate, distDate);

    const sitemapFiles = generateSitemap(
      'https://example.com',
      [distHtmlFile],
      testDir,
      '2026-01-01T00:00:00.000Z',
      {
        lastmodStrategy: 'file-mtime',
        prettyUrls: false,
        sourceHtmlDir,
      },
    );
    const sitemapContent = sitemapFiles[0].content;
    const expectedSourceMtime = statSync(sourceHtmlFile).mtime.toISOString();
    const distMtime = statSync(distHtmlFile).mtime.toISOString();

    expect(expectedSourceMtime).not.toBe(distMtime);
    expect(sitemapContent).toContain(`<lastmod>${expectedSourceMtime}</lastmod>`);
    expect(sitemapContent).not.toContain(`<lastmod>${distMtime}</lastmod>`);
  });

  it('should fallback to dist html mtime when source html is missing', () => {
    const distHtmlFile = join(testDir, 'fallback.html');
    const sourceHtmlDir = join(testDir, 'source-pages-missing');
    mkdirSync(sourceHtmlDir, { recursive: true });
    writeFileSync(distHtmlFile, '<html><head><title>Fallback</title></head></html>');

    const distDate = new Date('2026-02-02T02:00:00.000Z');
    utimesSync(distHtmlFile, distDate, distDate);

    const sitemapFiles = generateSitemap(
      'https://example.com',
      [distHtmlFile],
      testDir,
      '2026-01-01T00:00:00.000Z',
      {
        lastmodStrategy: 'file-mtime',
        prettyUrls: false,
        sourceHtmlDir,
      },
    );
    const sitemapContent = sitemapFiles[0].content;
    const expectedDistMtime = statSync(distHtmlFile).mtime.toISOString();

    expect(sitemapContent).toContain(`<lastmod>${expectedDistMtime}</lastmod>`);
  });

  it('should keep .html page URLs when prettyUrls is false', async () => {
    const aboutHtml = join(testDir, 'about.html');
    const docsIndexHtml = join(testDir, 'docs', 'index.html');

    writeFileSync(aboutHtml, '<html><head><title>About</title></head><body>About</body></html>');
    writeFileSync(docsIndexHtml, '<html><head><title>Docs</title></head><body>Docs</body></html>');

    const htmlFiles = findHtmlFiles(testDir);
    const { included } = await filterHtmlFiles(htmlFiles, { distDir: testDir });

    const sitemapFiles = generateSitemap(
      'https://example.com',
      included,
      testDir,
      '2026-02-28T00:00:00.000Z',
      { prettyUrls: false, lastmodStrategy: 'build' }
    );

    const sitemapContent = sitemapFiles[0].content;
    expect(sitemapContent).toContain('<loc>https://example.com/about.html</loc>');
    expect(sitemapContent).toContain('<loc>https://example.com/docs/index.html</loc>');
  });

  it('should use prettyUrls=true when option is omitted', async () => {
    const aboutHtml = join(testDir, 'about.html');
    const docsIndexHtml = join(testDir, 'docs', 'index.html');

    writeFileSync(aboutHtml, '<html><head><title>About</title></head><body>About</body></html>');
    writeFileSync(docsIndexHtml, '<html><head><title>Docs</title></head><body>Docs</body></html>');

    const htmlFiles = findHtmlFiles(testDir);
    const { included } = await filterHtmlFiles(htmlFiles, { distDir: testDir });

    const sitemapFiles = generateSitemap(
      'https://example.com',
      included,
      testDir,
      '2026-02-28T00:00:00.000Z',
      { lastmodStrategy: 'build' }
    );
    const sitemapContent = sitemapFiles[0].content;

    expect(sitemapContent).toContain('<loc>https://example.com/about</loc>');
    expect(sitemapContent).toContain('<loc>https://example.com/docs</loc>');

    const llmsTxtContent = generateLlmsTxt(
      {
        url: 'https://example.com',
        title: 'Test Site',
        description: 'A test website',
      },
      included,
      testDir,
      { llmsMdMirror: false }
    );

    expect(llmsTxtContent).toContain('[About](https://example.com/about)');
    expect(llmsTxtContent).toContain('[Docs](https://example.com/docs)');
  });

  it('should handle custom exclude patterns correctly', async () => {
    // Create test files
    writeFileSync(join(testDir, 'index.html'), '<html></html>');
    writeFileSync(join(testDir, 'draft-page.html'), '<html></html>');
    writeFileSync(join(testDir, 'test-page.html'), '<html></html>');
    writeFileSync(join(testDir, 'blog', 'draft-post.html'), '<html></html>');
    
    const htmlFiles = findHtmlFiles(testDir);
    const { included, excluded } = await filterHtmlFiles(htmlFiles, {
      distDir: testDir,
      excludePatterns: ['*draft*', '*test*'],
    });
    
    // Should only include index.html
    expect(included).toHaveLength(1);
    expect(included[0]).toContain('index.html');
    
    // Should exclude draft and test pages
    expect(excluded).toHaveLength(3);
    expect(excluded.some(f => f.includes('draft-page.html'))).toBe(true);
    expect(excluded.some(f => f.includes('test-page.html'))).toBe(true);
    expect(excluded.some(f => f.includes('draft-post.html'))).toBe(true);
  });

  it('should generate valid XML in sitemap', async () => {
    // Create test file with special characters
    const testFile = join(testDir, 'special.html');
    writeFileSync(testFile, `
      <html>
        <head>
          <title>Test & Special <Characters></title>
        </head>
      </html>
    `);
    
    const htmlFiles = findHtmlFiles(testDir);
    const { included } = await filterHtmlFiles(htmlFiles, { distDir: testDir });

    const sitemapFiles = generateSitemap(
      'https://example.com',
      included,
      testDir,
      '2026-02-28T00:00:00.000Z',
      { prettyUrls: false }
    );
    const sitemapContent = sitemapFiles[0].content;

    // Verify XML is well-formed (no unescaped special characters in URLs)
    expect(sitemapContent).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(sitemapContent).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(sitemapContent).toContain('</urlset>');

    // Verify proper XML structure
    const urlMatches = sitemapContent.match(/<url>/g);
    const urlCloseMatches = sitemapContent.match(/<\/url>/g);
    expect(urlMatches?.length).toBe(urlCloseMatches?.length);
  });
});
