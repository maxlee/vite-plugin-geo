import { existsSync, readFileSync } from 'fs';
import { relative, resolve } from 'path';
import { normalizeFilePath, resolvePagePath, extractPageMetadata } from './geoGenerator.js';

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

  return trimmedDomain.replace(/\/+$/, '');
}

function readPackageJsonDomain(packageJsonPath) {
  if (packageJsonPath === false) {
    return null;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

    if (!hasOwn(packageJson, 'domain')) {
      return null;
    }

    return {
      value: packageJson.domain,
      sourceLabel: 'package.json "domain"',
    };
  } catch (error) {
    throw new Error(`Missing required domain. Configure geo({ domain: 'https://example.com' }) or add "domain" to package.json.`);
  }
}

function resolveConfiguredDomain(options, packageJsonPath) {
  if (hasOwn(options, 'domain') && options.domain !== undefined) {
    return normalizeSiteDomain(options.domain, 'domain');
  }

  const packageDomain = readPackageJsonDomain(packageJsonPath);
  if (packageDomain) {
    return normalizeSiteDomain(packageDomain.value, packageDomain.sourceLabel);
  }

  throw new Error('Missing required domain. Configure geo({ domain: \'https://example.com\' }) or add "domain" to package.json.');
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
    .sort((a, b) => a.relativePath.length - b.relativePath.length);

  return homePageCandidates[0]?.filePath || '';
}

/**
 * Read final site metadata from build output and package.json.
 * Required source mapping:
 * - title/description/lang from dist/index.html (or equivalent homepage HTML file)
 * - url from options.domain, falling back to packageJson.domain
 * @param {string} distDir - Dist output directory
 * @param {object} [options={}] - Resolver options
 * @param {string} [options.domain] - Public site domain, overrides package.json domain
 * @param {string|boolean} [options.packageJsonPath='./package.json'] - package.json path
 * @param {string[]} [options.htmlFiles=[]] - HTML files collected during build
 * @param {string[]} [options.stripPathPrefixes=['src/pages/']] - Intermediate prefixes to strip
 * @returns {{url: string, title: string, description: string, lang: string}} Site metadata
 */
export function resolveSiteMetadataFromBuildOutput(distDir, options = {}) {
  const packageJsonPath = options.packageJsonPath === undefined
    ? './package.json'
    : options.packageJsonPath;
  const metadata = {
    ...DEFAULT_SITE_METADATA,
    url: resolveConfiguredDomain(options, packageJsonPath),
  };
  const htmlFiles = options.htmlFiles || [];
  const stripPathPrefixes = options.stripPathPrefixes || ['src/pages/'];

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

  // Extract author information
  if (packageJson.author) {
    if (typeof packageJson.author === 'string') {
      // Parse string format: "Name <email> (url)"
      const match = packageJson.author.match(/^([^<(]+)(?:\s*<([^>]+)>)?(?:\s*\(([^)]+)\))?$/);
      if (match) {
        teamInfo.author = {
          name: match[1].trim(),
          email: match[2] ? match[2].trim() : '',
          url: match[3] ? match[3].trim() : '',
        };
      }
    } else if (typeof packageJson.author === 'object') {
      teamInfo.author = {
        name: packageJson.author.name || '',
        email: packageJson.author.email || '',
        url: packageJson.author.url || '',
      };
    }
  }

  // Extract contributors
  if (Array.isArray(packageJson.contributors)) {
    teamInfo.contributors = packageJson.contributors.map(contributor => {
      if (typeof contributor === 'string') {
        const match = contributor.match(/^([^<(]+)(?:\s*<([^>]+)>)?(?:\s*\(([^)]+)\))?$/);
        if (match) {
          return {
            name: match[1].trim(),
            email: match[2] ? match[2].trim() : '',
            url: match[3] ? match[3].trim() : '',
          };
        }
      } else if (typeof contributor === 'object') {
        return {
          name: contributor.name || '',
          email: contributor.email || '',
          url: contributor.url || '',
        };
      }
      return null;
    }).filter(Boolean);
  }

  return teamInfo;
}

/**
 * Extract technology stack from package.json dependencies.
 * @param {object} packageJson - Parsed package.json content
 * @returns {string[]} Array of major framework/tool names
 */
export function extractTechStackFromPackageJson(packageJson) {
  const techStack = [];
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  // Major frameworks and tools to detect
  const majorTech = [
    'vite',
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
