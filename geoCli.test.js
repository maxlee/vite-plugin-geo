import { spawnSync } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { isCliEntrypoint, parseCliArgs, runCli, runSeoCliGenerate } from './cli.js';

describe('SEO CLI', () => {
  const fixtureRoot = join(process.cwd(), 'tempfiles', '__seo-cli-fixture__');
  // 使用 import.meta.url 获取 cli.js 的绝对路径，不依赖 process.cwd()
  const cliPath = fileURLToPath(import.meta.url).replace('geoCli.test.js', 'cli.js');
  const silentLogger = {
    log: () => {},
    warn: () => {},
    error: () => {},
  };

  beforeEach(() => {
    mkdirSync(fixtureRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('parses generate command arguments', () => {
    const parsed = parseCliArgs([
      'generate',
      '--dist-dir',
      'dist',
      '--source-html-dir=src/pages',
      '--no-pretty-urls',
      '--generate-feed=false',
      '--domain',
      'https://cli.example.com',
      '--strip-path-prefixes',
      'src/pages/,pages/',
    ]);

    expect(parsed.command).toBe('generate');
    expect(parsed.options.distDir).toBe('dist');
    expect(parsed.options.sourceHtmlDir).toBe('src/pages');
    expect(parsed.options.prettyUrls).toBe(false);
    expect(parsed.options.generateFeed).toBe(false);
    expect(parsed.options.domain).toBe('https://cli.example.com');
    expect(parsed.options.stripPathPrefixes).toEqual(['src/pages/', 'pages/']);
  });

  it('parses sitemap compatibility command arguments', () => {
    const parsed = parseCliArgs([
      'generate',
      '--no-generate-sitemap',
      '--sitemap-url',
      'sitemap-index.xml',
      '--llms-md-mirror-style',
      'replace',
      '--no-generate-robots',
      '--lastmod-strategy',
      'none',
    ]);

    expect(parsed.options.generateSitemap).toBe(false);
    expect(parsed.options.sitemapUrl).toBe('sitemap-index.xml');
    expect(parsed.options.llmsMdMirrorStyle).toBe('replace');
    expect(parsed.options.generateRobots).toBe(false);
    expect(parsed.options.lastmodStrategy).toBe('none');
  });

  it('defaults to the generate command and dist directory when no args are provided', async () => {
    const distDir = join(fixtureRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(distDir, 'index.html'),
      '<html lang="en"><head><title>Default CLI Home</title><meta name="description" content="Default CLI Desc"></head><body><h1>Home</h1></body></html>',
    );
    writeFileSync(
      join(fixtureRoot, 'package.json'),
      JSON.stringify({
        name: 'cli-fixture',
        domain: 'https://example.com',
      }, null, 2),
    );

    const messages = [];
    const logger = {
      log: (message) => messages.push(message),
      warn: (message) => messages.push(message),
      error: (message) => messages.push(message),
    };

    const exitCode = await runCli([], {
      cwd: fixtureRoot,
      logger,
    });

    expect(exitCode).toBe(0);
    expect(existsSync(join(distDir, 'sitemap.xml'))).toBe(true);
    expect(existsSync(join(distDir, 'llms.txt'))).toBe(true);
    expect(existsSync(join(distDir, 'robots.txt'))).toBe(true);
    expect(messages).toContain('✅ Generated sitemap.xml');
  });

  it('detects symlinked CLI binary paths as direct runs', () => {
    const symlinkPath = join(fixtureRoot, 'bin', 'vite-plugin-geo');
    mkdirSync(dirname(symlinkPath), { recursive: true });
    symlinkSync(cliPath, symlinkPath);

    expect(isCliEntrypoint({
      argv: ['node', symlinkPath],
      metaUrl: pathToFileURL(cliPath).href,
      importMetaMain: false,
    })).toBe(true);
  });

  it('treats Bun import.meta.main entrypoints as direct runs', () => {
    expect(isCliEntrypoint({
      argv: ['bunx', 'vite-plugin-geo'],
      metaUrl: pathToFileURL(cliPath).href,
      importMetaMain: true,
    })).toBe(true);
  });

  it('prints help when executed through a symlinked bin path', () => {
    const symlinkPath = join(fixtureRoot, 'bin', 'vite-plugin-geo');
    mkdirSync(dirname(symlinkPath), { recursive: true });
    symlinkSync(cliPath, symlinkPath);

    const result = spawnSync('node', [symlinkPath, '--help'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('vite-plugin-geo [generate] [options]');
  });

  it('generates seo files through standalone command flow', async () => {
    const distDir = join(fixtureRoot, 'dist');
    const sourceDir = join(fixtureRoot, 'src', 'pages');
    mkdirSync(distDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });

    const distIndexHtml = join(distDir, 'index.html');
    const sourceIndexHtml = join(sourceDir, 'index.html');
    writeFileSync(distIndexHtml, '<html lang="en"><head><title>CLI Home</title><meta name="description" content="CLI Desc"></head><body><h1>Home</h1></body></html>');
    writeFileSync(sourceIndexHtml, '<html><head><title>Source Home</title></head><body><h1>Source</h1></body></html>');

    const sourceDate = new Date('2024-01-01T00:00:00.000Z');
    const distDate = new Date('2026-03-03T00:00:00.000Z');
    utimesSync(sourceIndexHtml, sourceDate, sourceDate);
    utimesSync(distIndexHtml, distDate, distDate);

    const packageJsonPath = join(fixtureRoot, 'package.json');
    writeFileSync(packageJsonPath, JSON.stringify({
      name: 'cli-fixture',
      domain: 'https://example.com',
    }, null, 2));

    const result = await runSeoCliGenerate(
      {
        distDir: 'dist',
        sourceHtmlDir: 'src/pages',
        packageJsonPath: 'package.json',
        llmsMdMirror: false,
        lastmodStrategy: 'file-mtime',
      },
      {
        cwd: fixtureRoot,
        logger: silentLogger,
      },
    );

    expect(result.generatedFiles).toContain('sitemap.xml');
    expect(result.generatedFiles).toContain('llms.txt');
    expect(result.generatedFiles).toContain('robots.txt');
    expect(result.generatedFiles).toContain('feed.xml');

    expect(existsSync(join(distDir, 'sitemap.xml'))).toBe(true);
    expect(existsSync(join(distDir, 'llms.txt'))).toBe(true);
    expect(existsSync(join(distDir, 'robots.txt'))).toBe(true);
    expect(existsSync(join(distDir, 'feed.xml'))).toBe(true);

    const sitemapContent = readFileSync(join(distDir, 'sitemap.xml'), 'utf-8');
    const sourceMtime = statSync(sourceIndexHtml).mtime.toISOString();
    const distMtime = statSync(distIndexHtml).mtime.toISOString();

    expect(sourceMtime).not.toBe(distMtime);
    expect(sitemapContent).toContain(`<lastmod>${sourceMtime}</lastmod>`);
    expect(sitemapContent).not.toContain(`<lastmod>${distMtime}</lastmod>`);
  });

  it('auto-skips GEO sitemap generation when a sitemap exists in final output', async () => {
    const distDir = join(fixtureRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(distDir, 'index.html'),
      '<html lang="en"><head><title>Astro Home</title><meta name="description" content="Astro Desc"></head><body><h1>Home</h1></body></html>',
    );
    writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify({
      name: 'astro-fixture',
      domain: 'https://example.com',
      dependencies: {
        astro: '^6.0.0',
        '@astrojs/sitemap': '^3.7.3',
      },
    }, null, 2));
    writeFileSync(
      join(distDir, 'sitemap-index.xml'),
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></sitemapindex>',
    );

    const result = await runSeoCliGenerate(
      {
        distDir: 'dist',
        llmsMdMirror: false,
      },
      {
        cwd: fixtureRoot,
        logger: silentLogger,
      },
    );

    expect(result.generatedFiles).not.toContain('sitemap.xml');
    expect(existsSync(join(distDir, 'sitemap.xml'))).toBe(false);
    expect(readFileSync(join(distDir, 'robots.txt'), 'utf-8')).toContain('Sitemap: https://example.com/sitemap-index.xml');
    expect(readFileSync(join(distDir, 'llms.txt'), 'utf-8')).toContain('[Sitemap](https://example.com/sitemap-index.xml)');
  });

  it('uses CLI domain over package.json domain', async () => {
    const distDir = join(fixtureRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(distDir, 'index.html'),
      '<html lang="en"><head><title>CLI Domain Home</title><meta name="description" content="CLI Domain Desc"></head><body><h1>Home</h1></body></html>',
    );
    writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify({
      name: 'cli-domain-fixture',
      domain: 'https://package.example.com',
    }, null, 2));

    await runSeoCliGenerate(
      {
        distDir: 'dist',
        domain: 'https://cli.example.com/',
        llmsMdMirror: false,
        generateFeed: false,
      },
      {
        cwd: fixtureRoot,
        logger: silentLogger,
      },
    );

    expect(readFileSync(join(distDir, 'robots.txt'), 'utf-8')).toContain('Sitemap: https://cli.example.com/sitemap.xml');
    expect(readFileSync(join(distDir, 'llms.txt'), 'utf-8')).toContain('[Sitemap](https://cli.example.com/sitemap.xml)');
  });

  it('fails when no CLI or package.json domain is configured', async () => {
    const distDir = join(fixtureRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(distDir, 'index.html'),
      '<html lang="en"><head><title>Missing Domain</title><meta name="description" content="Missing domain desc"></head><body><h1>Home</h1></body></html>',
    );
    writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify({
      name: 'missing-domain-fixture',
    }, null, 2));

    const messages = [];
    const logger = {
      log: (message) => messages.push(message),
      warn: (message) => messages.push(message),
      error: (message) => messages.push(message),
    };

    const exitCode = await runCli(['generate', '--dist-dir', 'dist'], {
      cwd: fixtureRoot,
      logger,
    });

    expect(exitCode).toBe(1);
    expect(messages.join('\n')).toMatch(/domain/i);
  });
});
