/**
 * Advanced Features Tests for Phase 3
 * Tests for Sitemap splitting, hreflang, robots.txt, humans.txt, and RSS feed
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  extractLastmod,
  generateSitemap,
  generateRobotsTxt,
  generateHumansTxt,
  generateFeedXml,
} from '../geoGenerator.js';
import {
  extractTeamInfoFromPackageJson,
  extractTechStackFromPackageJson,
} from '../geoMetadataResolver.js';

describe('Phase 3 - Advanced Features Tests', () => {
  const testDir = join(process.cwd(), 'test-advanced-temp');
  const pluginSourcePath = existsSync(join(process.cwd(), 'viteGeoGeneratorPlugin.js'))
    ? join(process.cwd(), 'viteGeoGeneratorPlugin.js')
    : join(process.cwd(), 'packages/vite-plugin-geo', 'viteGeoGeneratorPlugin.js');

  beforeEach(() => {
    try {
      mkdirSync(testDir, { recursive: true });
    } catch (error) {
      // Directory might already exist
    }
  });

  describe('Plugin Messaging Contract', () => {
    it('should not include legacy v1/v2 compatibility narration in plugin logs', () => {
      const pluginSource = readFileSync(
        pluginSourcePath,
        'utf-8',
      );

      expect(pluginSource).not.toContain('Running in v1.0 compatibility mode');
      expect(pluginSource).not.toContain('List enabled v2.0 features');
    });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Sitemap Generation', () => {
    it('should generate valid sitemap with hreflang support', () => {
      const htmlFile = join(testDir, 'index.html');
      writeFileSync(htmlFile, '<html><head><title>Test</title></head><body>Content</body></html>');

      const hreflangConfig = {
        'en': 'https://example.com/{path}',
        'zh-CN': 'https://example.com/zh/{path}',
      };

      const result = generateSitemap('https://example.com', [htmlFile], testDir, '2026-02-28T00:00:00.000Z', {
        hreflang: hreflangConfig,
      });

      expect(result).toHaveLength(1);
      expect(result[0].filename).toBe('sitemap.xml');
      expect(result[0].content).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(result[0].content).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
      expect(result[0].content).toContain('hreflang="en"');
      expect(result[0].content).toContain('hreflang="zh-CN"');
    });

    it('should skip invalid language codes in hreflang config', () => {
      const htmlFile = join(testDir, 'index.html');
      writeFileSync(htmlFile, '<html><head><title>Test</title></head><body>Content</body></html>');

      const hreflangConfig = {
        'en': 'https://example.com/{path}',
        'INVALID': 'https://example.com/invalid/{path}',  // Invalid code
        'zh-CN': 'https://example.com/zh/{path}',
      };

      const result = generateSitemap('https://example.com', [htmlFile], testDir, '2026-02-28T00:00:00.000Z', {
        hreflang: hreflangConfig,
      });

      // Should only include valid language codes
      expect(result[0].content).toContain('hreflang="en"');
      expect(result[0].content).toContain('hreflang="zh-CN"');
      expect(result[0].content).not.toContain('hreflang="INVALID"');
    });

    it('should split sitemap files when the XML byte size exceeds the configured limit', () => {
      const htmlFiles = [];
      for (let index = 0; index < 4; index += 1) {
        const htmlFile = join(testDir, `page-${index}.html`);
        writeFileSync(htmlFile, `<html><head><title>Page ${index}</title></head><body>Content</body></html>`);
        htmlFiles.push(htmlFile);
      }

      const result = generateSitemap('https://example.com', htmlFiles, testDir, '2026-02-28T00:00:00.000Z', {
        prettyUrls: false,
        sitemapIndex: true,
        sitemapMaxBytes: 260,
      });

      expect(result.map(({ filename }) => filename)).toContain('sitemap_index.xml');
      expect(result.filter(({ filename }) => /^sitemap_\d+\.xml$/.test(filename)).length).toBeGreaterThan(1);
    });
  });

  describe('Lastmod Strategies', () => {
    it('should use the latest git commit timestamp when lastmodStrategy is git', () => {
      const gitDir = join(testDir, 'git-lastmod');
      mkdirSync(gitDir, { recursive: true });
      const htmlFile = join(gitDir, 'index.html');
      writeFileSync(htmlFile, '<html><body>Git timestamp</body></html>');

      const commands = [
        ['init'],
        ['config', 'user.email', 'test@example.com'],
        ['config', 'user.name', 'Test User'],
        ['add', 'index.html'],
        ['commit', '-m', 'add index'],
      ];
      commands.forEach((args) => {
        const result = spawnSync('git', args, {
          cwd: gitDir,
          encoding: 'utf-8',
          env: {
            ...process.env,
            GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z',
            GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z',
          },
        });
        expect(result.status).toBe(0);
      });

      expect(extractLastmod(htmlFile, 'git', '2026-02-28T00:00:00.000Z')).toBe('2026-01-02T03:04:05Z');
    });

    it('should omit lastmod when git has no timestamp for the file', () => {
      const htmlFile = join(testDir, 'not-git.html');
      writeFileSync(htmlFile, '<html><body>No git</body></html>');

      const result = extractLastmod(htmlFile, 'git', '2026-02-28T00:00:00.000Z');

      expect(result).toBeNull();
    });
  });

  describe('robots.txt Enhancement', () => {
    it('should generate basic robots.txt', () => {
      const result = generateRobotsTxt('https://example.com');

      expect(result).toContain('User-agent: *');
      expect(result).toContain('Allow: /');
      expect(result).toContain('Sitemap: https://example.com/sitemap.xml');
      expect(result).not.toContain('Google-Extended');
    });

    it('should include custom directives', () => {
      const result = generateRobotsTxt('https://example.com', {
        robotsDirectives: [
          'Disallow: /admin/',
          'Disallow: /private/',
          'Crawl-delay: 10',
        ],
      });

      expect(result).toContain('# Custom directives');
      expect(result).toContain('Disallow: /admin/');
      expect(result).toContain('Disallow: /private/');
      expect(result).toContain('Crawl-delay: 10');
    });

    it('should support Pretty URLs in sitemap reference', () => {
      const result = generateRobotsTxt('https://example.com', {
        prettyUrls: true,
      });

      expect(result).toContain('Sitemap: https://example.com/sitemap.xml');
    });
  });

  describe('humans.txt Generation', () => {
    it('should generate humans.txt from package.json', () => {
      const packageJson = {
        author: {
          name: 'John Doe',
          email: 'john@example.com',
          url: 'https://johndoe.com',
        },
        contributors: [
          { name: 'Jane Smith' },
          { name: 'Bob Johnson' },
        ],
        dependencies: {
          vite: '^5.0.0',
          react: '^18.0.0',
        },
      };

      const buildDate = '2026-02-28T00:00:00.000Z';
      const helpers = {
        extractTeamInfoFromPackageJson,
        extractTechStackFromPackageJson,
      };

      const result = generateHumansTxt(packageJson, buildDate, helpers);

      expect(result).toContain('/* TEAM */');
      expect(result).toContain('Developer: John Doe');
      expect(result).toContain('Contact: john@example.com');
      expect(result).toContain('From: https://johndoe.com');
      expect(result).toContain('/* THANKS */');
      expect(result).toContain('Jane Smith');
      expect(result).toContain('Bob Johnson');
      expect(result).toContain('/* SITE */');
      expect(result).toContain('Last update: 2026-02-28');
      expect(result).toContain('Components: vite, react');
    });

    it('should handle author as string format', () => {
      const packageJson = {
        author: 'John Doe <john@example.com> (https://johndoe.com)',
        dependencies: {
          vite: '^5.0.0',
        },
      };

      const buildDate = '2026-02-28T00:00:00.000Z';
      const helpers = {
        extractTeamInfoFromPackageJson,
        extractTechStackFromPackageJson,
      };

      const result = generateHumansTxt(packageJson, buildDate, helpers);

      expect(result).toContain('Developer: John Doe');
      expect(result).toContain('Contact: john@example.com');
      expect(result).toContain('From: https://johndoe.com');
    });

    it('should handle missing author gracefully', () => {
      const packageJson = {
        dependencies: {
          vite: '^5.0.0',
        },
      };

      const buildDate = '2026-02-28T00:00:00.000Z';
      const helpers = {
        extractTeamInfoFromPackageJson,
        extractTechStackFromPackageJson,
      };

      const result = generateHumansTxt(packageJson, buildDate, helpers);

      expect(result).not.toContain('/* TEAM */');
      expect(result).not.toMatch(/\[Your /);
      expect(result).toContain('Components: vite');
    });

    it('should extract tech stack correctly', () => {
      const packageJson = {
        author: 'Test',
        dependencies: {
          vite: '^5.0.0',
          vue: '^3.0.0',
          'vue-router': '^4.0.0',
        },
        devDependencies: {
          vitest: '^1.0.0',
        },
      };

      const buildDate = '2026-02-28T00:00:00.000Z';
      const helpers = {
        extractTeamInfoFromPackageJson,
        extractTechStackFromPackageJson,
      };

      const result = generateHumansTxt(packageJson, buildDate, helpers);

      expect(result).toContain('Components: vite, vue, vitest');
    });
  });

  describe('RSS Feed Generation', () => {
    it('should generate valid RSS 2.0 feed', () => {
      const pages = [
        {
          url: 'https://example.com/post-1',
          title: 'First Post',
          description: 'This is the first post',
          mtime: '2026-02-28T10:00:00.000Z',
        },
        {
          url: 'https://example.com/post-2',
          title: 'Second Post',
          description: 'This is the second post',
          mtime: '2026-02-27T10:00:00.000Z',
        },
      ];

      const siteMetadata = {
        url: 'https://example.com',
        title: 'Test Blog',
        description: 'A test blog',
        lang: 'en',
      };

      const buildDate = '2026-02-28T12:00:00.000Z';

      const result = generateFeedXml(pages, siteMetadata, buildDate);

      expect(result).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(result).toContain('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
      expect(result).toContain('<atom:link href="https://example.com/feed.xml" rel="self" type="application/rss+xml" />');
      expect(result).toContain('<channel>');
      expect(result).toContain('<title>Test Blog</title>');
      expect(result).toContain('<link>https://example.com</link>');
      expect(result).toContain('<description>A test blog</description>');
      expect(result).toContain('<language>en</language>');
      expect(result).toContain('<lastBuildDate>');
      expect(result).toContain('</channel>');
      expect(result).toContain('</rss>');
    });

    it('should sort pages by mtime descending', () => {
      const pages = [
        {
          url: 'https://example.com/old',
          title: 'Old Post',
          description: 'Old',
          mtime: '2026-01-01T00:00:00.000Z',
        },
        {
          url: 'https://example.com/new',
          title: 'New Post',
          description: 'New',
          mtime: '2026-02-28T00:00:00.000Z',
        },
        {
          url: 'https://example.com/middle',
          title: 'Middle Post',
          description: 'Middle',
          mtime: '2026-02-15T00:00:00.000Z',
        },
      ];

      const siteMetadata = {
        url: 'https://example.com',
        title: 'Test',
        description: 'Test',
        lang: 'en',
      };

      const result = generateFeedXml(pages, siteMetadata, '2026-02-28T00:00:00.000Z');

      // Check order: newest first
      const newIndex = result.indexOf('New Post');
      const middleIndex = result.indexOf('Middle Post');
      const oldIndex = result.indexOf('Old Post');

      expect(newIndex).toBeLessThan(middleIndex);
      expect(middleIndex).toBeLessThan(oldIndex);
    });

    it('should include all required item fields', () => {
      const pages = [
        {
          url: 'https://example.com/post',
          title: 'Test Post',
          description: 'Test Description',
          mtime: '2026-02-28T00:00:00.000Z',
        },
      ];

      const siteMetadata = {
        url: 'https://example.com',
        title: 'Test',
        description: 'Test',
        lang: 'en',
      };

      const result = generateFeedXml(pages, siteMetadata, '2026-02-28T00:00:00.000Z');

      expect(result).toContain('<item>');
      expect(result).toContain('<title>Test Post</title>');
      expect(result).toContain('<link>https://example.com/post</link>');
      expect(result).toContain('<description>Test Description</description>');
      expect(result).toContain('<pubDate>');
      expect(result).toContain('<guid isPermaLink="true">https://example.com/post</guid>');
      expect(result).toContain('</item>');
    });

    it('should escape XML special characters', () => {
      const pages = [
        {
          url: 'https://example.com/post',
          title: 'Test & Special <Characters>',
          description: 'Description with "quotes" and \'apostrophes\'',
          mtime: '2026-02-28T00:00:00.000Z',
        },
      ];

      const siteMetadata = {
        url: 'https://example.com',
        title: 'Test & Blog',
        description: 'A test blog with <special> characters',
        lang: 'en',
      };

      const result = generateFeedXml(pages, siteMetadata, '2026-02-28T00:00:00.000Z');

      expect(result).toContain('&amp;');
      expect(result).toContain('&lt;');
      expect(result).toContain('&gt;');
      expect(result).toContain('&quot;');
      expect(result).not.toContain('<Characters>');
    });
  });

  describe('Helper Functions', () => {
    it('should extract team info from package.json', () => {
      const packageJson = {
        author: {
          name: 'John Doe',
          email: 'john@example.com',
          url: 'https://johndoe.com',
        },
        contributors: [
          { name: 'Jane Smith', email: 'jane@example.com' },
          'Bob Johnson <bob@example.com>',
        ],
      };

      const result = extractTeamInfoFromPackageJson(packageJson);

      expect(result.author).toEqual({
        name: 'John Doe',
        email: 'john@example.com',
        url: 'https://johndoe.com',
      });
      expect(result.contributors).toHaveLength(2);
      expect(result.contributors[0].name).toBe('Jane Smith');
      expect(result.contributors[1].name).toBe('Bob Johnson');
    });

    it('should extract tech stack from package.json', () => {
      const packageJson = {
        dependencies: {
          vite: '^5.0.0',
          react: '^18.0.0',
          'react-dom': '^18.0.0',
          axios: '^1.0.0',
        },
        devDependencies: {
          vitest: '^1.0.0',
          eslint: '^8.0.0',
        },
      };

      const result = extractTechStackFromPackageJson(packageJson);

      expect(result).toContain('vite');
      expect(result).toContain('react');
      expect(result).toContain('vitest');
      expect(result).not.toContain('axios'); // Not a major framework
      expect(result).not.toContain('eslint'); // Not a major framework
    });
  });
});
