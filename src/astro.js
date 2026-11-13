import { logGeoAudit } from './geoAudit.js';
import { fileURLToPath } from 'url';
import { findHtmlFiles, normalizeRouteBasePath } from './geoGenerator.js';
import { runSeoCliGenerate } from './cli.js';

function normalizeAstroBase(base) {
  return normalizeRouteBasePath(base, { source: 'Astro base' });
}

function createAstroLogger(logger) {
  return {
    log(message) {
      logger.info(String(message));
    },
    warn(message) {
      logger.warn(String(message));
    },
    error(message) {
      logger.error(String(message));
    },
  };
}

/**
 * Create the Astro integration for vite-plugin-geo.
 * GEO files are generated only after Astro has written its final HTML output.
 *
 * @param {object} [options={}] - GEO generator options
 * @returns {import('astro').AstroIntegration}
 */
export function createAstroGeoIntegration(options = {}) {
  let projectRoot = process.cwd();
  let astroSite;
  let astroBase = '';
  let buildOutput = 'static';

  return {
    name: 'vite-plugin-geo',
    hooks: {
      'astro:config:done': ({ config, buildOutput: resolvedBuildOutput }) => {
        projectRoot = fileURLToPath(config.root);
        astroSite = config.site;
        astroBase = config.base;
        buildOutput = resolvedBuildOutput;
      },
      'astro:build:done': async ({ dir, logger }) => {
        const distDir = fileURLToPath(dir);

        if (buildOutput === 'server' && findHtmlFiles(distDir).length === 0) {
          if (options.audit !== false) logGeoAudit({ checkedPages: 0, diagnostics: [] }, createAstroLogger(logger));
          logger.warn('Astro server output contains no final static HTML, so GEO files were not generated.');
          return;
        }

        const generationOptions = {
          ...options,
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
}

export default createAstroGeoIntegration;
