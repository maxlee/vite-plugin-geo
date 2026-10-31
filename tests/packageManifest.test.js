import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';

const packageDir = existsSync(join(process.cwd(), 'package.json'))
  ? process.cwd()
  : join(process.cwd(), 'packages', 'vite-plugin-geo');
const manifestPath = join(packageDir, 'package.json');

describe('vite-plugin-geo publish manifest', () => {
  const expectedPackedFiles = [
    'README.md',
    'astro.d.ts',
    'astro.js',
    'astroSitemapCompatibility.js',
    'cli.js',
    'geoAudit.js',
    'geoBuildPipeline.js',
    'geoGenerator.js',
    'geoMetadataResolver.js',
    'geoReport.js',
    'geoVerify.js',
    'index.d.ts',
    'index.js',
    'package.json',
    'viteGeoGeneratorPlugin.js',
  ];

  it('points npm entry fields at package-root runtime files and whitelists only publishable paths', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

    expect(manifest.version).toBe('0.2.0');
    expect(manifest).toMatchObject({
      name: 'vite-plugin-geo',
      main: './index.js',
      bin: './cli.js',
      exports: {
        '.': './index.js',
        './astro': {
          types: './astro.d.ts',
          import: './astro.js',
          default: './astro.js',
        },
        './package.json': './package.json',
      },
      files: [
        'README.md',
        'astro.js',
        'astro.d.ts',
        'index.js',
        'index.d.ts',
        'cli.js',
        'viteGeoGeneratorPlugin.js',
        'geoBuildPipeline.js',
        'geoAudit.js',
        'geoVerify.js',
        'geoReport.js',
        'astroSitemapCompatibility.js',
        'geoGenerator.js',
        'geoMetadataResolver.js',
      ],
      publishConfig: {
        access: 'public',
      },
      scripts: {
        'pack:dry-run': 'npm_config_cache=/tmp/slinedev-npm-cache npm pack --dry-run --json',
        'verify:consumers': 'node scripts/verify-consumer-matrix.mjs',
        'verify:registry-metadata': 'node scripts/verify-registry-metadata.mjs',
      },
    });

    expect(manifest.peerDependencies.vite).toBe('^7.0.0 || ^8.0.0');
    expect(manifest.peerDependencies.astro).toBe('^7.0.0');
    expect(manifest.peerDependenciesMeta).toEqual({
      astro: {
        optional: true,
      },
    });
    expect(manifest.engines.node).toBe('^20.19.0 || >=22.12.0');
    expect(manifest.devDependencies.ajv).toBe('8.20.0');
    expect(manifest.devDependencies['ajv-formats']).toBe('3.0.1');
    expect(manifest.devDependencies).not.toHaveProperty('yaml');
    expect(manifest.overrides).toEqual({
      'js-yaml': '4.3.2',
      nanoid: '3.3.18',
    });
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'https://github.com/maxlee/vite-plugin-geo.git',
    });
    expect(manifest.bugs).toEqual({
      url: 'https://github.com/maxlee/vite-plugin-geo/issues',
    });
    expect(manifest.homepage).toBe(
      'https://github.com/maxlee/vite-plugin-geo#readme',
    );
    expect(manifest.$schema).toBe(
      'https://raw.githubusercontent.com/vitejs/vite-plugin-registry/refs/heads/main/data/schema/extended-package-json.schema.json',
    );
    expect(manifest.compatiblePackages).toEqual({
      schemaVersion: 1,
      vite: {
        type: 'compatible',
        versions: '^7.0.0 || ^8.0.0',
      },
      rollup: {
        type: 'unknown',
      },
      rolldown: {
        type: 'unknown',
      },
    });
  });

  it('packs only publishable runtime files', () => {
    const result = spawnSync(
      'npm',
      ['pack', '--dry-run', '--json'],
      {
        cwd: packageDir,
        encoding: 'utf-8',
        env: {
          ...process.env,
          npm_config_cache: '/tmp/slinedev-npm-cache',
        },
      },
    );
    expect(result.status).toBe(0);

    const parsedOutput = JSON.parse(result.stdout);
    const packResult = Array.isArray(parsedOutput)
      ? parsedOutput[0]
      : Object.values(parsedOutput)[0];
    const packedFiles = packResult.files.map(({ path }) => path).sort();

    expect(packedFiles).toEqual(expectedPackedFiles);

    expect(packedFiles).not.toContain('DEV.md');
    expect(packedFiles).not.toContain('STANDARDS.md');
    expect(packedFiles).not.toContain('.npmignore');
    expect(packedFiles).not.toContain('scripts/build-package.mjs');
    expect(packedFiles).not.toContain('bun.lock');
    expect(packedFiles.some((path) => path.endsWith('.test.js'))).toBe(false);
    expect(packedFiles.some((path) => path.startsWith('docs/'))).toBe(false);
    expect(packedFiles.some((path) => path.startsWith('tempfiles/'))).toBe(false);
    expect(packedFiles.some((path) => path.startsWith('dist/'))).toBe(false);
  });

  it('uses README as the complete user-facing standards and release guide', () => {
    const readme = readFileSync(join(packageDir, 'README.md'), 'utf-8');
    const developmentGuide = readFileSync(join(packageDir, 'DEV.md'), 'utf-8');

    expect(readme).toMatch(/^# 🌍 vite-plugin-geo/m);
    expect(readme).toContain('## ✨ 核心特性');
    expect(readme).toContain('## 📦 安装');
    expect(readme).toContain('## 🚀 快速开始');
    expect(readme).toContain('## 📄 输出文件');
    expect(readme).toContain('## ⚙️ 配置项');
    expect(readme).toContain('<details>');
    expect(readme).toContain('## 🔧 CLI 命令');
    expect(readme).toContain('## 📝 行为契约');
    expect(readme).toContain('## 💡 常见配置');
    expect(readme).toContain('当前版本：`vite-plugin-geo@0.2.0`');
    expect(readme).toContain('审核日期：2026-08-12');
    expect(readme).toContain('llms.txt v2');
    expect(readme).toContain('社区开放提案，不是 IETF/W3C 标准');
    expect(readme).toContain('https://llmstxt.org/changes.html');
    expect(readme).toContain('https://www.rfc-editor.org/rfc/rfc9309');
    expect(readme).toContain('https://www.sitemaps.org/protocol.html');
    expect(readme).toContain('https://www.rssboard.org/rss-specification');
    expect(readme).toContain('https://humanstxt.org/Standard.html');
    expect(readme).toContain('https://sku.md/spec/1.0.0-beta/sku-md-spec.md');
    expect(readme).toContain('## 🔭 已审核但不生成');
    expect(readme).toContain('IETF AIPREF');
    expect(readme).toContain('Cloudflare Content Signals');
    expect(readme).toContain('W3C TDM Reservation Protocol');
    expect(readme).toContain('`ai.txt`');
    expect(readme).toContain('Shopify `agents.md`');
    expect(readme).toContain('WebMCP Draft Community Group Report');
    expect(readme).not.toContain('STANDARDS.md');
    expect(readme).toContain('可选 Astro peer');
    expect(developmentGuide).not.toContain('STANDARDS.md');
    expect(developmentGuide).toContain('bun run verify:registry-metadata');
    expect(developmentGuide).toContain('bun run verify:consumers');
    expect(developmentGuide).toContain('再次取得明确批准');
  });

  it('publishes only the v0.2.0 public option surface', () => {
    const declarations = readFileSync(join(packageDir, 'index.d.ts'), 'utf-8');

    expect(declarations).toContain("export type LastmodStrategy = 'none' | 'file-mtime' | 'build' | 'git'");
    expect(declarations).toContain("export type LlmsMdMirrorStyle = 'append' | 'replace'");
    expect(declarations).toContain("export type SitemapConflict = 'preserve' | 'error' | 'overwrite'");
    expect(declarations).toContain("export type RouteConflict = 'error' | 'first' | 'last'");
    expect(declarations).toContain('generateRobots?: boolean');
    expect(declarations).toContain('audit?: boolean');
    expect(declarations).toContain('auditFailOn?: AuditFailOn');
    expect(declarations).toContain('hreflangFromHtml?: boolean');
    expect(declarations).toContain('lastmodIgnore?: string[]');
    expect(declarations).toContain('verifyGeoOutput');
    expect(declarations).toContain('catalog: Array<{');
    expect(declarations).not.toMatch(/llmsFull|llmsCtx|blockGoogleExtended|stabilityWaitMs|catalogUrl|contentLanguage|market/);
  });

  it('exposes the default geo factory and compatibility named exports', () => {
    const result = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `
          const entry = await import(${JSON.stringify(pathToFileURL(join(packageDir, 'index.js')).href)});
          const defaultPlugin = typeof entry.default === 'function'
            ? entry.default({ domain: 'https://example.com' })
            : null;
          process.stdout.write(JSON.stringify({
            defaultType: typeof entry.default,
            geoMatchesDefault: entry.geo === entry.default,
            namedMatchesDefault: entry.createGeoGeneratorPlugin === entry.default,
            defaultPluginName: defaultPlugin?.name || null,
          }));
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
      },
    );

    expect(result.status).toBe(0);

    const exportsSummary = JSON.parse(result.stdout);
    expect(exportsSummary).toEqual({
      defaultType: 'function',
      geoMatchesDefault: true,
      namedMatchesDefault: true,
      defaultPluginName: 'geo-generator',
    });
  });

  it('exposes the Astro integration from its dedicated package entry', () => {
    const result = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `
          import geo, { createAstroGeoIntegration } from ${JSON.stringify(pathToFileURL(join(packageDir, 'astro.js')).href)};
          const integration = geo({ domain: 'https://example.com' });
          process.stdout.write(JSON.stringify({
            defaultType: typeof geo,
            namedMatchesDefault: createAstroGeoIntegration === geo,
            integrationName: integration?.name || null,
            hookNames: Object.keys(integration?.hooks || {}).sort(),
          }));
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      defaultType: 'function',
      namedMatchesDefault: true,
      integrationName: 'vite-plugin-geo',
      hookNames: ['astro:build:done', 'astro:config:done'],
    });
  });
});
