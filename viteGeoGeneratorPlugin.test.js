import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveSiteMetadataFromBuildOutput,
} from './geoMetadataResolver.js';
import { extractPageMetadata } from './geoGenerator.js';

const fixtureRoot = join(process.cwd(), 'tempfiles', '__vite-geo-plugin-fixture__');
const pluginSourcePath = existsSync(join(process.cwd(), 'viteGeoGeneratorPlugin.js'))
  ? join(process.cwd(), 'viteGeoGeneratorPlugin.js')
  : join(process.cwd(), 'packages/vite-plugin-geo', 'viteGeoGeneratorPlugin.js');
const pluginManifestPath = existsSync(join(process.cwd(), 'packages/vite-plugin-geo', 'package.json'))
  ? join(process.cwd(), 'packages/vite-plugin-geo', 'package.json')
  : join(process.cwd(), 'package.json');

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
  it('reads the plugin version from the package manifest', () => {
    const manifest = JSON.parse(readFileSync(pluginManifestPath, 'utf-8'));
    const result = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        "import('./packages/vite-plugin-geo/viteGeoGeneratorPlugin.js').then((module) => console.log(module.resolvePluginVersion()))",
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
        "import('./packages/vite-plugin-geo/viteGeoGeneratorPlugin.js').then(({ createGeoGeneratorPlugin }) => { const logs = []; const originalLog = console.log; console.log = (...args) => logs.push(args.join(' ')); try { createGeoGeneratorPlugin(); } finally { console.log = originalLog; } process.stdout.write(JSON.stringify(logs)); })",
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
    const result = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        "import('./packages/vite-plugin-geo/viteGeoGeneratorPlugin.js').then(({ createGeoGeneratorPlugin }) => { const logs = []; const originalLog = console.log; console.log = (...args) => logs.push(args.join(' ')); try { createGeoGeneratorPlugin({ debug: true }); } finally { console.log = originalLog; } process.stdout.write(JSON.stringify(logs)); })",
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
      },
    );

    expect(result.status).toBe(0);

    const logs = JSON.parse(result.stdout);
    expect(logs[0]).toContain(`vite-plugin-geo v${manifest.version}`);
    expect(logs[1]).toContain('Defaults:');
    expect(logs[2]).toContain('Enabled options:');
  });

  it('records Vite and Rolldown versions from plugin context in debug mode', () => {
    const result = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `
          import { createGeoGeneratorPlugin } from './packages/vite-plugin-geo/viteGeoGeneratorPlugin.js';
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
    expect(pluginSource).toContain('if (options.generateFeed !== false)');
  });

  it('auto-skips GEO sitemap generation when Astro sitemap is configured', async () => {
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
    writeFixtureFile('astro.config.mjs', `
      import sitemap from '@astrojs/sitemap';
      export default { integrations: [sitemap()] };
    `);

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
            await plugin.closeBundle.handler();
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
    expect(existsSync(join(distDir, 'sitemap.xml'))).toBe(false);
    expect(readFileSync(join(distDir, 'robots.txt'), 'utf-8')).toContain('Sitemap: https://example.com/sitemap-index.xml');
    expect(readFileSync(join(distDir, 'llms.txt'), 'utf-8')).toContain('[Sitemap](https://example.com/sitemap-index.xml)');
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
            llmsCtx: true,
            llmsCtxFull: true,
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
      'llms-ctx.txt',
      'llms-ctx-full.txt',
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
            await plugin.closeBundle.handler();
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

  it('wires sourceHtmlDir defaults and unified mtime source resolution for feed', () => {
    const pluginSource = readFileSync(
      pluginSourcePath,
      'utf-8',
    );

    expect(pluginSource).toContain('function resolveSourceHtmlDir');
    expect(pluginSource).toContain("sourceHtmlDir: options.sourceHtmlDir || 'src/pages'");
    expect(pluginSource).toContain('resolveLastmodSourcePath');
    expect(pluginSource).toContain('const mtimeSourcePath = resolveLastmodSourcePath(filePath, distDir, seoOptions);');
    expect(pluginSource).toContain("'sourceHtmlDir'");
  });
});

describe('RSS/Atom link injection', () => {
  it('includes RSS/Atom link injection logic in closeBundle', () => {
    const pluginSource = readFileSync(pluginSourcePath, 'utf-8');

    // 检查 RSS/Atom link 注入代码存在
    expect(pluginSource).toContain('RSS/Atom link injection');
    expect(pluginSource).toContain('detectFeedFormat');
    expect(pluginSource).toContain('feedFormat');
    expect(pluginSource).toContain('feedHref');
    expect(pluginSource).toContain('newFeedLink');
  });

  it('detects feed format from generated feed.xml', () => {
    const pluginSource = readFileSync(pluginSourcePath, 'utf-8');

    // 检查格式检测逻辑
    expect(pluginSource).toContain("feedFormat = detectFeedFormat(feedContent)");
    expect(pluginSource).toContain("let feedFormat = 'rss'");
    expect(pluginSource).toContain("feedFormat === 'atom'");
  });

  it('uses correct feed type based on format', () => {
    const pluginSource = readFileSync(pluginSourcePath, 'utf-8');

    // 检查根据格式选择正确的 MIME 类型
    expect(pluginSource).toContain("feedFormat === 'atom' ? 'application/atom+xml' : 'application/rss+xml'");
    expect(pluginSource).toContain("feedFormat === 'atom' ? 'Atom Feed' : 'RSS Feed'");
  });

  it('replaces existing RSS Feed or Atom Feed link tags', () => {
    const pluginSource = readFileSync(pluginSourcePath, 'utf-8');

    // 检查替换已存在的 feed link 逻辑
    expect(pluginSource).toContain('existingFeedPattern');
    expect(pluginSource).toContain('RSS Feed|Atom Feed');
    expect(pluginSource).toContain('htmlContent.replace(existingFeedPattern, newFeedLink)');
  });

  it('injects link before </head> tag', () => {
    const pluginSource = readFileSync(pluginSourcePath, 'utf-8');

    // 检查注入位置逻辑
    expect(pluginSource).toContain('</head>');
    expect(pluginSource).toContain('htmlContent.replace');
  });

  it('constructs correct feed href with routeBasePath', () => {
    const pluginSource = readFileSync(pluginSourcePath, 'utf-8');

    // 检查 feed href 构建逻辑
    expect(pluginSource).toContain('${routeBasePath}feed.xml');
  });

  it('logs format-specific success message', () => {
    const pluginSource = readFileSync(pluginSourcePath, 'utf-8');

    // 检查日志消息包含格式信息
    expect(pluginSource).toContain('feedFormat.toUpperCase()');
  });
});
