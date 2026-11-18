import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';
import { build as buildVite7 } from 'vite7';
import { build as buildVite8 } from 'vite8';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveSiteMetadataFromBuildOutput,
} from '../src/geoMetadataResolver.js';
import { extractPageMetadata } from '../src/geoGenerator.js';
import { createGeoGeneratorPlugin } from '../src/viteGeoGeneratorPlugin.js';

const fixtureRoot = join(process.cwd(), 'tempfiles', '__vite-geo-plugin-fixture__');
const pluginSourcePath = join(process.cwd(), 'src', 'viteGeoGeneratorPlugin.js');
const pluginManifestPath = join(process.cwd(), 'package.json');
const pluginSourceUrl = pathToFileURL(pluginSourcePath).href;

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeFixtureFile(relativePath, content) {
  const fullPath = join(fixtureRoot, relativePath);
  ensureDir(dirname(fullPath));
  writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('viteGeoGeneratorPlugin metadata extraction', () => {
  it('uses only the final bundle generation hook for Vite output', () => {
    const plugin = createGeoGeneratorPlugin({
      domain: 'https://example.com',
      llmsMdMirror: false,
      generateFeed: false,
    });

    expect(plugin.generateBundle).toBeDefined();
    expect(plugin.writeBundle).toBeUndefined();
    expect(plugin.closeBundle).toBeUndefined();
  });

  it('reads the plugin version from the package manifest', () => {
    const manifest = JSON.parse(readFileSync(pluginManifestPath, 'utf-8'));
    const result = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `import(${JSON.stringify(pluginSourceUrl)}).then((module) => console.log(module.resolvePluginVersion()))`,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(manifest.version);
  });

  it('does not print the startup banner during normal builds', () => {
    const result = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `import(${JSON.stringify(pluginSourceUrl)}).then(({ createGeoGeneratorPlugin }) => { const logs = []; const originalLog = console.log; console.log = (...args) => logs.push(args.join(' ')); try { createGeoGeneratorPlugin(); } finally { console.log = originalLog; } process.stdout.write(JSON.stringify(logs)); })`,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it('prints the startup banner only when debug is enabled', () => {
    const manifest = JSON.parse(readFileSync(pluginManifestPath, 'utf-8'));
    const cleanEnv = { ...process.env };
    delete cleanEnv.VITEST;
    delete cleanEnv.VP_RESOLVING_CONFIG_METADATA;
    const result = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `import(${JSON.stringify(pluginSourceUrl)}).then(({ createGeoGeneratorPlugin }) => { const logs = []; const originalLog = console.log; console.log = (...args) => logs.push(args.join(' ')); try { createGeoGeneratorPlugin({ debug: true }); } finally { console.log = originalLog; } process.stdout.write(JSON.stringify(logs)); })`,
      ],
      {
        cwd: process.cwd(),
        env: cleanEnv,
        encoding: 'utf-8',
      },
    );

    expect(result.status).toBe(0);

    const logs = JSON.parse(result.stdout);
    expect(logs[0]).toContain(`vite-plugin-geo v${manifest.version}`);
    expect(logs[1]).toContain('Defaults:');
    expect(logs[2]).toContain('Enabled options:');
  });

  it.each([
    ['VP_RESOLVING_CONFIG_METADATA', '1'],
    ['VITEST', 'true'],
  ])('suppresses the startup banner when %s=%s', (envKey, envValue) => {
    const cleanEnv = { ...process.env };
    delete cleanEnv.VITEST;
    delete cleanEnv.VP_RESOLVING_CONFIG_METADATA;
    cleanEnv[envKey] = envValue;

    const result = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `import(${JSON.stringify(pluginSourceUrl)}).then(({ createGeoGeneratorPlugin }) => { const logs = []; const originalLog = console.log; console.log = (...args) => logs.push(args.join(' ')); try { createGeoGeneratorPlugin({ debug: true }); } finally { console.log = originalLog; } process.stdout.write(JSON.stringify(logs)); })`,
      ],
      {
        cwd: process.cwd(),
        env: cleanEnv,
        encoding: 'utf-8',
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it('records Vite and Rolldown versions from plugin context in debug mode', () => {
    const result = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `
          import { createGeoGeneratorPlugin } from ${JSON.stringify(pluginSourceUrl)};
          const logs = [];
          const originalLog = console.log;
          console.log = (...args) => logs.push(args.join(' '));
          try {
            const plugin = createGeoGeneratorPlugin({ debug: true });
            plugin.buildStart.handler.call({
              meta: {
                viteVersion: '8.0.10',
                rolldownVersion: '1.0.0',
              },
            });
          } finally {
            console.log = originalLog;
          }
          process.stdout.write(JSON.stringify(logs));
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
      },
    );

    expect(result.status).toBe(0);

    const logs = JSON.parse(result.stdout);
    expect(logs.join('\n')).toContain('Vite 8.0.10');
    expect(logs.join('\n')).toContain('Rolldown 1.0.0');
  });

  it('extracts title, description and lang from index html content', () => {
    const html = `<!doctype html>
<html lang="en">
  <head>
    <title>Sline Homepage</title>
    <meta name="description" content="Sline's description">
  </head>
</html>`;

    const metadata = extractPageMetadata(html, { includeLang: true });

    expect(metadata.title).toBe('Sline Homepage');
    expect(metadata.description).toBe("Sline's description");
    expect(metadata.lang).toBe('en');
  });

  it('resolves url from package.json domain and remaining fields from dist/index.html', () => {
    const distDir = join(fixtureRoot, 'dist');
    ensureDir(distDir);

    writeFixtureFile('dist/index.html', `<!doctype html>
<html lang="zh-CN">
  <head>
    <title>构建后的首页标题</title>
    <meta name="description" content="构建后的首页描述">
  </head>
</html>`);

    const packageJsonPath = writeFixtureFile('package.json', JSON.stringify({
      name: 'fixture',
      domain: 'https://sline.dev',
      siteMetadata: {
        url: 'https://should-not-be-used.dev',
        title: 'old title',
      },
    }, null, 2));

    const metadata = resolveSiteMetadataFromBuildOutput(distDir, {
      packageJsonPath,
      htmlFiles: [join(distDir, 'index.html')],
      stripPathPrefixes: ['src/pages/'],
    });

    expect(metadata.url).toBe('https://sline.dev');
    expect(metadata.title).toBe('构建后的首页标题');
    expect(metadata.description).toBe('构建后的首页描述');
    expect(metadata.lang).toBe('zh-CN');
  });

  it('prefers configured domain over package.json domain and normalizes trailing slash', () => {
    const distDir = join(fixtureRoot, 'dist');
    ensureDir(distDir);

    writeFixtureFile('dist/index.html', `<!doctype html>
<html lang="en">
  <head>
    <title>Domain Override Home</title>
    <meta name="description" content="Domain Override Desc">
  </head>
</html>`);

    const packageJsonPath = writeFixtureFile('package.json', JSON.stringify({
      name: 'fixture',
      domain: 'https://package.example.com/',
    }, null, 2));

    const metadata = resolveSiteMetadataFromBuildOutput(distDir, {
      domain: 'https://config.example.com/',
      packageJsonPath,
      htmlFiles: [join(distDir, 'index.html')],
      stripPathPrefixes: ['src/pages/'],
    });

    expect(metadata.url).toBe('https://config.example.com');
  });

  describe('package.json homepage fallback', () => {
    function resolveWithPackageJson(packageJson) {
      const distDir = join(fixtureRoot, 'dist');
      writeFixtureFile('dist/index.html', '<html><head><title>Home</title></head></html>');
      const packageJsonPath = writeFixtureFile('package.json', JSON.stringify(packageJson));
      return () => resolveSiteMetadataFromBuildOutput(distDir, {
        packageJsonPath,
        htmlFiles: [join(distDir, 'index.html')],
      });
    }

    it('uses an absolute homepage when domain is absent', () => {
      expect(resolveWithPackageJson({ name: 'fixture', homepage: 'https://home.example.com/' })().url)
        .toBe('https://home.example.com');
    });

    it('prefers domain over homepage', () => {
      expect(resolveWithPackageJson({
        name: 'fixture',
        domain: 'https://domain.example.com',
        homepage: 'https://home.example.com',
      })().url).toBe('https://domain.example.com');
    });

    it('ignores a relative homepage and reports the missing domain', () => {
      expect(resolveWithPackageJson({ name: 'fixture', homepage: '.' })).toThrow(/Missing required domain.*homepage/);
    });

    it('rejects a homepage that carries a path or fragment', () => {
      expect(resolveWithPackageJson({ name: 'fixture', homepage: 'https://github.com/owner/repo#readme' }))
        .toThrow(/package\.json "homepage" must be an origin-only URL/);
    });
  });

  it('rejects domains that are not absolute http or https URLs', () => {
    const distDir = join(fixtureRoot, 'dist');
    ensureDir(distDir);
    writeFixtureFile('dist/index.html', '<html><head><title>Bad Domain</title></head></html>');

    expect(() => resolveSiteMetadataFromBuildOutput(distDir, {
      domain: 'example.com',
      packageJsonPath: false,
      htmlFiles: [join(distDir, 'index.html')],
    })).toThrow(/domain.*http/i);
  });

  it('falls back to equivalent homepage html path when dist/index.html is unavailable', () => {
    const distDir = join(fixtureRoot, 'dist');
    ensureDir(join(distDir, 'src/pages'));

    const homepagePath = writeFixtureFile('dist/src/pages/index.html', `<!doctype html>
<html lang="en">
  <head>
    <title>Fallback Home</title>
    <meta name="description" content="Fallback description">
  </head>
</html>`);

    const packageJsonPath = writeFixtureFile('package.json', JSON.stringify({
      name: 'fixture',
      domain: 'https://sline.dev',
    }, null, 2));

    const metadata = resolveSiteMetadataFromBuildOutput(distDir, {
      packageJsonPath,
      htmlFiles: [homepagePath],
      stripPathPrefixes: ['src/pages/'],
    });

    expect(metadata.url).toBe('https://sline.dev');
    expect(metadata.title).toBe('Fallback Home');
    expect(metadata.description).toBe('Fallback description');
    expect(metadata.lang).toBe('en');
  });

  it('uses default-on semantics for prettyUrls and generateFeed in plugin flow', () => {
    const pluginSource = readFileSync(
      pluginSourcePath,
      'utf-8',
    );

    expect(pluginSource).toContain('prettyUrls: options.prettyUrls !== false');
    expect(pluginSource).toContain('generateFeed: options.generateFeed !== false');
  });

  it('reuses a sitemap already present in the final bundle', async () => {
    const distDir = join(fixtureRoot, 'dist');
    ensureDir(distDir);
    writeFixtureFile('dist/index.html', `<!doctype html>
<html lang="en">
  <head>
    <title>Astro Plugin Home</title>
    <meta name="description" content="Astro Plugin Desc">
  </head>
  <body><h1>Home</h1></body>
</html>`);
    const packageJsonPath = writeFixtureFile('package.json', JSON.stringify({
      name: 'astro-plugin-fixture',
      domain: 'https://example.com',
      dependencies: {
        astro: '^6.0.0',
        '@astrojs/sitemap': '^3.7.3',
      },
    }, null, 2));
    const result = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `
          import { createGeoGeneratorPlugin } from ${JSON.stringify(pathToFileURL(pluginSourcePath).href)};
          const plugin = createGeoGeneratorPlugin({
            packageJsonPath: ${JSON.stringify(packageJsonPath)},
            llmsMdMirror: false,
            generateFeed: false,
          });
          plugin.configResolved({
            root: ${JSON.stringify(fixtureRoot)},
            base: '',
            build: { outDir: 'dist' },
          });
          const originalLog = console.log;
          console.log = () => {};
          try {
            const emitted = [];
            await plugin.generateBundle.handler.call({
              emitFile(file) {
                emitted.push(file);
              },
            }, { dir: ${JSON.stringify(distDir)} }, {
              'index.html': {
                type: 'asset',
                fileName: 'index.html',
                source: ${JSON.stringify(readFileSync(join(distDir, 'index.html'), 'utf-8'))},
              },
              'catalog-index.xml': {
                type: 'asset',
                fileName: 'catalog-index.xml',
                source: '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></sitemapindex>',
              },
            });
            process.stdout.write(JSON.stringify(emitted));
          } finally {
            console.log = originalLog;
          }
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
      },
    );

    expect(result.status).toBe(0);
    const emitted = JSON.parse(result.stdout);
    expect(emitted.map(({ fileName }) => fileName)).not.toContain('sitemap.xml');
    expect(emitted.find(({ fileName }) => fileName === 'robots.txt').source)
      .toContain('Sitemap: https://example.com/catalog-index.xml');
    expect(emitted.find(({ fileName }) => fileName === 'llms.txt').source)
      .toContain('[Sitemap](https://example.com/catalog-index.xml)');
  });

  it('emits static GEO files from generateBundle when HTML assets are available', async () => {
    const distDir = join(fixtureRoot, 'dist');
    ensureDir(distDir);
    const packageJsonPath = writeFixtureFile('package.json', JSON.stringify({
      name: 'generate-bundle-fixture',
      domain: 'https://example.com',
    }, null, 2));

    const result = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `
          import { createGeoGeneratorPlugin } from ${JSON.stringify(pathToFileURL(pluginSourcePath).href)};
          const emitted = [];
          const plugin = createGeoGeneratorPlugin({
            packageJsonPath: ${JSON.stringify(packageJsonPath)},
            llmsMdMirror: false,
            generateFeed: true,
          });
          plugin.configResolved({
            root: ${JSON.stringify(fixtureRoot)},
            base: '',
            build: { outDir: 'dist' },
          });
          const originalLog = console.log;
          console.log = () => {};
          try {
            await plugin.generateBundle.handler.call({
              emitFile(file) {
                emitted.push(file);
              },
            }, { dir: ${JSON.stringify(distDir)} }, {
              'index.html': {
                type: 'asset',
                fileName: 'index.html',
                source: '<!doctype html><html><head><title>Home</title><meta name="description" content="Home desc"></head><body><h1>Home</h1></body></html>',
              },
            });
          } finally {
            console.log = originalLog;
          }
          process.stdout.write(JSON.stringify(emitted.map((file) => ({
            type: file.type,
            fileName: file.fileName,
            source: String(file.source),
          }))));
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
      },
    );

    expect(result.status).toBe(0);

    const emitted = JSON.parse(result.stdout);
    const emittedNames = emitted.map(({ fileName }) => fileName);
    expect(emittedNames).toEqual(expect.arrayContaining([
      'sitemap.xml',
      'llms.txt',
      'robots.txt',
      'feed.xml',
    ]));
    expect(emitted.find(({ fileName }) => fileName === 'llms.txt').source).toContain('## Docs');
  });

  it('fails plugin generation when no domain is configured', async () => {
    const distDir = join(fixtureRoot, 'dist');
    ensureDir(distDir);
    writeFixtureFile('dist/index.html', `<!doctype html>
<html lang="en">
  <head>
    <title>Missing Domain Home</title>
    <meta name="description" content="Missing Domain Desc">
  </head>
  <body><h1>Home</h1></body>
</html>`);
    const packageJsonPath = writeFixtureFile('package.json', JSON.stringify({
      name: 'missing-domain-fixture',
    }, null, 2));

    const result = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `
          import { createGeoGeneratorPlugin } from ${JSON.stringify(pathToFileURL(pluginSourcePath).href)};
          const plugin = createGeoGeneratorPlugin({
            packageJsonPath: ${JSON.stringify(packageJsonPath)},
            llmsMdMirror: false,
            generateFeed: false,
          });
          plugin.configResolved({
            root: ${JSON.stringify(fixtureRoot)},
            base: '',
            build: { outDir: 'dist' },
          });
          const originalLog = console.log;
          console.log = () => {};
          try {
            await plugin.generateBundle.handler.call({
              emitFile() {},
            }, { dir: ${JSON.stringify(distDir)} }, {
              'index.html': {
                type: 'asset',
                fileName: 'index.html',
                source: ${JSON.stringify(readFileSync(join(distDir, 'index.html'), 'utf-8'))},
              },
            });
          } finally {
            console.log = originalLog;
          }
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toMatch(/domain/i);
  });

  it('resolves sourceHtmlDir from the Vite project root', () => {
    const pluginSource = readFileSync(
      pluginSourcePath,
      'utf-8',
    );

    expect(pluginSource).toContain('function resolveSourceHtmlDir');
    expect(pluginSource).toContain("sourceHtmlDir: options.sourceHtmlDir || 'src/pages'");
    expect(pluginSource).toContain('resolveSourceHtmlDir(resolvedConfig, options.sourceHtmlDir)');
  });

  it('prints one actionable warning when the Vite entry is used inside Astro', async () => {
    ensureDir(join(fixtureRoot, 'dist'));
    writeFixtureFile('package.json', JSON.stringify({
      dependencies: { astro: '^7.1.0' },
    }));

    const plugin = createGeoGeneratorPlugin({
      domain: 'https://example.com',
    });
    plugin.configResolved({
      root: fixtureRoot,
      base: '',
      build: { outDir: 'dist' },
    });

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      await plugin.generateBundle.handler.call({ emitFile() {} }, {}, {});
      await plugin.generateBundle.handler.call({ emitFile() {} }, {}, {});
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.filter((message) => message.includes('vite-plugin-geo/astro'))).toHaveLength(1);
    expect(warnings.some((message) => message.includes('No HTML pages were found'))).toBe(true);
  });

  it('decodes Uint8Array HTML and XML assets as UTF-8 instead of byte strings', async () => {
    const distDir = join(fixtureRoot, 'dist');
    ensureDir(distDir);
    const encoder = new TextEncoder();
    const htmlSource = encoder.encode(
      '<!doctype html><html lang="en"><head><title>Binary HTML</title><meta name="description" content="UTF-8 bytes"></head><body><h1>Binary</h1></body></html>',
    );
    const existingSitemap = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/</loc></url></urlset>',
      'utf-8',
    );
    const plugin = createGeoGeneratorPlugin({
      domain: 'https://example.com',
      packageJsonPath: false,
      llmsMdMirror: false,
      generateFeed: false,
      audit: false,
    });
    plugin.configResolved({
      root: fixtureRoot,
      base: '',
      build: { outDir: 'dist' },
    });

    const emitted = [];
    const bundle = {
      'index.html': {
        type: 'asset',
        fileName: 'index.html',
        source: htmlSource,
      },
      'custom-sitemap.xml': {
        type: 'asset',
        fileName: 'custom-sitemap.xml',
        source: existingSitemap,
      },
    };
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
      await plugin.generateBundle.handler.call(
        { emitFile(file) { emitted.push(file); } },
        { dir: distDir },
        bundle,
      );
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }

    expect(emitted.map(({ fileName }) => fileName)).not.toContain('sitemap.xml');
    const llms = emitted.find(({ fileName }) => fileName === 'llms.txt')?.source;
    expect(llms).toContain('# Binary HTML');
    expect(llms).toContain('> UTF-8 bytes');
    expect(llms).toContain('[Sitemap](https://example.com/custom-sitemap.xml)');
    expect(bundle['index.html'].source).toContain('llms.txt');
  });

  it('uses active Environment API config and skips server environments only in multi-env builds', async () => {
    const wrongRoot = join(fixtureRoot, 'wrong');
    const activeRoot = join(fixtureRoot, 'active');
    const distDir = join(activeRoot, 'dist');
    ensureDir(wrongRoot);
    ensureDir(distDir);

    const plugin = createGeoGeneratorPlugin({
      domain: 'https://example.com',
      packageJsonPath: false,
      llmsMdMirror: false,
      generateFeed: false,
      audit: false,
    });
    const staleConfig = {
      root: wrongRoot,
      base: '/stale/',
      build: { outDir: 'dist', ssr: false },
    };
    const clientConfig = {
      root: activeRoot,
      base: '/docs/',
      consumer: 'client',
      build: { outDir: 'dist', ssr: false },
    };
    const ssrConfig = {
      root: activeRoot,
      base: '/docs/',
      consumer: 'server',
      build: { outDir: 'dist-ssr', ssr: true },
    };
    const topConfig = {
      environments: {
        client: clientConfig,
        ssr: ssrConfig,
      },
    };

    expect(plugin.applyToEnvironment({
      config: clientConfig,
      getTopLevelConfig: () => topConfig,
    })).toBe(true);
    expect(plugin.applyToEnvironment({
      config: ssrConfig,
      getTopLevelConfig: () => topConfig,
    })).toBe(false);
    expect(plugin.applyToEnvironment({
      config: { consumer: 'server', build: { ssr: 'src/entry.js' } },
      getTopLevelConfig: () => ({
        environments: {
          client: { consumer: 'client', build: { ssr: 'src/entry.js' } },
          ssr: { consumer: 'server', build: { ssr: 'src/entry.js' } },
        },
      }),
    })).toBe(true);

    plugin.configResolved(staleConfig);

    const emitted = [];
    const warnings = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => {};
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      await plugin.generateBundle.handler.call(
        {
          environment: {
            name: 'ssr',
            config: ssrConfig,
            getTopLevelConfig: () => topConfig,
          },
          emitFile(file) { emitted.push(file); },
        },
        {},
        {},
      );
      expect(warnings).toEqual([]);
      expect(emitted).toEqual([]);

      await plugin.generateBundle.handler.call(
        {
          environment: {
            name: 'client',
            config: clientConfig,
            getTopLevelConfig: () => topConfig,
          },
          emitFile(file) { emitted.push(file); },
        },
        { dir: distDir },
        {
          'index.html': {
            type: 'asset',
            fileName: 'index.html',
            source: '<html><head><title>Env Home</title></head><body>Home</body></html>',
          },
        },
      );
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }

    expect(emitted.find(({ fileName }) => fileName === 'sitemap.xml')?.source)
      .toContain('<loc>https://example.com/docs</loc>');

    // Single-environment SSR builds still surface an explanatory warning when misconfigured.
    const singleSsrPlugin = createGeoGeneratorPlugin({
      domain: 'https://example.com',
      packageJsonPath: false,
      audit: false,
    });
    singleSsrPlugin.configResolved({
      root: activeRoot,
      base: '/',
      consumer: 'server',
      build: { outDir: 'dist-ssr', ssr: 'src/entry.js' },
    });
    const singleSsrWarnings = [];
    const origWarn2 = console.warn;
    console.warn = (...args) => singleSsrWarnings.push(args.join(' '));
    try {
      await singleSsrPlugin.generateBundle.handler.call({ emitFile() {} }, {}, {});
    } finally {
      console.warn = origWarn2;
    }
    expect(singleSsrWarnings.some((msg) => msg.includes('buildShape=SSR'))).toBe(true);
    expect(singleSsrWarnings.some((msg) => msg.includes('SSR builds do not emit static HTML'))).toBe(true);
  });

  it('uses originalFileNames within projectRoot for lastmod and ignores paths outside projectRoot', async () => {
    const { utimesSync } = await import('fs');
    const distDir = join(fixtureRoot, 'dist');
    const outsideDir = join(fixtureRoot, '..', '__vite-geo-outside-lastmod__');
    ensureDir(distDir);
    ensureDir(outsideDir);
    const inRootSource = writeFixtureFile('landing.html', '<html><head><title>Landing</title></head><body>Landing</body></html>');
    const outsideSource = join(outsideDir, 'secret.html');
    writeFileSync(outsideSource, '<html><head><title>Outside</title></head><body>Outside</body></html>', 'utf-8');
    const mtime = new Date('2025-05-06T07:08:09.000Z');
    utimesSync(inRootSource, mtime, mtime);
    utimesSync(outsideSource, mtime, mtime);

    try {
      const plugin = createGeoGeneratorPlugin({
        domain: 'https://example.com',
        packageJsonPath: false,
        lastmodStrategy: 'file-mtime',
        llmsMdMirror: false,
        generateFeed: false,
        audit: false,
      });
      plugin.configResolved({
        root: fixtureRoot,
        base: '',
        build: { outDir: 'dist' },
      });

      const emitted = [];
      const originalLog = console.log;
      const originalWarn = console.warn;
      console.log = () => {};
      console.warn = () => {};
      try {
        await plugin.generateBundle.handler.call(
          { emitFile(file) { emitted.push(file); } },
          { dir: distDir },
          {
            'index.html': {
              type: 'asset',
              fileName: 'index.html',
              originalFileNames: [inRootSource],
              source: '<html><head><title>Landing</title></head><body>Landing</body></html>',
            },
            'outside.html': {
              type: 'asset',
              fileName: 'outside.html',
              originalFileNames: [outsideSource],
              source: '<html><head><title>Outside</title></head><body>Outside</body></html>',
            },
          },
        );
      } finally {
        console.log = originalLog;
        console.warn = originalWarn;
      }

      const sitemap = emitted.find(({ fileName }) => fileName === 'sitemap.xml')?.source || '';
      expect(sitemap).toContain('<lastmod>2025-05-06T07:08:09.000Z</lastmod>');
      expect(sitemap.match(/<lastmod>/g)).toHaveLength(1);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('detects Astro via astro Vite plugins in monorepos without local astro dependency', async () => {
    ensureDir(join(fixtureRoot, 'dist'));
    writeFixtureFile('package.json', JSON.stringify({ name: 'monorepo-app' }));

    const plugin = createGeoGeneratorPlugin({
      domain: 'https://example.com',
      audit: false,
    });
    const clientConfig = {
      root: fixtureRoot,
      base: '',
      consumer: 'client',
      build: { outDir: 'dist', ssr: true },
      plugins: [{ name: 'astro:build' }],
    };
    plugin.configResolved(clientConfig);

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      await plugin.generateBundle.handler.call(
        {
          environment: {
            name: 'client',
            config: clientConfig,
            getTopLevelConfig: () => ({
              environments: {
                client: clientConfig,
                prerender: { consumer: 'server', build: { ssr: true } },
              },
            }),
          },
          emitFile() {},
        },
        {},
        {},
      );
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.filter((message) => message.includes('vite-plugin-geo/astro'))).toHaveLength(1);
  });

  it("mounts astro:config:setup guard unconditionally that logs and throws 'vite-plugin-geo/astro' guidance", () => {
    const plugin = createGeoGeneratorPlugin();
    const setupHook = plugin.hooks?.['astro:config:setup'];
    expect(typeof setupHook).toBe('function');

    const errorSpy = vi.fn();
    expect(() => setupHook({ logger: { error: errorSpy } })).toThrow(
      /Detected the Vite plugin export from 'vite-plugin-geo' inside Astro integrations[\s\S]*vite-plugin-geo\/astro/,
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain("import geo from 'vite-plugin-geo/astro'");

    expect(() => setupHook()).toThrow(/vite-plugin-geo\/astro/);
    expect(() => setupHook(undefined)).toThrow(/vite-plugin-geo\/astro/);
    expect(() => setupHook(null)).toThrow(/vite-plugin-geo\/astro/);
  });

  it.each([
    ['Vite 7', buildVite7],
    ['Vite 8', buildVite8],
  ])('still completes %s builds cleanly with the Astro guard hook mounted', async (label, viteBuild) => {
    const root = join(fixtureRoot, `guard-${label.toLowerCase().replace(/\s+/g, '-')}`);
    const distDir = join(root, 'dist');
    writeFixtureFile(
      join(`guard-${label.toLowerCase().replace(/\s+/g, '-')}`, 'package.json'),
      JSON.stringify({ name: 'vite-guard-compat', domain: 'https://example.com' }),
    );
    writeFixtureFile(
      join(`guard-${label.toLowerCase().replace(/\s+/g, '-')}`, 'index.html'),
      '<!doctype html><html lang="en"><head><title>Guard Compat</title><meta name="description" content="Vite guard compat"></head><body><h1>Home</h1></body></html>',
    );

    const plugin = createGeoGeneratorPlugin({
      packageJsonPath: join(root, 'package.json'),
      llmsMdMirror: false,
      generateFeed: false,
      audit: false,
    });
    expect(typeof plugin.hooks?.['astro:config:setup']).toBe('function');

    await viteBuild({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin],
      build: {
        outDir: distDir,
        emptyOutDir: true,
      },
    });

    expect(existsSync(join(distDir, 'sitemap.xml'))).toBe(true);
    expect(existsSync(join(distDir, 'robots.txt'))).toBe(true);
    expect(existsSync(join(distDir, 'llms.txt'))).toBe(true);
  }, 20_000);
});
