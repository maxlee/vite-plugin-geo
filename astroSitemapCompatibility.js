import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ASTRO_CONFIG_FILES = [
  'astro.config.mjs',
  'astro.config.js',
  'astro.config.ts',
  'astro.config.mts',
  'astro.config.cts',
];

const DEFAULT_GEO_SITEMAP_URL = 'sitemap.xml';
const DEFAULT_ASTRO_SITEMAP_FILENAME_BASE = 'sitemap';

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function hasPackage(manifest, packageName) {
  const dependencyGroups = [
    manifest?.dependencies,
    manifest?.devDependencies,
    manifest?.peerDependencies,
    manifest?.optionalDependencies,
  ];

  return dependencyGroups.some((dependencies) => Boolean(dependencies?.[packageName]));
}

export function isAstroProject(projectRoot) {
  const packageJsonPath = join(projectRoot, 'package.json');
  const manifest = existsSync(packageJsonPath) ? readJsonFile(packageJsonPath) : null;
  return Boolean(manifest && hasPackage(manifest, 'astro'));
}

function findAstroConfigPath(projectRoot) {
  return ASTRO_CONFIG_FILES
    .map((fileName) => join(projectRoot, fileName))
    .find((filePath) => existsSync(filePath));
}

function readAstroConfig(projectRoot) {
  const configPath = findAstroConfigPath(projectRoot);
  if (!configPath) {
    return { configPath: null, content: '' };
  }

  try {
    return {
      configPath,
      content: readFileSync(configPath, 'utf-8'),
    };
  } catch {
    return { configPath: null, content: '' };
  }
}

function extractImportedSitemapIdentifier(configContent) {
  const defaultImportMatch = configContent.match(/import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]@astrojs\/sitemap['"]/);
  if (defaultImportMatch) {
    return defaultImportMatch[1];
  }

  const requireMatch = configContent.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]@astrojs\/sitemap['"]\s*\)/);
  if (requireMatch) {
    return requireMatch[1];
  }

  return null;
}

function configUsesAstroSitemap(configContent) {
  const importedIdentifier = extractImportedSitemapIdentifier(configContent);

  if (importedIdentifier) {
    const callPattern = new RegExp(`\\b${importedIdentifier}\\s*\\(`);
    return callPattern.test(configContent);
  }

  return /import\s*\(\s*['"]@astrojs\/sitemap['"]\s*\)/.test(configContent);
}

function extractStaticFilenameBase(configContent) {
  const filenameBaseMatch = configContent.match(/filenameBase\s*:\s*(['"`])([^'"`]+)\1/);
  if (!filenameBaseMatch) {
    return DEFAULT_ASTRO_SITEMAP_FILENAME_BASE;
  }

  return filenameBaseMatch[2].trim() || DEFAULT_ASTRO_SITEMAP_FILENAME_BASE;
}

function normalizeSitemapUrl(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();
  return trimmedValue || null;
}

/**
 * Resolve whether vite-plugin-geo should coexist with Astro's official sitemap integration.
 * This function only performs static reads and never executes user config files.
 *
 * @param {string} projectRoot - Project root directory
 * @param {object} [options={}] - User options
 * @param {boolean} [options.generateSitemap] - Explicit sitemap generation override
 * @param {string} [options.sitemapUrl] - Explicit public sitemap URL/path override
 * @returns {{detected: boolean, shouldGenerateSitemap: boolean, sitemapUrl: string, sitemapUrlExplicit: boolean, filenameBase: string|null, configPath: string|null}}
 */
export function resolveAstroSitemapCompatibility(projectRoot, options = {}) {
  const packageJsonPath = join(projectRoot, 'package.json');
  const manifest = existsSync(packageJsonPath) ? readJsonFile(packageJsonPath) : null;
  const { configPath, content } = readAstroConfig(projectRoot);
  const hasAstroProject = Boolean(manifest && hasPackage(manifest, 'astro'));
  const hasAstroSitemapPackage = Boolean(manifest && hasPackage(manifest, '@astrojs/sitemap'));
  const hasConfiguredAstroSitemap = Boolean(content && configUsesAstroSitemap(content));
  const detected = hasAstroProject && hasAstroSitemapPackage && hasConfiguredAstroSitemap;
  const filenameBase = detected ? extractStaticFilenameBase(content) : null;
  const detectedSitemapUrl = detected
    ? `${filenameBase}-index.xml`
    : DEFAULT_GEO_SITEMAP_URL;
  const explicitSitemapUrl = normalizeSitemapUrl(options.sitemapUrl);
  const sitemapUrlExplicit = explicitSitemapUrl !== null;
  const shouldGenerateSitemap = typeof options.generateSitemap === 'boolean'
    ? options.generateSitemap
    : !detected;

  return {
    detected,
    shouldGenerateSitemap,
    sitemapUrl: explicitSitemapUrl || detectedSitemapUrl,
    sitemapUrlExplicit,
    filenameBase,
    configPath,
  };
}

export function resolveGeneratedSitemapUrl(sitemapFiles, fallback = DEFAULT_GEO_SITEMAP_URL) {
  if (!Array.isArray(sitemapFiles) || sitemapFiles.length === 0) {
    return fallback;
  }

  const sitemapIndexFile = sitemapFiles.find(({ filename }) => filename === 'sitemap_index.xml');
  if (sitemapIndexFile) {
    return sitemapIndexFile.filename;
  }

  return sitemapFiles[0]?.filename || fallback;
}
