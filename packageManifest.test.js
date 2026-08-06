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
    'geoBuildPipeline.js',
    'geoGenerator.js',
    'geoMetadataResolver.js',
    'index.d.ts',
    'index.js',
    'package.json',
    'viteGeoGeneratorPlugin.js',
  ];

  it('points npm entry fields at package-root runtime files and whitelists only publishable paths', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
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
        'astroSitemapCompatibility.js',
        'geoGenerator.js',
        'geoMetadataResolver.js',
      ],
      publishConfig: {
        access: 'public',
      },
    });

    expect(manifest.peerDependencies.vite).toBe('^7.0.0 || ^8.0.0');
    expect(manifest.engines.node).toBe('^20.19.0 || >=22.12.0');
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/maxlee/vite-plugin-geo.git',
    });
    expect(String(manifest.bugs.url).includes('maxlee/vite-plugin-geo')).toBe(true);
    expect(String(manifest.homepage).includes('maxlee/vite-plugin-geo')).toBe(true);
    expect(manifest.vitesh).toMatchObject({
      schemaVersion: 1,
      recipeVersion: 1,
      compatibility: {
        node: '^20.19.0 || >=22.12.0',
        vite: '>=8.0.0 <9.0.0',
        astro: '>=7.0.0 <8.0.0',
      },
      integrations: {
        vite: {
          integrationId: 'vite-plugin-geo:vite',
          import: { kind: 'named', source: 'vite-plugin-geo', name: 'geo', local: 'geo' },
          target: 'plugins',
          call: {
            factory: 'geo',
            arguments: [
              {
                type: 'object',
                properties: { domain: { type: 'parameter', name: 'domain' } },
              },
            ],
          },
        },
        astro: {
          integrationId: 'vite-plugin-geo:astro',
          import: { kind: 'default', source: 'vite-plugin-geo/astro', local: 'geo' },
          target: 'integrations',
          ordering: { after: ['@astrojs/sitemap:astro'] },
        },
      },
      parameters: {
        domain: {
          type: 'url',
          required: true,
          persist: true,
          sources: ['astro-site', 'package-domain', 'interactive', 'set'],
        },
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
    expect(packedFiles).not.toContain('.npmignore');
    expect(packedFiles).not.toContain('scripts/build-package.mjs');
    expect(packedFiles).not.toContain('bun.lock');
    expect(packedFiles.some((path) => path.endsWith('.test.js'))).toBe(false);
    expect(packedFiles.some((path) => path.startsWith('docs/'))).toBe(false);
    expect(packedFiles.some((path) => path.startsWith('tempfiles/'))).toBe(false);
    expect(packedFiles.some((path) => path.startsWith('dist/'))).toBe(false);
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
