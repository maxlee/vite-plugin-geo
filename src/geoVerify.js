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
  classifyHtmlFiles,
  composePageUrl,
  findHtmlFiles,
  normalizeFilePath,
  normalizeRouteBasePath,
  resolveMarkdownMirrorPath,
  resolvePagePath,
} from './geoGenerator.js';
import { normalizeSiteDomain } from './geoMetadataResolver.js';

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

function readText(filePath) {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function decodeXmlEntities(value) {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .trim();
}

function parseSitemapXml(content) {
  const source = String(content || '');
  const isIndex = /<sitemapindex\b/i.test(source);
  const locs = [];
  const pattern = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const loc = decodeXmlEntities(match[1]);
    if (loc) locs.push(loc);
  }
  return { isIndex, locs };
}

function listTopLevelSitemaps(distDir) {
  try {
    return readdirSync(distDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^sitemap.*\.xml$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
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
 * Normalize a URL for comparison: origin + pathname without a trailing slash.
 * The site root keeps its single slash so it matches composePageUrl output.
 */
function normalizeUrlKey(value, siteUrl) {
  try {
    const url = new URL(String(value), `${siteUrl.replace(/\/+$/, '')}/`);
    if (!/^https?:$/.test(url.protocol)) return null;
    let pathname = url.pathname;
    if (pathname !== '/' && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

function resolveArtifactFile(distDir, relativePath, stripPrefixes = []) {
  const normalized = normalizeFilePath(relativePath);
  const baseCandidates = normalized === ''
    ? ['index.html']
    : (normalized.endsWith('/')
      ? [`${normalized}index.html`]
      : [normalized, `${normalized}/index.html`, `${normalized}.html`]);
  // Pages built from an intermediate directory (for example dist/src/pages)
  // still map to public routes through stripPathPrefixes. Accept the prefixed
  // artifact locations as fallbacks so verify checks the deployed file.
  const prefixedCandidates = normalized === ''
    ? stripPrefixes.map((prefix) => `${prefix}/index.html`)
    : stripPrefixes.flatMap((prefix) => (normalized.endsWith('/')
      ? [`${prefix}/${normalized}index.html`]
      : [`${prefix}/${normalized}`, `${prefix}/${normalized}/index.html`, `${prefix}/${normalized}.html`]));
  const candidates = [...baseCandidates, ...prefixedCandidates];

  for (const candidate of candidates) {
    if (fileExists(join(distDir, candidate))) return normalizeFilePath(candidate);
  }
  return null;
}

function collectSitemapLocs(distDir, rootFile, context) {
  const visited = new Set();
  const files = [];
  const locs = [];
  const missing = [];

  const visit = (file, depth) => {
    const normalizedFile = normalizeFilePath(file);
    if (!normalizedFile || visited.has(normalizedFile) || depth > SITEMAP_INDEX_MAX_DEPTH) return;
    visited.add(normalizedFile);

    const content = readText(join(distDir, normalizedFile));
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
      if (childPath === null || childPath === '') {
        missing.push(loc);
        continue;
      }
      visit(childPath, depth + 1);
    }
  };

  visit(rootFile, 0);
  return { locs, files, missing };
}

function extractDocumentUrls(content) {
  const urls = new Set();
  const markdownLink = /\]\(\s*([^)\s]+)\s*\)/g;
  const bareUrl = /https?:\/\/[^\s<>"')\]]+/g;
  let match;

  const add = (value) => {
    const trimmed = String(value).replace(/[.,;:]+$/, '');
    if (trimmed) urls.add(trimmed);
  };

  while ((match = markdownLink.exec(content)) !== null) add(match[1]);
  while ((match = bareUrl.exec(content)) !== null) add(match[0]);
  return [...urls];
}

function extractFeedUrls(content) {
  const urls = [];
  for (const tag of ['link', 'guid']) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const value = decodeXmlEntities(match[1]);
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

function resolveVerifySiteUrl({ siteUrl, projectRoot, options }) {
  if (typeof siteUrl === 'string' && siteUrl.trim()) {
    return normalizeSiteDomain(siteUrl, 'siteUrl');
  }
  if (options.domain !== undefined) {
    return normalizeSiteDomain(options.domain, 'domain');
  }
  if (options.packageJsonPath !== false) {
    const packageJsonPath = typeof options.packageJsonPath === 'string'
      ? resolve(projectRoot, options.packageJsonPath)
      : resolve(projectRoot, './package.json');
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      if (packageJson && packageJson.domain) {
        return normalizeSiteDomain(packageJson.domain, 'package.json "domain"');
      }
    } catch {
      // Fall through to the actionable error below.
    }
  }
  throw new Error(
    "Missing required domain. Configure domain: 'https://example.com' or add \"domain\" to package.json.",
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
  const resolvedDistDir = resolve(projectRoot, distDir);
  if (!existsSync(resolvedDistDir) || !statSync(resolvedDistDir).isDirectory()) {
    throw new Error(`Dist directory not found: ${resolvedDistDir}`);
  }

  const resolvedSiteUrl = resolveVerifySiteUrl({ siteUrl, projectRoot, options });
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

  const pagesByPath = new Map();
  for (const filePath of classified.included) {
    const relativePath = normalizeFilePath(relative(resolvedDistDir, filePath));
    const pagePath = resolvePagePath(relativePath, options);
    if (!pagesByPath.has(pagePath)) {
      pagesByPath.set(pagePath, { filePath, relativePath, pagePath });
    }
  }

  const pageUrlByPath = new Map();
  for (const [pagePath, page] of pagesByPath) {
    pageUrlByPath.set(pagePath, composePageUrl(resolvedSiteUrl, pagePath, resolvedRouteBasePath));
  }

  let sitemapFile = null;
  let sitemap = null;
  let locKeys = new Set();

  if (sitemapEnabled) {
    const explicitSitemap = typeof options.sitemapUrl === 'string' ? options.sitemapUrl.trim() : '';
    const candidates = [];
    if (explicitSitemap) {
      const explicitRelative = toDistRelative(explicitSitemap, context);
      if (explicitRelative) candidates.push(explicitRelative);
    }
    candidates.push('sitemap.xml', 'sitemap_index.xml', ...listTopLevelSitemaps(resolvedDistDir));

    sitemapFile = candidates.find((candidate) => (
      candidate && fileExists(join(resolvedDistDir, candidate))
    )) || null;

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

      for (const loc of sitemap.locs) {
        const key = normalizeUrlKey(loc, resolvedSiteUrl);
        if (key) {
          if (seenKeys.has(key)) duplicates.push(loc);
          seenKeys.add(key);
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
  for (const page of pagesByPath.values()) {
    const html = readText(page.filePath);
    if (html === null) continue;

    let facts = null;
    try {
      facts = collectAuditFacts(parse(html));
    } catch {
      facts = null;
    }

    const expectedPageUrl = pageUrlByPath.get(page.pagePath);

    if (facts) {
      const canonicalUrls = (facts.canonicals || []).filter((href) => String(href).trim());
      for (const href of canonicalUrls) {
        let resolvedCanonical;
        try {
          resolvedCanonical = new URL(href, expectedPageUrl).href;
        } catch {
          continue;
        }
        const canonicalKey = normalizeUrlKey(resolvedCanonical, resolvedSiteUrl);
        const expectedKey = normalizeUrlKey(expectedPageUrl, resolvedSiteUrl);
        if (canonicalKey && expectedKey && canonicalKey !== expectedKey
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

    const expectedMirrorPath = resolveMarkdownMirrorPath(page.pagePath, mirrorStyle);
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

    const declared = facts ? declaredMarkdownUrls(facts, expectedPageUrl) : [];
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
    } else if (!fileExists(join(resolvedDistDir, expectedMirrorPath))) {
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
      if (resolveArtifactFile(resolvedDistDir, relativePath, stripPrefixes) === null
        || (!/\.html?$/i.test(relativePath) ? false : !acceptedBySitemap(key))) {
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
          'feed.xml',
          `feed.xml 引用的地址无法映射到产物或 sitemap：${summarize(invalid)}`,
          '统一 feed 条目与公开页面地址。',
        );
      }
    }
  }

  const unique = [...new Map(diagnostics.map((item) => [JSON.stringify(item), item])).values()];
  unique.sort((a, b) => (
    a.severity.localeCompare(b.severity)
    || String(a.path).localeCompare(String(b.path))
    || a.rule.localeCompare(b.rule)
    || String(a.evidence).localeCompare(String(b.evidence))
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
      markdownMirrorPaths: markdownMirrorPaths.sort((a, b) => a.localeCompare(b)),
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
