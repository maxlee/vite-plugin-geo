import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseCliArgs, runCli } from '../src/cli.js';

const roots = [];

function fixture({ bare = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'geo-cli-'));
  roots.push(root);
  const distDir = join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'cli-fixture', domain: 'https://example.test' }));
  if (bare) {
    writeFileSync(join(distDir, 'index.html'), '<html><head></head><body></body></html>');
  } else {
    writeFileSync(join(distDir, 'index.html'), '<html lang="en"><head><title>Home</title><meta name="description" content="Home desc"></head><body><h1>Home</h1></body></html>');
    writeFileSync(join(distDir, 'about.html'), '<html lang="en"><head><title>About</title><meta name="description" content="About desc"></head><body><h1>About</h1></body></html>');
  }
  return { root, distDir };
}

function runtime() {
  const messages = [];
  const logger = {
    log: (...args) => messages.push(args.join(' ')),
    warn: (...args) => messages.push(args.join(' ')),
    error: (...args) => messages.push(args.join(' ')),
  };
  let stdout = '';
  return {
    runtime: { logger, stdout: { write: (chunk) => { stdout += chunk; } } },
    messages,
    stdout: () => stdout,
  };
}

const baseArgs = ['--dist-dir', 'dist', '--no-generate-feed', '--no-llms-md-mirror'];

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('CLI 0.2.0 hardening', () => {
  it('honors =false for every boolean flag and rejects values on --no-* flags', () => {
    const flags = [
      ['pretty-urls', 'prettyUrls'],
      ['sitemap-index', 'sitemapIndex'],
      ['generate-sitemap', 'generateSitemap'],
      ['generate-robots', 'generateRobots'],
      ['llms-md-mirror', 'llmsMdMirror'],
      ['generate-humans', 'generateHumans'],
      ['generate-feed', 'generateFeed'],
      ['hreflang-from-html', 'hreflangFromHtml'],
      ['audit', 'audit'],
      ['debug', 'debug'],
      ['verify', 'verify'],
    ];

    for (const [flag, key] of flags) {
      expect(parseCliArgs([`--${flag}=false`]).options[key]).toBe(false);
      expect(parseCliArgs([`--${flag}=true`]).options[key]).toBe(true);
    }

    expect(() => parseCliArgs(['--no-debug=false'])).toThrow(/Use --debug=true\|false/);
    expect(() => parseCliArgs(['--pretty-urls=maybe'])).toThrow(/Invalid boolean/);
  });

  it('recognizes generate/verify and rejects unknown commands', () => {
    expect(parseCliArgs([]).command).toBe('generate');
    expect(parseCliArgs(['generate']).command).toBe('generate');
    expect(parseCliArgs(['verify']).command).toBe('verify');
    expect(() => parseCliArgs(['frobnicate'])).toThrow(/Unsupported command: frobnicate/);
    expect(() => parseCliArgs(['--report-file', 'x.json'])).toThrow(/requires --report/);
    expect(() => parseCliArgs(['--report', 'yaml'])).toThrow(/Invalid report format/);
  });

  it('keeps stdout pure JSON and exits 0 for a healthy verify', async () => {
    const f = fixture();
    const generated = runtime();
    expect(await runCli(['generate', ...baseArgs], { cwd: f.root, ...generated.runtime })).toBe(0);

    const verified = runtime();
    const code = await runCli(
      ['verify', ...baseArgs, '--report', 'json'],
      { cwd: f.root, ...verified.runtime },
    );

    expect(code).toBe(0);
    const report = JSON.parse(verified.stdout());
    expect(report.schemaVersion).toBe('1.0');
    expect(report.command).toBe('verify');
    expect(report.summary.errors).toBe(0);
    expect(report.verify.ok).toBe(true);
    expect(verified.messages.join('\n')).toContain('[GEO verify]');
  });

  it('writes SARIF and exits 1 on verify errors, unless the gate is none', async () => {
    const f = fixture();
    const generated = runtime();
    await runCli(['generate', ...baseArgs], { cwd: f.root, ...generated.runtime });
    writeFileSync(
      join(f.distDir, 'sitemap.xml'),
      '<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>https://example.test/src/pages/index.html</loc></url></urlset>',
    );

    const failing = runtime();
    const failCode = await runCli(
      ['verify', ...baseArgs, '--report', 'sarif'],
      { cwd: f.root, ...failing.runtime },
    );
    expect(failCode).toBe(1);
    const sarif = JSON.parse(failing.stdout());
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results.some((result) => result.level === 'error')).toBe(true);
    expect(failing.messages.join('\n')).toContain('GEO verify gate failed');

    const soft = runtime();
    expect(await runCli(
      ['verify', ...baseArgs, '--fail-on-verify', 'none'],
      { cwd: f.root, ...soft.runtime },
    )).toBe(0);
  });

  it('writes the report to a file when --report-file is given', async () => {
    const f = fixture();
    const generated = runtime();
    await runCli(['generate', ...baseArgs], { cwd: f.root, ...generated.runtime });

    const verified = runtime();
    const code = await runCli(
      ['verify', ...baseArgs, '--report', 'json', '--report-file', 'geo-report.json'],
      { cwd: f.root, ...verified.runtime },
    );

    expect(code).toBe(0);
    expect(verified.stdout()).toBe('');
    const report = JSON.parse(readFileSync(join(f.root, 'geo-report.json'), 'utf-8'));
    expect(report.command).toBe('verify');
  });

  it('fails before writing when the audit gate trips', async () => {
    const f = fixture({ bare: true });
    const gated = runtime();
    const code = await runCli(
      ['generate', ...baseArgs, '--fail-on-audit', 'warning'],
      { cwd: f.root, ...gated.runtime },
    );

    expect(code).toBe(1);
    expect(gated.messages.join('\n')).toContain('GEO audit gate failed');
    expect(existsSync(join(f.distDir, 'llms.txt'))).toBe(false);

    const relaxed = runtime();
    expect(await runCli(['generate', ...baseArgs], { cwd: f.root, ...relaxed.runtime })).toBe(0);
    expect(existsSync(join(f.distDir, 'llms.txt'))).toBe(true);
  });

  it('supports --no-verify and rejects duplicate commands or invalid merged --config values', async () => {
    expect(parseCliArgs(['--no-verify']).options.verify).toBe(false);
    expect(() => parseCliArgs(['--no-verify=true'])).toThrow(/Use --verify=true\|false/);
    expect(() => parseCliArgs(['verify', 'generate'])).toThrow(/Unexpected extra command/);

    const f = fixture();
    writeFileSync(join(f.root, 'bad-json.json'), '{not-json');
    const badJsonRun = runtime();
    expect(await runCli(['verify', '--config', 'bad-json.json'], { cwd: f.root, ...badJsonRun.runtime })).toBe(1);
    expect(badJsonRun.messages.join('\n')).toContain('Invalid GEO config file');

    writeFileSync(join(f.root, 'array.json'), '["dist"]');
    const arrayRun = runtime();
    expect(await runCli(['verify', '--config', 'array.json'], { cwd: f.root, ...arrayRun.runtime })).toBe(1);
    expect(arrayRun.messages.join('\n')).toContain('top-level JSON value must be an object');

    writeFileSync(join(f.root, 'bad-fields.json'), JSON.stringify({ verify: 'yes' }));
    const badFieldsRun = runtime();
    expect(await runCli(['generate', '--config', 'bad-fields.json'], { cwd: f.root, ...badFieldsRun.runtime })).toBe(1);
    expect(badFieldsRun.messages.join('\n')).toContain("Option 'verify' must be a boolean");
  });

  it('honors report, verify, routeBasePath, and failOnVerify from --config and sanitizes prototype keys', async () => {
    const f = fixture();
    writeFileSync(join(f.distDir, 'humans.txt'), '/* custom humans */\n');
    const configPath = join(f.root, 'geo.config.json');
    writeFileSync(
      configPath,
      '{"__proto__":{"geoPolluted":true},"distDir":"dist","routeBasePath":"/docs","verify":true,"report":"json","generateFeed":false,"generateHumans":true,"llmsMdMirror":false}',
    );

    const r1 = runtime();
    const code = await runCli(['generate', '--config', 'geo.config.json', '--route-base-path='], {
      cwd: f.root,
      ...r1.runtime,
    });
    expect(code).toBe(0);
    expect(({}).geoPolluted).toBeUndefined();

    const report = JSON.parse(r1.stdout());
    expect(report.routeBasePath).toBe('');
    expect(report.verify.ok).toBe(true);
    expect(report.preservedFiles).toContain('humans.txt');
    expect(report.fileCompatibility).toEqual({
      policy: 'preserve',
      decisions: [{ filename: 'humans.txt', decision: 'preserve' }],
    });
    expect(report.generatedFiles.some((item) => item.filename === 'llms.txt' && typeof item.size === 'number')).toBe(true);
    // Human logs go to logger (stderr), never stdout when report comes from --config
    expect(r1.messages.join('\n')).toContain('[GEO verify]');

    // --config providing report format allows --report-file on CLI without --report
    const r2 = runtime();
    const code2 = await runCli(
      ['verify', '--config', 'geo.config.json', '--route-base-path=', '--report-file', 'reports/verify.json'],
      {
        cwd: f.root,
        ...r2.runtime,
      },
    );
    expect(code2).toBe(0);
    expect(r2.stdout()).toBe('');
    expect(JSON.parse(readFileSync(join(f.root, 'reports/verify.json'), 'utf-8')).command).toBe('verify');

    // Without --route-base-path= override, config's routeBasePath /docs mismatches dist and fails unless failOnVerify: none
    const r3 = runtime();
    expect(await runCli(['verify', '--config', 'geo.config.json'], { cwd: f.root, ...r3.runtime })).toBe(1);
    const softConfig = join(f.root, 'geo.soft.json');
    writeFileSync(softConfig, JSON.stringify({ distDir: 'dist', routeBasePath: '/docs', failOnVerify: 'none', generateFeed: false, llmsMdMirror: false }));
    const r4 = runtime();
    expect(await runCli(['verify', '--config', 'geo.soft.json'], { cwd: f.root, ...r4.runtime })).toBe(0);
  });

  it('reports empty generatedFiles when --fail-on-audit aborts before disk writes and escapes route conflict controls', async () => {
    const f = fixture({ bare: true });
    const gated = runtime();
    const code = await runCli(
      ['generate', ...baseArgs, '--fail-on-audit', 'warning', '--report', 'json'],
      { cwd: f.root, ...gated.runtime },
    );
    expect(code).toBe(1);
    const failedReport = JSON.parse(gated.stdout());
    expect(failedReport.generatedFiles).toEqual([]);
    expect(existsSync(join(f.distDir, 'llms.txt'))).toBe(false);

    const conflictFixture = fixture();
    writeFileSync(join(conflictFixture.distDir, 'guide.html'), '<html lang="en"><head><title>G</title><meta name="description" content="G"></head><body><h1>G</h1></body></html>');
    mkdirSync(join(conflictFixture.distDir, 'guide'), { recursive: true });
    writeFileSync(join(conflictFixture.distDir, 'guide/index.html'), '<html lang="en"><head><title>G2</title><meta name="description" content="G2"></head><body><h1>G2</h1></body></html>');
    const cRun = runtime();
    const cCode = await runCli(
      ['generate', ...baseArgs, '--route-conflict', 'first'],
      { cwd: conflictFixture.root, ...cRun.runtime },
    );
    expect(cCode).toBe(0);
    expect(cRun.messages.join('\n')).toContain('Route conflict');
  });
});
