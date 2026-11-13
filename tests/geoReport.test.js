import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createJsonReport, createSarifReport, writeReport } from '../src/geoReport.js';

const roots = [];

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('GEO report serialization', () => {
  it('builds schema 1.0 JSON reports with compatibility metadata and sanitized strings', () => {
    const report = createJsonReport({
      command: 'generate',
      version: '0.2.0',
      siteUrl: 'https://example.test',
      routeBasePath: '/docs',
      distDir: 'dist',
      generatedAt: '2026-10-01T00:00:00.000Z',
      generatedFiles: ['llms.txt', { filename: 'sitemap\u001b[31m.xml', size: 128 }],
      preservedFiles: ['robots\u0007.txt'],
      fileCompatibility: {
        policy: 'preserve',
        decisions: [{ filename: 'robots.txt', decision: 'preserve' }],
      },
      audit: {
        checkedPages: 2,
        diagnostics: [
          {
            path: 'index\u001b[31m.html',
            rule: 'missing-title',
            severity: 'warning',
            evidence: 'bad\u001b[0m',
            suggestion: 'add title\u0007',
          },
          {
            path: 'about.html',
            rule: 'orphan-page',
            severity: 'advice',
            evidence: 'no links',
            suggestion: 'link it',
          },
        ],
      },
      verify: {
        ok: false,
        errors: [{ path: 'sitemap.xml', rule: 'sitemap-empty', evidence: 'empty', suggestion: 'fix' }],
        warnings: [{ path: 'robots.txt', rule: 'robots-sitemap-mismatch', evidence: 'mismatch', suggestion: 'align' }],
        checks: { checkedPages: 2 },
        summary: { siteUrl: 'https://example.test' },
      },
    });

    expect(report.schemaVersion).toBe('1.0');
    expect(report.generatedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(report.summary).toEqual({ errors: 1, warnings: 2, advice: 1 });
    expect(report.generatedFiles).toEqual([
      { filename: 'llms.txt' },
      { filename: 'sitemap[31m.xml', size: 128 },
    ]);
    expect(report.preservedFiles).toEqual(['robots.txt']);
    expect(report.fileCompatibility).toEqual({
      policy: 'preserve',
      decisions: [{ filename: 'robots.txt', decision: 'preserve' }],
    });
    expect(report.audit.diagnostics[0]).toMatchObject({
      path: 'index[31m.html',
      evidence: 'bad[0m',
      suggestion: 'add title',
    });

    const empty = createJsonReport();
    expect(empty.schemaVersion).toBe('1.0');
    expect(empty.verify).toBeNull();
    expect(empty.audit).toBeNull();
    expect(empty.preservedFiles).toEqual([]);
    expect(empty.fileCompatibility).toBeNull();
  });

  it('builds SARIF 2.1.0 with %SRCROOT% for in-tree files and omits it for external or file URIs', () => {
    const root = mkdtempSync(join(tmpdir(), 'geo-report-'));
    roots.push(root);
    const externalDist = mkdtempSync(join(tmpdir(), 'geo-report-ext-'));
    roots.push(externalDist);

    const inTreeSarif = createSarifReport({
      version: '0.2.0',
      projectRoot: root,
      distDir: join(root, 'dist dir'),
      audit: {
        checkedPages: 2,
        diagnostics: [
          {
            path: 'docs/a#1?v=2.html',
            rule: 'zeta-rule',
            severity: 'advice',
            evidence: 'adv\u001b[31m',
            suggestion: 'fix',
          },
          {
            path: 'file:///external/file.html',
            rule: 'alpha-rule',
            severity: 'warning',
            evidence: 'warn',
            suggestion: 'check',
          },
        ],
      },
      verify: {
        ok: false,
        errors: [{ path: 'sitemap.xml', rule: 'beta-rule', evidence: 'err', suggestion: 'repair' }],
        warnings: [{ path: 'robots.txt', rule: 'robots-warn', evidence: 'warn', suggestion: 'align' }],
      },
    });

    expect(inTreeSarif.$schema).toBe('https://json.schemastore.org/sarif-2.1.0.json');
    expect(inTreeSarif.version).toBe('2.1.0');
    const run = inTreeSarif.runs[0];
    expect(run.tool.driver.rules.map((r) => r.id)).toEqual([
      'alpha-rule',
      'beta-rule',
      'robots-warn',
      'zeta-rule',
    ]);
    expect(run.originalUriBaseIds['%SRCROOT%'].uri).toMatch(/^file:\/\/\//);

    const encodedLocation = run.results[0].locations[0].physicalLocation.artifactLocation;
    expect(encodedLocation).toEqual({
      uri: 'dist%20dir/docs/a%231%3Fv%3D2.html',
      uriBaseId: '%SRCROOT%',
    });
    expect(run.results[0].level).toBe('note');
    expect(run.results[0].message.text).not.toContain('\u001b');

    const fileUriLocation = run.results[1].locations[0].physicalLocation.artifactLocation;
    expect(fileUriLocation).toEqual({ uri: 'file:///external/file.html' });
    expect(fileUriLocation.uriBaseId).toBeUndefined();

    const outsideSarif = createSarifReport({
      projectRoot: root,
      distDir: resolve(externalDist),
      audit: {
        checkedPages: 1,
        diagnostics: [{ path: 'index.html', rule: 'ext-rule', severity: 'warning', evidence: 'e', suggestion: 's' }],
      },
    });
    const outsideLocation = outsideSarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation;
    expect(outsideLocation.uri).toMatch(/^file:\/\/\//);
    expect(outsideLocation.uriBaseId).toBeUndefined();
  });

  it('writes reports to stdout or nested output directories and rejects invalid formats', () => {
    const root = mkdtempSync(join(tmpdir(), 'geo-report-write-'));
    roots.push(root);
    const report = createJsonReport({ command: 'verify' });

    let stdoutBuffer = '';
    const stdoutResult = writeReport({
      format: 'json',
      report,
      stdout: { write: (chunk) => { stdoutBuffer += chunk; } },
    });
    expect(stdoutResult).toEqual({ written: true, target: 'stdout' });
    expect(JSON.parse(stdoutBuffer).command).toBe('verify');

    const nestedPath = join(root, 'reports', 'ci', 'geo.sarif');
    const fileResult = writeReport({
      format: 'sarif',
      filePath: nestedPath,
      report,
    });
    expect(fileResult).toEqual({ written: true, target: 'file', filePath: nestedPath });
    expect(existsSync(nestedPath)).toBe(true);
    expect(JSON.parse(readFileSync(nestedPath, 'utf-8')).command).toBe('verify');

    expect(() => writeReport({ format: 'xml', report })).toThrow(/Unsupported report format/);
  });
});
