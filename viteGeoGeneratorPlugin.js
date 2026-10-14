import { logGeoAudit } from './geoAudit.js';
import { readFileSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import {
  buildGeoGenerationPlan,
  validateGeoOptions,
} from './geoBuildPipeline.js';
import { isAstroProject } from './astroSitemapCompatibility.js';

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

function collectOutputAssets(bundle) {
  return Object.values(bundle || [])
    .filter((output) => (
      output?.type === 'asset'
      && output.source !== undefined
      && /\.(?:html?|md|txt|xml)$/i.test(output.fileName || '')
    ))
    .map((output) => ({
      filename: output.fileName,
      content: String(output.source),
    }));
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
  let resolvedConfig;
  let astroUsageWarningShown = false;

  return {
    name: 'geo-generator',
    apply: 'build',
    enforce: 'post',

    configResolved(config) {
      resolvedConfig = config;
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
        const htmlAssets = collectHtmlAssetsFromBundle(bundle);
        const projectRoot = resolvedConfig?.root || process.cwd();

        if (htmlAssets.length === 0) {
          if (options.audit !== false) logGeoAudit({ checkedPages: 0, diagnostics: [] }, console);
          if (isAstroProject(projectRoot) && !astroUsageWarningShown) {
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
            filePath: resolve(distDir, asset.fileName),
            relativePath: asset.fileName,
            htmlContent: String(asset.source),
          })),
          outputAssets: collectOutputAssets(bundle),
          options: {
            ...options,
            routeBasePath,
            sourceHtmlDir,
            prettyUrls: options.prettyUrls !== false,
          },
          currentDate,
        });

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

        logGeoAudit(plan.report.audit, console);

        debug('Generated GEO assets', {
          includedHtmlFiles: plan.report.includedHtmlFiles,
          excludedHtmlFiles: plan.report.excludedHtmlFiles,
          generatedFiles: plan.report.generatedFiles,
        });
      },
    },
  };
}

export function resolvePluginVersion() {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
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
  if (options.debug !== true) return;

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
    generateSitemap: options.generateSitemap !== false,
    generateRobots: options.generateRobots !== false,
    generateHumans: options.generateHumans === true,
    skuMd: options.skuMd !== undefined,
    debug: true,
  }).filter(([, enabled]) => enabled).map(([name]) => name);
  console.log(`   Enabled options: ${enabledOptions.join(', ') || 'none'}`);
}
