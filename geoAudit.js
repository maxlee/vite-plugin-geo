/** Read-only diagnostics for the current static build; no network or HTML reparsing. */
export function collectAuditFacts(documentAst, { discoveryOnly = false } = {}) {
  const facts = { titles: [], descriptions: [], lang: '', h1Count: 0, canonicals: [], baseHref: null, jsonLd: [], missingAlt: 0, anchors: [], links: [] };
  const text = (node) => node.nodeName === '#text' ? node.value : (node.childNodes || []).map(text).join('');
  function walk(node, inHead = false) {
    const tag = node.tagName;
    if (discoveryOnly && tag && !['html', 'head', 'base', 'link'].includes(tag)) return;
    const attrs = Object.fromEntries((node.attrs || []).map(({ name, value }) => [name, value]));
    const head = inHead || tag === 'head';
    if (!discoveryOnly && tag === 'html') facts.lang = attrs.lang || '';
    if (head && tag === 'title') facts.titles.push(text(node));
    if (head && tag === 'meta' && attrs.name?.toLowerCase() === 'description') facts.descriptions.push(attrs.content || '');
    if (head && tag === 'base' && facts.baseHref === null && 'href' in attrs) facts.baseHref = attrs.href;
    if (head && tag === 'link') {
      const link = { rel: attrs.rel || '', type: attrs.type || '', href: attrs.href || '', hreflang: attrs.hreflang || '' };
      facts.links.push(link);
      if (!discoveryOnly && tokens(link.rel).includes('canonical')) facts.canonicals.push(link.href);
    }
    if (tag === 'h1') facts.h1Count++;
    if (tag === 'img' && !('alt' in attrs)) facts.missingAlt++;
    if (tag === 'a' && 'href' in attrs) facts.anchors.push({ href: attrs.href, download: 'download' in attrs });
    if (tag === 'script' && attrs.type?.trim().toLowerCase() === 'application/ld+json') facts.jsonLd.push(text(node));
    for (const child of node.childNodes || []) walk(child, head);
  }
  walk(documentAst);
  return facts;
}

const tokens = (value) => String(value || '').toLowerCase().split(/\s+/).filter(Boolean);
const normalize = (value) => String(value || '').trim().replace(/\s+/g, ' ');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function httpUrl(value, base) {
  try {
    const url = new URL(value, base);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}
function key(url) { return `${url.origin}${url.pathname}`; }
function documentBase(facts, pageUrl) {
  try { return new URL(facts.baseHref ?? pageUrl, pageUrl).href; } catch { return pageUrl; }
}
function publicUrl(siteUrl, path, routeBasePath = '') {
  const route = routeBasePath === './' ? '' : routeBasePath.replace(/^\/+|\/+$/g, '');
  return new URL([route, path.replace(/^\/+/, '')].filter(Boolean).join('/'), `${siteUrl.replace(/\/+$/, '')}/`);
}
function validLang(value) {
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value)) return false;
  try { return Intl.getCanonicalLocales(value).length === 1; } catch { return false; }
}

export function auditGeoPlan({ allPages = [], pages = [], homePage, files = [], existingFiles = [], options = {}, siteUrl, sitemapGenerated = false, discoveryByPath = new Map() }) {
  const diagnostics = [];
  const add = (page, rule, severity, evidence, suggestion) => diagnostics.push({ path: page.relativePath, rule, severity, evidence, suggestion });
  const routeRoot = publicUrl(siteUrl, '', options.routeBasePath || '');
  const targets = new Map();
  for (const page of allPages) {
    const fileUrl = page.filePageUrl || publicUrl(siteUrl, page.relativePath, options.routeBasePath || '').href;
    const aliases = [page.pageUrl, fileUrl];
    if (/(^|\/)index\.html?$/i.test(page.relativePath)) {
      const directory = /index\.html?$/i.test(fileUrl) ? fileUrl.replace(/index\.html?$/i, '') : `${fileUrl.replace(/\/$/, '')}/`;
      aliases.push(directory, directory.replace(/\/$/, ''), `${directory}index.html`);
    }
    for (const alias of aliases) { const url = httpUrl(alias); if (url) targets.set(key(url), page); }
  }
  const plannedFiles = new Set([...files, ...existingFiles].map(({ filename }) => key(publicUrl(siteUrl, filename, options.routeBasePath || ''))));
  const inScope = (url) => url.origin === routeRoot.origin && (url.pathname === routeRoot.pathname.replace(/\/$/, '') || url.pathname.startsWith(routeRoot.pathname.endsWith('/') ? routeRoot.pathname : `${routeRoot.pathname}/`));
  const inspectedTargets = new Set();
  function checkTarget(page, href, base, source, missing = false) {
    if (!normalize(href) || String(href).trim().startsWith('#')) return;
    const url = httpUrl(href, base);
    if (!url || !inScope(url)) return;
    const extension = url.pathname.split('/').pop().match(/\.[^.]+$/)?.[0];
    const target = targets.get(key(url));
    if (!target && extension && !/^\.html?$/i.test(extension)) return;
    const inspectionKey = `${page.relativePath}\0${source}\0${key(url)}`;
    if (inspectedTargets.has(inspectionKey)) return;
    inspectedTargets.add(inspectionKey);
    if (target?.noindex) add(page, `${source}-noindex`, 'warning', `${source} 指向已知 noindex 页面：${href}`, '确认目标是否应被索引，或修改链接。');
    else if (!target && missing) add(page, 'anchor-target-missing', 'advice', `链接 ${href}：构建产物中未找到，需确认线上路由`, '确认服务器路由或补齐对应页面。');
  }
  const titleGroups = new Map();
  const descriptionGroups = new Map();
  for (const page of pages) {
    const facts = page.audit || {};
    if (page.noindex) add(page, 'noindex-included', 'warning', '已知 noindex 页面被纳入生成集合', '确认索引配置与页面筛选结果一致。');
    const base = documentBase(facts, page.filePageUrl || page.pageUrl);
    const titles = facts.titles || [];
    const descriptions = facts.descriptions || [];
    for (const [name, values, severity, groups] of [['title', titles, 'warning', titleGroups], ['description', descriptions, 'advice', descriptionGroups]]) {
      if (!values.length) add(page, `${name}-missing`, severity, `缺少 ${name}`, `为页面填写 ${name}。`);
      else if (values.some((value) => !normalize(value))) add(page, `${name}-empty`, severity, `${name} 为空`, `填写非空 ${name}。`);
      if (values.length > 1) add(page, `${name}-multiple`, severity, `发现 ${values.length} 个 ${name}`, `保留一个明确的 ${name}。`);
      for (const value of new Set(values.map(normalize).filter(Boolean))) {
        if (!groups.has(value)) groups.set(value, []);
        groups.get(value).push(page);
      }
    }
    if (!normalize(facts.lang)) add(page, 'lang-missing', 'warning', '缺少 html lang', '填写页面实际使用的语言标签。');
    else if (!validLang(facts.lang)) add(page, 'lang-invalid', 'warning', `无法识别的语言标签：${facts.lang}`, '使用有效的 BCP 47 语言标签。');
    if (!facts.h1Count) add(page, 'h1-missing', 'advice', '缺少 H1', '为主要内容提供明确的一级标题。');
    else if (facts.h1Count > 1) add(page, 'h1-multiple', 'advice', `发现 ${facts.h1Count} 个 H1`, '确认页面的标题层级。');
    if (facts.missingAlt) add(page, 'image-alt-missing', 'advice', `${facts.missingAlt} 张图片缺少 alt 属性`, '提供图片说明；装饰图片可使用空 alt。');
    for (const [index, source] of (facts.jsonLd || []).entries()) {
      try { JSON.parse(source); } catch { add(page, 'jsonld-invalid', 'warning', `第 ${index + 1} 个 JSON-LD 无法解析`, '修正 JSON 语法。'); }
    }
    const canonicals = facts.canonicals || [];
    if (!canonicals.length) add(page, 'canonical-missing', 'advice', '缺少 canonical', '确认是否需要声明首选页面地址。');
    const canonicalUrls = new Set();
    for (const href of canonicals) {
      if (!normalize(href)) { add(page, 'canonical-empty', 'warning', 'canonical 地址为空', '填写首选页面的绝对地址。'); continue; }
      const url = httpUrl(href, base);
      if (!url) { add(page, 'canonical-invalid', 'warning', `无效 canonical：${href}`, '使用不含账户信息的 HTTP 或 HTTPS 地址。'); continue; }
      canonicalUrls.add(url.href);
      if (!/^https?:\/\//i.test(href)) add(page, 'canonical-relative', 'advice', `canonical 使用相对地址：${href}`, '考虑使用绝对地址以避免基准地址歧义。');
      if (url.origin !== new URL(page.pageUrl).origin) add(page, 'canonical-cross-origin', 'advice', `canonical 指向其他来源：${href}`, '确认跨站首选地址符合预期。');
      if (sitemapGenerated && url.href !== new URL(page.pageUrl).href) add(page, 'canonical-sitemap-mismatch', url.origin === new URL(page.pageUrl).origin ? 'warning' : 'advice', `canonical ${url.href} 与本次 sitemap 页面地址 ${page.pageUrl} 不一致`, '统一首选地址与 sitemap 中的地址。');
      checkTarget(page, href, base, 'canonical');
    }
    if (canonicalUrls.size > 1) add(page, 'canonical-conflict', 'warning', `存在不同 canonical：${[...canonicalUrls].sort(compare).join('、')}`, '仅保留一个首选地址。');
    for (const anchor of facts.anchors || []) if (!anchor.download) checkTarget(page, anchor.href, base, 'anchor', true);
    for (const link of facts.links || []) if (link.hreflang && tokens(link.rel).includes('alternate')) checkTarget(page, link.href, base, 'hreflang');
    for (const pattern of Object.values(options.hreflang || {})) {
      if (typeof pattern !== 'string') continue;
      const href = pattern.replace('{path}', page.pagePath ?? '');
      const resolved = /^https?:\/\//.test(href) ? href : `${siteUrl.replace(/\/$/, '')}/${href.replace(/^\//, '')}`;
      checkTarget(page, resolved, page.pageUrl, 'hreflang');
    }
    const finalFacts = (discoveryByPath instanceof Map ? discoveryByPath.get(page.relativePath) : discoveryByPath[page.relativePath]) || facts;
    const finalBase = documentBase(finalFacts, page.filePageUrl || page.pageUrl);
    const links = finalFacts.links || [];
    const discovery = (rule, expected, predicate) => {
      if (!plannedFiles.has(key(new URL(expected)))) add(page, `${rule}-file-missing`, 'warning', `发现入口对应的文件不在构建产物中：${expected}`, '确认生成文件已纳入本次输出。');
      const candidates = links.filter(predicate);
      if (!candidates.some((link) => httpUrl(link.href, finalBase)?.href === expected)) add(page, rule, 'warning', candidates.length ? `发现入口未指向预期地址 ${expected}：${candidates.map((link) => link.href).join('、')}` : `缺少发现入口：${expected}`, '确认最终 HTML 中的入口及 base 地址。');
    };
    discovery('discovery-llms', publicUrl(siteUrl, 'llms.txt', options.routeBasePath || '').href, (link) => tokens(link.rel).includes('describedby') && link.type.toLowerCase() === 'text/markdown');
    if (options.generateFeed !== false) discovery('discovery-feed', publicUrl(siteUrl, 'feed.xml', options.routeBasePath || '').href, (link) => tokens(link.rel).includes('alternate') && /application\/(rss|atom)\+xml/i.test(link.type));
    if (options.llmsMdMirror !== false && page.markdownUrl && !page.hasExistingMarkdownAlternate) discovery('discovery-markdown', page.markdownUrl, (link) => tokens(link.rel).includes('alternate') && link.type.toLowerCase() === 'text/markdown');
    if (page.hasExistingMarkdownAlternate) for (const link of links.filter((link) => tokens(link.rel).includes('alternate') && link.type.toLowerCase() === 'text/markdown')) {
      const url = httpUrl(link.href, finalBase);
      if (url && url.origin === routeRoot.origin && !plannedFiles.has(key(url))) add(page, 'markdown-target-unverified', 'advice', `已有 Markdown 入口 ${link.href} 不在本次生成文件中`, '确认既有文件或线上路由可用。');
    }
    if (homePage && (homePage === page || homePage.relativePath === page.relativePath)) for (const field of ['title', 'description', 'lang']) {
      if (!page[field]) add(page, `home-${field}-fallback`, 'advice', `首页 ${field} 为空，站点信息使用默认值`, `填写首页 ${field}，避免默认站点信息。`);
    }
  }
  for (const [rule, groups, severity] of [['title-duplicate', titleGroups, 'warning'], ['description-duplicate', descriptionGroups, 'advice']]) for (const [value, group] of groups) if (group.length > 1) for (const page of group) add(page, rule, severity, `内容重复「${value}」：${group.map((entry) => entry.relativePath).sort(compare).join('、')}`, '为不同页面提供能区分内容的说明。');
  const unique = [...new Map(diagnostics.map((item) => [JSON.stringify(item), item])).values()];
  unique.sort((a, b) => compare(a.path, b.path) || compare(a.rule, b.rule) || compare(a.evidence, b.evidence));
  return { checkedPages: pages.length, diagnostics: unique };
}

function safeText(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
export function logGeoAudit(report, logger) {
  if (!report || !logger) return;
  const warnings = report.diagnostics.filter((item) => item.severity === 'warning').length;
  logger.log(`[GEO audit] ${report.checkedPages ? `已检查 ${report.checkedPages} 个页面` : '未检查：没有纳入的页面'}；${warnings} 项警告，${report.diagnostics.length - warnings} 项建议。仅检查构建产物；第三方 sitemap、robots 规则和线上状态未验证。`);
  for (const item of report.diagnostics) logger[item.severity === 'warning' ? 'warn' : 'log'](`[GEO audit] [${item.severity === 'warning' ? '警告' : '建议'}] ${safeText(item.path)} [${safeText(item.rule)}] ${safeText(item.evidence)}；${safeText(item.suggestion)}`);
}
