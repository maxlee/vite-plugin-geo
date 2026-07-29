import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import {
  analyzeHtmlPage,
  composePageUrl,
  extractLastmod,
  findHtmlFiles,
  generateFeedXml,
  generateHumansTxt,
  generateLlmsContextTxt,
  generateLlmsFullMd,
  generateLlmsTxt,
  generateRobotsTxt,
  generateSitemap,
  injectFeedLink,
  normalizeFilePath,
  resolveLastmodSourcePath,
  resolvePagePath,
} from './geoGenerator.js';
import {
  extractTeamInfoFromPackageJson,
  extractTechStackFromPackageJson,
  normalizeSiteDomain,
} from './geoMetadataResolver.js';
import { resolveGeneratedSitemapUrl } from './astroSitemapCompatibility.js';

const DEFAULT_EXCLUDE_PATTERNS = ['404.html', '500.html'];
const SKU_MD_VERSION = 'sku.md/1.8-draft';

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

function yamlString(value) {
  return JSON.stringify(String(value));
}

function normalizeRouteBasePath(value) {
  if (!value || value === '/' || value === './') {
    return value === '/' ? '/' : '';
  }
  return `/${String(value).replace(/^\/+|\/+$/g, '')}/`;
}

function resolvePackageJsonPath(projectRoot, packageJsonPath) {
  if (packageJsonPath === false) {
    return false;
  }
  const configuredPath = packageJsonPath || './package.json';
  return isAbsolute(configuredPath) ? configuredPath : resolve(projectRoot, configuredPath);
}

function readPackageJson(packageJsonPath) {
  if (!packageJsonPath) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  } catch {
    return null;
  }
}

function resolveSiteUrl(options, packageJson) {
  if (Object.prototype.hasOwnProperty.call(options, 'domain') && options.domain !== undefined) {
    return normalizeSiteDomain(options.domain, 'domain');
  }
  if (packageJson && Object.prototype.hasOwnProperty.call(packageJson, 'domain')) {
    return normalizeSiteDomain(packageJson.domain, 'package.json "domain"');
  }
  throw new Error('Missing required domain. Configure geo({ domain: \'https://example.com\' }) or add "domain" to package.json.');
}

function matchGlob(pattern, value) {
  const regexPattern = String(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '___DOUBLESTAR___')
    .replace(/\*/g, '[^/]*')
    .replace(/___DOUBLESTAR___/g, '.*');
  return new RegExp(`^${regexPattern}$`).test(value);
}

function dedupePageInputs(inputs, options) {
  const selected = new Map();
  inputs.forEach((input) => {
    const relativePath = normalizeFilePath(input.relativePath);
    const pagePath = resolvePagePath(relativePath, options);
    const current = selected.get(pagePath);
    if (!current || relativePath.length < current.relativePath.length) {
      selected.set(pagePath, { ...input, relativePath, pagePath });
    }
  });
  return Array.from(selected.values()).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function filterPageModels(pageModels, options) {
  const customPatterns = Array.isArray(options.excludePatterns) ? options.excludePatterns : [];
  const included = [];
  const excluded = [];

  pageModels.forEach((page) => {
    const fileName = basename(page.relativePath);
    let reason = '';
    if (DEFAULT_EXCLUDE_PATTERNS.includes(fileName)) {
      reason = 'default exclude';
    } else if (customPatterns.some((pattern) => (
      matchGlob(pattern, page.relativePath) || matchGlob(pattern, fileName)
    ))) {
      reason = 'exclude pattern';
    } else if (page.noindex) {
      reason = 'contains noindex meta tag';
    }

    if (reason) {
      excluded.push({ ...page, excludeReason: reason });
    } else {
      included.push(page);
    }
  });

  return { included, excluded };
}

function findExistingSitemap(outputAssets = []) {
  const candidates = outputAssets
    .filter(({ filename, content }) => (
      /\.xml$/i.test(filename)
      && /<(?:sitemapindex|urlset)\b/i.test(String(content || ''))
    ))
    .sort((a, b) => {
      const aIndex = /<sitemapindex\b/i.test(String(a.content || ''));
      const bIndex = /<sitemapindex\b/i.test(String(b.content || ''));
      if (aIndex !== bIndex) return aIndex ? -1 : 1;
      return a.filename.localeCompare(b.filename);
    });
  return candidates[0]?.filename || null;
}

function resolveSitemapBehavior(options, outputAssets) {
  const existingSitemap = findExistingSitemap(outputAssets);
  const sitemapUrlExplicit = typeof options.sitemapUrl === 'string' && options.sitemapUrl.trim() !== '';
  const shouldGenerateSitemap = typeof options.generateSitemap === 'boolean'
    ? options.generateSitemap
    : !existingSitemap;
  return {
    detected: Boolean(existingSitemap),
    shouldGenerateSitemap,
    sitemapUrl: sitemapUrlExplicit
      ? options.sitemapUrl.trim()
      : (existingSitemap || 'sitemap.xml'),
    sitemapUrlExplicit,
  };
}

function validateStringArray(options, key, errors) {
  if (options[key] === undefined) return;
  if (!Array.isArray(options[key])) {
    errors.push(`Option '${key}' must be an array.`);
    return;
  }
  options[key].forEach((value, index) => {
    if (typeof value !== 'string') {
      errors.push(`${key}[${index}] must be a string.`);
    }
  });
}

export function validateGeoOptions(options = {}) {
  const errors = [];
  const booleanOptions = [
    'prettyUrls',
    'sitemapIndex',
    'blockGoogleExtended',
    'llmsMdMirror',
    'llmsFull',
    'llmsCtx',
    'llmsCtxFull',
    'generateHumans',
    'generateFeed',
    'generateSitemap',
    'debug',
  ];
  booleanOptions.forEach((key) => {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') {
      errors.push(`Option '${key}' must be a boolean.`);
    }
  });

  ['domain', 'distDir', 'routeBasePath', 'lastmodStrategy', 'sourceHtmlDir', 'sitemapUrl'].forEach((key) => {
    if (options[key] !== undefined && typeof options[key] !== 'string') {
      errors.push(`Option '${key}' must be a string.`);
    }
  });
  if (
    options.packageJsonPath !== undefined
    && options.packageJsonPath !== false
    && typeof options.packageJsonPath !== 'string'
  ) {
    errors.push("Option 'packageJsonPath' must be a string or false.");
  }
  if (typeof options.domain === 'string' && options.domain.trim()) {
    try {
      normalizeSiteDomain(options.domain, 'domain');
    } catch (error) {
      errors.push(error.message);
    }
  }
  ['stabilityWaitMs', 'stabilityPollIntervalMs', 'stabilityRounds', 'sitemapMaxBytes'].forEach((key) => {
    if (options[key] !== undefined && (typeof options[key] !== 'number' || !Number.isFinite(options[key]))) {
      errors.push(`Option '${key}' must be a finite number.`);
    }
  });
  if (options.sitemapMaxBytes !== undefined && options.sitemapMaxBytes <= 0) {
    errors.push("Option 'sitemapMaxBytes' must be greater than zero.");
  }
  ['stripPathPrefixes', 'excludePatterns', 'robotsDirectives'].forEach(
    (key) => validateStringArray(options, key, errors),
  );
  if (options.lastmodStrategy !== undefined && !['file-mtime', 'build', 'git'].includes(options.lastmodStrategy)) {
    errors.push("Option 'lastmodStrategy' must be one of: file-mtime, build, git.");
  }
  if (options.llmsClassify !== undefined && typeof options.llmsClassify !== 'function') {
    errors.push("Option 'llmsClassify' must be a function.");
  }
  if (
    options.llmsSections !== undefined
    && (
      !options.llmsSections
      || typeof options.llmsSections !== 'object'
      || Array.isArray(options.llmsSections)
    )
  ) {
    errors.push("Option 'llmsSections' must be an object.");
  }
  if (options.hreflang !== undefined) {
    if (!options.hreflang || typeof options.hreflang !== 'object' || Array.isArray(options.hreflang)) {
      errors.push("Option 'hreflang' must be an object.");
    } else {
      Object.entries(options.hreflang).forEach(([languageTag, urlPattern]) => {
        if (!isValidLanguageTag(languageTag, { allowXDefault: true })) {
          errors.push(`Invalid BCP 47 language code in hreflang: '${languageTag}'.`);
        }
        if (typeof urlPattern !== 'string') {
          errors.push(`hreflang URL pattern for '${languageTag}' must be a string.`);
        }
      });
    }
  }
  (options.robotsDirectives || []).forEach((directive) => {
    if (/[\u0000-\u001F\u007F]/.test(String(directive))) {
      errors.push('robotsDirectives must not contain control characters.');
    }
  });

  if (errors.length > 0) {
    throw new Error(`Invalid GEO configuration:\n- ${errors.join('\n- ')}`);
  }
  return options;
}

export function validateSkuMdOptions(options, context) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('skuMd must be an object.');
  }
  if (typeof options.merchantName !== 'string' || !options.merchantName.trim()) {
    throw new Error('skuMd.merchantName must be a non-empty string.');
  }
  if (typeof options.catalogUrl !== 'string' || !options.catalogUrl.trim()) {
    throw new Error('skuMd.catalogUrl must be a non-empty absolute HTTPS URL.');
  }

  const siteUrl = new URL(context.siteUrl);
  let catalogUrl;
  try {
    catalogUrl = new URL(options.catalogUrl);
  } catch {
    throw new Error('skuMd.catalogUrl must be a non-empty absolute HTTPS URL.');
  }
  if (catalogUrl.protocol !== 'https:') {
    throw new Error('skuMd.catalogUrl must use HTTPS.');
  }
  if (catalogUrl.origin !== siteUrl.origin) {
    throw new Error('skuMd.catalogUrl must use the same origin as the configured site.');
  }

  const routeBasePath = context.routeBasePath || '';
  if (
    !['', '/', './'].includes(routeBasePath)
    || (siteUrl.pathname && siteUrl.pathname !== '/')
    || siteUrl.search
    || siteUrl.hash
  ) {
    throw new Error('sku.md can only be generated for a site deployed at the domain root.');
  }
  if (
    options.contentLanguage !== undefined
    && (
      typeof options.contentLanguage !== 'string'
      || !isValidLanguageTag(options.contentLanguage)
    )
  ) {
    throw new Error('skuMd.contentLanguage must be a valid BCP 47 language tag.');
  }
  if (
    options.market !== undefined
    && (
      typeof options.market !== 'string'
      || !/^[A-Z]{2}$/.test(options.market)
    )
  ) {
    throw new Error('skuMd.market must be a two-letter ISO country code.');
  }
  return options;
}

export function generateSkuMd(options, context) {
  const normalizedSiteUrl = new URL(context.siteUrl);
  normalizedSiteUrl.pathname = '/';
  normalizedSiteUrl.search = '';
  normalizedSiteUrl.hash = '';
  const siteRoot = normalizedSiteUrl.toString();
  const canonical = new URL('/sku.md', normalizedSiteUrl).toString();
  const lines = [
    '---',
    `schema_version: ${yamlString(SKU_MD_VERSION)}`,
    'document_type: "catalog_manifest"',
    'profile: "manifest-basic"',
    `canonical: ${yamlString(canonical)}`,
  ];

  if (options.contentLanguage) {
    lines.push(`content_language: ${yamlString(options.contentLanguage)}`);
  }
  lines.push(
    'merchant:',
    `  name: ${yamlString(options.merchantName.trim())}`,
    `  site_url: ${yamlString(siteRoot)}`,
    'catalog:',
    '  mode: "discovery"',
    '  entrypoints:',
    '    - type: "storefront_catalog"',
    '      format: "html"',
    `      url: ${yamlString(options.catalogUrl)}`,
    '      media_type: "text/html"',
  );
  if (options.contentLanguage) lines.push(`      content_language: ${yamlString(options.contentLanguage)}`);
  if (options.market) lines.push(`      market: ${yamlString(options.market)}`);
  lines.push(
    '---',
    '',
    `# ${options.merchantName.trim()}`,
    '',
    '> Product catalog discovery document. Live commercial details must be verified on the storefront.',
    '',
    '## Catalog',
    '',
    `- [Product Catalog](${options.catalogUrl}): Browse the merchant storefront catalog.`,
    '',
  );
  return lines.join('\n');
}

function createPageModels(htmlInputs, distDir, options, currentDate) {
  const dedupedInputs = dedupePageInputs(htmlInputs, options);
  return dedupedInputs.map((input) => {
    const analyzed = analyzeHtmlPage(input.htmlContent);
    const filePath = input.filePath || resolve(distDir, input.relativePath);
    const mtimeSourcePath = resolveLastmodSourcePath(filePath, distDir, options);
    const mtime = input.mtime || extractLastmod(
      mtimeSourcePath || filePath,
      options.lastmodStrategy || 'file-mtime',
      currentDate,
    );
    return {
      ...input,
      ...analyzed,
      filePath,
      relativePath: normalizeFilePath(input.relativePath),
      pagePath: resolvePagePath(input.relativePath, options),
      mtime,
    };
  });
}

function listExistingOutputAssets(distDir) {
  if (!existsSync(distDir)) return [];
  return readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.xml'))
    .map((entry) => ({
      filename: entry.name,
      content: readFileSync(join(distDir, entry.name), 'utf-8'),
    }));
}

export async function buildGeoGenerationPlan({
  projectRoot,
  distDir,
  htmlInputs,
  outputAssets = [],
  options = {},
  currentDate = new Date().toISOString(),
}) {
  validateGeoOptions(options);
  const routeBasePath = normalizeRouteBasePath(options.routeBasePath);
  const stripPathPrefixes = options.stripPathPrefixes || ['src/pages/'];
  const sourceHtmlDir = isAbsolute(options.sourceHtmlDir || '')
    ? options.sourceHtmlDir
    : resolve(projectRoot, options.sourceHtmlDir || 'src/pages');
  const packageJsonPath = resolvePackageJsonPath(projectRoot, options.packageJsonPath);
  const packageJson = readPackageJson(packageJsonPath);
  const siteUrl = resolveSiteUrl(options, packageJson);
  const normalizedOptions = {
    ...options,
    routeBasePath,
    stripPathPrefixes,
    sourceHtmlDir,
    prettyUrls: options.prettyUrls !== false,
    sitemapIndex: options.sitemapIndex !== false,
    lastmodStrategy: options.lastmodStrategy || 'file-mtime',
    llmsFull: options.llmsFull === true,
  };
  const allPageModels = createPageModels(htmlInputs, distDir, normalizedOptions, currentDate);
  const { included: pageModels, excluded } = filterPageModels(allPageModels, normalizedOptions);
  if (pageModels.length === 0) {
    return {
      files: [],
      htmlUpdates: [],
      report: {
        totalHtmlFiles: allPageModels.length,
        includedHtmlFiles: 0,
        excludedHtmlFiles: excluded.length,
      },
    };
  }

  const homePage = pageModels.find((page) => page.pagePath === '') || pageModels[0];
  const siteMetadata = {
    url: siteUrl,
    title: homePage.title || 'My Site',
    description: homePage.description || 'Site description',
    lang: homePage.lang || 'en',
  };
  const pageModelMap = new Map(pageModels.map((page) => [page.filePath, page]));
  const sitemapCompatibility = resolveSitemapBehavior(normalizedOptions, outputAssets);
  const generatorOptions = {
    ...normalizedOptions,
    pageModels: pageModelMap,
    sitemapUrl: sitemapCompatibility.sitemapUrl,
  };
  const files = [];
  const addFile = (filename, content) => {
    if (typeof content !== 'string') {
      throw new Error(`Generated ${filename} content must be a string.`);
    }
    files.push({ filename: normalizeFilePath(filename), content });
  };

  if (sitemapCompatibility.shouldGenerateSitemap) {
    const sitemapFiles = generateSitemap(
      siteMetadata.url,
      pageModels.map((page) => page.filePath),
      distDir,
      currentDate,
      generatorOptions,
    );
    if (!sitemapCompatibility.sitemapUrlExplicit) {
      generatorOptions.sitemapUrl = resolveGeneratedSitemapUrl(sitemapFiles);
    }
    sitemapFiles.forEach(({ filename, content }) => addFile(filename, content));
  }

  if (generatorOptions.llmsMdMirror !== false) {
    pageModels.forEach((page) => addFile(`${page.relativePath}.md`, page.markdown));
  }

  let skuMdOptions = null;
  if (options.skuMd !== undefined) {
    const requestedSkuOptions = {
      ...options.skuMd,
      contentLanguage: options.skuMd.contentLanguage ?? (
        isValidLanguageTag(siteMetadata.lang) ? siteMetadata.lang : undefined
      ),
    };
    skuMdOptions = validateSkuMdOptions(requestedSkuOptions, {
      siteUrl,
      routeBasePath,
    });
    generatorOptions.skuMd = skuMdOptions;
  }

  addFile('llms.txt', generateLlmsTxt(
    siteMetadata,
    pageModels.map((page) => page.filePath),
    distDir,
    generatorOptions,
  ));
  if (options.llmsCtx === true) {
    addFile('llms-ctx.txt', generateLlmsContextTxt(
      siteMetadata,
      pageModels.map((page) => page.filePath),
      distDir,
      { ...generatorOptions, includeOptional: false },
    ));
  }
  if (options.llmsCtxFull === true) {
    addFile('llms-ctx-full.txt', generateLlmsContextTxt(
      siteMetadata,
      pageModels.map((page) => page.filePath),
      distDir,
      { ...generatorOptions, includeOptional: true },
    ));
  }
  if (generatorOptions.llmsFull) {
    addFile('llms-full.md', generateLlmsFullMd(
      pageModels.map((page) => page.filePath),
      distDir,
      { ...generatorOptions, url: siteMetadata.url },
    ));
  }
  addFile('robots.txt', generateRobotsTxt(siteMetadata.url, {
    routeBasePath,
    blockGoogleExtended: options.blockGoogleExtended === true,
    robotsDirectives: options.robotsDirectives || [],
    sitemapUrl: generatorOptions.sitemapUrl,
  }));
  if (options.generateHumans === true) {
    if (!packageJson) {
      throw new Error('generateHumans requires a readable package.json.');
    }
    addFile('humans.txt', generateHumansTxt(packageJson, currentDate, {
      extractTeamInfoFromPackageJson,
      extractTechStackFromPackageJson,
    }));
  }

  const htmlUpdates = [];
  if (options.generateFeed !== false) {
    const feedPages = pageModels.map((page) => ({
      url: composePageUrl(siteMetadata.url, page.pagePath, routeBasePath),
      title: page.title || 'Untitled',
      description: page.description || '',
      mtime: page.mtime,
    }));
    addFile('feed.xml', generateFeedXml(feedPages, siteMetadata, currentDate));
    const feedHref = `${routeBasePath || '/'}feed.xml`.replace(/\/{2,}/g, '/');
    pageModels.forEach((page) => {
      const content = injectFeedLink(page.htmlContent, feedHref);
      if (content !== page.htmlContent) {
        htmlUpdates.push({ filename: page.relativePath, content });
      }
    });
  }

  if (skuMdOptions) {
    addFile('sku.md', generateSkuMd(skuMdOptions, { siteUrl }));
  }

  return {
    files,
    htmlUpdates,
    report: {
      totalHtmlFiles: allPageModels.length,
      includedHtmlFiles: pageModels.length,
      excludedHtmlFiles: excluded.length,
      sitemapCompatibility,
      generatedFiles: files.map(({ filename, content }) => ({
        filename,
        size: Buffer.byteLength(content, 'utf-8'),
      })),
    },
  };
}

export async function buildGeoGenerationPlanFromDisk({
  projectRoot,
  distDir,
  options = {},
  currentDate,
}) {
  if (!existsSync(distDir)) {
    throw new Error(`Dist directory not found: ${distDir}`);
  }
  const htmlInputs = findHtmlFiles(distDir).map((filePath) => ({
    filePath,
    relativePath: normalizeFilePath(relative(distDir, filePath)),
    htmlContent: readFileSync(filePath, 'utf-8'),
  }));
  return buildGeoGenerationPlan({
    projectRoot,
    distDir,
    htmlInputs,
    outputAssets: listExistingOutputAssets(distDir),
    options,
    currentDate,
  });
}

export function applyGeoGenerationPlanToDisk(plan, { distDir }) {
  const entries = [...plan.files, ...plan.htmlUpdates];
  if (entries.length === 0) return;

  mkdirSync(distDir, { recursive: true });
  const stageDir = mkdtempSync(join(distDir, '.vite-plugin-geo-stage-'));
  const backupDir = mkdtempSync(join(distDir, '.vite-plugin-geo-backup-'));
  const appliedTargets = [];
  const backedUpTargets = [];

  try {
    entries.forEach(({ filename, content }) => {
      const stagedPath = resolve(stageDir, filename);
      mkdirSync(dirname(stagedPath), { recursive: true });
      writeFileSync(stagedPath, content, 'utf-8');
    });

    entries.forEach(({ filename }) => {
      const targetPath = resolve(distDir, filename);
      const stagedPath = resolve(stageDir, filename);
      const backupPath = resolve(backupDir, filename);
      mkdirSync(dirname(targetPath), { recursive: true });
      if (existsSync(targetPath)) {
        mkdirSync(dirname(backupPath), { recursive: true });
        renameSync(targetPath, backupPath);
        backedUpTargets.push({ targetPath, backupPath });
      }
      renameSync(stagedPath, targetPath);
      appliedTargets.push(targetPath);
    });
  } catch (error) {
    appliedTargets.reverse().forEach((targetPath) => {
      rmSync(targetPath, { force: true });
    });
    backedUpTargets.reverse().forEach(({ targetPath, backupPath }) => {
      if (existsSync(backupPath)) {
        mkdirSync(dirname(targetPath), { recursive: true });
        renameSync(backupPath, targetPath);
      }
    });
    throw error;
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  }
}
