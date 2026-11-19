/**
 * Post-build verification of the final GEO output.
 *
 * Reads `dist` from disk instead of the in-memory bundle, so it observes what
 * actually shipped even when another plugin rewrites files in `closeBundle`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { parse } from 'parse5';
import { collectAuditFacts } from './geoAudit.js';
import {
  filterFeedPages,
  resolvePageLocaleKey,
  resolvePageTrailingSlashMode,
  resolvePrimaryFeedLocale,
  validateGeoOptions,
} from './geoBuildPipeline.js';
import {
  classifyHtmlFiles,
  compareCodeUnits,
  composePageUrl,
  decodeXmlEntities,
  findHtmlFiles,
  isWithinDir,
  normalizeFilePath,
  normalizeRouteBasePath,
  resolveMarkdownMirrorPath,
  resolvePagePath,
  resolvePagePathConflicts,
  shouldGenerateMarkdownMirror,
} from './geoGenerator.js';
import { normalizeSiteDomain, resolvePackageJsonSiteDomain } from './geoMetadataResolver.js';

const DEFAULT_STRIP_PATH_PREFIXES = ['src/pages/'];
const SITEMAP_INDEX_MAX_DEPTH = 5;
const SAMPLE_LIMIT = 5;
const HTML_EXTENSION_PATTERN = /\.html?$/i;
const MARKDOWN_EXTENSION_PATTERN = /\.html?\.md$/i;
const MARKDOWN_TYPE = 'text/markdown';

function fileExists(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function safeDistFilePath(distDir, relativePath) {
  const normalized = normalizeFilePath(relativePath).replace(/^\/+/, '');
  if (!normalized) return null;
  if (normalized.split('/').some((segment) => segment === '..')) {
    return null;
  }
  const resolvedPath = resolve(distDir, normalized);
  return isWithinDir(distDir, resolvedPath) ? resolvedPath : null;
}

function readText(filePath) {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function stripXmlCommentsOutsideCdata(xml) {
  return String(xml || '').replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g, (match) => (
    match.startsWith('<![CDATA[') ? match : ''
  ));
}

function unwrapXmlValue(value) {
  const str = String(value || '');
  let result = '';
  let lastIndex = 0;
  const cdataPattern = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let match;
  while ((match = cdataPattern.exec(str)) !== null) {
    result += decodeXmlEntities(str.slice(lastIndex, match.index));
    result += match[1];
    lastIndex = match.index + match[0].length;
  }
  result += decodeXmlEntities(str.slice(lastIndex));
  return result.trim();
}

function parseSitemapXml(content) {
  const source = stripXmlCommentsOutsideCdata(content);
  const isIndex = /<(?:[a-zA-Z_][\w.-]*:)?sitemapindex\b/i.test(source);
  const locs = [];
  const pattern = /<(?:[a-zA-Z_][\w.-]*:)?loc(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/(?:[a-zA-Z_][\w.-]*:)?loc>/gi;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const loc = unwrapXmlValue(match[1]);
    if (loc) locs.push(loc);
  }
  return { isIndex, locs };
}

function listTopLevelSitemaps(distDir) {
  try {
    const xmlFiles = readdirSync(distDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.xml$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareCodeUnits);

    const candidates = [];
    for (const name of xmlFiles) {
      const content = readText(join(distDir, name));
      const cleaned = stripXmlCommentsOutsideCdata(content || '');
      const isIndex = /<(?:[a-zA-Z_][\w.-]*:)?sitemapindex\b/i.test(cleaned);
      const isUrlset = /<(?:[a-zA-Z_][\w.-]*:)?urlset\b/i.test(cleaned);
      const isNamedSitemap = /^sitemap.*\.xml$/i.test(name);
      if (!isIndex && !isUrlset && !isNamedSitemap) continue;
      candidates.push({ name, isIndex, isUrlset });
    }

    const rank = (entry) => {
      if (entry.isIndex) {
        if (entry.name === 'sitemap_index.xml') return 0;
        if (entry.name === 'sitemap-index.xml') return 1;
        if (entry.name === 'sitemap.xml') return 2;
        return 3;
      }
      if (entry.name === 'sitemap.xml') return 4;
      if (entry.name === 'sitemap_index.xml') return 5;
      if (entry.name === 'sitemap-index.xml') return 6;
      if (entry.isUrlset) return 7;
      return 8;
    };

    return candidates
      .sort((a, b) => rank(a) - rank(b) || compareCodeUnits(a.name, b.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Convert a public URL to a dist-relative path.
 * Returns '' for the site root and null for external or out-of-scope URLs.
 */
function toDistRelative(value, { siteUrl, routeBasePath }) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  let url;
  let origin;
  try {
    origin = new URL(siteUrl).origin;
    url = new URL(raw, `${siteUrl.replace(/\/+$/, '')}/`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || url.origin !== origin) return null;

  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Keep the raw pathname when it contains malformed escapes.
  }

  const base = routeBasePath === '/' ? '' : routeBasePath.replace(/^\/+|\/+$/g, '');
  if (base) {
    if (pathname === `/${base}`) {
      pathname = '/';
    } else if (pathname.startsWith(`/${base}/`)) {
      pathname = pathname.slice(base.length + 1);
    } else {
      return null;
    }
  }

  return pathname.replace(/^\/+/, '');
}

/**
 * Normalize a URL for comparison: origin + pathname (without trailing slash except root) + search.
 * Preserves query strings so query-distinct canonicals do not collapse into the base path.
 */
function normalizeUrlKey(value, siteUrl) {
  try {
    const url = new URL(String(value), `${siteUrl.replace(/\/+$/, '')}/`);
    if (!/^https?:$/.test(url.protocol)) return null;
    let pathname = url.pathname;
    if (pathname !== '/' && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    return `${url.origin}${pathname}${url.search}`;
  } catch {
    return null;
  }
}

function resolveArtifactFile(distDir, relativePath, stripPrefixes = []) {
  const normalized = normalizeFilePath(relativePath);
  const withoutTrailingSlash = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  const baseCandidates = normalized === ''
    ? ['index.html']
    : (normalized.endsWith('/')
      ? (withoutTrailingSlash === '' ? ['index.html'] : [`${normalized}index.html`, `${withoutTrailingSlash}.html`])
      : [normalized, `${normalized}/index.html`, `${normalized}.html`]);
  // Pages built from an intermediate directory (for example dist/src/pages)
  // still map to public routes through stripPathPrefixes. Accept the prefixed
  // artifact locations as fallbacks so verify checks the deployed file.
  const prefixedCandidates = normalized === ''
    ? stripPrefixes.map((prefix) => `${prefix}/index.html`)
    : stripPrefixes.flatMap((prefix) => (normalized.endsWith('/')
      ? (withoutTrailingSlash === ''
        ? [`${prefix}/index.html`]
        : [`${prefix}/${normalized}index.html`, `${prefix}/${withoutTrailingSlash}.html`])
      : [`${prefix}/${normalized}`, `${prefix}/${normalized}/index.html`, `${prefix}/${normalized}.html`]));
  const candidates = [...baseCandidates, ...prefixedCandidates];

  for (const candidate of candidates) {
    const safePath = safeDistFilePath(distDir, candidate);
    if (safePath && fileExists(safePath)) return normalizeFilePath(candidate);
  }
  return null;
}

function collectSitemapLocs(distDir, rootFile, context) {
  const visited = new Set();
  const files = [];
  const locs = [];
  const missing = [];
  const depthExceeded = [];

  const visit = (file, depth) => {
    const normalizedFile = normalizeFilePath(file);
    if (!normalizedFile || visited.has(normalizedFile)) return;
    if (depth > SITEMAP_INDEX_MAX_DEPTH) {
      depthExceeded.push(normalizedFile);
      return;
    }
    visited.add(normalizedFile);

    const resolvedPath = safeDistFilePath(distDir, normalizedFile);
    const content = resolvedPath ? readText(resolvedPath) : null;
    if (content === null) {
      missing.push(normalizedFile);
      return;
    }
    files.push(normalizedFile);

    const parsed = parseSitemapXml(content);
    if (!parsed.isIndex) {
      locs.push(...parsed.locs);
      return;
    }
    for (const loc of parsed.locs) {
      const childPath = toDistRelative(loc, context);
      if (childPath === null || childPath === '' || !safeDistFilePath(distDir, childPath)) {
        missing.push(loc);
        continue;
      }
      visit(childPath, depth + 1);
    }
  };

  visit(rootFile, 0);
  return { locs, files, missing, depthExceeded };
}

function extractDocumentUrls(content) {
  const stripped = String(content || '').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|<!--[\s\S]*?-->|`[^`\n]*`/g, ' ');
  const urls = new Set();
  const markdownLink = /\]\(\s*([^)\s]+)\s*\)/g;
  const bareUrl = /https?:\/\/[^\s<>"')\]]+/g;
  let match;

  const add = (value) => {
    const trimmed = String(value).replace(/[.,;:]+$/, '');
    if (trimmed) urls.add(trimmed);
  };

  while ((match = markdownLink.exec(stripped)) !== null) add(match[1]);
  while ((match = bareUrl.exec(stripped)) !== null) add(match[0]);
  return [...urls];
}

function findFeedFilesInDist(distDir) {
  const found = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.vite-plugin-geo-')) continue;
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase() === 'feed.xml') {
        found.push(normalizeFilePath(relative(distDir, entryPath)));
      }
    }
  };
  visit(distDir);
  return found.sort(compareCodeUnits);
}

function extractFeedUrls(content) {
  const cleaned = stripXmlCommentsOutsideCdata(content);
  const urls = [];
  for (const tag of ['link', 'guid']) {
    const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    let match;
    while ((match = pattern.exec(cleaned)) !== null) {
      const attrs = match[1] || '';
      if (tag === 'guid' && /\bisPermaLink\s*=\s*(?:"false"|'false'|false\b)/i.test(attrs)) {
        continue;
      }
      const value = unwrapXmlValue(match[2]);
      if (value && !/^urn:/i.test(value)) urls.push(value);
    }
  }
  return urls;
}

function declaredMarkdownUrls(facts, pageUrl) {
  const urls = [];
  for (const link of facts.links || []) {
    const relTokens = String(link.rel || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!relTokens.includes('alternate')) continue;
    if (String(link.type || '').toLowerCase() !== MARKDOWN_TYPE) continue;
    try {
      const url = new URL(link.href, pageUrl);
      if (/^https?:$/.test(url.protocol) && !url.username && !url.password) urls.push(url.href);
    } catch {
      // Ignore malformed alternates; the HTML audit reports them separately.
    }
  }
  return urls;
}

function summarize(items, limit = SAMPLE_LIMIT) {
  const unique = [...new Set(items.map(String))];
  const samples = unique.slice(0, limit).join('、');
  return unique.length > limit ? `${samples} 等 ${unique.length} 项` : samples;
}

function inferSiteUrlFromDistOutput(distDir, options = {}) {
  const sitemapCandidates = listTopLevelSitemaps(distDir);
  for (const fileName of sitemapCandidates) {
    const content = readText(join(distDir, fileName));
    if (!content) continue;
    const { locs } = parseSitemapXml(content);
    for (const loc of locs) {
      try {
        const parsed = new URL(loc);
        if (/^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password) {
          return normalizeSiteDomain(parsed.origin, `${fileName} <loc>`);
        }
      } catch {
        // Ignore unparseable loc entries when probing fallback origin.
      }
    }
  }

  const stripPrefixes = (options.stripPathPrefixes || DEFAULT_STRIP_PATH_PREFIXES)
    .map((prefix) => normalizeFilePath(prefix).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
  const htmlCandidates = [];
  const rootIndex = join(distDir, 'index.html');
  if (fileExists(rootIndex)) {
    htmlCandidates.push(rootIndex);
  } else {
    for (const prefix of stripPrefixes) {
      const prefixedIndex = safeDistFilePath(distDir, `${prefix}/index.html`);
      if (prefixedIndex && fileExists(prefixedIndex)) htmlCandidates.push(prefixedIndex);
    }
  }

  for (const htmlPath of htmlCandidates) {
    const html = readText(htmlPath);
    if (!html) continue;
    try {
      const facts = collectAuditFacts(parse(html));
      for (const href of facts.canonicals || []) {
        const trimmed = String(href || '').trim();
        if (!trimmed) continue;
        try {
          const parsed = new URL(trimmed);
          if (/^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password) {
            return normalizeSiteDomain(parsed.origin, 'index.html canonical');
          }
        } catch {
          // Relative canonicals cannot establish origin; continue probing.
        }
      }
    } catch {
      // Ignore parse issues during fallback probing.
    }
  }

  return null;
}

function resolveVerifySiteUrl({ siteUrl, projectRoot, distDir, options }) {
  if (siteUrl !== undefined && (typeof siteUrl !== 'string' || siteUrl.trim())) {
    return normalizeSiteDomain(siteUrl, 'siteUrl');
  }
  if (options.domain !== undefined) {
    return normalizeSiteDomain(options.domain, 'domain');
  }
  if (options.packageJsonPath !== false) {
    const packageJsonPath = typeof options.packageJsonPath === 'string'
      ? resolve(projectRoot, options.packageJsonPath)
      : resolve(projectRoot, './package.json');
    let rawPackageJson = null;
    try {
      rawPackageJson = readFileSync(packageJsonPath, 'utf-8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error(`Failed to read package.json at ${packageJsonPath}: ${error?.message || String(error)}`);
      }
    }
    if (rawPackageJson !== null) {
      let packageJson;
      try {
        packageJson = JSON.parse(rawPackageJson);
      } catch (error) {
        throw new Error(`Invalid package.json at ${packageJsonPath}: ${error?.message || String(error)}`);
      }
      if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
        throw new Error(`Invalid package.json at ${packageJsonPath}: expected a JSON object.`);
      }
      const packageDomain = resolvePackageJsonSiteDomain(packageJson);
      if (packageDomain) {
        return packageDomain;
      }
    }
  }

  const inferredOrigin = inferSiteUrlFromDistOutput(distDir, options);
  if (inferredOrigin) {
    return inferredOrigin;
  }

  throw new Error(
    "Missing required domain. Configure domain: 'https://example.com' or add \"domain\" (or an absolute \"homepage\" URL) to package.json.",
  );
}

/**
 * Verify the final dist output on disk.
 *
 * @param {object} params
 * @param {string} params.projectRoot - Project root used to resolve package.json
 * @param {string} params.distDir - Final build output directory
 * @param {object} [params.options={}] - Resolved GEO options
 * @param {string} [params.siteUrl] - Explicit site origin (overrides options.domain)
 * @param {string} [params.routeBasePath] - Explicit route base path
 * @returns {{
 *   ok: boolean,
 *   errors: Array<object>,
 *   warnings: Array<object>,
 *   checks: object,
 *   summary: object,
 * }}
 */
export function verifyGeoOutput({
  projectRoot = process.cwd(),
  distDir,
  options = {},
  siteUrl,
  routeBasePath,
} = {}) {
  if (!distDir) {
    throw new Error('verifyGeoOutput requires a distDir.');
  }
  if (options !== undefined) {
    validateGeoOptions(options);
  }
  const resolvedDistDir = resolve(projectRoot, distDir);
  if (!existsSync(resolvedDistDir) || !statSync(resolvedDistDir).isDirectory()) {
    throw new Error(`Dist directory not found: ${resolvedDistDir}`);
  }

  const resolvedSiteUrl = resolveVerifySiteUrl({
    siteUrl,
    projectRoot,
    distDir: resolvedDistDir,
    options,
  });
  const resolvedRouteBasePath = normalizeRouteBasePath(
    routeBasePath !== undefined ? routeBasePath : options.routeBasePath,
    { source: 'routeBasePath' },
  );
  const context = { siteUrl: resolvedSiteUrl, routeBasePath: resolvedRouteBasePath };
  const prettyUrls = options.prettyUrls !== false;
  const stripPrefixes = (options.stripPathPrefixes || DEFAULT_STRIP_PATH_PREFIXES)
    .map((prefix) => normalizeFilePath(prefix).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
  const mirrorStyle = options.llmsMdMirrorStyle || 'append';
  const mirrorEnabled = options.llmsMdMirror !== false;
  const sitemapEnabled = options.generateSitemap !== false;

  const diagnostics = [];
  const add = (severity, rule, path, evidence, suggestion) => {
    diagnostics.push({ path, rule, severity, evidence, suggestion });
  };

  const htmlFiles = findHtmlFiles(resolvedDistDir);
  const classified = classifyHtmlFiles(htmlFiles, {
    distDir: resolvedDistDir,
    excludePatterns: options.excludePatterns,
  });

  const routeGroups = new Map();
  for (const filePath of classified.included) {
    const relativePath = normalizeFilePath(relative(resolvedDistDir, filePath));
    const pagePath = resolvePagePath(relativePath, options);
    if (!routeGroups.has(pagePath)) {
      routeGroups.set(pagePath, []);
    }
    routeGroups.get(pagePath).push({ filePath, relativePath, pagePath });
  }
  const { selected: selectedPages } = resolvePagePathConflicts(routeGroups, {
    ...options,
    routeConflict: options.routeConflict || 'first',
  });
  const pagesByPath = new Map(selectedPages.map((page) => [page.pagePath, page]));

  const pageInspectionByPath = new Map();
  for (const [pagePath, page] of pagesByPath) {
    const html = readText(page.filePath);
    if (html === null) continue;
    let facts = null;
    try {
      facts = collectAuditFacts(parse(html));
    } catch {
      facts = null;
    }
    const filePageUrl = composePageUrl(
      resolvedSiteUrl,
      resolvePagePath(page.relativePath, { ...options, prettyUrls: false }),
      resolvedRouteBasePath,
    );
    let documentBaseUrl = filePageUrl;
    if (facts?.baseHref !== null && facts?.baseHref !== undefined) {
      try {
        documentBaseUrl = new URL(facts.baseHref, filePageUrl).href;
      } catch {
        documentBaseUrl = filePageUrl;
      }
    }
    pageInspectionByPath.set(pagePath, { html, facts, filePageUrl, documentBaseUrl });
  }

  const pageUrlByPath = new Map();
  const expectedUrlByKey = new Map();
  for (const [pagePath] of pagesByPath) {
    const inspection = pageInspectionByPath.get(pagePath);
    const canonicalHref = (inspection?.facts?.canonicals || []).find((href) => String(href || '').trim()) || '';
    const pageTrailingSlash = resolvePageTrailingSlashMode(
      canonicalHref,
      inspection?.documentBaseUrl || inspection?.filePageUrl || resolvedSiteUrl,
      resolvedSiteUrl,
      options.trailingSlash,
    );
    const pageUrl = composePageUrl(resolvedSiteUrl, pagePath, resolvedRouteBasePath, {
      trailingSlash: pageTrailingSlash,
    });
    pageUrlByPath.set(pagePath, pageUrl);
    const urlKey = normalizeUrlKey(pageUrl, resolvedSiteUrl);
    if (urlKey) expectedUrlByKey.set(urlKey, pageUrl);
  }

  let sitemapFile = null;
  let sitemap = null;
  let locKeys = new Set();

  if (sitemapEnabled) {
    const explicitSitemap = typeof options.sitemapUrl === 'string' ? options.sitemapUrl.trim() : '';
    const candidates = [];
    if (explicitSitemap) {
      const explicitFromUrl = toDistRelative(explicitSitemap, context);
      if (explicitFromUrl && safeDistFilePath(resolvedDistDir, explicitFromUrl)) {
        candidates.push(explicitFromUrl);
      } else if (!/^[a-z][a-z\d+.-]*:/i.test(explicitSitemap) && !explicitSitemap.startsWith('//')) {
        const directRelative = normalizeFilePath(explicitSitemap).replace(/^\/+/, '');
        if (directRelative && safeDistFilePath(resolvedDistDir, directRelative)) {
          candidates.push(directRelative);
        }
      }
    }
    candidates.push(...listTopLevelSitemaps(resolvedDistDir));

    sitemapFile = candidates.find((candidate) => {
      const resolvedCandidate = candidate ? safeDistFilePath(resolvedDistDir, candidate) : null;
      return Boolean(resolvedCandidate && fileExists(resolvedCandidate));
    }) || null;

    if (!sitemapFile) {
      add(
        'error',
        'sitemap-missing',
        'sitemap.xml',
        `在产物目录中未找到 sitemap：${relative(process.cwd(), resolvedDistDir)}`,
        '确认 sitemap 生成未被 --no-generate-sitemap 或第三方插件覆盖。',
      );
    } else {
      sitemap = collectSitemapLocs(resolvedDistDir, sitemapFile, context);
      locKeys = new Set(sitemap.locs.map((loc) => normalizeUrlKey(loc, resolvedSiteUrl)).filter(Boolean));

      if (sitemap.depthExceeded.length > 0) {
        add(
          'warning',
          'sitemap-index-depth',
          sitemapFile,
          `sitemap 索引递归超过最大深度（${SITEMAP_INDEX_MAX_DEPTH}）：${summarize(sitemap.depthExceeded)}`,
          '精简多层嵌套的 sitemap 索引，避免搜索引擎和校验器遗漏子文件。',
        );
      }
      if (sitemap.missing.length > 0) {
        add(
          'error',
          'sitemap-missing',
          sitemapFile,
          `sitemap 索引引用的文件缺失：${summarize(sitemap.missing)}`,
          '重新生成 sitemap 索引或删除失效的索引条目。',
        );
      }
      if (sitemap.locs.length === 0) {
        add(
          'error',
          'sitemap-empty',
          sitemapFile,
          'sitemap 不包含任何 <loc> 条目',
          '确认页面集合非空且 sitemap 生成器正常工作。',
        );
      }

      const duplicates = [];
      const seenKeys = new Set();
      const unmapped = [];
      const prefixed = [];
      const htmlExtension = [];
      const trailingSlashMismatches = [];
      const strictTrailingSlash = options.trailingSlash === 'always' || options.trailingSlash === 'never';

      for (const loc of sitemap.locs) {
        const key = normalizeUrlKey(loc, resolvedSiteUrl);
        if (key) {
          if (seenKeys.has(key)) duplicates.push(loc);
          seenKeys.add(key);

          if (strictTrailingSlash && expectedUrlByKey.has(key)) {
            const expectedUrl = expectedUrlByKey.get(key);
            try {
              const locUrl = new URL(loc);
              const expectedObj = new URL(expectedUrl);
              if (expectedObj.pathname !== '/') {
                if (locUrl.pathname !== expectedObj.pathname) trailingSlashMismatches.push(loc);
              } else if (options.trailingSlash === 'always' && !String(loc).split(/[?#]/, 1)[0].endsWith('/')) {
                trailingSlashMismatches.push(loc);
              }
            } catch {
              // Ignore unparseable URLs here; unmapped check covers them.
            }
          }
        }

        const relativePath = toDistRelative(loc, context);
        if (relativePath === null
          || resolveArtifactFile(resolvedDistDir, relativePath, stripPrefixes) === null) {
          unmapped.push(loc);
        }
        if (relativePath !== null) {
          if (stripPrefixes.some((prefix) => (
            relativePath === prefix || relativePath.startsWith(`${prefix}/`)
          ))) {
            prefixed.push(loc);
          }
          if (prettyUrls && HTML_EXTENSION_PATTERN.test(relativePath)) {
            htmlExtension.push(loc);
          }
        }
      }

      if (duplicates.length > 0) {
        add(
          'error',
          'sitemap-duplicate-loc',
          sitemapFile,
          `sitemap 包含重复 <loc>：${summarize(duplicates)}`,
          '确保每个公开页面只出现一次。',
        );
      }
      if (unmapped.length > 0) {
        add(
          'error',
          'sitemap-unmapped-loc',
          sitemapFile,
          `sitemap <loc> 无法映射到产物文件：${summarize(unmapped)}`,
          '检查 sitemap 是否指向了中间构建路径或产物中不存在的页面。',
        );
      }
      if (prefixed.length > 0) {
        add(
          'error',
          'sitemap-intermediate-prefix',
          sitemapFile,
          `sitemap <loc> 含中间路径前缀：${summarize(prefixed)}`,
          'sitemap 必须使用公开 URL；检查 stripPathPrefixes 与第三方 sitemap 插件。',
        );
      }
      if (htmlExtension.length > 0) {
        add(
          'error',
          'sitemap-html-extension',
          sitemapFile,
          `prettyUrls 下 sitemap <loc> 仍以 .html 结尾：${summarize(htmlExtension)}`,
          '使用无扩展名公开地址，或关闭 prettyUrls 以匹配实际路由。',
        );
      }
      if (trailingSlashMismatches.length > 0) {
        add(
          'warning',
          'sitemap-trailing-slash',
          sitemapFile,
          `sitemap <loc> 尾斜杠不符合 trailingSlash='${options.trailingSlash}'：${summarize(trailingSlashMismatches)}`,
          '统一 sitemap 中的页面 URL 尾斜杠风格。',
        );
      }
      if (pagesByPath.size > 0 && sitemap.locs.length < pagesByPath.size) {
        add(
          'error',
          'sitemap-url-count',
          sitemapFile,
          `sitemap 只有 ${sitemap.locs.length} 条 <loc>，少于 ${pagesByPath.size} 个页面`,
          '确认构建期间没有第三方插件覆盖 sitemap，或页面是否被意外排除。',
        );
      }

      const missingPages = [];
      for (const [pagePath, page] of pagesByPath) {
        const key = normalizeUrlKey(pageUrlByPath.get(pagePath), resolvedSiteUrl);
        if (key && !locKeys.has(key)) missingPages.push(page.relativePath);
      }
      if (missingPages.length > 0) {
        add(
          'error',
          'sitemap-missing-page',
          sitemapFile,
          `以下页面未出现在 sitemap 中：${summarize(missingPages)}`,
          '确认页面未被过滤，或 sitemap 未被其他插件覆盖。',
        );
      }

      if (pagesByPath.has('')) {
        const homeKey = normalizeUrlKey(pageUrlByPath.get(''), resolvedSiteUrl);
        if (homeKey && !locKeys.has(homeKey)) {
          add(
            'error',
            'sitemap-homepage-missing',
            sitemapFile,
            `sitemap 缺少首页地址：${pageUrlByPath.get('')}`,
            '确保首页被纳入 sitemap。',
          );
        }
      }

      const robots = readText(join(resolvedDistDir, 'robots.txt'));
      if (robots !== null) {
        const expectedUrls = new Set(
          [sitemapFile, explicitSitemap]
            .filter(Boolean)
            .map((value) => normalizeUrlKey(
              /^[a-z][a-z\d+.-]*:\/\//i.test(value)
                ? value
                : composePageUrl(resolvedSiteUrl, value, resolvedRouteBasePath),
              resolvedSiteUrl,
            ))
            .filter(Boolean),
        );
        const declared = robots
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => /^sitemap\s*:/i.test(line))
          .map((line) => normalizeUrlKey(line.replace(/^sitemap\s*:\s*/i, ''), resolvedSiteUrl))
          .filter(Boolean);

        if (declared.length === 0) {
          add(
            'warning',
            'robots-sitemap-mismatch',
            'robots.txt',
            'robots.txt 未声明 Sitemap 地址',
            '在 robots.txt 中添加指向实际 sitemap 的 Sitemap: 行。',
          );
        } else if (!declared.some((url) => expectedUrls.has(url))) {
          add(
            'warning',
            'robots-sitemap-mismatch',
            'robots.txt',
            `robots.txt 的 Sitemap 指向 ${declared.join('、')}，与产物 sitemap 不一致`,
            '更新 robots.txt 或 sitemap 配置，使公开地址一致。',
          );
        }
      }
    }
  }

  const markdownMirrorPaths = [];
  const strictTrailingSlash = options.trailingSlash === 'always' || options.trailingSlash === 'never';
  for (const page of pagesByPath.values()) {
    const inspection = pageInspectionByPath.get(page.pagePath);
    if (!inspection) continue;
    const { facts, documentBaseUrl } = inspection;
    const expectedPageUrl = pageUrlByPath.get(page.pagePath);

    if (facts) {
      const canonicalUrls = (facts.canonicals || []).filter((href) => String(href).trim());
      for (const href of canonicalUrls) {
        let resolvedUrl;
        try {
          resolvedUrl = new URL(href, documentBaseUrl);
        } catch {
          continue;
        }
        const resolvedCanonical = resolvedUrl.href;
        const canonicalKey = normalizeUrlKey(resolvedCanonical, resolvedSiteUrl);
        const expectedKey = normalizeUrlKey(expectedPageUrl, resolvedSiteUrl);
        let trailingMismatch = false;
        if (strictTrailingSlash && canonicalKey && expectedKey && canonicalKey === expectedKey) {
          const expectedObj = new URL(expectedPageUrl);
          if (resolvedUrl.pathname !== expectedObj.pathname) {
            const directoryMatch = !prettyUrls
              && /(^|\/)index\.html?$/i.test(expectedObj.pathname)
              && resolvedUrl.pathname === (expectedObj.pathname.replace(/index\.html?$/i, '') || '/');
            if (!directoryMatch) {
              trailingMismatch = true;
            }
          }
        }
        if (canonicalKey && expectedKey && (canonicalKey !== expectedKey || trailingMismatch)
          && canonicalKey.startsWith(`${new URL(resolvedSiteUrl).origin}/`)) {
          add(
            'warning',
            'canonical-mismatch',
            page.relativePath,
            `canonical ${resolvedCanonical} 与预期的页面地址 ${expectedPageUrl} 不一致`,
            '统一 canonical 与公开路由，避免历史 .html 地址混入。',
          );
        }
      }
    }

    if (!mirrorEnabled) continue;

    const declared = facts ? declaredMarkdownUrls(facts, documentBaseUrl) : [];
    const mirrorExpected = shouldGenerateMarkdownMirror(page, options);
    if (!mirrorExpected && declared.length === 0) continue;

    const expectedMirrorPath = resolveMarkdownMirrorPath(page.pagePath, mirrorStyle);
    if (mirrorExpected) {
      markdownMirrorPaths.push(expectedMirrorPath);

      if (stripPrefixes.some((prefix) => (
        expectedMirrorPath === prefix || expectedMirrorPath.startsWith(`${prefix}/`)
      )) || (prettyUrls && MARKDOWN_EXTENSION_PATTERN.test(expectedMirrorPath))) {
        add(
          'warning',
          'markdown-mirror-path',
          page.relativePath,
          `Markdown 镜像路径不是公开路径：${expectedMirrorPath}`,
          '镜像应基于公开 pagePath 派生，不能包含中间构建目录或双扩展名。',
        );
      }
    }

    if (declared.length > 0) {
      for (const url of declared) {
        const relativePath = toDistRelative(url, context);
        if (relativePath === null || relativePath === '') continue;
        if (stripPrefixes.some((prefix) => (
          relativePath === prefix || relativePath.startsWith(`${prefix}/`)
        )) || (prettyUrls && MARKDOWN_EXTENSION_PATTERN.test(relativePath))) {
          add(
            'warning',
            'markdown-mirror-path',
            page.relativePath,
            `页面声明的 Markdown 地址不是公开路径：${url}`,
            '改为基于公开 pagePath 的镜像地址。',
          );
        }
        if (resolveArtifactFile(resolvedDistDir, relativePath, stripPrefixes) === null) {
          add(
            'warning',
            'markdown-mirror-missing',
            page.relativePath,
            `页面声明的 Markdown 文件不存在：${url}`,
            '确认镜像已生成并部署。',
          );
        }
      }
    } else if (mirrorExpected && !fileExists(join(resolvedDistDir, expectedMirrorPath))) {
      add(
        'warning',
        'markdown-mirror-missing',
        page.relativePath,
        `缺少 Markdown 镜像文件：${expectedMirrorPath}`,
        '确认 llmsMdMirror 未被关闭且镜像已写入产物。',
      );
    }
  }

  const llmsContent = readText(join(resolvedDistDir, 'llms.txt'));
  if (llmsContent === null) {
    add(
      'warning',
      'llms-link-invalid',
      'llms.txt',
      '产物中缺少 llms.txt',
      '确认 llms.txt 未被第三方插件删除。',
    );
  } else {
    const acceptedBySitemap = (key) => key === null || locKeys.size === 0 || locKeys.has(key);
    const invalid = [];
    for (const url of extractDocumentUrls(llmsContent)) {
      const relativePath = toDistRelative(url, context);
      if (relativePath === null) continue;
      const key = normalizeUrlKey(url, resolvedSiteUrl);
      const artifact = resolveArtifactFile(resolvedDistDir, relativePath, stripPrefixes);
      const isHtmlArtifact = artifact !== null && HTML_EXTENSION_PATTERN.test(artifact);
      if (artifact === null || (isHtmlArtifact && !acceptedBySitemap(key))) {
        invalid.push(url);
      }
    }
    if (invalid.length > 0) {
      add(
        'warning',
        'llms-link-invalid',
        'llms.txt',
        `llms.txt 引用了无法解析的地址：${summarize(invalid)}`,
        '确认 llms.txt 中的页面、镜像与 sitemap 地址均对应产物文件。',
      );
    }
  }

  if (options.generateFeed !== false) {
    const verifyFeedFile = (feedRelPath, feedContent) => {
      const invalid = [];
      for (const url of extractFeedUrls(feedContent)) {
        const relativePath = toDistRelative(url, context);
        if (relativePath === null) continue;
        const key = normalizeUrlKey(url, resolvedSiteUrl);
        if (resolveArtifactFile(resolvedDistDir, relativePath, stripPrefixes) === null
          || (key !== null && locKeys.size > 0 && !locKeys.has(key))) {
          invalid.push(url);
        }
      }
      if (invalid.length > 0) {
        add(
          'warning',
          'feed-link-invalid',
          feedRelPath,
          `${feedRelPath} 引用的地址无法映射到产物或 sitemap：${summarize(invalid)}`,
          '统一 feed 条目与公开页面地址。',
        );
      }
    };

    if (options.feedByLocale === true) {
      const homePage = pagesByPath.get('') || selectedPages[0];
      const homeLang = homePage ? (pageInspectionByPath.get(homePage.pagePath)?.facts?.lang || '') : '';
      const primaryLocale = resolvePrimaryFeedLocale(options, homeLang);
      const primaryLocaleKey = primaryLocale.toLowerCase();
      const feedCandidatePages = [...pagesByPath.values()].map((page) => ({
        pagePath: page.pagePath,
        relativePath: page.relativePath,
        lang: pageInspectionByPath.get(page.pagePath)?.facts?.lang || '',
      }));
      const filteredFeedPages = filterFeedPages(feedCandidatePages, options);
      const expectedFeedFiles = new Set();
      for (const page of filteredFeedPages) {
        const locKey = resolvePageLocaleKey(page.lang, primaryLocale);
        expectedFeedFiles.add(locKey === primaryLocaleKey ? 'feed.xml' : `${locKey}/feed.xml`);
      }

      const foundFeedFiles = findFeedFilesInDist(resolvedDistDir);
      const foundFeedSet = new Set(foundFeedFiles);
      for (const expectedFeed of [...expectedFeedFiles].sort(compareCodeUnits)) {
        if (!foundFeedSet.has(expectedFeed)) {
          add(
            'warning',
            'feed-link-invalid',
            expectedFeed,
            `产物中缺少 ${expectedFeed}`,
            '确认 generateFeed 未被关闭且对应语言的 feed 未被第三方插件删除。',
          );
        }
      }
      for (const feedFile of foundFeedFiles) {
        const feedContent = readText(join(resolvedDistDir, feedFile));
        if (feedContent !== null) {
          verifyFeedFile(feedFile, feedContent);
        }
      }
    } else {
      const feedContent = readText(join(resolvedDistDir, 'feed.xml'));
      if (feedContent === null) {
        add(
          'warning',
          'feed-link-invalid',
          'feed.xml',
          '产物中缺少 feed.xml',
          '确认 generateFeed 未被关闭且 feed 未被第三方插件删除。',
        );
      } else {
        verifyFeedFile('feed.xml', feedContent);
      }
    }
  }

  const unique = [...new Map(diagnostics.map((item) => [JSON.stringify(item), item])).values()];
  unique.sort((a, b) => (
    compareCodeUnits(a.severity, b.severity)
    || compareCodeUnits(a.path, b.path)
    || compareCodeUnits(a.rule, b.rule)
    || compareCodeUnits(a.evidence, b.evidence)
  ));

  const errors = unique.filter((item) => item.severity === 'error');
  const warnings = unique.filter((item) => item.severity === 'warning');

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    checks: {
      checkedPages: pagesByPath.size,
      excludedHtmlFiles: classified.excludedDetails.length,
      checkedLocs: sitemap ? sitemap.locs.length : 0,
      sitemapChecked: Boolean(sitemap),
      sitemapFiles: sitemap ? sitemap.files : [],
      markdownMirrorPaths: [...markdownMirrorPaths].sort(compareCodeUnits),
    },
    summary: {
      siteUrl: resolvedSiteUrl,
      routeBasePath: resolvedRouteBasePath,
      distDir: resolvedDistDir,
      sitemapFile,
      sitemapLocCount: sitemap ? sitemap.locs.length : 0,
      pageCount: pagesByPath.size,
      errorCount: errors.length,
      warningCount: warnings.length,
    },
  };
}

export default verifyGeoOutput;
