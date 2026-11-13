import { describe, expect, it } from 'vitest';
import { parse } from 'parse5';
import {
  assertAuditGate,
  auditFailures,
  auditGeoPlan,
  collectAuditFacts,
  countAuditFindings,
} from '../src/geoAudit.js';

const siteUrl = 'https://example.com';

function page(relativePath = 'index.html', extra = {}) {
  const pageUrl = relativePath === 'index.html' ? siteUrl : `${siteUrl}/${relativePath}`;
  return {
    relativePath,
    pageUrl,
    title: relativePath,
    description: `About ${relativePath}`,
    lang: 'en',
    audit: collectAuditFacts(parse(
      `<html lang="en"><head><title>${relativePath}</title><meta name="description" content="About ${relativePath}"></head><body><h1>Hello</h1></body></html>`,
    )),
    ...extra,
  };
}

function run(pages, extra = {}) {
  return auditGeoPlan({
    allPages: pages,
    pages,
    files: [{ filename: 'llms.txt', content: '' }],
    options: { generateFeed: false, llmsMdMirror: false },
    siteUrl,
    ...extra,
  });
}

const rules = (report) => report.diagnostics.map((item) => item.rule);

describe('0.2.0 audit rules', () => {
  it('flags static .html links even though aliases resolve the target', () => {
    const home = page();
    const about = page('about.html', { pagePath: 'about', filePageUrl: `${siteUrl}/about.html` });
    home.audit.anchors = [{ href: '/about.html', download: false }];

    const result = run([home, about]);

    expect(rules(result)).toContain('internal-link-html-extension');
    expect(rules(result)).not.toContain('anchor-target-missing');
  });

  it('flags mirror URLs that leak the build prefix or keep .html', () => {
    const p = page();
    p.markdownUrl = `${siteUrl}/src/pages/index.html.md`;

    const result = run([p], { options: { generateFeed: false, llmsMdMirror: true } });

    expect(rules(result)).toContain('markdown-mirror-path');
  });

  it('reports orphan inner pages but exempts home', () => {
    const home = page();
    const about = page('about.html', { pagePath: 'about', filePageUrl: `${siteUrl}/about.html` });

    const result = run([home, about]);

    expect(result.diagnostics.filter((item) => item.rule === 'orphan-page').map((item) => item.path))
      .toEqual(['about.html']);
  });

  it('checks hreflang self-reference and reciprocity only for pages that declare alternates', () => {
    const home = page();
    const zh = page('zh.html', {
      pagePath: 'zh',
      pageUrl: `${siteUrl}/zh`,
      filePageUrl: `${siteUrl}/zh.html`,
    });
    home.audit.links.push({ rel: 'alternate', hreflang: 'zh', href: `${siteUrl}/zh` });

    const result = run([home, zh]);

    expect(rules(result)).toEqual(expect.arrayContaining([
      'hreflang-self-reference',
      'hreflang-reciprocity',
    ]));
    expect(result.diagnostics.find((item) => item.rule === 'hreflang-self-reference').severity).toBe('advice');
    expect(result.diagnostics.find((item) => item.rule === 'hreflang-reciprocity').severity).toBe('warning');
    expect(result.diagnostics.some((item) => item.path === 'zh.html' && item.rule === 'hreflang-reciprocity'))
      .toBe(false);
  });

  it('gates only when a threshold is configured', () => {
    const audit = { diagnostics: [{ severity: 'advice', rule: 'a' }, { severity: 'warning', rule: 'b' }] };

    expect(countAuditFindings(audit)).toEqual({ warnings: 1, advice: 1, total: 2 });
    expect(auditFailures(audit, undefined)).toBe(false);
    expect(auditFailures(audit, 'none')).toBe(false);
    expect(auditFailures(audit, 'warning')).toBe(true);
    expect(auditFailures(audit, 'advice')).toBe(true);
    expect(() => assertAuditGate(audit, undefined)).not.toThrow();
    expect(() => assertAuditGate(audit, 'warning')).toThrow(/GEO audit gate failed \(failOn=warning\)/);

    const adviceOnly = { diagnostics: [{ severity: 'advice', rule: 'a' }] };
    expect(auditFailures(adviceOnly, 'warning')).toBe(false);
    expect(auditFailures(adviceOnly, 'advice')).toBe(true);
  });
});
