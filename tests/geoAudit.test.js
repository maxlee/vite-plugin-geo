import { describe, it, expect } from 'vitest';
import { parse } from 'parse5';
import { collectAuditFacts, auditGeoPlan, logGeoAudit } from '../geoAudit.js';

const siteUrl = 'https://example.com';
function page(relativePath = 'index.html', html = '', extra = {}) {
  const pageUrl = relativePath === 'index.html' ? siteUrl : `${siteUrl}/${relativePath}`;
  const source = html || `<html lang="en"><head><title>${relativePath}</title><meta name="description" content="About ${relativePath}"><link rel="canonical" href="${pageUrl}"><link rel="describedby" type="text/markdown" href="/llms.txt"></head><body><h1>Hello</h1></body></html>`;
  return { relativePath, pageUrl, title: relativePath, description: `About ${relativePath}`, lang: 'en', audit: collectAuditFacts(parse(source)), ...extra };
}
function run(pages, extra = {}) { return auditGeoPlan({ allPages: pages, pages, files: [{ filename: 'llms.txt', content: '' }], options: { generateFeed: false, llmsMdMirror: false }, siteUrl, ...extra }); }
const rules = (report) => report.diagnostics.map((item) => item.rule);

describe('static GEO audit', () => {
  it('reads the existing AST, ignores inert templates, and accepts empty decorative alt', () => {
    const facts = collectAuditFacts(parse('<html lang="zh-CN"><head><title> A &amp; B </title><base href="/first/"><base href="/second/"><link rel="CANONICAL" href="/a"><script type="application/ld+json">{"@graph":[]}</script></head><body><template><h1>inert</h1><img></template><h1>A</h1><img alt=""><img><a href="x" download>file</a></body></html>'));
    expect(facts.titles).toEqual([' A & B ']);
    expect(facts.baseHref).toBe('/first/');
    expect(facts.h1Count).toBe(1);
    expect(facts.missingAlt).toBe(1);
    expect(facts.anchors).toEqual([{ href: 'x', download: true }]);
    expect(facts.canonicals).toEqual(['/a']);
  });
  it('collects only discovery links and base without visiting title or body content', () => {
    const ast = parse('<html lang="en"><head><title>A</title><base href="/base/"><link rel="describedby" type="text/markdown" href="llms.txt"></head><body><h1>A</h1></body></html>');
    const html = ast.childNodes.find((node) => node.tagName === 'html');
    const head = html.childNodes.find((node) => node.tagName === 'head');
    const body = html.childNodes.find((node) => node.tagName === 'body');
    Object.defineProperty(body, 'childNodes', { get() { throw new Error('body visited'); } });
    Object.defineProperty(head.childNodes.find((node) => node.tagName === 'title'), 'childNodes', { get() { throw new Error('title visited'); } });
    const facts = collectAuditFacts(ast, { discoveryOnly: true });
    expect(facts.baseHref).toBe('/base/');
    expect(facts.links).toHaveLength(1);
    expect(facts.titles).toEqual([]);
    expect(facts.h1Count).toBe(0);
  });
  it('checks known dotted pretty URLs before treating dotted paths as resources', () => {
    const p = page(); p.audit.anchors = [{ href: '/v1.0', download: false }, { href: '/asset.png', download: false }];
    p.audit.canonicals = ['/v1.0'];
    p.audit.links.push({ rel: 'alternate', type: 'text/html', hreflang: 'en', href: '/v1.0' });
    const target = page('v1.0.html', '', { pageUrl: `${siteUrl}/v1.0`, noindex: true });
    const result = run([p], { allPages: [p, target] });
    expect(rules(result)).toEqual(expect.arrayContaining(['anchor-noindex', 'canonical-noindex', 'hreflang-noindex']));
    expect(rules(result)).not.toContain('anchor-target-missing');
  });
  it('resolves document and final discovery links against the static file directory', () => {
    const p = page('guide/index.html', '', { pageUrl: `${siteUrl}/guide`, filePageUrl: `${siteUrl}/guide/index.html` });
    p.audit.anchors = [{ href: 'child.html', download: false }];
    const target = page('guide/child.html', '', { noindex: true });
    let result = run([p], { allPages: [p, target] });
    expect(rules(result)).toContain('anchor-noindex');
    expect(rules(result)).not.toContain('anchor-target-missing');
    p.audit.baseHref = '../';
    p.audit.anchors = [{ href: 'guide/child.html', download: false }];
    p.audit.links = [{ rel: 'describedby', type: 'text/markdown', href: 'llms.txt' }];
    result = run([p], { allPages: [p, target], discoveryByPath: new Map([[p.relativePath, p.audit]]) });
    expect(rules(result)).toContain('anchor-noindex');
    expect(rules(result)).not.toContain('discovery-llms');
  });
  it('keeps query-sensitive canonical addresses distinct', () => {
    const p = page(); p.audit.canonicals = [`${siteUrl}/?view=a`, `${siteUrl}/?view=b`];
    expect(rules(run([p]))).toContain('canonical-conflict');
  });
  it('produces no findings for complete metadata and final links', () => {
    expect(run([page()]).diagnostics).toEqual([]);
    expect(run([page()], { sitemapGenerated: true }).diagnostics).toEqual([]);
  });
  it('separates missing, empty, multiple, duplicates, language, and fallback diagnostics', () => {
    const first = page('index.html', '<html lang="en_US"><head><title> Shared  title </title><title></title><meta name="description" content="same"></head><body><h1>A</h1><h1>B</h1></body></html>', { description: '', lang: '' });
    const second = page('b.html', '<html><head><title>Shared title</title><meta name="description" content="same"></head></html>');
    const result = run([first, second], { homePage: first });
    expect(rules(result)).toEqual(expect.arrayContaining(['title-empty', 'title-multiple', 'title-duplicate', 'description-duplicate', 'lang-invalid', 'lang-missing', 'h1-missing', 'h1-multiple', 'home-description-fallback', 'home-lang-fallback']));
    expect(result.diagnostics.filter((item) => item.rule === 'title-duplicate')).toHaveLength(2);
  });
  it('accepts JSON-LD arrays and graphs, reports invalid JSON without guessing schema requirements', () => {
    const p = page(); p.audit.jsonLd = ['[]', '{"@graph":[]}', 'null', '{bad'];
    expect(rules(run([p]))).toEqual(['jsonld-invalid']);
  });
  it('reports invalid, conflicting, relative, and cross-origin canonicals', () => {
    const p = page(); p.audit.canonicals = ['', 'javascript:x', 'https://user:pass@example.com', '/a', 'https://elsewhere.test/'];
    const result = run([p]);
    expect(rules(result)).toEqual(expect.arrayContaining(['canonical-empty', 'canonical-invalid', 'canonical-relative', 'canonical-conflict', 'canonical-cross-origin']));
    expect(rules(result)).not.toContain('canonical-sitemap-mismatch');
    expect(rules(run([p], { sitemapGenerated: true }))).toContain('canonical-sitemap-mismatch');
  });
  it('resolves base, query/hash and noindex targets while excluding resources and external routes', () => {
    const p = page('folder/index.html'); p.audit.baseHref = '/folder/';
    p.audit.anchors = ['../hidden.html?q=1#x', 'missing', '#local', 'https://elsewhere.test/missing', '/image.png', 'mailto:x@y.test', '../Hidden.html'].map((href) => ({ href, download: false }));
    p.audit.anchors.push({ href: '/download-missing', download: true });
    p.audit.canonicals = ['/hidden.html'];
    p.audit.links.push({ rel: 'alternate', type: 'text/html', hreflang: 'en', href: '/hidden.html' });
    const hidden = page('hidden.html', '', { noindex: true });
    const result = run([p], { allPages: [p, hidden] });
    expect(rules(result)).toEqual(expect.arrayContaining(['anchor-noindex', 'canonical-noindex', 'hreflang-noindex']));
    expect(result.diagnostics.filter((item) => item.rule === 'anchor-target-missing')).toHaveLength(2);
  });
  it('keeps URL trailing-slash resolution and limits missing targets to route scope', () => {
    const p = page('index.html', '', { pageUrl: `${siteUrl}/docs` });
    p.audit.anchors = ['/outside', '/docs/missing', '/docs/'].map((href) => ({ href, download: false }));
    const result = run([p], { options: { routeBasePath: '/docs/', generateFeed: false, llmsMdMirror: false } });
    expect(result.diagnostics.filter((item) => item.rule === 'anchor-target-missing').map((item) => item.evidence)).toEqual(['链接 /docs/missing：构建产物中未找到，需确认线上路由']);
  });
  it('uses captured final links to check RSS, llms and generated Markdown', () => {
    const p = page('index.html', '', { markdownUrl: `${siteUrl}/index.md`, mirrorRelativePath: 'index.md' });
    const finalFacts = { ...p.audit, links: [...p.audit.links, { rel: 'alternate', type: 'application/rss+xml', href: '/feed.xml' }, { rel: 'alternate', type: 'text/markdown', href: '/index.md' }] };
    const config = { files: ['llms.txt', 'feed.xml', 'index.md'].map((filename) => ({ filename, content: '' })), options: {}, discoveryByPath: new Map([['index.html', finalFacts]]) };
    expect(run([p], config).diagnostics).toEqual([]);
    finalFacts.baseHref = 'https://elsewhere.test/';
    expect(rules(run([p], config))).toEqual(expect.arrayContaining(['discovery-llms', 'discovery-feed', 'discovery-markdown']));
  });
  it('allows external Markdown alternates and treats unmanaged local ones only as advice', () => {
    const p = page('index.html', '', { hasExistingMarkdownAlternate: true, markdownUrl: 'https://other.test/a.md' });
    p.audit.links.push({ rel: 'alternate', type: 'text/markdown', href: p.markdownUrl });
    expect(run([p]).diagnostics).toEqual([]);
    p.audit.links.at(-1).href = '/legacy.md';
    const result = run([p]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].severity).toBe('advice');
    expect(run([p], { existingFiles: [{ filename: 'legacy.md', content: '' }] }).diagnostics).toEqual([]);
  });
  it('reports configured hreflang links to known noindex pages', () => {
    const p = page(); const hidden = page('private.html', '', { noindex: true });
    expect(rules(run([p], { allPages: [p, hidden], options: { generateFeed: false, llmsMdMirror: false, hreflang: { en: '/private.html' } } }))).toContain('hreflang-noindex');
  });
  it('checks included noindex, generated file existence, and cross-origin mismatch advice', () => {
    const p = page(); p.noindex = true; p.audit.canonicals = ['https://other.test/'];
    const result = run([p], { files: [], sitemapGenerated: true });
    expect(rules(result)).toEqual(expect.arrayContaining(['noindex-included', 'discovery-llms-file-missing']));
    expect(result.diagnostics.find((item) => item.rule === 'canonical-sitemap-mismatch').severity).toBe('advice');
  });
  it('deduplicates target checks after query and fragment removal', () => {
    const p = page(); p.audit.anchors = ['/missing?a', '/missing#x'].map((href) => ({ href, download: false }));
    expect(run([p]).diagnostics).toHaveLength(1);
  });
  it('is deterministic, removes repeated evidence, and escapes terminal controls', () => {
    const p = page(); p.audit.anchors = [{ href: '/missing\u001b[31m', download: false }, { href: '/missing\u001b[31m', download: false }];
    const report = run([p]);
    expect(report.diagnostics).toHaveLength(1);
    const messages = [];
    logGeoAudit(report, { log: (v) => messages.push(v), warn: (v) => messages.push(v) });
    expect(messages).toHaveLength(2);
    expect(messages.join('')).not.toContain('\u001b');
    expect(messages[1]).toContain('\\u001b');
    expect(() => logGeoAudit(report)).not.toThrow();
    expect(() => logGeoAudit(undefined, { log: () => { throw new Error('unexpected log'); } })).not.toThrow();
    logGeoAudit(run([]), { log: (v) => messages.push(v), warn: () => {} });
    expect(messages.at(-1)).toContain('未检查');
  });
});
