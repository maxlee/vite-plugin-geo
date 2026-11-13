/**
 * SEO generator module for sitemap.xml / llms.txt / robots.txt
 */

import { spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, isAbsolute, join, relative, basename, resolve } from 'path';
import { parse, serialize } from 'parse5';
import TurndownService from 'turndown';
import { collectAuditFacts } from './geoAudit.js';

const DEFAULT_STRIP_PATH_PREFIXES = ['src/pages/'];
const DEFAULT_EXCLUDE_PATTERNS = ['404.html', '500.html'];
const MARKDOWN_STRIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg']);
const MARKDOWN_BODY_CHROME_TAGS = new Set(['nav', 'aside', 'footer']);
const MARKDOWN_BODY_CHROME_ROLES = new Set(['navigation', 'complementary', 'contentinfo']);
const HEADING_TAG_NAMES = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const ABSOLUTE_URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i;
const LEADING_H1_PATTERN = /^#(?!#)\s+(.+?)(?:\s+#+)?\s*$/;
const SITEMAP_MAX_URLS = 50000;
const SITEMAP_MAX_BYTES = 52_428_800;

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  strongDelimiter: '**',
});

turndownService.remove(['script', 'style', 'noscript', 'template', 'svg']);

/**
 * Find the first element node by tag name in parse5 AST.
 * @param {object} node - parse5 AST node
 * @param {string} tagName - HTML tag name
 * @returns {object|null} Matched node
 */
function findFirstNodeByTagName(node, tagName) {
  if (!node || typeof node !== 'object') {
    return null;
  }

  if (node.tagName === tagName) {
    return node;
  }

  if (!Array.isArray(node.childNodes)) {
    return null;
  }

  for (const childNode of node.childNodes) {
    const matchedNode = findFirstNodeByTagName(childNode, tagName);
    if (matchedNode) {
      return matchedNode;
    }
  }

  return null;
}

function findFirstNodeByRole(node, role) {
  if (!node || typeof node !== 'object') {
    return null;
  }

  const roles = getAttribute(node, 'role').toLowerCase().split(/\s+/).filter(Boolean);
  if (roles.includes(role)) {
    return node;
  }

  if (!Array.isArray(node.childNodes)) {
    return null;
  }

  for (const childNode of node.childNodes) {
    const matchedNode = findFirstNodeByRole(childNode, role);
    if (matchedNode) {
      return matchedNode;
    }
  }

  return null;
}

function containsHeadingNode(node) {
  if (!node || typeof node !== 'object') {
    return false;
  }

  if (HEADING_TAG_NAMES.has(node.tagName)) {
    return true;
  }

  return Array.isArray(node.childNodes) && node.childNodes.some((childNode) => (
    containsHeadingNode(childNode)
  ));
}

/**
 * Choose the element that represents the page's readable content.
 * `<main>` is authoritative, a single `<article>` is the next best signal,
 * and `<body>` is the fallback for pages without semantic containers.
 */
function selectMarkdownContentRoot(documentAst) {
  const mainNode = findFirstNodeByTagName(documentAst, 'main')
    || findFirstNodeByRole(documentAst, 'main');
  if (mainNode) {
    return { node: mainNode, bodyFallback: false };
  }

  const articleNodes = findNodesByTagName(documentAst, 'article');
  if (articleNodes.length === 1) {
    return { node: articleNodes[0], bodyFallback: false };
  }

  const bodyNode = findFirstNodeByTagName(documentAst, 'body');
  return { node: bodyNode || documentAst, bodyFallback: Boolean(bodyNode) };
}

function shouldKeepBodyChild(childNode) {
  if (!childNode || typeof childNode !== 'object') {
    return true;
  }

  if (MARKDOWN_BODY_CHROME_TAGS.has(childNode.tagName)) {
    return false;
  }

  const roles = getAttribute(childNode, 'role').toLowerCase().split(/\s+/).filter(Boolean);
  if (roles.some((role) => MARKDOWN_BODY_CHROME_ROLES.has(role))) {
    return false;
  }

  if (childNode.tagName === 'header' || roles.includes('banner')) {
    return containsHeadingNode(childNode);
  }

  return true;
}

/**
 * Remove site chrome from a `<body>` fallback while keeping article-internal
 * headers and footers intact.
 */
function stripBodyChromeNodes(node) {
  if (!node || !Array.isArray(node.childNodes)) {
    return;
  }

  node.childNodes = node.childNodes.filter((childNode) => shouldKeepBodyChild(childNode));
  node.childNodes.forEach((childNode) => {
    if (childNode?.tagName === 'main' || childNode?.tagName === 'article') {
      return;
    }
    stripBodyChromeNodes(childNode);
  });
}

function getNodeText(node) {
  if (!node || typeof node !== 'object') {
    return '';
  }

  if (node.nodeName === '#text') {
    return node.value || '';
  }

  return Array.isArray(node.childNodes)
    ? node.childNodes.map((childNode) => getNodeText(childNode)).join('')
    : '';
}

function getAttribute(node, name) {
  return node?.attrs?.find((attribute) => attribute.name.toLowerCase() === name.toLowerCase())?.value || '';
}

function findNodesByTagName(node, tagName, matches = []) {
  if (!node || typeof node !== 'object') {
    return matches;
  }

  if (node.tagName === tagName) {
    matches.push(node);
  }

  if (Array.isArray(node.childNodes)) {
    node.childNodes.forEach((childNode) => findNodesByTagName(childNode, tagName, matches));
  }

  return matches;
}

function isValidLanguageTag(languageTag, { allowXDefault = false } = {}) {
  if (allowXDefault && languageTag === 'x-default') {
    return true;
  }

  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(languageTag)) {
    return false;
  }

  try {
    Intl.getCanonicalLocales(languageTag);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove blocked nodes from parse5 AST recursively.
 * @param {object} node - parse5 AST node
 * @param {Set<string>} blockedTagNames - Tag names to strip
 */
function stripBlockedNodes(node, blockedTagNames) {
  if (!node || !Array.isArray(node.childNodes)) {
    return;
  }

  node.childNodes = node.childNodes.filter((childNode) => !blockedTagNames.has(childNode.tagName));
  node.childNodes.forEach((childNode) => stripBlockedNodes(childNode, blockedTagNames));
}


// XML entity lookup (defined once, reused for all escapeXml calls)
const XML_ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/**
 * Escape XML special characters (internal helper).
 * @param {string} str - Raw string
 * @returns {string} Escaped XML-safe string
 */
function escapeXml(str) {
  return String(str).replace(/[&<>"']/g, (char) => XML_ENTITIES[char]);
}

function getPageModel(options, filePath) {
  if (options.pageModels instanceof Map) {
    return options.pageModels.get(filePath);
  }
  if (Array.isArray(options.pageModels)) {
    return options.pageModels.find((page) => page.filePath === filePath);
  }
  return null;
}

/**
 * Normalize file path to POSIX-like format (internal helper).
 * @param {string} filePath - Any path
 * @returns {string} POSIX-like path
 */
export function normalizeFilePath(filePath) {
  return filePath
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

/**
 * Extract lastmod timestamp from file or use build date.
 * @param {string} filePath - Absolute file path
 * @param {string} strategy - 'none', 'file-mtime', 'build', or 'git'
 * @param {string} buildDate - ISO 8601 build date
 * @param {{onWarning?: (message: string) => void}} [context={}] - Warning sink
 * @returns {string|null} Verified ISO 8601 timestamp, or null when unavailable
 */
export function extractLastmod(filePath, strategy, buildDate, context = {}) {
  const warn = typeof context.onWarning === 'function'
    ? context.onWarning
    : (message) => console.warn(message);

  if (!strategy || strategy === 'none') {
    return null;
  }

  if (strategy === 'build') {
    return buildDate;
  }

  if (strategy === 'git') {
    try {
      if (!existsSync(filePath)) {
        warn(`⚠️  [Non-fatal] File not found for git lastmod: ${filePath}, omitting lastmod`);
        return null;
      }

      const result = spawnSync(
        'git',
        ['log', '-1', '--format=%cI', '--', filePath],
        {
          cwd: dirname(filePath),
          encoding: 'utf-8',
        },
      );
      const gitTimestamp = result.status === 0 ? result.stdout.trim() : '';

      if (gitTimestamp) {
        return gitTimestamp;
      }
    } catch {
      // Omit unverifiable timestamps.
    }
    warn(`⚠️  [Non-fatal] No git timestamp for ${filePath}, omitting lastmod`);
    return null;
  }

  try {
    if (!existsSync(filePath)) {
      warn(`⚠️  [Non-fatal] File not found for mtime: ${filePath}, omitting lastmod`);
      return null;
    }

    const stats = statSync(filePath);
    return stats.mtime.toISOString();
  } catch (error) {
    warn(`⚠️  [Non-fatal] Failed to read mtime for ${filePath}: ${error.message}, omitting lastmod`);
    return null;
  }
}

/**
 * Resolve effective source path for lastmod timestamp lookup.
 * Strategy:
 * 1) Try mapped source HTML path(s) under sourceHtmlDir.
 * 2) Fallback to dist HTML file path.
 * 3) Return null if neither exists.
 *
 * @param {string} distHtmlFilePath - Absolute HTML file path in dist
 * @param {string} distDir - Dist output directory
 * @param {object} [options={}] - Options
 * @param {string} [options.sourceHtmlDir='src/pages'] - Source HTML directory
 * @param {string[]} [options.stripPathPrefixes] - Prefixes to strip when mapping
 * @returns {string|null} Effective file path for mtime lookup
 */
export function resolveLastmodSourcePath(distHtmlFilePath, distDir, options = {}) {
  const sourceHtmlDir = options.sourceHtmlDir || 'src/pages';
  const projectRoot = options.projectRoot || process.cwd();
  const sourceRoot = isAbsolute(sourceHtmlDir)
    ? sourceHtmlDir
    : resolve(projectRoot, sourceHtmlDir);

  const relativePath = normalizeFilePath(relative(distDir, distHtmlFilePath));
  const stripPathPrefixes = (options.stripPathPrefixes || DEFAULT_STRIP_PATH_PREFIXES)
    .map((prefix) => normalizeFilePath(prefix).replace(/\/+$/, ''))
    .filter((prefix) => prefix.length > 0);

  const sourceCandidates = new Set([relativePath]);

  stripPathPrefixes.forEach((prefix) => {
    if (relativePath === prefix) {
      sourceCandidates.add('');
      return;
    }
    if (relativePath.startsWith(`${prefix}/`)) {
      sourceCandidates.add(relativePath.slice(prefix.length + 1));
    }
  });

  for (const candidate of sourceCandidates) {
    if (!candidate) {
      continue;
    }
    const sourceCandidatePath = resolve(sourceRoot, candidate);
    if (existsSync(sourceCandidatePath)) {
      return sourceCandidatePath;
    }
  }

  if (existsSync(distHtmlFilePath)) {
    return distHtmlFilePath;
  }

  return null;
}

/**
 * Detect if HTML content contains noindex meta tag (internal helper).
 * @param {string} htmlContent - Raw HTML content
 * @returns {boolean} True if noindex is present
 */
function detectNoindex(htmlContent) {
  // Match <meta name="robots" content="...noindex...">
  // Case-insensitive matching
  // Support multiple values in content (e.g., "noindex, nofollow")
  const metaRobotsRegex = /<meta\s+[^>]*name\s*=\s*["']robots["'][^>]*>/gi;
  const matches = htmlContent.match(metaRobotsRegex) || [];
  
  for (const metaTag of matches) {
    const contentMatch = metaTag.match(/content\s*=\s*["']([^"']*)["']/i);
    if (contentMatch) {
      const content = contentMatch[1].toLowerCase();
      if (content.includes('noindex')) {
        return true;
      }
    }
  }
  
  return false;
}

/**
 * Simple glob pattern matcher (supports * and ** wildcards).
 * @param {string} pattern - Glob pattern
 * @param {string} str - String to match
 * @returns {boolean} True if matches
 */
export function matchGlob(pattern, str) {
  // Escape special regex characters except * and /
  const regexPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '___DOUBLESTAR___')
    .replace(/\*/g, '[^/]*')
    .replace(/___DOUBLESTAR___/g, '.*');
  
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(str);
}

/**
 * Classify HTML files as included or excluded without logging.
 * Excluded entries carry the reason so callers can aggregate diagnostics.
 * @param {string[]} htmlFiles - Absolute HTML file paths
 * @param {object} options - Filter options
 * @param {string[]} [options.excludePatterns] - Exclude patterns (glob)
 * @param {string} options.distDir - Output directory
 * @returns {{included: string[], excluded: string[], excludedDetails: Array<{filePath: string, reason: string}>}}
 */
export function classifyHtmlFiles(htmlFiles, options) {
  const { excludePatterns = DEFAULT_EXCLUDE_PATTERNS, distDir } = options;
  const included = [];
  const excluded = [];

  for (const filePath of htmlFiles) {
    const relativePath = normalizeFilePath(relative(distDir, filePath));
    const fileName = basename(filePath);
    let shouldExclude = false;
    let excludeReason = '';
    
    // Check default excludes (404.html, 500.html)
    if (DEFAULT_EXCLUDE_PATTERNS.includes(fileName)) {
      shouldExclude = true;
      excludeReason = 'default exclude';
    }
    
    // Check custom exclude patterns
    if (!shouldExclude && excludePatterns && excludePatterns.length > 0) {
      for (const pattern of excludePatterns) {
        if (matchGlob(pattern, relativePath) || matchGlob(pattern, fileName)) {
          shouldExclude = true;
          excludeReason = `matches pattern: ${pattern}`;
          break;
        }
      }
    }
    
    // Check noindex meta tag
    if (!shouldExclude && existsSync(filePath)) {
      try {
        const htmlContent = readFileSync(filePath, 'utf-8');
        if (detectNoindex(htmlContent)) {
          shouldExclude = true;
          excludeReason = 'contains noindex meta tag';
        }
      } catch (error) {
        console.warn(`⚠️  [Non-fatal] Failed to read ${filePath} for noindex detection: ${error.message}`);
        // Continue processing - don't exclude due to read error
      }
    }
    
    if (shouldExclude) {
      excluded.push({ filePath, reason: excludeReason });
    } else {
      included.push(filePath);
    }
  }

  return {
    included,
    excluded: excluded.map((entry) => entry.filePath),
    excludedDetails: excluded,
  };
}

/**
 * Filter HTML files by applying noindex detection and custom exclude patterns.
 * @param {string[]} htmlFiles - Absolute HTML file paths
 * @param {object} options - Filter options
 * @param {string[]} [options.excludePatterns] - Exclude patterns (glob)
 * @param {string} options.distDir - Output directory
 * @returns {Promise<{included: string[], excluded: string[]}>}
 */
export async function filterHtmlFiles(htmlFiles, options) {
  const { included, excluded, excludedDetails } = classifyHtmlFiles(htmlFiles, options);

  // Log excluded files
  if (excludedDetails.length > 0) {
    console.log(`\n🚫 Excluded ${excludedDetails.length} file(s):`);
    excludedDetails.forEach(({ filePath, reason }) => {
      const fileName = basename(filePath);
      console.log(`   - ${fileName} (${reason})`);
    });
  }

  return {
    included,
    excluded,
  };
}

/**
 * Normalize a route base path to canonical `'' | '/' | '/path/'` form.
 * Rejects absolute URLs (for example a CDN `base`); callers must set
 * `routeBasePath` explicitly when the site is served from a path.
 * @param {string} value - Raw route base path
 * @param {{source?: string}} [context={}] - Error context
 * @returns {string} Canonical route base path
 */
export function normalizeRouteBasePath(value, context = {}) {
  const source = context.source || 'routeBasePath';

  if (value === undefined || value === null) {
    return '';
  }

  const raw = String(value).trim();
  if (raw === '' || raw === './') {
    return '';
  }
  if (raw === '/') {
    return '/';
  }

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw) || raw.startsWith('//')) {
    throw new Error(
      `${source} must be a URL path such as "/docs/", not an absolute URL: "${raw}". `
      + 'Set `routeBasePath` explicitly to the path the site is served from.',
    );
  }

  const pathOnly = raw.split(/[?#]/, 1)[0];
  if (!pathOnly || pathOnly.includes('\\') || /[\u0000-\u001f\u007f]/.test(pathOnly)) {
    throw new Error(`Invalid ${source}: "${raw}". Use a URL path such as "/docs/".`);
  }

  const segments = pathOnly.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`Invalid ${source}: "${raw}". Path segments must not be "." or "..".`);
  }

  return segments.length > 0 ? `/${segments.join('/')}/` : '';
}

/**
 * Compose page URL by joining site URL + route base path + page path.
 * @param {string} siteUrl - Site URL in metadata
 * @param {string} pagePath - Page path without leading slash
 * @param {string} routeBasePath - Optional route base path
 * @returns {string} Final absolute URL without trailing slash
 */
export function composePageUrl(siteUrl, pagePath, routeBasePath = '') {
  const normalizedBasePath = normalizeRouteBasePath(routeBasePath)
    .replace(/^\/+|\/+$/g, '');
  const normalizedPagePath = normalizeFilePath(pagePath);
  const joinedPath = [normalizedBasePath, normalizedPagePath]
    .filter(Boolean)
    .join('/');

  const baseUrl = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;

  if (!joinedPath) {
    return siteUrl.endsWith('/') ? siteUrl.slice(0, -1) : siteUrl;
  }

  return new URL(joinedPath, baseUrl).toString().replace(/\/$/, '');
}

function composePublicFileUrl(siteUrl, filePath, routeBasePath = '') {
  if (/^[a-z][a-z\d+.-]*:/i.test(filePath)) {
    return filePath;
  }

  return composePageUrl(siteUrl, filePath, routeBasePath);
}

/**
 * Recursively find all HTML files in a directory.
 * @param {string} dirPath - Directory path
 * @param {string[]} [htmlFiles=[]] - Recursive accumulator
 * @returns {string[]} HTML file absolute paths
 */
export function findHtmlFiles(dirPath, htmlFiles = []) {
  if (!existsSync(dirPath)) {
    return htmlFiles;
  }

  const entries = readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      findHtmlFiles(fullPath, htmlFiles);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      htmlFiles.push(fullPath);
    }
  }

  return htmlFiles.sort((a, b) => a.localeCompare(b));
}

/**
 * Unified page path resolver - combines path normalization, prefix stripping, and pretty URL conversion.
 * This is the primary function for converting HTML file paths to URL paths.
 *
 * @param {string} relativePath - Relative path from dist directory
 * @param {object} [options={}] - Options
 * @param {string[]} [options.stripPathPrefixes] - Prefixes to strip (e.g., ['src/pages/'])
 * @param {boolean} [options.prettyUrls=true] - Enable Pretty URLs (remove .html)
 * @returns {string} Resolved page path without leading slash
 */
export function resolvePagePath(relativePath, options = {}) {
  const prettyUrls = options.prettyUrls !== false;

  // Step 1: Normalize file path
  let path = normalizeFilePath(relativePath);

  // Step 2: Strip configured prefixes
  const stripPathPrefixes = (options.stripPathPrefixes || DEFAULT_STRIP_PATH_PREFIXES)
    .map((prefix) => normalizeFilePath(prefix).replace(/\/+$/, ''))
    .filter(Boolean);

  for (const prefix of stripPathPrefixes) {
    if (path === prefix) {
      path = '';
      break;
    }
    if (path.startsWith(`${prefix}/`)) {
      path = path.slice(prefix.length + 1);
      break;
    }
  }

  // Step 3: Apply strict prettyUrls semantics while keeping homepage special-case.
  // - prettyUrls: true  => remove ".html" and collapse "*/index.html" to directory path
  // - prettyUrls: false => keep ".html" for non-home pages
  if (path === 'index' || path === 'index.html') {
    path = '';
  } else if (path.endsWith('/index') || path.endsWith('/index.html')) {
    if (prettyUrls) {
      path = path.replace(/\/index(?:\.html)?$/, '');
    } else if (!path.endsWith('.html')) {
      path = `${path}.html`;
    }
  } else if (path.endsWith('.html')) {
    if (prettyUrls) {
      path = path.slice(0, -'.html'.length);
    }
  }

  return path;
}

function normalizeMarkdownOutput(markdownContent) {
  return String(markdownContent || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/^(\s*(?:-|\d+\.))\s+/gm, '$1 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function resolveEffectiveBaseUrl(documentAst, baseUrl) {
  if (!baseUrl) {
    return '';
  }

  const baseNode = findFirstNodeByTagName(documentAst, 'base');
  const href = getAttribute(baseNode, 'href').trim();
  if (!href) {
    return baseUrl;
  }

  return resolveHttpUrl(href, baseUrl) || baseUrl;
}

function resolveResourceUrl(value, baseUrl) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('#') || ABSOLUTE_URL_SCHEME_PATTERN.test(raw)) {
    return value;
  }

  return resolveHttpUrl(raw, baseUrl) || value;
}

function rewriteImageSources(node, baseUrl) {
  if (!node || typeof node !== 'object') {
    return;
  }

  if (node.tagName === 'img') {
    const src = getAttribute(node, 'src');
    const resolved = src ? resolveResourceUrl(src, baseUrl) : src;
    if (resolved && resolved !== src) {
      const srcAttribute = node.attrs?.find((attribute) => attribute.name.toLowerCase() === 'src');
      if (srcAttribute) {
        srcAttribute.value = resolved;
      }
    }
  }

  if (Array.isArray(node.childNodes)) {
    node.childNodes.forEach((childNode) => rewriteImageSources(childNode, baseUrl));
  }
}

/**
 * Convert HTML content to Markdown format.
 * The page's semantic content container is preferred; body fallback removes
 * site chrome so mirrors keep mainly the title, description, and article body.
 *
 * @param {object} documentAst - parse5 document AST
 * @param {object} [options]
 * @param {string} [options.baseUrl] - Public URL of the built HTML file
 * @returns {string} Markdown formatted content
 */
function convertHtmlAstToMarkdown(documentAst, { baseUrl = '' } = {}) {
  const effectiveBaseUrl = resolveEffectiveBaseUrl(documentAst, baseUrl);

  const convertRootNode = (rootNode, bodyFallback) => {
    stripBlockedNodes(rootNode, MARKDOWN_STRIP_TAGS);
    if (bodyFallback) {
      stripBodyChromeNodes(rootNode);
    }
    if (effectiveBaseUrl) {
      rewriteImageSources(rootNode, effectiveBaseUrl);
    }

    const cleanedHtml = (serialize(rootNode) || '').trim();
    if (!cleanedHtml) {
      return '';
    }

    return normalizeMarkdownOutput(turndownService.turndown(cleanedHtml));
  };

  const selection = selectMarkdownContentRoot(documentAst);
  const markdown = convertRootNode(selection.node, selection.bodyFallback);
  if (markdown || selection.bodyFallback) {
    return markdown;
  }

  // An empty semantic container (for example an app shell) should not suppress
  // readable body content. Retry with the body and its chrome cleanup.
  const bodyNode = findFirstNodeByTagName(documentAst, 'body');
  return bodyNode ? convertRootNode(bodyNode, true) : '';
}

export function convertHtmlToMarkdown(htmlContent, options = {}) {
  if (typeof htmlContent !== 'string' || htmlContent.trim() === '') {
    return '';
  }

  try {
    const documentAst = parse(htmlContent);
    return convertHtmlAstToMarkdown(documentAst, options);
  } catch (error) {
    console.warn(`⚠️  [Non-fatal] Failed HTML->Markdown conversion: ${error.message}, fallback to text-only mode`);

    return htmlContent
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

function normalizeInlineText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compose a mirror with a title heading, description blockquote, and the
 * content extracted from the built page. A leading H1 identical to the title
 * is removed so the mirror does not repeat the same heading.
 *
 * @param {object} page - Page model with title, description, and markdown
 * @returns {string} Mirror body (without the ownership marker)
 */
export function composeMarkdownMirrorContent({ title, description, markdown } = {}) {
  const normalizedTitle = normalizeInlineText(title);
  const normalizedDescription = normalizeInlineText(description);
  let body = String(markdown || '').replace(/\r\n/g, '\n').trim();

  if (normalizedTitle && body) {
    const lines = body.split('\n');
    const firstContentIndex = lines.findIndex((line) => line.trim() !== '');
    if (firstContentIndex !== -1) {
      const headingMatch = lines[firstContentIndex].trim().match(LEADING_H1_PATTERN);
      if (
        headingMatch
        && normalizeInlineText(headingMatch[1]).toLowerCase() === normalizedTitle.toLowerCase()
      ) {
        lines.splice(firstContentIndex, 1);
        while (firstContentIndex < lines.length && lines[firstContentIndex].trim() === '') {
          lines.splice(firstContentIndex, 1);
        }
        body = lines.join('\n').trim();
      }
    }
  }

  const parts = [];
  if (normalizedTitle) {
    parts.push(`# ${normalizedTitle}`);
  }
  if (
    normalizedDescription
    && normalizedDescription.toLowerCase() !== normalizedTitle.toLowerCase()
  ) {
    parts.push(`> ${normalizedDescription}`);
  }
  if (body) {
    parts.push(body);
  }

  return parts.join('\n\n');
}

export function analyzeHtmlPage(htmlContent, { audit = false, baseUrl = '' } = {}) {
  const source = String(htmlContent || '');
  const documentAst = parse(source);
  const titleNode = findFirstNodeByTagName(documentAst, 'title');
  const htmlNode = findFirstNodeByTagName(documentAst, 'html');
  const metaNodes = findNodesByTagName(documentAst, 'meta');
  const linkNodes = findNodesByTagName(documentAst, 'link');
  const descriptionNode = metaNodes.find(
    (node) => getAttribute(node, 'name').toLowerCase() === 'description',
  );
  const noindex = metaNodes.some((node) => {
    const name = getAttribute(node, 'name').toLowerCase();
    const content = getAttribute(node, 'content').toLowerCase();
    return name === 'robots' && content.split(/[\s,]+/).includes('noindex');
  });
  // Declared alternates are cheap to collect here and drive per-page hreflang
  // in the sitemap when `hreflangFromHtml` is enabled.
  const hreflang = [];
  for (const link of linkNodes) {
    const relTokens = getAttribute(link, 'rel').toLowerCase().split(/\s+/).filter(Boolean);
    const languageTag = getAttribute(link, 'hreflang').trim();
    const href = getAttribute(link, 'href').trim();
    if (!relTokens.includes('alternate') || !languageTag || !href) continue;
    hreflang.push({ hreflang: languageTag, href });
  }

  return {
    title: getNodeText(titleNode).trim(),
    description: getAttribute(descriptionNode, 'content').trim(),
    lang: getAttribute(htmlNode, 'lang').trim(),
    noindex,
    hreflang,
    ...(audit ? { audit: collectAuditFacts(documentAst) } : {}),
    markdown: convertHtmlAstToMarkdown(documentAst, { baseUrl }),
  };
}

function resolveHttpUrl(value, baseUrl) {
  try {
    const resolved = new URL(value, baseUrl);
    return ['http:', 'https:'].includes(resolved.protocol) ? resolved.toString() : null;
  } catch {
    return null;
  }
}

function normalizeComparableUrl(value) {
  try {
    const resolved = new URL(value);
    resolved.hash = '';
    const serialized = resolved.toString();
    // /en/ and /en address the same page; keep the site root slash so that
    // https://example.test/ still matches its canonical serialization.
    return resolved.pathname !== '/' && serialized.endsWith('/')
      ? serialized.slice(0, -1)
      : serialized;
  } catch {
    return null;
  }
}

/**
 * Resolve the first valid Markdown alternate declared by an HTML page.
 * @param {string} htmlContent - Raw HTML source
 * @param {string} pageUrl - Absolute public page URL
 * @returns {string|null} Absolute Markdown URL
 */
export function resolveMarkdownAlternateUrl(htmlContent, pageUrl) {
  const documentAst = parse(String(htmlContent || ''));
  const links = findNodesByTagName(documentAst, 'link');

  for (const link of links) {
    const relTokens = getAttribute(link, 'rel').toLowerCase().split(/\s+/).filter(Boolean);
    const type = getAttribute(link, 'type').toLowerCase();
    if (!relTokens.includes('alternate') || type !== 'text/markdown') {
      continue;
    }
    const resolved = resolveHttpUrl(getAttribute(link, 'href'), pageUrl);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

/**
 * Derive the Markdown mirror path from the public page path.
 * The result is what gets emitted into dist and is also the public mirror URL,
 * so it must never contain the HTML bundle path or intermediate prefixes.
 * @param {string} pagePath - Public page path from resolvePagePath ('' for home)
 * @param {'append'|'replace'} style - Mirror naming style
 * @returns {string} Markdown mirror path relative to dist root
 */
export function resolveMarkdownMirrorPath(pagePath, style = 'append') {
  const normalizedPath = normalizeFilePath(pagePath);

  if (!normalizedPath || normalizedPath === 'index' || normalizedPath === 'index.html') {
    return 'index.md';
  }

  if (style === 'replace' && /\.html?$/i.test(normalizedPath)) {
    return normalizedPath.replace(/\.html?$/i, '.md');
  }

  return `${normalizedPath}.md`;
}

/**
 * Resolve the public URL of the built HTML file, used as the base for
 * absolutizing relative image sources in Markdown mirrors.
 * @param {string} relativePath - HTML path relative to dist root
 * @param {string} siteUrl - Site origin
 * @param {object} [options] - Resolved geo options
 * @returns {string} Absolute HTML file URL
 */
export function resolveMarkdownResourceBaseUrl(relativePath, siteUrl, options = {}) {
  const filePagePath = resolvePagePath(relativePath, { ...options, prettyUrls: false });
  const fileUrl = composePageUrl(siteUrl, filePagePath, options.routeBasePath);

  // Home pages are directories, so relative resources must resolve against a
  // trailing-slash base rather than treating the last segment as a file.
  if (!filePagePath) {
    return fileUrl.endsWith('/') ? fileUrl : `${fileUrl}/`;
  }

  return fileUrl;
}

/**
 * Add llms.txt v2 discovery links without replacing unrelated page metadata.
 * @param {string} htmlContent - Raw HTML source
 * @param {object} links - Discovery targets
 * @param {string|null} links.markdownUrl - Absolute Markdown alternate URL
 * @param {string} links.llmsUrl - Absolute scoped llms.txt URL
 * @param {string} links.pageUrl - Absolute public page URL
 * @returns {string} Updated HTML source
 */
export function injectLlmsDiscoveryLinks(htmlContent, { markdownUrl, llmsUrl, pageUrl, onInspect, inspectionFacts }) {
  const source = String(htmlContent || '');
  const canInsert = /<\/head>/i.test(source);
  if (!canInsert && inspectionFacts) {
    onInspect?.(null, [], inspectionFacts);
    return source;
  }
  if (!canInsert && !onInspect) return source;

  const documentAst = parse(source, { sourceCodeLocationInfo: Boolean(onInspect) });
  const links = findNodesByTagName(documentAst, 'link');
  const hasMarkdownAlternate = links.some((link) => {
    const relTokens = getAttribute(link, 'rel').toLowerCase().split(/\s+/).filter(Boolean);
    if (!relTokens.includes('alternate') || getAttribute(link, 'type').toLowerCase() !== 'text/markdown') {
      return false;
    }
    return Boolean(resolveHttpUrl(getAttribute(link, 'href'), pageUrl));
  });
  const hasLlmsDescription = links.some((link) => {
    const relTokens = getAttribute(link, 'rel').toLowerCase().split(/\s+/).filter(Boolean);
    const resolvedHref = resolveHttpUrl(getAttribute(link, 'href'), pageUrl);
    return relTokens.includes('describedby')
      && getAttribute(link, 'type').toLowerCase() === 'text/markdown'
      && resolvedHref === llmsUrl;
  });

  const additions = [];
  const addedLinks = [];
  if (canInsert && markdownUrl && !hasMarkdownAlternate) {
    addedLinks.push({ rel: 'alternate', type: 'text/markdown', href: markdownUrl, hreflang: '' });
    additions.push(`<link rel="alternate" type="text/markdown" href="${markdownUrl}" />`);
  }
  if (canInsert && !hasLlmsDescription) {
    addedLinks.push({ rel: 'describedby', type: 'text/markdown', href: llmsUrl, hreflang: '' });
    additions.push(`<link rel="describedby" type="text/markdown" href="${llmsUrl}" />`);
  }
  const updated = additions.length === 0
    ? source
    : source.replace(/<\/head>/i, `${additions.join('')}</head>`);
  if (onInspect) {
    // Literal closing tags inside comments/scripts do not create real head links.
    const headEnd = findFirstNodeByTagName(documentAst, 'head')?.sourceCodeLocation?.endTag?.startOffset;
    if (headEnd === undefined && additions.length > 0) {
      // An implicit head has no source location. Inspect the changed HTML rather
      // than guessing where its new links landed; ordinary pages reuse the AST.
      onInspect(parse(updated), []);
    } else {
      onInspect(documentAst, headEnd === source.search(/<\/head>/i) ? addedLinks : []);
    }
  }
  return updated;
}

/**
 * Group candidates that resolve to the same public page path and resolve
 * conflicts deterministically.
 *
 * By default a duplicate route throws: silently dropping a page hides it from
 * sitemap, feed, and llms.txt without any signal. `routeConflict: 'first'` or
 * `'last'` opts into the previous lenient behavior.
 *
 * @param {Map<string, Array<{relativePath: string}>>} groups - pagePath -> candidates
 * @param {object} [options={}] - Options
 * @param {'error'|'first'|'last'} [options.routeConflict='error'] - Conflict policy
 * @returns {{selected: Array<object>, conflicts: Array<{pagePath: string, route: string, files: string[], chosen: string}>}}
 */
export function resolvePagePathConflicts(groups, options = {}) {
  const policy = options.routeConflict || 'error';
  const selected = [];
  const conflicts = [];

  for (const [pagePath, entries] of groups) {
    if (entries.length === 1) {
      selected.push(entries[0]);
      continue;
    }

    const sorted = [...entries].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    const files = sorted.map((entry) => entry.relativePath);
    const route = pagePath ? `/${pagePath}` : '/';

    if (policy === 'error') {
      throw new Error(
        `Route conflict: ${files.length} files map to the same public page "${route}": ${files.join('、')}. `
        + "Remove or rename one of them, or set routeConflict: 'first' or 'last' to choose deterministically.",
      );
    }

    const chosen = policy === 'last' ? sorted[sorted.length - 1] : sorted[0];
    conflicts.push({ pagePath, route, files, chosen: chosen.relativePath });
    selected.push(chosen);
  }

  selected.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { selected, conflicts };
}

/**
 * Dedupe HTML files by route page path.
 * @param {string[]} htmlFiles - Candidate absolute HTML file paths
 * @param {string} distDir - Dist output directory
 * @param {object} [options={}] - Options
 * @param {string[]} [options.stripPathPrefixes] - Prefixes to strip
 * @param {'error'|'first'|'last'} [options.routeConflict] - Conflict policy
 * @returns {string[]} Dedupe HTML file paths
 */
export function dedupeHtmlFilesByPagePath(htmlFiles, distDir, options = {}) {
  const groups = new Map();

  for (const filePath of htmlFiles) {
    const relativePath = normalizeFilePath(relative(distDir, filePath));
    const pagePath = resolvePagePath(relativePath, options);
    if (!groups.has(pagePath)) groups.set(pagePath, []);
    groups.get(pagePath).push({ filePath, relativePath });
  }

  const { selected } = resolvePagePathConflicts(groups, options);
  return selected
    .map((entry) => entry.filePath)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Extract page title + meta description from HTML source.
 * @param {string} htmlContent - Raw HTML source
 * @returns {{title: string, description: string}}
 */
export function extractPageMetadata(htmlContent, options = {}) {
  const { includeLang = false } = options;
  const analyzed = analyzeHtmlPage(htmlContent);
  const { title, description } = analyzed;

  const result = { title, description };

  if (includeLang) {
    result.lang = analyzed.lang;
  }

  return result;
}

/**
 * Generate sitemap.xml content with support for splitting and hreflang.
 * Uses metadata caching for improved performance.
 * 
 * @param {string} baseUrl - Site URL
 * @param {string[]} htmlFiles - Absolute HTML file paths
 * @param {string} distDir - Dist output directory
 * @param {string} currentDate - Date string in YYYY-MM-DD or ISO 8601
 * @param {object} [options={}] - Options
 * @param {string} [options.routeBasePath=''] - Optional route base path
 * @param {string[]} [options.stripPathPrefixes] - Prefixes to strip
 * @param {string} [options.sourceHtmlDir='src/pages'] - Source HTML directory for mtime lookup
 * @param {string} [options.lastmodStrategy='none'] - 'none', 'file-mtime', 'build', or 'git'
 * @param {boolean} [options.prettyUrls=true] - Enable Pretty URLs (remove .html)
 * @param {boolean} [options.sitemapIndex=true] - Enable sitemap splitting
 * @param {object} [options.hreflang] - Hreflang configuration {langCode: urlPattern}
 * @returns {Array<{filename: string, content: string}>} Array of sitemap files
 */
export function generateSitemap(baseUrl, htmlFiles, distDir, currentDate, options = {}) {
  const dedupedHtmlFiles = dedupeHtmlFilesByPagePath(htmlFiles, distDir, options);
  const lastmodStrategy = options.lastmodStrategy || 'none';
  const buildDate = currentDate.includes('T') ? currentDate : new Date(currentDate).toISOString();
  const prettyUrls = options.prettyUrls !== false;
  const sitemapIndex = options.sitemapIndex !== false; // Default to true
  const sitemapMaxBytes = options.sitemapMaxBytes || SITEMAP_MAX_BYTES;
  const hreflangConfig = options.hreflang;
  const hreflangFromHtml = options.hreflangFromHtml === true;

  // Check if we need xmlns:xhtml namespace for hreflang
  const needsXhtmlNamespace = (hreflangConfig && Object.keys(hreflangConfig).length > 0)
    || (hreflangFromHtml && dedupedHtmlFiles.some(
      (filePath) => (getPageModel(options, filePath)?.hreflang || []).length > 0,
    ));

  const urlEntries = dedupedHtmlFiles.map((filePath) => {
    const relativePath = normalizeFilePath(relative(distDir, filePath));
    // Use unified resolvePagePath with prettyUrls option
    const pagePath = resolvePagePath(relativePath, { ...options, prettyUrls });

    const loc = composePageUrl(baseUrl, pagePath, options.routeBasePath);
    const pageModel = getPageModel(options, filePath);
    const mtimeSourcePath = resolveLastmodSourcePath(filePath, distDir, options);
    // pageModel.mtime already contains the lastmodResolver result and the
    // configured strategy. Do not short-circuit on strategy 'none' here:
    // a resolver is allowed to provide timestamps with the default strategy.
    const lastmod = pageModel
      ? pageModel.mtime
      : (lastmodStrategy === 'none'
        ? null
        : extractLastmod(mtimeSourcePath || filePath, lastmodStrategy, buildDate));

    // Per-page declarations win when enabled; pages without any fall back to
    // the global hreflang patterns.
    let hreflangLinks = [];
    if (hreflangFromHtml && pageModel?.hreflang?.length > 0) {
      hreflangLinks = generateHreflangLinksFromHtml(
        pageModel.hreflang,
        pageModel.lang,
        loc,
        baseUrl,
      );
    } else if (hreflangConfig) {
      hreflangLinks = generateHreflangLinks(pagePath, hreflangConfig, baseUrl);
    }

    let urlEntry = `  <url>\n    <loc>${escapeXml(loc)}</loc>`;
    if (lastmod) {
      urlEntry += `\n    <lastmod>${escapeXml(lastmod)}</lastmod>`;
    }

    if (hreflangLinks.length > 0) {
      urlEntry += '\n' + hreflangLinks.join('\n');
    }

    urlEntry += '\n  </url>';

    return urlEntry;
  });

  const xmlnsXhtml = needsXhtmlNamespace ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : '';
  const singleSitemapContent = buildSitemapXml(urlEntries, xmlnsXhtml);

  if (!sitemapIndex && urlEntries.length > SITEMAP_MAX_URLS) {
    throw new Error('Sitemap exceeds the 50,000 URL limit while sitemapIndex is disabled.');
  }

  // Check if we need to split the sitemap by URL count or protocol byte limit.
  if (
    sitemapIndex &&
    (urlEntries.length > SITEMAP_MAX_URLS || Buffer.byteLength(singleSitemapContent, 'utf-8') > sitemapMaxBytes)
  ) {
    const sitemapFiles = splitSitemap(urlEntries, {
      maxUrlsPerFile: SITEMAP_MAX_URLS,
      maxBytesPerFile: sitemapMaxBytes,
      xmlnsXhtml,
    });

    if (sitemapFiles.length === 1 && sitemapFiles[0].filename === 'sitemap.xml') {
      return sitemapFiles;
    }

    // Generate sitemap index
    const sitemapIndexContent = generateSitemapIndex(
      sitemapFiles.map(f => f.filename),
      baseUrl,
      lastmodStrategy === 'none' ? null : buildDate,
      options.routeBasePath,
    );

    return [
      ...sitemapFiles,
      { filename: 'sitemap_index.xml', content: sitemapIndexContent }
    ];
  }

  if (Buffer.byteLength(singleSitemapContent, 'utf-8') > sitemapMaxBytes) {
    throw new Error('Sitemap exceeds the configured byte limit while sitemapIndex is disabled.');
  }

  // Single sitemap file
  return [{ filename: 'sitemap.xml', content: singleSitemapContent }];
}

function buildSitemapXml(urlEntries, xmlnsXhtml = '') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by vite-plugin-geo -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${xmlnsXhtml}>
${urlEntries.join('\n')}
</urlset>`;
}

/**
 * Split sitemap URLs into multiple files if exceeding the limit (internal helper).
 * @param {string[]} urlEntries - Serialized URL entries
 * @param {object} [options={}] - Split limits
 * @param {number} [options.maxUrlsPerFile=50000] - Maximum URLs per sitemap file
 * @param {number} [options.maxBytesPerFile=52428800] - Maximum uncompressed sitemap bytes
 * @param {string} [options.xmlnsXhtml=''] - Optional xhtml namespace
 * @returns {Array<{filename: string, content: string}>} Array of sitemap files
 */
function splitSitemap(urlEntries, options = {}) {
  const maxUrlsPerFile = options.maxUrlsPerFile || SITEMAP_MAX_URLS;
  const maxBytesPerFile = options.maxBytesPerFile || SITEMAP_MAX_BYTES;
  const xmlnsXhtml = options.xmlnsXhtml || '';

  // If within limit, return single sitemap
  const singleContent = buildSitemapXml(urlEntries, xmlnsXhtml);
  if (
    urlEntries.length <= maxUrlsPerFile &&
    Buffer.byteLength(singleContent, 'utf-8') <= maxBytesPerFile
  ) {
    return [{ filename: 'sitemap.xml', content: singleContent }];
  }

  // Split into multiple sitemaps
  const chunks = [];
  let currentChunk = [];

  urlEntries.forEach((entry) => {
    const nextChunk = [...currentChunk, entry];
    const nextContent = buildSitemapXml(nextChunk, xmlnsXhtml);
    const exceedsUrlLimit = nextChunk.length > maxUrlsPerFile;
    const exceedsByteLimit = Buffer.byteLength(nextContent, 'utf-8') > maxBytesPerFile;

    if (currentChunk.length > 0 && (exceedsUrlLimit || exceedsByteLimit)) {
      chunks.push(currentChunk);
      const singleEntryContent = buildSitemapXml([entry], xmlnsXhtml);
      if (Buffer.byteLength(singleEntryContent, 'utf-8') > maxBytesPerFile) {
        throw new Error('A single sitemap entry exceeds the configured byte limit.');
      }
      currentChunk = [entry];
      return;
    }

    if (currentChunk.length === 0 && exceedsByteLimit) {
      throw new Error('A single sitemap entry exceeds the configured byte limit.');
    }

    currentChunk = nextChunk;
  });

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  if (chunks.length <= 1) {
    return [{ filename: 'sitemap.xml', content: buildSitemapXml(chunks[0] || [], xmlnsXhtml) }];
  }

  return chunks.map((chunk, index) => ({
    filename: `sitemap_${index + 1}.xml`,
    content: buildSitemapXml(chunk, xmlnsXhtml),
  }));
}
/**
 * Generate sitemap index file referencing multiple sitemap files (internal helper).
 * @param {Array<string>} sitemapFiles - Array of sitemap filenames (e.g., ['sitemap_1.xml', 'sitemap_2.xml'])
 * @param {string} baseUrl - Site base URL
 * @param {string|null} lastmod - ISO 8601 timestamp for lastmod, or null to omit
 * @returns {string} sitemap_index.xml content
 */
function generateSitemapIndex(sitemapFiles, baseUrl, lastmod, routeBasePath = '') {
  const sitemapEntries = sitemapFiles.map((filename) => {
    const loc = composePageUrl(baseUrl, filename, routeBasePath);
    return `  <sitemap>
    <loc>${escapeXml(loc)}</loc>${lastmod ? `
    <lastmod>${escapeXml(lastmod)}</lastmod>` : ''}
  </sitemap>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by vite-plugin-geo -->
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapEntries.join('\n')}
</sitemapindex>`;
}
/**
 * Build xhtml:link elements from alternates declared in one page's HTML.
 * Declarations are authoritative; a self entry is synthesized from
 * `<html lang>` when missing, and x-default is never invented.
 */
function generateHreflangLinksFromHtml(declared, lang, pageUrl, baseUrl) {
  const links = new Map();

  for (const entry of declared) {
    const languageTag = String(entry?.hreflang || '').trim();
    if (!languageTag || !isValidLanguageTag(languageTag, { allowXDefault: true })) continue;
    const href = resolveHttpUrl(entry?.href, pageUrl || baseUrl);
    if (!href) continue;
    links.set(`${languageTag}\0${href}`, { hreflang: languageTag, href });
  }

  const normalizedLang = String(lang || '').trim();
  const selfUrl = resolveHttpUrl(pageUrl || baseUrl, baseUrl);
  const comparableSelfUrl = selfUrl ? normalizeComparableUrl(selfUrl) : null;
  if (normalizedLang && selfUrl && isValidLanguageTag(normalizedLang)) {
    // Any declared non-x-default alternate that resolves to this page counts
    // as the self reference, even when its tag differs from <html lang>
    // (for example en-US vs en). x-default is a fallback, not a language.
    const hasSelf = comparableSelfUrl !== null && [...links.values()].some(({ hreflang, href }) => (
      hreflang.toLowerCase() !== 'x-default'
      && normalizeComparableUrl(href) === comparableSelfUrl
    ));
    if (!hasSelf) {
      links.set(`${normalizedLang}\0${selfUrl}`, { hreflang: normalizedLang, href: selfUrl });
    }
  }

  return [...links.values()]
    .sort((a, b) => a.hreflang.localeCompare(b.hreflang) || a.href.localeCompare(b.href))
    .map(({ hreflang, href }) => (
      `    <xhtml:link rel="alternate" hreflang="${escapeXml(hreflang)}" href="${escapeXml(href)}"/>`
    ));
}

/**
 * Generate hreflang links for a page (internal helper).
 * @param {string} pagePath - Page path (without .html)
 * @param {object} hreflangConfig - Language code to URL pattern mapping
 * @param {string} baseUrl - Site base URL
 * @returns {string[]} Array of xhtml:link elements
 */
function generateHreflangLinks(pagePath, hreflangConfig, baseUrl) {
  if (!hreflangConfig || typeof hreflangConfig !== 'object') {
    return [];
  }

  const hreflangLinks = [];

  for (const [langCode, urlPattern] of Object.entries(hreflangConfig)) {
    if (!isValidLanguageTag(langCode, { allowXDefault: true })) {
      console.warn(`⚠️  Invalid BCP 47 language code: ${langCode}, skipping`);
      continue;
    }

    // Generate URL by replacing {path} placeholder
    let url;
    if (urlPattern.includes('{path}')) {
      url = urlPattern.replace('{path}', pagePath);
    } else {
      url = urlPattern;
    }

    // Ensure URL is absolute
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `${baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl}/${url.replace(/^\//, '')}`;
    }

    // Generate xhtml:link element
    hreflangLinks.push(`    <xhtml:link rel="alternate" hreflang="${escapeXml(langCode)}" href="${escapeXml(url)}"/>`);
  }

  return hreflangLinks;
}
/**
 * Generate humans.txt content following humanstxt.org standard.
 * @param {object} packageJson - Parsed package.json content
 * @param {string} buildDate - ISO 8601 build date
 * @param {object} helpers - Helper functions from geoMetadataResolver
 * @param {Function} helpers.extractTeamInfoFromPackageJson - Team info extractor
 * @param {Function} helpers.extractTechStackFromPackageJson - Tech stack extractor
 * @returns {string} humans.txt content
 */
export function generateHumansTxt(packageJson, buildDate, helpers = {}) {
  const lines = [];

  // Use provided helper functions or create minimal fallback
  const extractTeamInfo = helpers.extractTeamInfoFromPackageJson || (() => ({ author: null, contributors: [] }));
  const extractTechStack = helpers.extractTechStackFromPackageJson || (() => []);

  const teamInfo = extractTeamInfo(packageJson);
  const techStack = extractTechStack(packageJson);

  if (teamInfo.author) {
    const authorLines = [];
    if (teamInfo.author.name) {
      authorLines.push(`  Developer: ${teamInfo.author.name}`);
    }
    if (teamInfo.author.email) {
      authorLines.push(`  Contact: ${teamInfo.author.email}`);
    }
    if (teamInfo.author.url) {
      authorLines.push(`  From: ${teamInfo.author.url}`);
    }
    if (authorLines.length > 0) {
      lines.push('/* TEAM */', ...authorLines, '');
    }
  }

  const contributorNames = (teamInfo.contributors || [])
    .map((contributor) => contributor.name)
    .filter(Boolean);
  if (contributorNames.length > 0) {
    lines.push('/* THANKS */');
    contributorNames.forEach((name) => lines.push(`  ${name}`));
    lines.push('');
  }

  lines.push('/* SITE */');
  const date = new Date(buildDate);
  const formattedDate = date.toISOString().split('T')[0];
  lines.push(`  Last update: ${formattedDate}`);

  if (techStack.length > 0) {
    lines.push(`  Components: ${techStack.join(', ')}`);
  }

  return `${lines.join('\n')}\n`;
}
/**
 * Convert ISO 8601 date to RFC 822 format (required by RSS 2.0) (internal helper).
 * @param {string} isoDate - ISO 8601 date string
 * @returns {string} RFC 822 formatted date
 */
function toRFC822Date(isoDate) {
  const date = new Date(isoDate);

  // RFC 822 format: "Day, DD Mon YYYY HH:MM:SS GMT"
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const dayName = days[date.getUTCDay()];
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = months[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');

  return `${dayName}, ${day} ${month} ${year} ${hours}:${minutes}:${seconds} GMT`;
}

/**
 * 检测 feed 内容的格式类型
 * @param {string} feedContent - feed 文件内容
 * @returns {'rss' | 'atom'} feed 格式类型
 */
export function detectFeedFormat(feedContent) {
  // Atom 格式: <feed xmlns="http://www.w3.org/2005/Atom">
  if (/<feed[^>]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom["']/i.test(feedContent)) {
    return 'atom';
  }
  // RSS 格式: <rss version="...">
  if (/<rss[^>]*version=/i.test(feedContent)) {
    return 'rss';
  }
  // 默认返回 rss
  return 'rss';
}

export function injectFeedLink(htmlContent, feedHref) {
  const newFeedLink = `<link rel="alternate" type="application/rss+xml" title="RSS Feed" href="${String(feedHref)}" />`;
  const linkPattern = /<link\b[^>]*>/gi;
  let replaced = false;
  const updatedHtml = String(htmlContent).replace(linkPattern, (linkTag) => {
    const rel = linkTag.match(/\brel\s*=\s*(["'])(.*?)\1/i)?.[2]?.toLowerCase() || '';
    const type = linkTag.match(/\btype\s*=\s*(["'])(.*?)\1/i)?.[2]?.toLowerCase() || '';
    const title = linkTag.match(/\btitle\s*=\s*(["'])(.*?)\1/i)?.[2]?.toLowerCase() || '';
    const isFeedLink = rel.split(/\s+/).includes('alternate')
      && (
        type === 'application/rss+xml'
        || type === 'application/atom+xml'
        || title === 'rss feed'
        || title === 'atom feed'
      );

    if (!isFeedLink) {
      return linkTag;
    }

    if (replaced) {
      return '';
    }
    replaced = true;
    return newFeedLink;
  });

  if (replaced) {
    return updatedHtml;
  }

  return /<\/head>/i.test(updatedHtml)
    ? updatedHtml.replace(/<\/head>/i, `${newFeedLink}</head>`)
    : updatedHtml;
}

/**
 * Generate RSS 2.0 feed.xml content.
 * @param {Array<{url: string, title: string, description: string, mtime: string}>} pages - Page metadata array
 * @param {object} siteMetadata - Site metadata
 * @param {string} siteMetadata.url - Site URL
 * @param {string} siteMetadata.title - Site title
 * @param {string} siteMetadata.description - Site description
 * @param {string} siteMetadata.lang - Site language
 * @param {string} buildDate - ISO 8601 build date
 * @returns {string} feed.xml content
 */
export function generateFeedXml(pages, siteMetadata, buildDate) {
  const { url, title, description, lang } = siteMetadata;
  const feedUrl = siteMetadata.feedUrl || new URL('feed.xml', `${url.replace(/\/+$/, '')}/`).toString();

  // Sort pages by mtime descending (newest first)
  const sortedPages = [...pages].sort((a, b) => {
    const dateA = a.mtime ? new Date(a.mtime).getTime() : 0;
    const dateB = b.mtime ? new Date(b.mtime).getTime() : 0;
    return dateB - dateA;
  });

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
  lines.push('  <channel>');
  lines.push(`    <title>${escapeXml(title)}</title>`);
  lines.push(`    <link>${escapeXml(url)}</link>`);
  lines.push(`    <description>${escapeXml(description)}</description>`);
  lines.push(`    <language>${escapeXml(lang)}</language>`);
  lines.push(`    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />`);
  lines.push(`    <lastBuildDate>${toRFC822Date(buildDate)}</lastBuildDate>`);
  lines.push('');

  // Generate item elements for each page
  sortedPages.forEach(page => {
    lines.push('    <item>');
    lines.push(`      <title>${escapeXml(page.title)}</title>`);
    lines.push(`      <link>${escapeXml(page.url)}</link>`);
    lines.push(`      <description>${escapeXml(page.description)}</description>`);
    if (page.mtime && !Number.isNaN(new Date(page.mtime).getTime())) {
      lines.push(`      <pubDate>${toRFC822Date(page.mtime)}</pubDate>`);
    }
    lines.push(`      <guid isPermaLink="true">${escapeXml(page.url)}</guid>`);
    lines.push('    </item>');
  });

  lines.push('  </channel>');
  lines.push('</rss>');

  return lines.join('\n');
}

/**
 * Generate llms.txt content.
 * @param {object} siteMetadata - Site metadata
 * @param {string[]} htmlFiles - Absolute HTML file paths
 * @param {string} distDir - Dist output directory
 * @param {object} [options={}] - Options
 * @param {string} [options.routeBasePath=''] - Optional route base path
 * @param {string[]} [options.stripPathPrefixes] - Prefixes to strip
 * @param {boolean} [options.prettyUrls=true] - Enable Pretty URLs (remove .html)
 * @param {string} [options.sitemapUrl='sitemap.xml'] - Public sitemap URL or path
 * @returns {string} llms.txt
 */
export function generateLlmsTxt(siteMetadata, htmlFiles, distDir, options = {}) {
  const { url, title, description } = siteMetadata;
  const pages = collectLlmsPages(siteMetadata, htmlFiles, distDir, options);
  const groupedPages = groupLlmsPages(pages);

  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');

  if (description) {
    lines.push(`> ${description}`);
    lines.push('');
  }

  groupedPages.forEach(({ section, pages: sectionPages }) => {
    lines.push(`## ${section}`);
    sectionPages.forEach((page) => {
      lines.push(`- [${page.title}](${page.url}): ${truncateLlmsDescription(page.description)}`);
    });
    lines.push('');
  });

  if (Array.isArray(options.skuMd?.catalog) && options.skuMd.catalog.length > 0) {
    lines.push('## Product Catalog');
    options.skuMd.catalog.forEach(({ label, url: catalogUrl }) => {
      lines.push(`- [${label}](${catalogUrl}): Browse the merchant storefront catalog`);
    });
    lines.push('');
  }

  if (options.includeOptional !== false) {
    const optionalLinks = [];
    if (options.includeSitemap !== false) {
      optionalLinks.push(`- [Sitemap](${composePublicFileUrl(url, options.sitemapUrl || 'sitemap.xml', options.routeBasePath)}): Complete list of all indexed pages`);
    }
    if (options.includeRobots ?? (options.generateRobots !== false)) {
      optionalLinks.push(`- [robots.txt](${composePageUrl(url, 'robots.txt')}): Search engine crawling instructions`);
    }
    if (optionalLinks.length > 0) {
      lines.push('## Optional', ...optionalLinks);
    }
  }

  return lines.join('\n');
}

function collectLlmsPages(siteMetadata, htmlFiles, distDir, options = {}) {
  const { url } = siteMetadata;
  const prettyUrls = options.prettyUrls !== false;
  const llmsMdMirror = options.llmsMdMirror !== false; // Default to true
  const dedupedHtmlFiles = dedupeHtmlFilesByPagePath(htmlFiles, distDir, options);

  return dedupedHtmlFiles.map((filePath) => {
    const relativePath = normalizeFilePath(relative(distDir, filePath));
    const pageModel = getPageModel(options, filePath);
    const metadata = pageModel || extractPageMetadata(readFileSync(filePath, 'utf-8'));
    const pagePath = resolvePagePath(relativePath, { ...options, prettyUrls });
    const pageUrl = pageModel?.markdownUrl || (
      llmsMdMirror
        ? composePageUrl(
          url,
          resolveMarkdownMirrorPath(pagePath, options.llmsMdMirrorStyle),
          options.routeBasePath,
        )
        : composePageUrl(url, pagePath, options.routeBasePath)
    );
    const page = {
      filePath,
      relativePath,
      pagePath,
      url: pageUrl,
      title: metadata.title || 'Untitled',
      description: metadata.description || metadata.title || 'Page content',
      isHome: pagePath === '',
    };

    return {
      ...page,
      section: resolveLlmsSection(page, options),
    };
  }).sort((a, b) => {
    if (a.isHome && !b.isHome) return -1;
    if (!a.isHome && b.isHome) return 1;
    return a.url.localeCompare(b.url);
  });
}

function resolveLlmsSection(page, options = {}) {
  if (typeof options.llmsClassify === 'function') {
    const section = options.llmsClassify(page);
    if (typeof section === 'string' && section.trim()) {
      return section.trim();
    }
  }

  if (options.llmsSections && typeof options.llmsSections === 'object' && !Array.isArray(options.llmsSections)) {
    for (const [section, patterns] of Object.entries(options.llmsSections)) {
      const patternList = Array.isArray(patterns) ? patterns : [patterns];
      if (patternList.some((pattern) => pattern && page.relativePath.includes(String(pattern)))) {
        return section;
      }
    }
  }

  const path = page.relativePath.toLowerCase();
  if (/(^|\/)(api|reference|sdk)(\/|\.|-|$)/.test(path)) {
    return 'API';
  }
  if (/(^|\/)(examples?|demos?|samples?|tutorials?)(\/|\.|-|$)/.test(path) || path.includes('convert')) {
    return 'Examples';
  }
  return 'Docs';
}

function groupLlmsPages(pages) {
  const preferredOrder = ['Docs', 'Examples', 'API'];
  const sectionMap = new Map();
  pages.forEach((page) => {
    if (!sectionMap.has(page.section)) {
      sectionMap.set(page.section, []);
    }
    sectionMap.get(page.section).push(page);
  });

  const sections = [
    ...preferredOrder.filter((section) => sectionMap.has(section)),
    ...Array.from(sectionMap.keys()).filter((section) => !preferredOrder.includes(section)).sort(),
  ];

  return sections.map((section) => ({
    section,
    pages: sectionMap.get(section),
  }));
}

function truncateLlmsDescription(description) {
  const normalizedDescription = String(description || '').replace(/\s+/g, ' ').trim();
  if (normalizedDescription.length <= 80) {
    return normalizedDescription;
  }
  return `${normalizedDescription.substring(0, 77)}...`;
}

/**
 * Generate robots.txt content following RFC 9309 processing limits.
 * @param {string} baseUrl - Origin-only site URL
 * @param {object} [options={}] - Generator options
 * @param {string} [options.routeBasePath=''] - Public sitemap base path
 * @param {string[]} [options.robotsDirectives=[]] - Custom robots directives
 * @param {string} [options.sitemapUrl='sitemap.xml'] - Public sitemap URL or path
 * @returns {string} robots.txt
 */
export function generateRobotsTxt(baseUrl, options = {}) {
  const robotsDirectives = options.robotsDirectives || [];
  robotsDirectives.forEach((directive) => {
    if (/[\u0000-\u001F\u007F]/.test(String(directive))) {
      throw new Error('robotsDirectives must not contain control characters.');
    }
  });

  const lines = [
    `# robots.txt for ${new URL(baseUrl).hostname}`,
    '# See https://www.rfc-editor.org/rfc/rfc9309',
    '',
    'User-agent: *',
    'Allow: /',
  ];
  if (robotsDirectives.length > 0) {
    lines.push('', '# Custom directives', ...robotsDirectives);
  }
  if (options.includeSitemap !== false) {
    lines.push(
      '',
      `Sitemap: ${composePublicFileUrl(baseUrl, options.sitemapUrl || 'sitemap.xml', options.routeBasePath)}`,
    );
  }

  const content = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(content, 'utf-8') > 500 * 1024) {
    throw new Error('robots.txt exceeds the 500 KiB processing limit.');
  }
  return content;
}
