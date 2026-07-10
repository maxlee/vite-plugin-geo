import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';

const packageDir = join(process.cwd(), 'packages', 'vite-plugin-geo');
const manifestPath = join(packageDir, 'package.json');

describe('vite-plugin-geo publish manifest', () => {
  const expectedPackedFiles = [
    'README.md',
    'astroSitemapCompatibility.js',
    'cli.js',
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
        './package.json': './package.json',
      },
      files: [
        'README.md',
        'index.js',
        'index.d.ts',
        'cli.js',
        'viteGeoGeneratorPlugin.js',
        'astroSitemapCompatibility.js',
        'geoGenerator.js',
        'geoMetadataResolver.js',
      ],
      publishConfig: {
        access: 'public',
      },
    });

    expect(manifest.peerDependencies.vite).toBe('^5.0.0 || ^6.0.0 || ^7.0.0 || ^8.0.0');
    expect(manifest.repository).toMatchObject({
      type: 'git',
      url: expect.stringContaining('github.com'),
    });
    expect(manifest.bugs.url).toContain('github.com');
    expect(manifest.homepage).toContain('github.com');
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
    const packedFiles = parsedOutput[0].files.map(({ path }) => path).sort();

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
});
