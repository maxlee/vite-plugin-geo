import { existsSync, readFileSync } from 'fs';
import { relative, resolve } from 'path';
import { compareCodeUnits, normalizeFilePath, resolvePagePath, extractPageMetadata } from './geoGenerator.js';

const DEFAULT_SITE_METADATA = {
  title: 'My Site',
  description: 'Site description',
  lang: 'en',
};

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Normalize and validate the public site domain.
 * @param {unknown} domain - Candidate domain value
 * @param {string} sourceLabel - Human-readable source for error messages
 * @returns {string} Normalized absolute domain without trailing slash
 */
export function normalizeSiteDomain(domain, sourceLabel = 'domain') {
  if (typeof domain !== 'string' || !domain.trim()) {
    throw new Error(`${sourceLabel} must be a non-empty http:// or https:// URL.`);
  }

  const trimmedDomain = domain.trim();
  let parsedUrl;

  try {
    parsedUrl = new URL(trimmedDomain);
  } catch {
    throw new Error(`${sourceLabel} must be an absolute http:// or https:// URL.`);
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol) || !parsedUrl.hostname) {
    throw new Error(`${sourceLabel} must be an absolute http:// or https:// URL.`);
  }

  if (
    parsedUrl.username
    || parsedUrl.password
    || parsedUrl.search
    || parsedUrl.hash
    || (parsedUrl.pathname && parsedUrl.pathname !== '/')
  ) {
    throw new Error(`${sourceLabel} must be an origin-only URL without credentials, a path, query, or fragment.`);
  }

  return parsedUrl.origin;
}

export const MISSING_DOMAIN_MESSAGE = 'Missing required domain. Configure geo({ domain: \'https://example.com\' }) or add "domain" (or an absolute "homepage" URL) to package.json.';

/**
 * Resolve the site origin from a parsed package.json.
 * "domain" wins; "homepage" is used only when it is an absolute http(s) URL,
 * so relative values such as "." (Create React App base path) are ignored.
 * @param {object|null} packageJson - Parsed package.json object
 * @returns {string|null} Normalized origin, or null when neither field applies
 */
export function resolvePackageJsonSiteDomain(packageJson) {
  if (!packageJson) {
    return null;
  }
  if (hasOwn(packageJson, 'domain') && packageJson.domain !== undefined) {
    return normalizeSiteDomain(packageJson.domain, 'package.json "domain"');
  }
  if (typeof packageJson.homepage === 'string' && /^https?:\/\//i.test(packageJson.homepage.trim())) {
    return normalizeSiteDomain(packageJson.homepage, 'package.json "homepage"');
  }
  return null;
}

function readPackageJson(packageJsonPath) {
  if (packageJsonPath === false || typeof packageJsonPath !== 'string' || !packageJsonPath.trim()) {
    return null;
  }

  let rawContent;
  try {
    rawContent = readFileSync(packageJsonPath, 'utf-8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw new Error(`Failed to read package.json at ${packageJsonPath}: ${error?.message || String(error)}`);
  }

  let packageJson;
  try {
    packageJson = JSON.parse(rawContent);
  } catch (error) {
    throw new Error(`Invalid package.json at ${packageJsonPath}: ${error?.message || String(error)}`);
  }

  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
    throw new Error(`Invalid package.json at ${packageJsonPath}: expected a JSON object.`);
  }

  return packageJson;
}

function resolveConfiguredDomain(options, packageJsonPath) {
  if (hasOwn(options, 'domain') && options.domain !== undefined) {
    return normalizeSiteDomain(options.domain, 'domain');
  }

  const packageDomain = resolvePackageJsonSiteDomain(readPackageJson(packageJsonPath));
  if (packageDomain) {
    return packageDomain;
  }

  throw new Error(MISSING_DOMAIN_MESSAGE);
}

function resolveIndexHtmlPath(distDir, htmlFiles, stripPathPrefixes) {
  const preferredIndexPath = resolve(distDir, 'index.html');
  if (existsSync(preferredIndexPath)) {
    return preferredIndexPath;
  }

  const homePageCandidates = htmlFiles
    .filter((filePath) => existsSync(filePath))
    .map((filePath) => {
      const relativePath = normalizeFilePath(relative(distDir, filePath));
      const pagePath = resolvePagePath(relativePath, { stripPathPrefixes });

      return {
        filePath,
        relativePath,
        pagePath,
      };
    })
    .filter((entry) => entry.pagePath === '')
    .sort((a, b) => (a.relativePath.length - b.relativePath.length) || compareCodeUnits(a.relativePath, b.relativePath));

  return homePageCandidates[0]?.filePath || '';
}

/**
 * Read final site metadata from build output and package.json.
 * Required source mapping:
 * - title/description/lang from dist/index.html (or equivalent homepage HTML file)
 * - url from options.domain, falling back to packageJson.domain, then an absolute packageJson.homepage
 * @param {string} distDir - Dist output directory
 * @param {object} [options={}] - Resolver options
 * @param {string} [options.domain] - Public site domain, overrides package.json domain
 * @param {string|boolean} [options.packageJsonPath='./package.json'] - package.json path
 * @param {string[]} [options.htmlFiles=[]] - HTML files collected during build
 * @param {string[]} [options.stripPathPrefixes=['src/pages/']] - Intermediate prefixes to strip
 * @returns {{url: string, title: string, description: string, lang: string}} Site metadata
 */
export function resolveSiteMetadataFromBuildOutput(distDir, options = {}) {
  const safeOptions = options && typeof options === 'object' ? options : {};
  const packageJsonPath = safeOptions.packageJsonPath === undefined
    ? './package.json'
    : safeOptions.packageJsonPath;
  const metadata = {
    ...DEFAULT_SITE_METADATA,
    url: resolveConfiguredDomain(safeOptions, packageJsonPath),
  };
  const htmlFiles = Array.isArray(safeOptions.htmlFiles) ? safeOptions.htmlFiles : [];
  const stripPathPrefixes = Array.isArray(safeOptions.stripPathPrefixes)
    ? safeOptions.stripPathPrefixes
    : ['src/pages/'];

  const indexHtmlPath = resolveIndexHtmlPath(distDir, htmlFiles, stripPathPrefixes);
  if (!indexHtmlPath) {
    console.warn('⚠️  dist/index.html not found, fallback to default title/description/lang');
    return metadata;
  }

  try {
    const htmlContent = readFileSync(indexHtmlPath, 'utf-8');
    const extractedMetadata = extractPageMetadata(htmlContent, { includeLang: true });
    return {
      url: metadata.url,
      title: extractedMetadata.title || metadata.title,
      description: extractedMetadata.description || metadata.description,
      lang: extractedMetadata.lang || metadata.lang,
    };
  } catch (error) {
    console.warn('⚠️  Could not parse dist index metadata, fallback to default title/description/lang');
    return metadata;
  }
}
function parsePackagePerson(entry) {
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    if (!trimmed) {
      return null;
    }

    // Parse "Name <email> (url)" or "Name (url) <email>"
    const match = trimmed.match(/^([^<(]+?)(?:\s*<([^>]+)>|\s*\(([^)]+)\)){0,2}\s*$/);
    if (!match) {
      return null;
    }

    const name = match[1].trim();
    if (!name) {
      return null;
    }

    const rest = trimmed.slice(match[1].length);
    const emailMatch = rest.match(/<([^>]+)>/);
    const urlMatch = rest.match(/\(([^)]+)\)/);
    return {
      name,
      email: emailMatch ? emailMatch[1].trim() : '',
      url: urlMatch ? urlMatch[1].trim() : '',
    };
  }

  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    return {
      name: typeof entry.name === 'string' ? entry.name.trim() : '',
      email: typeof entry.email === 'string' ? entry.email.trim() : '',
      url: typeof entry.url === 'string' ? entry.url.trim() : '',
    };
  }

  return null;
}

/**
 * Extract team information from package.json.
 * @param {object} packageJson - Parsed package.json content
 * @returns {{author: object|null, contributors: Array}} Team information
 */
export function extractTeamInfoFromPackageJson(packageJson) {
  const teamInfo = {
    author: null,
    contributors: [],
  };

  if (!packageJson || typeof packageJson !== 'object') {
    return teamInfo;
  }

  if (packageJson.author) {
    teamInfo.author = parsePackagePerson(packageJson.author);
  }

  if (Array.isArray(packageJson.contributors)) {
    teamInfo.contributors = packageJson.contributors
      .map(parsePackagePerson)
      .filter(Boolean);
  }

  return teamInfo;
}

/**
 * Extract technology stack from package.json dependencies.
 * @param {object} packageJson - Parsed package.json content
 * @returns {string[]} Array of major framework/tool names
 */
export function extractTechStackFromPackageJson(packageJson) {
  if (!packageJson || typeof packageJson !== 'object') {
    return [];
  }

  const techStack = [];
  const deps = packageJson.dependencies && typeof packageJson.dependencies === 'object' && !Array.isArray(packageJson.dependencies)
    ? packageJson.dependencies
    : {};
  const devDeps = packageJson.devDependencies && typeof packageJson.devDependencies === 'object' && !Array.isArray(packageJson.devDependencies)
    ? packageJson.devDependencies
    : {};
  const dependencies = {
    ...deps,
    ...devDeps,
  };

  // Major frameworks and tools to detect
  const majorTech = [
    'vite',
    'vite-plus',
    'react',
    'vue',
    'angular',
    'svelte',
    'next',
    'nuxt',
    'astro',
    'solid-js',
    'preact',
    'typescript',
    'webpack',
    'rollup',
    'esbuild',
    'tailwindcss',
    'sass',
    'less',
    'postcss',
    'vitest',
    'jest',
  ];

  for (const tech of majorTech) {
    if (dependencies[tech]) {
      techStack.push(tech);
    }
  }

  return techStack;
}
