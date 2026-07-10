/**
 * SEO generator module for sitemap.xml / llms.txt / robots.txt
 */

import { spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, relative, basename, resolve } from 'path';
import { parse, serialize } from 'parse5';
import TurndownService from 'turndown';

const DEFAULT_STRIP_PATH_PREFIXES = ['src/pages/'];
const DEFAULT_EXCLUDE_PATTERNS = ['404.html', '500.html'];
const MARKDOWN_STRIP_TAGS = new Set(['script', 'style', 'noscript', 'template']);
const SITEMAP_MAX_URLS = 50000;
const SITEMAP_MAX_BYTES = 52_428_800;

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  strongDelimiter: '**',
});

turndownService.remove(['script', 'style', 'noscript', 'template']);

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

/**
 * Check if Markdown mirror needs update (incremental update strategy)
 * @param {string} htmlFilePath - HTML file path
 * @param {string} mdFilePath - Markdown file path
 * @returns {boolean} True if update is needed
 */
function needsMarkdownUpdate(htmlFilePath, mdFilePath) {
  try {
    if (!existsSync(mdFilePath)) {
      return true; // MD file doesn't exist, needs creation
    }

    const htmlStats = statSync(htmlFilePath);
    const mdStats = statSync(mdFilePath);

    // Update if HTML is newer than MD
    return htmlStats.mtime > mdStats.mtime;
  } catch (error) {
    return true; // On error, assume update is needed
  }
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
  return str.replace(/[&<>"']/g, (char) => XML_ENTITIES[char]);
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
 * @param {string} strategy - 'file-mtime' or 'build'
 * @param {string} buildDate - ISO 8601 build date fallback
 * @returns {string} ISO 8601 timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)
 */
export function extractLastmod(filePath, strategy, buildDate) {
  if (strategy === 'build') {
    return buildDate;
  }

  if (strategy === 'git') {
    try {
      if (!existsSync(filePath)) {
        console.warn(`⚠️  [Non-fatal] File not found for git lastmod: ${filePath}, using build date`);
        return buildDate;
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
      // Fall through to file mtime below.
    }
  }

  // Default strategy is 'file-mtime'
  try {
    if (!existsSync(filePath)) {
      console.warn(`⚠️  [Non-fatal] File not found for mtime: ${filePath}, using build date`);
      return buildDate;
    }
    
    const stats = statSync(filePath);
    return stats.mtime.toISOString();
  } catch (error) {
    console.warn(`⚠️  [Non-fatal] Failed to read mtime for ${filePath}: ${error.message}, using build date`);
    return buildDate;
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
  const sourceRoot = isAbsolute(sourceHtmlDir)
    ? sourceHtmlDir
    : resolve(process.cwd(), sourceHtmlDir);

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
function matchGlob(pattern, str) {
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
 * Filter HTML files by applying noindex detection and custom exclude patterns.
 * @param {string[]} htmlFiles - Absolute HTML file paths
 * @param {object} options - Filter options
 * @param {string[]} [options.excludePatterns] - Exclude patterns (glob)
 * @param {string} options.distDir - Output directory
 * @returns {Promise<{included: string[], excluded: string[]}>}
 */
export async function filterHtmlFiles(htmlFiles, options) {
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
  
  // Log excluded files
  if (excluded.length > 0) {
    console.log(`\n🚫 Excluded ${excluded.length} file(s):`);
    excluded.forEach(({ filePath, reason }) => {
      const fileName = basename(filePath);
      console.log(`   - ${fileName} (${reason})`);
    });
  }
  
  return {
    included,
    excluded: excluded.map(e => e.filePath),
  };
}

/**
 * Compose page URL by joining site URL + route base path + page path.
 * @param {string} siteUrl - Site URL in metadata
 * @param {string} pagePath - Page path without leading slash
 * @param {string} routeBasePath - Optional route base path
 * @returns {string} Final absolute URL without trailing slash
 */
export function composePageUrl(siteUrl, pagePath, routeBasePath = '') {
  // Inline normalizeRouteBasePath logic
  let normalizedBasePath = '';
  if (routeBasePath && routeBasePath !== '/' && routeBasePath !== './') {
    normalizedBasePath = normalizeFilePath(routeBasePath).replace(/\/+$/, '');
  }

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

/**
 * Convert HTML content to Markdown format.
 * This function extracts text content from HTML and converts it to clean Markdown,
 * making it easier for LLMs to process and understand the content.
 * 
 * @param {string} htmlContent - Raw HTML content
 * @returns {string} Markdown formatted content
 */
export function convertHtmlToMarkdown(htmlContent) {
  if (typeof htmlContent !== 'string' || htmlContent.trim() === '') {
    return '';
  }

  try {
    const documentAst = parse(htmlContent);
    const bodyNode = findFirstNodeByTagName(documentAst, 'body');
    const contentRootNode = bodyNode || documentAst;

    stripBlockedNodes(contentRootNode, MARKDOWN_STRIP_TAGS);
    const cleanedHtml = (serialize(contentRootNode) || '').trim();

    if (!cleanedHtml) {
      return '';
    }

    const markdownContent = turndownService.turndown(cleanedHtml);

    return markdownContent
      .replace(/\r\n/g, '\n')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/^(\s*(?:-|\d+\.))\s+/gm, '$1 ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
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

function getHtmlCandidateScore(relativePath, options = {}) {
  const normalizedRelativePath = normalizeFilePath(relativePath);
  // Check if path uses intermediate prefix by comparing with resolved path
  const resolvedPath = resolvePagePath(relativePath, { ...options, prettyUrls: false });
  // If the original path is much longer than resolved, it likely uses intermediate prefix
  const usesIntermediatePrefix = normalizedRelativePath.length > resolvedPath.length + 5;

  return {
    usesIntermediatePrefix,
    length: normalizedRelativePath.length,
  };
}

/**
 * Dedupe HTML files by route page path.
 * If both intermediate and final paths exist, prefer final route-like path.
 * @param {string[]} htmlFiles - Candidate absolute HTML file paths
 * @param {string} distDir - Dist output directory
 * @param {object} [options={}] - Options
 * @param {string[]} [options.stripPathPrefixes] - Prefixes to strip
 * @returns {string[]} Dedupe HTML file paths
 */
export function dedupeHtmlFilesByPagePath(htmlFiles, distDir, options = {}) {
  const pagePathToCandidate = new Map();

  for (const filePath of htmlFiles) {
    const relativePath = normalizeFilePath(relative(distDir, filePath));
    const pagePath = resolvePagePath(relativePath, options);
    const score = getHtmlCandidateScore(relativePath, options);
    const current = pagePathToCandidate.get(pagePath);

    if (!current) {
      pagePathToCandidate.set(pagePath, { filePath, score });
      continue;
    }

    const shouldReplace =
      (current.score.usesIntermediatePrefix && !score.usesIntermediatePrefix)
      || (
        current.score.usesIntermediatePrefix === score.usesIntermediatePrefix
        && score.length < current.score.length
      );

    if (shouldReplace) {
      pagePathToCandidate.set(pagePath, { filePath, score });
    }
  }

  return Array.from(pagePathToCandidate.values())
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

  const titleMatch = htmlContent.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  let description = '';
  const metaTags = htmlContent.match(/<meta\s+[^>]*>/gi) || [];
  for (const metaTag of metaTags) {
    if (!/\bname\s*=\s*["']description["']/i.test(metaTag)) {
      continue;
    }
    const contentMatch = metaTag.match(/\bcontent\s*=\s*(["'])([\s\S]*?)\1/i);
    description = contentMatch ? contentMatch[2].trim() : '';
    break;
  }

  const result = { title, description };

  if (includeLang) {
    const htmlLangMatch = htmlContent.match(/<html[^>]*\blang=["']([^"']+)["'][^>]*>/i);
    result.lang = htmlLangMatch ? htmlLangMatch[1].trim() : '';
  }

  return result;
}

/**
 * Infer page priority + change frequency (internal helper).
 * @param {string} fileName - HTML file name
 * @param {string} pagePath - Route page path
 * @returns {{priority: number, changefreq: string}}
 */
function getPagePriority(fileName, pagePath) {
  if (fileName === 'index.html' || pagePath === '') {
    return { priority: 1.0, changefreq: 'weekly' };
  }

  if (fileName === 'docs.html' || fileName.includes('convert')) {
    return { priority: 0.8, changefreq: 'weekly' };
  }

  return { priority: 0.6, changefreq: 'monthly' };
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
 * @param {string} [options.lastmodStrategy='file-mtime'] - 'file-mtime' or 'build'
 * @param {boolean} [options.prettyUrls=true] - Enable Pretty URLs (remove .html)
 * @param {boolean} [options.sitemapIndex=true] - Enable sitemap splitting
 * @param {object} [options.hreflang] - Hreflang configuration {langCode: urlPattern}
 * @returns {Array<{filename: string, content: string}>} Array of sitemap files
 */
export function generateSitemap(baseUrl, htmlFiles, distDir, currentDate, options = {}) {
  const dedupedHtmlFiles = dedupeHtmlFilesByPagePath(htmlFiles, distDir, options);
  const lastmodStrategy = options.lastmodStrategy || 'file-mtime';
  const buildDate = currentDate.includes('T') ? currentDate : new Date(currentDate).toISOString();
  const prettyUrls = options.prettyUrls !== false;
  const sitemapIndex = options.sitemapIndex !== false; // Default to true
  const sitemapMaxBytes = options.sitemapMaxBytes || SITEMAP_MAX_BYTES;
  const hreflangConfig = options.hreflang;

  // Check if we need xmlns:xhtml namespace for hreflang
  const needsXhtmlNamespace = hreflangConfig && Object.keys(hreflangConfig).length > 0;

  const urlEntries = dedupedHtmlFiles.map((filePath) => {
    const relativePath = normalizeFilePath(relative(distDir, filePath));
    const fileName = relativePath.split('/').pop();
    // Use unified resolvePagePath with prettyUrls option
    const pagePath = resolvePagePath(relativePath, { ...options, prettyUrls });

    const loc = composePageUrl(baseUrl, pagePath, options.routeBasePath);
    const { priority, changefreq } = getPagePriority(fileName, pagePath);
    const mtimeSourcePath = resolveLastmodSourcePath(filePath, distDir, options);
    const lastmod = extractLastmod(mtimeSourcePath || filePath, lastmodStrategy, buildDate);

    // Generate hreflang links if configured
    const hreflangLinks = hreflangConfig
      ? generateHreflangLinks(pagePath, hreflangConfig, baseUrl)
      : [];

    let urlEntry = `  <url>
    <loc>${escapeXml(loc)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority.toFixed(1)}</priority>`;

    if (hreflangLinks.length > 0) {
      urlEntry += '\n' + hreflangLinks.join('\n');
    }

    urlEntry += '\n  </url>';

    return urlEntry;
  });

  const xmlnsXhtml = needsXhtmlNamespace ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : '';
  const singleSitemapContent = buildSitemapXml(urlEntries, xmlnsXhtml);

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
      buildDate
    );

    return [
      ...sitemapFiles,
      { filename: 'sitemap_index.xml', content: sitemapIndexContent }
    ];
  }

  // Single sitemap file
  return [{ filename: 'sitemap.xml', content: singleSitemapContent }];
}

function buildSitemapXml(urlEntries, xmlnsXhtml = '') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${xmlnsXhtml}>
${urlEntries.join('\n')}
</urlset>`;
}

/**
 * Split sitemap URLs into multiple files if exceeding the limit (internal helper).
 * @param {Array<{loc: string, lastmod: string, changefreq: string, priority: number}>} urlEntries - URL entries
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
      currentChunk = [entry];
      return;
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
 * @param {string} lastmod - ISO 8601 timestamp for lastmod
 * @returns {string} sitemap_index.xml content
 */
function generateSitemapIndex(sitemapFiles, baseUrl, lastmod) {
  const sitemapEntries = sitemapFiles.map((filename) => {
    const loc = `${baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl}/${filename}`;
    return `  <sitemap>
    <loc>${escapeXml(loc)}</loc>
    <lastmod>${lastmod}</lastmod>
  </sitemap>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapEntries.join('\n')}
</sitemapindex>`;
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

  // BCP 47 format regex (inlined validateLanguageCode)
  const bcp47Regex = /^[a-z]{2}(-[A-Z]{2})?$/;
  const hreflangLinks = [];

  for (const [langCode, urlPattern] of Object.entries(hreflangConfig)) {
    // Validate language code (inlined)
    if (!bcp47Regex.test(langCode)) {
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

  // TEAM section
  lines.push('/* TEAM */');
  if (teamInfo.author) {
    if (teamInfo.author.name) {
      lines.push(`  Developer: ${teamInfo.author.name}`);
    }
    if (teamInfo.author.email) {
      lines.push(`  Contact: ${teamInfo.author.email}`);
    }
    if (teamInfo.author.url) {
      lines.push(`  From: ${teamInfo.author.url}`);
    }
  } else {
    lines.push('  Developer: [Your Name]');
    lines.push('  Contact: [Your Email]');
  }
  lines.push('');

  // THANKS section
  if (teamInfo.contributors && teamInfo.contributors.length > 0) {
    lines.push('/* THANKS */');
    teamInfo.contributors.forEach(contributor => {
      if (contributor.name) {
        lines.push(`  ${contributor.name}`);
      }
    });
    lines.push('');
  }

  // SITE section
  lines.push('/* SITE */');

  // Format build date
  const date = new Date(buildDate);
  const formattedDate = date.toISOString().split('T')[0]; // YYYY-MM-DD
  lines.push(`  Last update: ${formattedDate}`);

  lines.push('  Standards: HTML5, CSS3, JavaScript');

  if (techStack.length > 0) {
    lines.push(`  Components: ${techStack.join(', ')}`);
  }

  lines.push(`  Software: ${techStack.includes('vite') ? 'Vite' : 'Build Tools'}`);

  return lines.join('\n');
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

  // Sort pages by mtime descending (newest first)
  const sortedPages = [...pages].sort((a, b) => {
    const dateA = new Date(a.mtime);
    const dateB = new Date(b.mtime);
    return dateB - dateA;
  });

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<rss version="2.0">');
  lines.push('  <channel>');
  lines.push(`    <title>${escapeXml(title)}</title>`);
  lines.push(`    <link>${escapeXml(url)}</link>`);
  lines.push(`    <description>${escapeXml(description)}</description>`);
  lines.push(`    <language>${escapeXml(lang)}</language>`);
  lines.push(`    <lastBuildDate>${toRFC822Date(buildDate)}</lastBuildDate>`);
  lines.push('');

  // Generate item elements for each page
  sortedPages.forEach(page => {
    lines.push('    <item>');
    lines.push(`      <title>${escapeXml(page.title)}</title>`);
    lines.push(`      <link>${escapeXml(page.url)}</link>`);
    lines.push(`      <description>${escapeXml(page.description)}</description>`);
    lines.push(`      <pubDate>${toRFC822Date(page.mtime)}</pubDate>`);
    lines.push(`      <guid>${escapeXml(page.url)}</guid>`);
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

  // Key Features as plain paragraph (not H2)
  lines.push('Key Features: JSON Schema for structured entity knowledge, llms.txt standardized format for LLM discovery, NDJSON for efficient batch processing, client-side processing with no server uploads, and multi-platform support for Shopify and SHOPLINE formats.');
  lines.push('');

  groupedPages.forEach(({ section, pages: sectionPages }) => {
    lines.push(`## ${section}`);
    sectionPages.forEach((page) => {
      lines.push(`- [${page.title}](${page.url}): ${truncateLlmsDescription(page.description)}`);
    });
    lines.push('');
  });

  if (options.includeOptional !== false) {
    lines.push('## Optional');
    lines.push(`- [Sitemap](${composePublicFileUrl(url, options.sitemapUrl || 'sitemap.xml', options.routeBasePath)}): Complete list of all indexed pages`);
    lines.push(`- [robots.txt](${composePageUrl(url, 'robots.txt', options.routeBasePath)}): Search engine crawling instructions`);
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
    const htmlContent = readFileSync(filePath, 'utf-8');
    const metadata = extractPageMetadata(htmlContent);
    const pagePath = resolvePagePath(relativePath, { ...options, prettyUrls });
    const pageUrl = llmsMdMirror
      ? composePageUrl(url, `${relativePath}.md`, options.routeBasePath)
      : composePageUrl(url, pagePath, options.routeBasePath);
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
 * Generate llms context text by expanding the llms.txt index with page content.
 * @param {object} siteMetadata - Site metadata
 * @param {string[]} htmlFiles - Absolute HTML file paths
 * @param {string} distDir - Dist output directory
 * @param {object} [options={}] - Options
 * @param {boolean} [options.includeOptional=false] - Include Optional section links
 * @returns {string} Expanded context text
 */
export function generateLlmsContextTxt(siteMetadata, htmlFiles, distDir, options = {}) {
  const indexContent = generateLlmsTxt(siteMetadata, htmlFiles, distDir, {
    ...options,
    includeOptional: options.includeOptional === true,
  });
  const pages = collectLlmsPages(siteMetadata, htmlFiles, distDir, options);
  const lines = [];

  lines.push(`# ${siteMetadata.title} Context`);
  lines.push('');
  lines.push(indexContent);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Included Page Content');

  pages.forEach((page) => {
    try {
      const htmlContent = readFileSync(page.filePath, 'utf-8');
      lines.push('');
      lines.push(`### ${page.title}`);
      lines.push('');
      lines.push(`Source: ${page.url}`);
      lines.push('');
      lines.push(convertHtmlToMarkdown(htmlContent));
    } catch (error) {
      console.warn(`⚠️  [Non-fatal] Failed to include ${page.filePath} in llms context: ${error.message}`);
    }
  });

  return lines.join('\n');
}

/**
 * Generate Markdown mirror files for HTML pages with incremental update strategy.
 * This creates .html.md files that contain Markdown versions of HTML content,
 * making it easier for LLMs to process the content.
 * Only updates files that have changed since last generation.
 *
 * @param {string[]} htmlFiles - Array of HTML file paths
 * @param {string} distDir - Distribution directory
 * @param {object} [options={}] - Options
 * @param {boolean} [options.llmsMdMirror=true] - Enable Markdown mirror generation
 * @returns {Map<string, string>} Map of HTML file path to .md file path
 */
export function generateMarkdownMirrors(htmlFiles, distDir, options = {}) {
  const llmsMdMirror = options.llmsMdMirror !== false; // Default to true
  const mirrorMap = new Map();

  if (!llmsMdMirror) {
    return mirrorMap;
  }

  const dedupedHtmlFiles = dedupeHtmlFilesByPagePath(htmlFiles, distDir, options);
  let updatedCount = 0;
  let skippedCount = 0;

  for (const filePath of dedupedHtmlFiles) {
    try {
      // Read HTML content
      if (!existsSync(filePath)) {
        console.warn(`⚠️  [Non-fatal] File not found for Markdown mirror: ${filePath}, skipping`);
        continue;
      }

      // Generate .html.md file path
      const mdFilePath = `${filePath}.md`;

      // Check if update is needed (incremental update)
      if (!needsMarkdownUpdate(filePath, mdFilePath)) {
        skippedCount++;
        mirrorMap.set(filePath, mdFilePath);
        continue;
      }
      
      const htmlContent = readFileSync(filePath, 'utf-8');

      // Convert to Markdown
      const markdownContent = convertHtmlToMarkdown(htmlContent);

      // Write Markdown file
      writeFileSync(mdFilePath, markdownContent, 'utf-8');

      // Store mapping
      mirrorMap.set(filePath, mdFilePath);
      updatedCount++;
    } catch (error) {
      console.warn(`⚠️  [Non-fatal] Failed to generate Markdown mirror for ${filePath}: ${error.message}`);
      // Continue processing other files
    }
  }

  if (skippedCount > 0) {
    console.log(`   ℹ️  Skipped ${skippedCount} unchanged Markdown mirror(s) (incremental update)`);
  }

  return mirrorMap;
}


/**
 * Generate robots.txt content with enhanced configuration options.
 * @param {string} baseUrl - Site URL
 * @param {object} [options={}] - Options
 * @param {string} [options.routeBasePath=''] - Optional route base path
 * @param {boolean} [options.prettyUrls=true] - Enable Pretty URLs (remove .html)
 * @param {boolean} [options.blockGoogleExtended=false] - Block Google-Extended AI crawler
 * @param {string[]} [options.robotsDirectives=[]] - Custom robots directives
 * @param {string} [options.sitemapUrl='sitemap.xml'] - Public sitemap URL or path
 * @returns {string} robots.txt
 */
export function generateRobotsTxt(baseUrl, options = {}) {
  const prettyUrls = options.prettyUrls !== false;
  const blockGoogleExtended = options.blockGoogleExtended || false;
  const robotsDirectives = options.robotsDirectives || [];
  const lines = [];
  lines.push(`# robots.txt for ${new URL(baseUrl).hostname}`);
  lines.push('# See https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec');
  lines.push('');

  // Block Google-Extended if configured
  if (blockGoogleExtended) {
    lines.push('# Block Google-Extended AI crawler');
    lines.push('User-agent: Google-Extended');
    lines.push('Disallow: /');
    lines.push('');
  }

  // Default allow all
  lines.push('User-agent: *');
  lines.push('Allow: /');

  // Add custom directives if provided
  if (robotsDirectives && robotsDirectives.length > 0) {
    lines.push('');
    lines.push('# Custom directives');
    robotsDirectives.forEach(directive => {
      lines.push(directive);
    });
  }

  lines.push('');
  lines.push(`Sitemap: ${composePublicFileUrl(baseUrl, options.sitemapUrl || 'sitemap.xml', options.routeBasePath)}`);

  return lines.join('\n');
}
/**
 * Generate llms-full.md - a single Markdown file containing all site content.
 * This provides LLMs with a complete snapshot of the entire website in one file.
 *
 * @param {string[]} htmlFiles - Array of HTML file paths
 * @param {string} distDir - Distribution directory
 * @param {object} options - Options
 * @param {string} options.url - Site base URL
 * @param {boolean} [options.llmsFull=false] - Enable full site Markdown generation
 * @param {boolean} [options.prettyUrls=true] - Enable Pretty URLs
 * @param {string} [options.routeBasePath=''] - Route base path
 * @returns {string} llms-full.md content
 */
export function generateLlmsFullMd(htmlFiles, distDir, options = {}) {
  const llmsFull = options.llmsFull || false;

  if (!llmsFull) {
    return '';
  }

  const { url } = options;
  const prettyUrls = options.prettyUrls !== false;
  const dedupedHtmlFiles = dedupeHtmlFilesByPagePath(htmlFiles, distDir, options);

  const lines = [];

  // Add title and table of contents header
  lines.push('# Complete Site Content');
  lines.push('');
  lines.push('This file contains all indexable pages from the website in Markdown format.');
  lines.push('');
  lines.push('## Table of Contents');
  lines.push('');

  // Collect page data for TOC and content
  const pageData = [];

  for (const filePath of dedupedHtmlFiles) {
    try {
      if (!existsSync(filePath)) {
        console.warn(`⚠️  [Non-fatal] File not found for llms-full.md: ${filePath}, skipping`);
        continue;
      }
      
      const relativePath = normalizeFilePath(relative(distDir, filePath));
      const htmlContent = readFileSync(filePath, 'utf-8');
      const metadata = extractPageMetadata(htmlContent);
      // Use unified resolvePagePath with prettyUrls option
      const pagePath = resolvePagePath(relativePath, { ...options, prettyUrls });

      const pageUrl = composePageUrl(url, pagePath, options.routeBasePath);

      // Convert HTML to Markdown
      const markdownContent = convertHtmlToMarkdown(htmlContent);

      // Get last modified time
      const lastmod = extractLastmod(filePath, options.lastmodStrategy || 'file-mtime', new Date().toISOString());

      pageData.push({
        title: metadata.title || 'Untitled',
        url: pageUrl,
        lastmod: lastmod,
        content: markdownContent,
      });
    } catch (error) {
      console.warn(`⚠️  [Non-fatal] Failed to process ${filePath} for llms-full.md: ${error.message}`);
      // Continue processing other files
    }
  }

  // Generate table of contents
  pageData.forEach((page, index) => {
    lines.push(`${index + 1}. [${page.title}](#page-${index + 1})`);
  });
  lines.push('');
  lines.push('---');
  lines.push('');

  // Generate content for each page
  pageData.forEach((page, index) => {
    lines.push(`<!-- Page ${index + 1} -->`);
    lines.push(`<!-- Title: ${page.title} -->`);
    lines.push(`<!-- URL: ${page.url} -->`);
    lines.push(`<!-- Last Modified: ${page.lastmod} -->`);
    lines.push('');
    lines.push(`## Page ${index + 1}: ${page.title} {#page-${index + 1}}`);
    lines.push('');
    lines.push(page.content);
    lines.push('');
    lines.push('---');
    lines.push('');
  });

  return lines.join('\n');
}
