import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildGeoGenerationPlanFromDisk } from '../geoBuildPipeline.js';
import { resolveMarkdownMirrorPath } from '../geoGenerator.js';

const roots = [];

function page(title) {
  return `<html lang="en"><head><title>${title}</title><meta name="description" content="${title} desc"></head><body><h1>${title}</h1></body></html>`;
}

function fixture(pages) {
  const root = mkdtempSync(join(tmpdir(), 'geo-mirror-'));
  roots.push(root);
  const distDir = join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'mirror-fixture', domain: 'https://example.test' }));
  for (const [name, source] of Object.entries(pages)) {
    mkdirSync(join(distDir, name, '..'), { recursive: true });
    writeFileSync(join(distDir, name), source);
  }
  return { root, distDir };
}

function planFor(f, options = {}) {
  return buildGeoGenerationPlanFromDisk({
    projectRoot: f.root,
    distDir: f.distDir,
    currentDate: '2026-10-01T00:00:00.000Z',
    options,
  });
}

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('markdown mirrors use public paths', () => {
  it('derives mirror paths from the public page path', () => {
    expect(resolveMarkdownMirrorPath('', 'append')).toBe('index.md');
    expect(resolveMarkdownMirrorPath('index', 'append')).toBe('index.md');
    expect(resolveMarkdownMirrorPath('index.html', 'replace')).toBe('index.md');
    expect(resolveMarkdownMirrorPath('about', 'append')).toBe('about.md');
    expect(resolveMarkdownMirrorPath('docs/intro', 'replace')).toBe('docs/intro.md');
    expect(resolveMarkdownMirrorPath('about.html', 'append')).toBe('about.html.md');
    expect(resolveMarkdownMirrorPath('about.html', 'replace')).toBe('about.md');
  });

  it('uses one resolver for emitted files, llms.txt and injected alternates', async () => {
    const f = fixture({
      'src/pages/index.html': page('Home'),
      'src/pages/about.html': page('About'),
      'src/pages/docs/index.html': page('Docs'),
    });
    const plan = await planFor(f);
    const files = new Map(plan.files.map(({ filename, content }) => [filename, content]));

    expect([...files.keys()]).toEqual(expect.arrayContaining(['index.md', 'about.md', 'docs.md']));
    expect(files.get('llms.txt')).toContain('https://example.test/about.md');
    expect(files.get('llms.txt')).toContain('https://example.test/docs.md');
    expect(files.get('llms.txt')).not.toContain('src/pages');
    expect(files.get('llms.txt')).not.toContain('.html.md');

    const aboutUpdate = plan.htmlUpdates.find(({ filename }) => filename === 'src/pages/about.html');
    expect(aboutUpdate?.content).toContain('href="https://example.test/about.md"');
  });

  it('keeps .html mirrors only when pretty URLs are disabled', async () => {
    const f = fixture({ 'src/pages/about.html': page('About') });
    const plan = await planFor(f, { prettyUrls: false });
    const names = plan.files.map(({ filename }) => filename);

    expect(names).toContain('about.html.md');
    expect(names).not.toContain('about.md');
    const update = plan.htmlUpdates.find(({ filename }) => filename === 'src/pages/about.html');
    expect(update?.content).toContain('href="https://example.test/about.html.md"');
  });
});
