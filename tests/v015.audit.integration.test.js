import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildGeoGenerationPlanFromDisk, applyGeoGenerationPlanToDisk } from '../src/geoBuildPipeline.js';
import { parseCliArgs, runCli, runSeoCliGenerate } from '../src/cli.js';
import { createGeoGeneratorPlugin } from '../src/viteGeoGeneratorPlugin.js';
import astroGeo from '../src/astro.js';

const roots = [];
function fixture(pages = { 'index.html': '<html><head><title> </title></head><body><img src="x.png"><a href="/absent">Next</a></body></html>' }) {
  const root = mkdtempSync(join(tmpdir(), 'geo-v015-'));
  roots.push(root);
  const distDir = join(root, 'dist');
  mkdirSync(distDir);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ domain: 'https://example.test' }));
  for (const [name, source] of Object.entries(pages)) {
    mkdirSync(join(distDir, name, '..'), { recursive: true });
    writeFileSync(join(distDir, name), source);
  }
  return { root, distDir, pages };
}
const date = '2026-10-14T00:00:00.000Z';
function fromDisk(f, options = {}) {
  return buildGeoGenerationPlanFromDisk({ projectRoot: f.root, distDir: f.distDir, currentDate: date, options });
}
function logger() {
  const messages = [];
  return { messages, log: (m) => messages.push(String(m)), warn: (m) => messages.push(String(m)), error: (m) => messages.push(String(m)) };
}
async function captureConsole(action) {
  const out = logger();
  const original = { log: console.log, warn: console.warn };
  console.log = out.log;
  console.warn = out.warn;
  try { await action(); } finally { Object.assign(console, original); }
  return out.messages;
}
function snapshot(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => {
    const path = join(entry.parentPath || entry.path, entry.name);
    return [path.slice(dir.length + 1), readFileSync(path, 'utf8')];
  }).sort(([a], [b]) => a.localeCompare(b));
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('v0.1.5 audit integration', () => {

  it('captures JSON-LD in the body before Markdown conversion strips scripts', async () => {
    const f = fixture({ 'index.html': '<html><head><title>Home</title></head><body><script type="application/ld+json">{broken}</script></body></html>' });
    const plan = await fromDisk(f);
    expect(plan.report.audit.diagnostics.some((d) => d.rule === 'jsonld-invalid')).toBe(true);
  });

  it('reuses stripped paths for local file and directory URL aliases', async () => {
    const f = fixture({
      'src/pages/index.html': '<html><head><title>Home</title></head><body><a href="/docs/about.html">About</a><a href="/docs/sub/">Sub</a></body></html>',
      'src/pages/about.html': '<html><head><title>About</title></head><body></body></html>',
      'src/pages/sub/index.html': '<html><head><title>Sub</title></head><body></body></html>',
    });
    const plan = await fromDisk(f, { routeBasePath: '/docs/' });
    expect(plan.report.audit.diagnostics.filter((d) => d.rule === 'anchor-target-missing')).toEqual([]);
  });

  it('does not mistake a present unmanaged Markdown file for an unknown target', async () => {
    const f = fixture({ 'index.html': '<html><head><title>Home</title><link rel="alternate" type="text/markdown" href="/manual.md"></head><body></body></html>' });
    writeFileSync(join(f.distDir, 'manual.md'), '# Maintained separately');
    const plan = await fromDisk(f);
    expect(plan.report.audit.diagnostics.filter((d) => d.rule === 'markdown-target-unverified')).toEqual([]);
  });

  it('lets explicit CLI settings override audit in a JSON config', async () => {
    const f = fixture();
    const config = join(f.root, 'geo.json');
    writeFileSync(config, JSON.stringify({ audit: true, distDir: f.distDir }));
    const out = logger();
    expect(await runCli(['--config', config, '--audit=false'], { cwd: f.root, logger: out })).toBe(0);
    expect(out.messages.some((m) => m.includes('[GEO audit]'))).toBe(false);
  });


  it('uses the static document directory for relative links and recognizes dotted page names', async () => {
    const f = fixture({
      'guide/index.html': '<html><head><title>Guide</title></head><body><a href="child.html">Child</a><a href="../v1.0">Version</a></body></html>',
      'guide/child.html': '<html><head><title>Child</title></head><body></body></html>',
      'v1.0.html': '<html><head><meta name="robots" content="noindex"></head><body></body></html>',
    });
    const report = (await fromDisk(f)).report.audit;
    expect(report.diagnostics.filter((d) => d.rule === 'anchor-target-missing')).toEqual([]);
    expect(report.diagnostics.some((d) => d.rule === 'anchor-noindex')).toBe(true);
  });

  it('reports missing discoveries in a headless document without changing output', async () => {
    const f = fixture({ 'index.html': '<title>Implicit head</title><h1>Body</h1>' });
    const on = await fromDisk(f), off = await fromDisk(f, { audit: false });
    expect(on.files).toEqual(off.files); expect(on.htmlUpdates).toEqual(off.htmlUpdates);
    expect(on.report.audit.diagnostics.map((d) => d.rule)).toEqual(expect.arrayContaining(['discovery-llms', 'discovery-feed', 'discovery-markdown']));
  });


  it('does not count discovery markup inserted into comment or script text as real links', async () => {
    for (const literal of ['<!-- literal </head> in comment -->', '<script>const text = "</head>";</script>']) {
      const f = fixture({ 'index.html': `<html><head><title>Home</title>${literal}</head><body><h1>Home</h1></body></html>` });
      const on = await fromDisk(f, { generateFeed: false }), off = await fromDisk(f, { generateFeed: false, audit: false });
      expect(on.files).toEqual(off.files); expect(on.htmlUpdates).toEqual(off.htmlUpdates);
      expect(on.report.audit.diagnostics.map((d) => d.rule)).toEqual(expect.arrayContaining(['discovery-llms', 'discovery-markdown']));
    }
  });


  it('recognizes real discovery links when the head opening tag is implicit', async () => {
    const f = fixture({ 'index.html': '<html lang="en"><title>Home</title><meta name="description" content="Home"></head><body><h1>Home</h1></body></html>' });
    const on = await fromDisk(f), off = await fromDisk(f, { audit: false });
    expect(on.files).toEqual(off.files); expect(on.htmlUpdates).toEqual(off.htmlUpdates);
    expect(on.report.audit.diagnostics.filter((d) => d.rule.startsWith('discovery-'))).toEqual([]);
  });

  it('accepts exact CLI boolean values and rejects ambiguous values', () => {
    for (const [args, expected] of [[['--audit'], true], [['--no-audit'], false], [['--audit=true'], true], [['--audit=false'], false], [['--no-audit', '--audit'], true]]) {
      expect(parseCliArgs(args).options.audit).toBe(expected);
    }
    for (const arg of ['--audit=maybe', '--audit=', '--no-audit=true']) expect(() => parseCliArgs([arg])).toThrow();
    expect(() => createGeoGeneratorPlugin({ audit: 'true' })).toThrow('audit');
  });

  it('collects diagnostics without changing generated bytes or HTML updates', async () => {
    const f = fixture();
    const on = await fromDisk(f);
    const off = await fromDisk(f, { audit: false });
    expect(on.report.audit.checkedPages).toBe(1);
    expect(on.report.audit.diagnostics.length).toBeGreaterThan(0);
    expect(off.report.audit).toBeUndefined();
    expect(on.files).toEqual(off.files);
    expect(on.htmlUpdates).toEqual(off.htmlUpdates);
  });

  it('distinguishes empty and fully excluded builds from successful inspection', async () => {
    for (const pages of [{}, { 'index.html': '<html><head><meta name="robots" content="noindex"></head></html>' }]) {
      const f = fixture(pages);
      const plan = await fromDisk(f);
      expect(plan.report.audit).toEqual({ checkedPages: 0, diagnostics: [] });
      const out = logger();
      expect(await runCli(['--dist-dir', f.distDir, '--domain', 'https://example.test'], { cwd: f.root, logger: out })).toBe(0);
      expect(out.messages.join('\n')).toMatch(/未检查|未执行|没有可检查/);
    }
  });

  it('diagnostic findings do not make CLI fail, and disabling leaves no audit logs', async () => {
    const f = fixture();
    const out = logger();
    expect(await runCli(['--audit', '--dist-dir', f.distDir], { cwd: f.root, logger: out })).toBe(0);
    expect(out.messages.join('\n')).toContain('index.html');
    const silent = logger();
    expect(await runCli(['--no-audit', '--dist-dir', f.distDir], { cwd: f.root, logger: silent })).toBe(0);
    expect(silent.messages.some((m) => /GEO audit/.test(m))).toBe(false);
  });

  it('uses the same diagnostics through Vite, CLI and Astro entry points', async () => {
    const f = fixture();
    const options = { domain: 'https://example.test', prettyUrls: true };
    const plugin = createGeoGeneratorPlugin(options);
    plugin.configResolved({ root: f.root, base: '/', build: { outDir: f.distDir } });
    const bundle = Object.fromEntries(Object.entries(f.pages).map(([fileName, source]) => [fileName, { type: 'asset', fileName, source }]));
    const viteLogs = await captureConsole(() => plugin.generateBundle.handler.call({ emitFile() {} }, { dir: f.distDir }, bundle));
    const cliLogs = logger();
    await runSeoCliGenerate({ ...options, distDir: f.distDir }, { cwd: f.root, logger: cliLogs });
    // Reset the original HTML so all three adapters see the same input.
    rmSync(f.distDir, { recursive: true }); mkdirSync(f.distDir);
    for (const [name, source] of Object.entries(f.pages)) writeFileSync(join(f.distDir, name), source);
    const integration = astroGeo(options);
    const astroLogs = logger();
    const astroLogger = { info: astroLogs.log, warn: astroLogs.warn, error: astroLogs.error };
    integration.hooks['astro:config:done']({ config: { root: pathToFileURL(`${f.root}/`), site: new URL(options.domain), base: '/' }, buildOutput: 'static' });
    await integration.hooks['astro:build:done']({ dir: pathToFileURL(`${f.distDir}/`), logger: astroLogger });
    const auditLines = (lines) => lines.filter((line) => line.includes('[GEO audit]'));
    expect(auditLines(viteLogs).length).toBeGreaterThan(1);
    expect(auditLines(viteLogs)).toEqual(auditLines(cliLogs.messages));
    expect(auditLines(viteLogs)).toEqual(auditLines(astroLogs.messages));
  });

  it('repeated generation is byte-stable and does not accumulate diagnostics', async () => {
    const f = fixture();
    const first = await fromDisk(f);
    applyGeoGenerationPlanToDisk(first, { distDir: f.distDir });
    const before = snapshot(f.distDir);
    const second = await fromDisk(f);
    applyGeoGenerationPlanToDisk(second, { distDir: f.distDir });
    expect(snapshot(f.distDir)).toEqual(before);
    expect(second.report.audit.diagnostics).toEqual(first.report.audit.diagnostics);
  });

  it('preserves core outputs across audit options under subpaths and alternate settings', async () => {
    const f = fixture({
      'index.html': '<html lang="en"><head><title>Home</title><meta name="description" content="Home"><link rel="alternate" type="text/markdown" href="https://docs.other.test/home.md"></head><body><h1>Home</h1></body></html>',
      'other.html': '<html lang="en"><head><title>Other</title><meta name="description" content="Other"></head><body><h1>Other</h1></body></html>',
    });
    for (const options of [
      { routeBasePath: '/docs/', llmsMdMirrorStyle: 'replace' },
      { llmsMdMirror: false, generateFeed: false, prettyUrls: false },
      { sitemapMaxBytes: 350 },
      { hreflang: { en: '/{path}', 'x-default': 'https://external.test/{path}' } },
    ]) {
      const on = await fromDisk(f, options), off = await fromDisk(f, { ...options, audit: false });
      expect(on.files).toEqual(off.files); expect(on.htmlUpdates).toEqual(off.htmlUpdates);
    }
    writeFileSync(join(f.distDir, 'third-party.xml'), '<sitemapindex></sitemapindex>');
    const thirdParty = await fromDisk(f);
    expect(thirdParty.report.sitemapCompatibility.detected).toBe(true);
    expect(thirdParty.files.some((f) => f.filename === 'sitemap.xml')).toBe(false);
  });
});
