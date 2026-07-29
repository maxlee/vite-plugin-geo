import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

const DEFAULT_GEO_SITEMAP_URL = 'sitemap.xml';

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function hasPackage(manifest, packageName) {
  return [
    manifest?.dependencies,
    manifest?.devDependencies,
    manifest?.peerDependencies,
    manifest?.optionalDependencies,
  ].some((dependencies) => Boolean(dependencies?.[packageName]));
}

export function isAstroProject(projectRoot) {
  const packageJsonPath = join(projectRoot, 'package.json');
  const manifest = existsSync(packageJsonPath) ? readJsonFile(packageJsonPath) : null;
  return Boolean(manifest && hasPackage(manifest, 'astro'));
}

function findGeneratedSitemap(distDir) {
  if (!existsSync(distDir)) return null;
  const candidates = readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.xml'))
    .map((entry) => {
      const content = readFileSync(join(distDir, entry.name), 'utf-8');
      return {
        filename: entry.name,
        isIndex: /<sitemapindex\b/i.test(content),
        isSitemap: /<(?:sitemapindex|urlset)\b/i.test(content),
      };
    })
    .filter(({ isSitemap }) => isSitemap)
    .sort((a, b) => {
      if (a.isIndex !== b.isIndex) return a.isIndex ? -1 : 1;
      return a.filename.localeCompare(b.filename);
    });
  return candidates[0]?.filename || null;
}

export function resolveAstroSitemapCompatibility(projectRoot, options = {}, distDir) {
  const resolvedDistDir = distDir || resolve(projectRoot, options.distDir || 'dist');
  const detectedSitemapUrl = findGeneratedSitemap(resolvedDistDir);
  const explicitSitemapUrl = typeof options.sitemapUrl === 'string' && options.sitemapUrl.trim()
    ? options.sitemapUrl.trim()
    : null;
  const detected = Boolean(detectedSitemapUrl);
  return {
    detected,
    shouldGenerateSitemap: typeof options.generateSitemap === 'boolean'
      ? options.generateSitemap
      : !detected,
    sitemapUrl: explicitSitemapUrl || detectedSitemapUrl || DEFAULT_GEO_SITEMAP_URL,
    sitemapUrlExplicit: Boolean(explicitSitemapUrl),
    filenameBase: null,
    configPath: null,
  };
}

export function resolveGeneratedSitemapUrl(sitemapFiles, fallback = DEFAULT_GEO_SITEMAP_URL) {
  if (!Array.isArray(sitemapFiles) || sitemapFiles.length === 0) {
    return fallback;
  }
  const sitemapIndexFile = sitemapFiles.find(({ filename }) => filename === 'sitemap_index.xml');
  return sitemapIndexFile?.filename || sitemapFiles[0]?.filename || fallback;
}
