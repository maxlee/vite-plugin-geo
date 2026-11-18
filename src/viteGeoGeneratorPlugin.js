import { assertAuditGate, logGeoAudit } from './geoAudit.js';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import {
  buildGeoGenerationPlan,
  formatGeoDebugSummary,
  logFileCompatibility,
  logRobotsPreservation,
  logSitemapCompatibility,
  summarizeExcludedReasons,
  validateGeoOptions,
} from './geoBuildPipeline.js';
import { isAstroProject } from './astroSitemapCompatibility.js';
import { isWithinDir, normalizeRouteBasePath } from './geoGenerator.js';

function resolveDistDir(config, explicitDistDir) {
  const configRoot = config?.root ?? process.cwd();
  if (explicitDistDir) {
    return isAbsolute(explicitDistDir)
      ? explicitDistDir
      : resolve(configRoot, explicitDistDir);
  }
  return resolve(configRoot, config?.build?.outDir ?? 'dist');
}

function resolveSourceHtmlDir(config, explicitSourceHtmlDir) {
  const configRoot = config?.root ?? process.cwd();
  const sourceHtmlDir = explicitSourceHtmlDir || 'src/pages';
  return isAbsolute(sourceHtmlDir)
    ? sourceHtmlDir
    : resolve(configRoot, sourceHtmlDir);
}

function collectHtmlAssetsFromBundle(bundle) {
  return Object.values(bundle || {}).filter((output) => (
    output?.type === 'asset'
    && output.fileName?.endsWith('.html')
    && output.source !== undefined
  ));
}

const MANAGED_PUBLIC_FILENAMES = new Set([
  'robots.txt',
  'llms.txt',
  'feed.xml',
  'humans.txt',
  'sku.md',
  'sitemap.xml',
  'sitemap_index.xml',
]);

function collectPublicDirAssets(publicDir, assets) {
  const existing = new Set(assets.map(({ filename }) => filename));

  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), relativeName);
        continue;
      }
      if (!entry.isFile()) continue;

      const fileName = entry.name.toLowerCase();
      const isManagedName = !prefix && MANAGED_PUBLIC_FILENAMES.has(fileName);
      const isXml = fileName.endsWith('.xml');
      const isMarkdown = fileName.endsWith('.md');
      if (!isManagedName && !isXml && !isMarkdown) continue;
      if (existing.has(relativeName)) continue;

      let content;
      try {
        content = readFileSync(join(dir, entry.name), 'utf-8');
      } catch {
        continue;
      }
      // Non-managed XML only participates when it looks like a sitemap.
      // Managed names such as feed.xml must not be filtered by shape.
      if (isXml && !isManagedName && !/<(?:sitemapindex|urlset)\b/i.test(content)) continue;

      existing.add(relativeName);
      assets.push({ filename: relativeName, content, source: 'publicDir' });
    }
  };

  walk(publicDir, '');
}

function decodeAssetSource(source) {
  if (typeof source === 'string') {
    return source;
  }
  if (source instanceof Uint8Array || ArrayBuffer.isView(source)) {
    return Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString('utf-8');
  }
  if (source instanceof ArrayBuffer) {
    return Buffer.from(source).toString('utf-8');
  }
  return String(source);
}

function resolveViteAssetFilePath(asset, distDir, projectRoot) {
  const originalPath = (Array.isArray(asset?.originalFileNames) && asset.originalFileNames[0])
    || asset?.originalFileName;
  if (typeof originalPath === 'string' && originalPath.trim()) {
    const candidatePath = resolve(projectRoot, originalPath);
    if (isWithinDir(projectRoot, candidatePath) && existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  return resolve(distDir, asset.fileName);
}

function hasAstroVitePlugin(config) {
  return Array.isArray(config?.plugins) && config.plugins.some(
    (plugin) => typeof plugin?.name === 'string' && plugin.name.startsWith('astro:'),
  );
}

function isServerEnvironmentConfig(config) {
  return config?.consumer === 'server'
    || (config?.consumer !== 'client' && Boolean(config?.build?.ssr));
}

function hasMultiEnvClientBuild(environment, config, { allowSsrFlag = false } = {}) {
  const topEnvironments = environment?.getTopLevelConfig?.().environments ?? config?.environments;
  if (!topEnvironments || typeof topEnvironments !== 'object') {
    return false;
  }
  return Object.entries(topEnvironments).some(([envName, envConfig]) => (
    envConfig
    && envConfig !== config
    && (!environment?.name || envName !== environment.name)
    && envConfig.consumer === 'client'
    && (allowSsrFlag || !envConfig.build?.ssr)
  ));
}

function collectOutputAssets(bundle, config) {
  const assets = Object.values(bundle || {})
    .filter((output) => (
      output?.type === 'asset'
      && output.source !== undefined
      && /\.(?:html?|md|txt|xml)$/i.test(output.fileName || '')
    ))
    .map((output) => ({
      filename: output.fileName,
      content: decodeAssetSource(output.source),
    }));

  // Vite copies public files separately; scan them so a public/sitemap.xml
  // participates in conflict detection instead of silently disappearing.
  if (config?.publicDir && config.build?.copyPublicDir !== false) {
    collectPublicDirAssets(config.publicDir, assets);
  }
  return assets;
}

function createDebugLogger(enabled) {
  return (...args) => {
    if (enabled) {
      console.log('🔍 [DEBUG]', ...args);
    }
  };
}

export function createGeoGeneratorPlugin(options = {}) {
  validateGeoOptions(options);
  logPluginVersion(options);

  const debug = createDebugLogger(options.debug === true);
  let fallbackResolvedConfig;
  let astroUsageWarningShown = false;

  return {
    name: 'geo-generator',
    apply: 'build',
    enforce: 'post',
    hooks: {
      'astro:config:setup'(context = {}) {
        const message = "Detected the Vite plugin export from 'vite-plugin-geo' inside Astro integrations. "
          + "Change the import to: import geo from 'vite-plugin-geo/astro'.";
        context?.logger?.error?.(message);
        throw new Error(message);
      },
    },

    applyToEnvironment(environment) {
      const envConfig = environment?.config;
      const isServerEnv = isServerEnvironmentConfig(envConfig);
      if (!isServerEnv) {
        return true;
      }
      return !hasMultiEnvClientBuild(environment, envConfig);
    },

    configResolved(config) {
      fallbackResolvedConfig = config;
      if (typeof options.routeBasePath !== 'string') {
        try {
          normalizeRouteBasePath(config.base, { source: 'Vite base' });
        } catch (error) {
          throw new Error(`${error.message} Set routeBasePath explicitly on the geo plugin.`);
        }
      }
    },

    buildStart: {
      order: 'pre',
      handler() {
        if (options.debug !== true) return;
        const viteVersion = this.meta?.viteVersion || 'unknown';
        const bundlerLabel = this.meta?.rolldownVersion
          ? `Rolldown ${this.meta.rolldownVersion}`
          : 'Rollup-compatible bundler';
        console.log(`🔍 [DEBUG] Running on Vite ${viteVersion} / ${bundlerLabel}`);
      },
    },

    generateBundle: {
      order: 'post',
      sequential: true,
      async handler(outputOptions, bundle) {
        const resolvedConfig = this.environment?.config ?? fallbackResolvedConfig;
        const htmlAssets = collectHtmlAssetsFromBundle(bundle);
        const projectRoot = resolvedConfig?.root || process.cwd();

        if (htmlAssets.length === 0) {
          const isAstro = hasAstroVitePlugin(resolvedConfig) || isAstroProject(projectRoot);
          const isServerEnv = isServerEnvironmentConfig(resolvedConfig);
          if (isServerEnv && hasMultiEnvClientBuild(this.environment, resolvedConfig, { allowSsrFlag: isAstro })) {
            return;
          }
          const distDir = resolveDistDir(resolvedConfig, outputOptions.dir || options.distDir);
          const sourceHtmlDir = resolveSourceHtmlDir(resolvedConfig, options.sourceHtmlDir);
          const buildShape = isServerEnv
            ? 'SSR'
            : (resolvedConfig?.build?.lib ? 'library' : 'static');
          console.warn(
            '⚠️  [vite-plugin-geo] No HTML pages were found, so no GEO files were generated. '
            + `root=${projectRoot} distDir=${distDir} sourceHtmlDir=${sourceHtmlDir} `
            + `include=**/*.html excludePatterns=${(options.excludePatterns || []).join(',') || 'none'} buildShape=${buildShape}`,
          );
          if (buildShape !== 'static') {
            console.warn(`⚠️  [vite-plugin-geo] ${buildShape} builds do not emit static HTML; GEO generation is skipped by design.`);
          }
          if (options.audit !== false) logGeoAudit({ checkedPages: 0, diagnostics: [] }, console);
          if (isAstro && !astroUsageWarningShown) {
            console.warn("⚠️  Astro generates HTML after Vite finishes. Move this plugin from vite.plugins to integrations and import it from 'vite-plugin-geo/astro'.");
            astroUsageWarningShown = true;
          }
          return;
        }

        const distDir = resolveDistDir(
          resolvedConfig,
          outputOptions.dir || options.distDir,
        );
        const routeBasePath = typeof options.routeBasePath === 'string'
          ? options.routeBasePath
          : (typeof resolvedConfig?.base === 'string' ? resolvedConfig.base : '');
        const sourceHtmlDir = resolveSourceHtmlDir(resolvedConfig, options.sourceHtmlDir);
        const currentDate = new Date().toISOString();
        const plan = await buildGeoGenerationPlan({
          projectRoot,
          distDir,
          htmlInputs: htmlAssets.map((asset) => ({
            filePath: resolveViteAssetFilePath(asset, distDir, projectRoot),
            relativePath: asset.fileName,
            htmlContent: decodeAssetSource(asset.source),
          })),
          outputAssets: collectOutputAssets(bundle, resolvedConfig),
          options: {
            ...options,
            routeBasePath,
            sourceHtmlDir,
            prettyUrls: options.prettyUrls !== false,
          },
          currentDate,
        });

        if (plan.report.includedHtmlFiles === 0) {
          console.warn(
            `⚠️  [vite-plugin-geo] All ${plan.report.totalHtmlFiles} HTML file(s) were excluded, so no GEO files were generated. `
            + `Reasons: ${summarizeExcludedReasons(plan.report.excludedDetails) || 'unknown'}`,
          );
        }
        (plan.report.routeConflicts || []).forEach(({ route, files, chosen }) => {
          console.warn(
            `⚠️  [vite-plugin-geo] Route conflict for ${route}: ${files.join('、')}; kept ${chosen}.`,
          );
        });

        logSitemapCompatibility(plan.report.sitemapCompatibility, console);
        logRobotsPreservation(plan.report.robotsCompatibility, console);
        logFileCompatibility(plan.report.fileCompatibility, console);
        logGeoAudit(plan.report.audit, console);
        // Gate before mutating the bundle so a failing CI build ships nothing.
        assertAuditGate(plan.report.audit, options.auditFailOn);

        plan.htmlUpdates.forEach(({ filename, content }) => {
          const asset = Object.values(bundle).find(
            (output) => output?.type === 'asset' && output.fileName === filename,
          );
          if (asset) {
            asset.source = content;
          }
        });
        plan.files.forEach(({ filename, content }) => {
          const existingAsset = Object.values(bundle).find(
            (output) => output?.type === 'asset' && output.fileName === filename,
          );
          if (existingAsset) {
            existingAsset.source = content;
            return;
          }
          this.emitFile({
            type: 'asset',
            fileName: filename,
            source: content,
          });
        });

        debug(formatGeoDebugSummary({
          projectRoot,
          distDir,
          sourceHtmlDir,
          report: plan.report,
        }));
      },
    },
  };
}

export function resolvePluginVersion() {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    );
    if (typeof packageJson.version === 'string' && packageJson.version.trim()) {
      return packageJson.version.trim();
    }
  } catch {
    // Keep debug output usable if the manifest cannot be read.
  }
  return 'unknown';
}

const PLUGIN_VERSION = resolvePluginVersion();

function logPluginVersion(options = {}) {
  if (
    options.debug !== true
    || process.env.VP_RESOLVING_CONFIG_METADATA === '1'
    || Boolean(process.env.VITEST)
  ) {
    return;
  }

  console.log(`\n🔧 vite-plugin-geo v${PLUGIN_VERSION}`);
  const resolvedSummary = {
    prettyUrls: options.prettyUrls !== false,
    generateFeed: options.generateFeed !== false,
    lastmodStrategy: options.lastmodStrategy || 'none',
    sourceHtmlDir: options.sourceHtmlDir || 'src/pages',
    llmsMdMirror: options.llmsMdMirror !== false,
  };
  console.log(`   Defaults: prettyUrls=${resolvedSummary.prettyUrls}, generateFeed=${resolvedSummary.generateFeed}, lastmodStrategy=${resolvedSummary.lastmodStrategy}, sourceHtmlDir=${resolvedSummary.sourceHtmlDir}, llmsMdMirror=${resolvedSummary.llmsMdMirror}`);

  const enabledOptions = Object.entries({
    prettyUrls: resolvedSummary.prettyUrls,
    generateFeed: resolvedSummary.generateFeed,
    llmsMdMirror: resolvedSummary.llmsMdMirror,
    sitemapIndex: options.sitemapIndex !== false,
    generateSitemap: options.generateSitemap === undefined ? 'auto' : options.generateSitemap,
    generateRobots: options.generateRobots !== false,
    generateHumans: options.generateHumans === true,
    skuMd: options.skuMd !== undefined,
    debug: true,
  }).filter(([, enabled]) => enabled !== false && enabled !== undefined).map(([name, enabled]) => (
    enabled === 'auto' ? `${name}=auto` : name
  ));
  console.log(`   Enabled options: ${enabledOptions.join(', ') || 'none'}`);
  const behavior = {
    sitemapConflict: options.sitemapConflict || 'auto',
    fileConflict: options.fileConflict || 'preserve',
    routeConflict: options.routeConflict || 'error',
    auditFailOn: options.auditFailOn || 'none',
  };
  console.log(`   Conflict/gate behavior: ${Object.entries(behavior).map(([key, value]) => `${key}=${value}`).join(', ')}`);
}
