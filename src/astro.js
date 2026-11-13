import { logGeoAudit } from './geoAudit.js';
import { relative } from 'path';
import { fileURLToPath } from 'url';
import {
  findHtmlFiles,
  isWithinDir,
  normalizeFilePath,
  normalizeRouteBasePath,
} from './geoGenerator.js';
import { validateGeoOptions } from './geoBuildPipeline.js';
import { runSeoCliGenerate } from './cli.js';

function normalizeAstroBase(base) {
  return normalizeRouteBasePath(base, { source: 'Astro base' });
}

function isNativeAstroLogger(logger) {
  return Boolean(
    logger
    && typeof logger.fork === 'function'
    && typeof logger.label === 'string'
    && logger.label.length > 0,
  );
}

function formatAstroLogMessage(message, nativeAstroLogger) {
  const text = String(message ?? '');
  return nativeAstroLogger
    ? text.replace(/^\[vite-plugin-geo\]\s*/i, '')
    : text;
}

function createAstroLogger(logger) {
  const nativeAstroLogger = isNativeAstroLogger(logger);
  return {
    log(message) {
      const formatted = formatAstroLogMessage(message, nativeAstroLogger);
      if (typeof logger?.info === 'function') {
        logger.info(formatted);
      } else {
        console.log(formatted);
      }
    },
    warn(message) {
      const formatted = formatAstroLogMessage(message, nativeAstroLogger);
      if (typeof logger?.warn === 'function') {
        logger.warn(formatted);
      } else {
        console.warn(formatted);
      }
    },
    error(message) {
      const formatted = formatAstroLogMessage(message, nativeAstroLogger);
      if (typeof logger?.error === 'function') {
        logger.error(formatted);
      } else {
        console.error(formatted);
      }
    },
  };
}

function toDistRelativeHtmlPath(url, distDir) {
  try {
    const fileUrl = url instanceof URL ? url : new URL(String(url));
    if (fileUrl.protocol !== 'file:') {
      return null;
    }
    const filePath = fileURLToPath(fileUrl);
    if (!isWithinDir(distDir, filePath)) {
      return null;
    }
    const relPath = normalizeFilePath(relative(distDir, filePath));
    return relPath && relPath.endsWith('.html') ? relPath : null;
  } catch {
    return null;
  }
}

function resolveRedirectExcludePatterns(distDir, redirectRoutes, assets) {
  if (!Array.isArray(redirectRoutes) || redirectRoutes.length === 0) {
    return [];
  }

  const redirectPatterns = new Set(
    redirectRoutes.map(({ pattern }) => pattern).filter(Boolean),
  );
  const candidates = [];
  const coveredPatterns = new Set();
  const nonRedirectPageBasenames = new Set();

  if (assets && typeof assets.entries === 'function') {
    for (const [pattern, urls] of assets.entries()) {
      if (!Array.isArray(urls)) continue;
      const isRedirect = redirectPatterns.has(pattern);
      if (isRedirect) {
        coveredPatterns.add(pattern);
      }
      for (const url of urls) {
        const relPath = toDistRelativeHtmlPath(url, distDir);
        if (!relPath) continue;
        if (isRedirect) {
          candidates.push(relPath);
        } else {
          const segments = relPath.split('/');
          nonRedirectPageBasenames.add(segments[segments.length - 1]);
        }
      }
    }
  }

  for (const route of redirectRoutes) {
    if (coveredPatterns.has(route.pattern) || typeof route.pathname !== 'string') continue;
    const trimmed = route.pathname.replace(/^\/+|\/+$/g, '');
    if (!trimmed) continue;
    candidates.push(`${trimmed}/index.html`, `${trimmed}.html`);
  }

  const patterns = new Set();
  for (const relPath of candidates) {
    // Nested paths contain '/' so getStaticExcludeReason won't match basename on other pages.
    if (relPath.includes('/')) {
      patterns.add(relPath);
    } else if (relPath !== 'index.html' && !nonRedirectPageBasenames.has(relPath)) {
      patterns.add(relPath);
    }
  }
  return Array.from(patterns);
}

/**
 * Create the Astro integration for vite-plugin-geo.
 * GEO files are generated only after Astro has written its final HTML output.
 *
 * @param {object} [options={}] - GEO generator options
 * @returns {import('astro').AstroIntegration}
 */
export function createAstroGeoIntegration(options = {}) {
  validateGeoOptions(options);

  let projectRoot = process.cwd();
  let astroSite;
  let astroBase = '';
  let astroBuildFormat;
  let buildOutput = 'static';
  let redirectRoutes = [];
  let pendingSitemapOrderWarning = '';

  const integration = {
    name: 'vite-plugin-geo',
    hooks: {
      'astro:routes:resolved': ({ routes }) => {
        redirectRoutes = Array.isArray(routes)
          ? routes
            .filter((route) => route?.type === 'redirect')
            .map((route) => ({
              pattern: route.pattern,
              pathname: route.pathname,
            }))
          : [];
      },
      'astro:config:done': ({ config, buildOutput: resolvedBuildOutput, logger }) => {
        projectRoot = fileURLToPath(config.root);
        astroSite = config.site;
        astroBase = config.base;
        astroBuildFormat = config.build?.format;
        buildOutput = resolvedBuildOutput;
        pendingSitemapOrderWarning = '';

        if (Array.isArray(config?.integrations)) {
          const identityIndex = config.integrations.indexOf(integration);
          const selfIndex = identityIndex >= 0
            ? identityIndex
            : config.integrations.findIndex((item) => item?.name === 'vite-plugin-geo');
          const sitemapIndex = config.integrations.findIndex((item) => item?.name === '@astrojs/sitemap');
          if (selfIndex >= 0 && sitemapIndex > selfIndex) {
            const warning = "'@astrojs/sitemap' is registered after 'vite-plugin-geo' in Astro integrations. "
              + "Move sitemap() before geo() (`integrations: [sitemap(), geo()]`) so Astro's sitemap exists before GEO generation runs.";
            if (typeof logger?.warn === 'function') {
              logger.warn(warning);
            } else {
              pendingSitemapOrderWarning = warning;
            }
          }
        }
      },
      'astro:build:done': async ({ dir, pages, assets, logger }) => {
        if (pendingSitemapOrderWarning) {
          logger?.warn?.(pendingSitemapOrderWarning);
          pendingSitemapOrderWarning = '';
        }

        const distDir = fileURLToPath(dir);
        const hasBuiltPages = Array.isArray(pages) && pages.length > 0;

        if (buildOutput === 'server' && !hasBuiltPages && findHtmlFiles(distDir).length === 0) {
          if (options.audit !== false) logGeoAudit({ checkedPages: 0, diagnostics: [] }, createAstroLogger(logger));
          logger?.warn?.('Astro server output contains no final static HTML, so GEO files were not generated.');
          return;
        }

        const redirectExcludePatterns = resolveRedirectExcludePatterns(distDir, redirectRoutes, assets);
        const baseExcludePatterns = Array.isArray(options.excludePatterns) ? options.excludePatterns : [];
        const mergedExcludePatterns = redirectExcludePatterns.length > 0
          ? Array.from(new Set([...baseExcludePatterns, ...redirectExcludePatterns]))
          : options.excludePatterns;

        const resolvedPrettyUrls = options.prettyUrls !== undefined
          ? options.prettyUrls
          : (astroBuildFormat === 'file' ? false : undefined);

        const generationOptions = {
          ...options,
          ...(resolvedPrettyUrls !== undefined ? { prettyUrls: resolvedPrettyUrls } : {}),
          ...(mergedExcludePatterns !== undefined ? { excludePatterns: mergedExcludePatterns } : {}),
          distDir,
          routeBasePath: typeof options.routeBasePath === 'string'
            ? options.routeBasePath
            : normalizeAstroBase(astroBase),
        };

        if (options.domain === undefined) {
          if (astroSite) {
            generationOptions.domain = astroSite.toString();
          } else {
            delete generationOptions.domain;
          }
        }

        await runSeoCliGenerate(generationOptions, {
          cwd: projectRoot,
          logger: createAstroLogger(logger),
        });
      },
    },
  };

  return integration;
}

export default createAstroGeoIntegration;
