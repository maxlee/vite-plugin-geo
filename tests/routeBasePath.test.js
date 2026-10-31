import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { createGeoGeneratorPlugin } from '../viteGeoGeneratorPlugin.js';
import { validateGeoOptions } from '../geoBuildPipeline.js';
import { composePageUrl, normalizeRouteBasePath } from '../geoGenerator.js';
import astroGeo from '../astro.js';

const roots = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'geo-base-path-'));
  roots.push(root);
  const distDir = join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'base-fixture', domain: 'https://example.test' }));
  writeFileSync(join(distDir, 'index.html'), '<html lang="en"><head><title>Home</title></head><body></body></html>');
  return { root, distDir };
}

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('routeBasePath validation', () => {
  it('normalizes path forms and joins URLs unchanged', () => {
    expect(normalizeRouteBasePath('')).toBe('');
    expect(normalizeRouteBasePath('./')).toBe('');
    expect(normalizeRouteBasePath('/')).toBe('/');
    expect(normalizeRouteBasePath('docs')).toBe('/docs/');
    expect(normalizeRouteBasePath('/docs/?x=1#top')).toBe('/docs/');
    expect(composePageUrl('https://example.com', 'about', '/docs/')).toBe('https://example.com/docs/about');
  });

  it('rejects absolute and protocol-relative bases everywhere', async () => {
    expect(() => normalizeRouteBasePath('https://cdn.example.com/', { source: 'Vite base' }))
      .toThrow(/absolute URL/);
    expect(() => normalizeRouteBasePath('//cdn.example.com/', { source: 'Vite base' }))
      .toThrow(/absolute URL/);
    expect(() => validateGeoOptions({ routeBasePath: 'https://cdn.example.com/' }))
      .toThrow(/absolute URL/);
    expect(() => createGeoGeneratorPlugin({ routeBasePath: 'https://cdn.example.com/' }))
      .toThrow(/absolute URL/);

    const plugin = createGeoGeneratorPlugin({});
    expect(() => plugin.configResolved({ root: '/tmp/project', base: 'https://cdn.example.com/' }))
      .toThrow(/routeBasePath/);

    const explicit = createGeoGeneratorPlugin({ routeBasePath: '/docs/' });
    expect(() => explicit.configResolved({ root: '/tmp/project', base: 'https://cdn.example.com/' }))
      .not.toThrow();
  });

  it('rejects an absolute Astro base with guidance', async () => {
    const f = fixture();
    const integration = astroGeo({ domain: 'https://example.test' });
    integration.hooks['astro:config:done']({
      config: {
        root: pathToFileURL(`${f.root}/`),
        site: new URL('https://example.test'),
        base: 'https://cdn.example.com/',
      },
      buildOutput: 'static',
    });

    await expect(integration.hooks['astro:build:done']({
      dir: pathToFileURL(`${f.distDir}/`),
      logger: { info() {}, warn() {}, error() {} },
    })).rejects.toThrow(/Astro base.*absolute URL/);
  });
});
