/**
 * Unit tests for SEO Generator core functions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  compareCodeUnits,
  decodeXmlEntities,
  escapeHtmlAttribute,
  escapeXml,
  extractLastmod,
  resolveLastmodSourcePath,
  filterHtmlFiles,
  isValidLanguageTag,
  isWithinDir,
  matchGlob,
  normalizeFilePath,
  resolvePagePath,
  sanitizeControlChars,
} from '../src/geoGenerator.js';

describe('Core Functionality Tests', () => {
  const testDir = join(process.cwd(), 'tempfiles', '__geo-generator__');

  beforeEach(() => {
    // Create test directory
    try {
      mkdirSync(testDir, { recursive: true });
    } catch (error) {
      // Directory might already exist
    }
  });

  afterEach(() => {
    // Clean up test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('extractLastmod', () => {
    it('should extract file mtime when strategy is file-mtime', () => {
      const testFile = join(testDir, 'test.html');
      writeFileSync(testFile, '<html></html>');

      const buildDate = '2026-01-01T00:00:00.000Z';
      const result = extractLastmod(testFile, 'file-mtime', buildDate);

      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(result).not.toBe(buildDate);
    });

    it('should return build date when strategy is build', () => {
      const testFile = join(testDir, 'test.html');
      writeFileSync(testFile, '<html></html>');

      const buildDate = '2026-01-01T00:00:00.000Z';
      const result = extractLastmod(testFile, 'build', buildDate);

      expect(result).toBe(buildDate);
    });

    it('should omit file mtime when the file does not exist', () => {
      const nonExistentFile = join(testDir, 'nonexistent.html');
      const buildDate = '2026-01-01T00:00:00.000Z';

      const result = extractLastmod(nonExistentFile, 'file-mtime', buildDate);

      expect(result).toBeNull();
    });

    it('should omit lastmod by default', () => {
      const testFile = join(testDir, 'test.html');
      writeFileSync(testFile, '<html></html>');

      const buildDate = '2026-01-01T00:00:00.000Z';
      const result = extractLastmod(testFile, undefined, buildDate);

      expect(result).toBeNull();
    });
  });

  describe('resolveLastmodSourcePath', () => {
    it('should resolve source html path when mapped source file exists', () => {
      const distDir = join(testDir, 'dist');
      const sourceHtmlDir = join(testDir, 'src', 'pages');
      mkdirSync(distDir, { recursive: true });
      mkdirSync(sourceHtmlDir, { recursive: true });

      const distHtmlFile = join(distDir, 'about.html');
      const sourceHtmlFile = join(sourceHtmlDir, 'about.html');
      writeFileSync(distHtmlFile, '<html></html>');
      writeFileSync(sourceHtmlFile, '<html></html>');

      const resolved = resolveLastmodSourcePath(distHtmlFile, distDir, { sourceHtmlDir });
      expect(resolved).toBe(sourceHtmlFile);
    });

    it('should resolve source html path after stripPathPrefixes mapping', () => {
      const distDir = join(testDir, 'dist');
      const sourceHtmlDir = join(testDir, 'src', 'pages');
      mkdirSync(join(distDir, 'src', 'pages', 'docs'), { recursive: true });
      mkdirSync(join(sourceHtmlDir, 'docs'), { recursive: true });

      const distHtmlFile = join(distDir, 'src', 'pages', 'docs', 'index.html');
      const sourceHtmlFile = join(sourceHtmlDir, 'docs', 'index.html');
      writeFileSync(distHtmlFile, '<html></html>');
      writeFileSync(sourceHtmlFile, '<html></html>');

      const resolved = resolveLastmodSourcePath(distHtmlFile, distDir, {
        sourceHtmlDir,
        stripPathPrefixes: ['src/pages/'],
      });
      expect(resolved).toBe(sourceHtmlFile);
    });

    it('should fallback to dist html path when source html does not exist', () => {
      const distDir = join(testDir, 'dist');
      const sourceHtmlDir = join(testDir, 'src', 'pages');
      mkdirSync(distDir, { recursive: true });
      mkdirSync(sourceHtmlDir, { recursive: true });

      const distHtmlFile = join(distDir, 'contact.html');
      writeFileSync(distHtmlFile, '<html></html>');

      const resolved = resolveLastmodSourcePath(distHtmlFile, distDir, { sourceHtmlDir });
      expect(resolved).toBe(distHtmlFile);
    });

    it('should return null when neither source nor dist html exists', () => {
      const distDir = join(testDir, 'dist');
      const sourceHtmlDir = join(testDir, 'src', 'pages');
      mkdirSync(distDir, { recursive: true });
      mkdirSync(sourceHtmlDir, { recursive: true });

      const missingDistHtmlFile = join(distDir, 'missing.html');
      const resolved = resolveLastmodSourcePath(missingDistHtmlFile, distDir, { sourceHtmlDir });
      expect(resolved).toBeNull();

      const buildDate = '2026-01-01T00:00:00.000Z';
      const lastmod = extractLastmod(missingDistHtmlFile, 'file-mtime', buildDate);
      expect(lastmod).toBeNull();
    });
  });

  describe('resolvePagePath', () => {
    it('should convert HTML file path to page path', () => {
      expect(resolvePagePath('docs.html')).toBe('docs');
      expect(resolvePagePath('about.html')).toBe('about');
    });

    it('should handle index.html specially', () => {
      expect(resolvePagePath('index.html')).toBe('');
      expect(resolvePagePath('docs/index.html')).toBe('docs');
    });

    it('should strip configured prefixes', () => {
      expect(resolvePagePath('src/pages/docs.html', { stripPathPrefixes: ['src/pages/'] })).toBe('docs');
      expect(resolvePagePath('src/pages/blog/post.html', { stripPathPrefixes: ['src/pages/'] })).toBe('blog/post');
    });

    it('should handle nested index files', () => {
      expect(resolvePagePath('blog/index.html')).toBe('blog');
      expect(resolvePagePath('docs/guide/index.html')).toBe('docs/guide');
    });

    it('should use prettyUrls as default behavior', () => {
      expect(resolvePagePath('docs.html')).toBe('docs');
      expect(resolvePagePath('docs/index.html')).toBe('docs');
    });

    it('should support strict prettyUrls toggle', () => {
      expect(resolvePagePath('docs.html', { prettyUrls: false })).toBe('docs.html');
      expect(resolvePagePath('docs.html', { prettyUrls: true })).toBe('docs');
      expect(resolvePagePath('docs/index.html', { prettyUrls: false })).toBe('docs/index.html');
      expect(resolvePagePath('docs/index.html', { prettyUrls: true })).toBe('docs');
    });
  });

  describe('filterHtmlFiles', () => {
    it('should exclude 404.html and 500.html by default', async () => {
      const file404 = join(testDir, '404.html');
      const file500 = join(testDir, '500.html');
      const fileNormal = join(testDir, 'index.html');

      writeFileSync(file404, '<html></html>');
      writeFileSync(file500, '<html></html>');
      writeFileSync(fileNormal, '<html></html>');

      const result = await filterHtmlFiles([file404, file500, fileNormal], {
        distDir: testDir,
      });

      expect(result.included).toHaveLength(1);
      expect(result.included[0]).toBe(fileNormal);
      expect(result.excluded).toHaveLength(2);
    });

    it('should exclude files with noindex meta tag', async () => {
      const fileWithNoindex = join(testDir, 'noindex.html');
      const fileNormal = join(testDir, 'index.html');

      writeFileSync(fileWithNoindex, '<html><head><meta name="robots" content="noindex"></head></html>');
      writeFileSync(fileNormal, '<html></html>');

      const result = await filterHtmlFiles([fileWithNoindex, fileNormal], {
        distDir: testDir,
      });

      expect(result.included).toHaveLength(1);
      expect(result.included[0]).toBe(fileNormal);
      expect(result.excluded).toContain(fileWithNoindex);
    });

    it('should apply custom exclude patterns', async () => {
      const fileDraft = join(testDir, 'draft-page.html');
      const fileNormal = join(testDir, 'index.html');

      writeFileSync(fileDraft, '<html></html>');
      writeFileSync(fileNormal, '<html></html>');

      const result = await filterHtmlFiles([fileDraft, fileNormal], {
        distDir: testDir,
        excludePatterns: ['*draft*'],
      });

      expect(result.included).toHaveLength(1);
      expect(result.included[0]).toBe(fileNormal);
      expect(result.excluded).toContain(fileDraft);
    });

    it('should combine multiple filter criteria', async () => {
      const file404 = join(testDir, '404.html');
      const fileNoindex = join(testDir, 'noindex.html');
      const fileDraft = join(testDir, 'draft.html');
      const fileNormal = join(testDir, 'index.html');

      writeFileSync(file404, '<html></html>');
      writeFileSync(fileNoindex, '<html><head><meta name="robots" content="noindex"></head></html>');
      writeFileSync(fileDraft, '<html></html>');
      writeFileSync(fileNormal, '<html></html>');

      const result = await filterHtmlFiles([file404, fileNoindex, fileDraft, fileNormal], {
        distDir: testDir,
        excludePatterns: ['*draft*'],
      });

      expect(result.included).toHaveLength(1);
      expect(result.included[0]).toBe(fileNormal);
      expect(result.excluded).toHaveLength(3);
    });
  });

  describe('Helper Functions', () => {
    it('normalizeFilePath should normalize paths', () => {
      expect(normalizeFilePath('./path/to/file')).toBe('path/to/file');
      expect(normalizeFilePath('/path/to/file')).toBe('path/to/file');
      expect(normalizeFilePath('path\\to\\file')).toBe('path/to/file');
    });

    it('detects unquoted noindex meta tags without triggering on HTML comments', async () => {
      const commented = join(testDir, 'commented.html');
      const unquoted = join(testDir, 'unquoted.html');
      writeFileSync(commented, '<html><head><!-- <meta name="robots" content="noindex"> --></head></html>');
      writeFileSync(unquoted, '<html><head><meta name=robots content=noindex></head></html>');

      const result = await filterHtmlFiles([commented, unquoted], { distDir: testDir });
      expect(result.included).toEqual([commented]);
      expect(result.excluded).toEqual([unquoted]);
    });

    it('extracts git lastmod for relative repository file paths', () => {
      const timestamp = extractLastmod('src/index.js', 'git', '2026-01-01T00:00:00.000Z');
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('exposes shared sanitization, path boundary, XML, and glob helpers', () => {
      expect(compareCodeUnits('a', 'b')).toBe(-1);
      expect(isWithinDir('/tmp/dist', '/tmp/dist/sub/file.md')).toBe(true);
      expect(isWithinDir('/tmp/dist', '/tmp/dist2/file.md')).toBe(false);
      expect(isWithinDir('/tmp/dist', '/tmp/dist/../etc/passwd')).toBe(false);
      expect(sanitizeControlChars('Hi\nThere\x00')).toBe('Hi There');
      expect(escapeXml('a\x00<b&"c">')).toBe('a&lt;b&amp;&quot;c&quot;&gt;');
      expect(escapeHtmlAttribute('x" onclick="y')).toBe('x&quot; onclick=&quot;y');
      expect(decodeXmlEntities('&amp;lt;&#99999999;&#xD800;&#65;')).toBe('&lt;&#99999999;&#xD800;A');
      expect(isValidLanguageTag('en-x-custom')).toBe(true);
      expect(isValidLanguageTag('en-US')).toBe(true);
      expect(matchGlob('**/*.html', 'index.html')).toBe(true);
      expect(matchGlob('**/*.html', 'docs/guide.html')).toBe(true);
      expect(matchGlob('foo___DOUBLESTAR___bar', 'fooXbar')).toBe(false);
    });
  });
});
