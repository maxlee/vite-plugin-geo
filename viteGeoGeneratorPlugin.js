import { dirname, isAbsolute, resolve } from 'path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { normalizePath } from 'vite';
import { setTimeout as sleep } from 'timers/promises';
import {
  resolveAstroSitemapCompatibility,
  resolveGeneratedSitemapUrl,
} from './astroSitemapCompatibility.js';
import {
  extractTeamInfoFromPackageJson,
  extractTechStackFromPackageJson,
  normalizeSiteDomain,
  resolveSiteMetadataFromBuildOutput,
} from './geoMetadataResolver.js';

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
    output?.type === 'asset' &&
    output.fileName?.endsWith('.html') &&
    output.source !== undefined
  ));
}

function materializeBundleHtmlAssets(bundle) {
  const htmlAssets = collectHtmlAssetsFromBundle(bundle);
  if (htmlAssets.length === 0) {
    return { tempDir: null, htmlFiles: [] };
  }

  const tempDir = mkdtempSync(resolve(tmpdir(), 'vite-plugin-geo-'));
  const htmlFiles = htmlAssets.map((asset) => {
    const filePath = resolve(tempDir, asset.fileName);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, String(asset.source), 'utf-8');
    return filePath;
  });

  return { tempDir, htmlFiles };
}

async function waitForStableHtmlFiles(findHtmlFiles, distDir, waitMs, intervalMs, stableRounds) {
  let previousSnapshot = '';
  let stableCount = 0;
  let lastHtmlFiles = [];
  const normalizedDistDir = normalizePath(distDir);

  const startTime = Date.now();
  while (Date.now() - startTime <= waitMs) {
    lastHtmlFiles = findHtmlFiles(distDir);
    // Inline createStableSnapshot logic
    const currentSnapshot = lastHtmlFiles
      .map((file) => normalizePath(file).replace(`${normalizedDistDir}/`, ''))
      .sort()
      .join('\n');

    if (currentSnapshot === previousSnapshot) {
      stableCount += 1;
      if (stableCount >= stableRounds) {
        return lastHtmlFiles;
      }
    } else {
      previousSnapshot = currentSnapshot;
      stableCount = 0;
    }

    // Inline sleep logic
    await sleep(intervalMs);
  }

  return lastHtmlFiles;
}

/**
 * 创建 Vite GEO 生成器插件
 * @param {object} options - 插件配置选项
 * @param {string} [options.domain] - Public site domain, overrides package.json domain
 * @param {string} [options.distDir] - 输出目录（未提供时读取 Vite 最终配置的 build.outDir）
 * @param {string} [options.routeBasePath] - 生成 URL 时的路径前缀（默认读取 Vite config.base）
 * @param {string[]} [options.stripPathPrefixes=['src/pages/']] - 需要从路由中剥离的构建中间路径前缀
 * @param {string} [options.sourceHtmlDir='src/pages'] - 源码 HTML 目录，用于 file-mtime 时间映射
 * @param {number} [options.stabilityWaitMs=1500] - closeBundle 阶段等待输出文件稳定的最大时长
 * @param {number} [options.stabilityPollIntervalMs=100] - closeBundle 阶段轮询间隔
 * @param {number} [options.stabilityRounds=2] - 连续稳定轮次，达到后开始生成 GEO 文件
 * @param {string|boolean} [options.packageJsonPath='./package.json'] - package.json 路径，设为 false 禁用自动读取
 * @returns {object} Vite 插件对象
 */
export function createGeoGeneratorPlugin(options = {}) {
  const debugEnabled = options.debug === true;
  // Validate configuration options
  const validation = validatePluginOptions(options);
  
  if (!validation.valid) {
    console.error('\n❌ Configuration Validation Errors:');
    validation.errors.forEach(error => {
      console.error(`   - ${error}`);
    });
    throw new Error('Invalid plugin configuration. Please fix the errors above.');
  }
  
  // Log validation warnings
  if (validation.warnings.length > 0) {
    console.warn('\n⚠️  Configuration Warnings:');
    validation.warnings.forEach(warning => {
      console.warn(`   - ${warning}`);
    });
  }

  // Log plugin version and enabled features
  logPluginVersion(options);
  
  const stripPathPrefixes = options.stripPathPrefixes || ['src/pages/'];
  const stabilityWaitMs = options.stabilityWaitMs ?? 1500;
  const stabilityPollIntervalMs = options.stabilityPollIntervalMs ?? 100;
  const stabilityRounds = options.stabilityRounds ?? 2;

  let resolvedConfig;
  const bundleHtmlCandidates = new Set();
  let generatedInBundle = false;
  let generatedBundleFiles = [];
  let pluginEnvironment = {
    viteVersion: 'unknown',
    rolldownVersion: null,
  };

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
        generatedInBundle = false;
        generatedBundleFiles = [];
        pluginEnvironment = {
          viteVersion: this.meta?.viteVersion || 'unknown',
          rolldownVersion: this.meta?.rolldownVersion || null,
        };

        if (debugEnabled) {
          const bundlerLabel = pluginEnvironment.rolldownVersion
            ? `Rolldown ${pluginEnvironment.rolldownVersion}`
            : 'Rollup-compatible bundler';
          console.log(`🔍 [DEBUG] Running on Vite ${pluginEnvironment.viteVersion} / ${bundlerLabel}`);
        }
      },
    },

    generateBundle: {
      order: 'post',
      sequential: true,
      async handler(outputOptions, bundle) {
        const { tempDir, htmlFiles: bundleHtmlFiles } = materializeBundleHtmlAssets(bundle);
        if (bundleHtmlFiles.length === 0) {
          return;
        }

        const debug = createDebugLogger(debugEnabled);
        const generatedFiles = [];

        try {
          const {
            dedupeHtmlFilesByPagePath,
            filterHtmlFiles,
            generateSitemap,
            generateLlmsTxt,
            generateLlmsContextTxt,
            generateLlmsFullMd,
            generateRobotsTxt,
            generateHumansTxt,
            generateFeedXml,
            extractPageMetadata,
            extractLastmod,
            resolveLastmodSourcePath,
            resolvePagePath,
            composePageUrl,
            normalizeFilePath,
          } = await import('./geoGenerator.js');

          const distDir = resolveDistDir(resolvedConfig, outputOptions.dir || options.distDir);
          const routeBasePath = typeof options.routeBasePath === 'string'
            ? options.routeBasePath
            : (typeof resolvedConfig?.base === 'string' ? resolvedConfig.base : '');
          const packageJsonPath = options.packageJsonPath === undefined
            ? './package.json'
            : options.packageJsonPath;
          const sourceHtmlDir = resolveSourceHtmlDir(resolvedConfig, options.sourceHtmlDir);
          const stripPathPrefixesForRun = stripPathPrefixes;
          const sitemapCompatibility = resolveAstroSitemapCompatibility(
            resolvedConfig?.root || process.cwd(),
            options,
          );

          const dedupedHtmlFiles = dedupeHtmlFilesByPagePath(bundleHtmlFiles, tempDir, {
            stripPathPrefixes: stripPathPrefixesForRun,
          });
          const filterResult = await filterHtmlFiles(dedupedHtmlFiles, {
            excludePatterns: options.excludePatterns,
            distDir: tempDir,
          });
          const htmlFiles = filterResult.included;

          if (htmlFiles.length === 0) {
            debug.log('generateBundle found HTML assets, but all were excluded.');
            return;
          }

          const siteMetadata = resolveSiteMetadataFromBuildOutput(tempDir, {
            domain: options.domain,
            packageJsonPath,
            htmlFiles,
            stripPathPrefixes: stripPathPrefixesForRun,
          });
          const currentDate = new Date().toISOString();
          const seoOptions = {
            routeBasePath,
            stripPathPrefixes: stripPathPrefixesForRun,
            sourceHtmlDir,
            lastmodStrategy: options.lastmodStrategy || 'file-mtime',
            prettyUrls: options.prettyUrls !== false,
            sitemapIndex: options.sitemapIndex !== false,
            sitemapMaxBytes: options.sitemapMaxBytes,
            hreflang: options.hreflang,
            llmsMdMirror: options.llmsMdMirror,
            llmsFull: options.llmsFull || false,
            llmsClassify: options.llmsClassify,
            llmsSections: options.llmsSections,
            sitemapUrl: sitemapCompatibility.sitemapUrl,
          };

          const emitAsset = (filename, content) => {
            this.emitFile({
              type: 'asset',
              fileName: filename,
              source: content,
            });
            generatedFiles.push({ filename, size: content.length });
          };

          if (sitemapCompatibility.shouldGenerateSitemap) {
            const sitemapFiles = generateSitemap(
              siteMetadata.url,
              htmlFiles,
              tempDir,
              currentDate,
              seoOptions,
            );

            if (!sitemapCompatibility.sitemapUrlExplicit) {
              seoOptions.sitemapUrl = resolveGeneratedSitemapUrl(sitemapFiles);
            }

            sitemapFiles.forEach(({ filename, content }) => emitAsset(filename, content));
          }

          emitAsset('llms.txt', generateLlmsTxt(siteMetadata, htmlFiles, tempDir, seoOptions));

          if (options.llmsCtx === true) {
            emitAsset('llms-ctx.txt', generateLlmsContextTxt(siteMetadata, htmlFiles, tempDir, {
              ...seoOptions,
              includeOptional: false,
            }));
          }

          if (options.llmsCtxFull === true) {
            emitAsset('llms-ctx-full.txt', generateLlmsContextTxt(siteMetadata, htmlFiles, tempDir, {
              ...seoOptions,
              includeOptional: true,
            }));
          }

          if (seoOptions.llmsFull) {
            const llmsFullContent = generateLlmsFullMd(htmlFiles, tempDir, {
              ...seoOptions,
              url: siteMetadata.url,
            });
            if (llmsFullContent) {
              emitAsset('llms-full.md', llmsFullContent);
            }
          }

          emitAsset('robots.txt', generateRobotsTxt(siteMetadata.url, {
            routeBasePath,
            prettyUrls: options.prettyUrls !== false,
            blockGoogleExtended: options.blockGoogleExtended || false,
            robotsDirectives: options.robotsDirectives || [],
            sitemapUrl: seoOptions.sitemapUrl,
          }));

          if (options.generateHumans === true && packageJsonPath && existsSync(packageJsonPath)) {
            const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
            emitAsset('humans.txt', generateHumansTxt(packageJson, currentDate, {
              extractTeamInfoFromPackageJson,
              extractTechStackFromPackageJson,
            }));
          }

          if (options.generateFeed !== false) {
            const pages = htmlFiles.map((filePath) => {
              const htmlContent = readFileSync(filePath, 'utf-8');
              const metadata = extractPageMetadata(htmlContent);
              const relativePath = normalizeFilePath((filePath).replace(`${tempDir}/`, ''));
              const pagePath = resolvePagePath(relativePath, {
                stripPathPrefixes: stripPathPrefixesForRun,
                prettyUrls: options.prettyUrls !== false,
              });
              const url = composePageUrl(siteMetadata.url, pagePath, routeBasePath);
              const mtimeSourcePath = resolveLastmodSourcePath(filePath, tempDir, seoOptions);
              const mtime = extractLastmod(
                mtimeSourcePath || filePath,
                options.lastmodStrategy || 'file-mtime',
                currentDate,
              );

              return {
                url,
                title: metadata.title || 'Untitled',
                description: metadata.description || '',
                mtime,
              };
            });

            emitAsset('feed.xml', generateFeedXml(pages, siteMetadata, currentDate));
          }

          generatedInBundle = true;
          generatedBundleFiles = generatedFiles;
          debug.log('generateBundle emitted GEO assets:', {
            environment: pluginEnvironment,
            htmlAssets: htmlFiles.length,
            generatedFiles,
            sitemapCompatibility,
          });
        } finally {
          if (tempDir) {
            rmSync(tempDir, { recursive: true, force: true });
          }
        }
      },
    },

    writeBundle: {
      order: 'post',
      sequential: true,
      handler(outputOptions, bundle) {
        const distDir = resolveDistDir(resolvedConfig, outputOptions.dir || options.distDir);

        for (const output of Object.values(bundle)) {
          if (!output.fileName?.endsWith('.html')) {
            continue;
          }
          bundleHtmlCandidates.add(resolve(distDir, output.fileName));
        }
      },
    },

    closeBundle: {
      order: 'post',
      sequential: true,
      async handler() {
        // Capture and clear bundle candidates for watch mode support
        const bundleCandidates = Array.from(bundleHtmlCandidates);
        bundleHtmlCandidates.clear();

        const startTime = Date.now();
        const debug = createDebugLogger(debugEnabled);

        debug.time('Total GEO generation');
        debug.log('Starting GEO file generation...');
        
        const {
          dedupeHtmlFilesByPagePath,
          findHtmlFiles,
          generateSitemap,
          generateLlmsTxt,
          generateLlmsContextTxt,
          generateRobotsTxt,
          filterHtmlFiles,
          generateMarkdownMirrors,
          generateLlmsFullMd,
          generateHumansTxt,
          generateFeedXml,
          extractPageMetadata,
          extractLastmod,
          resolveLastmodSourcePath,
          resolvePagePath,
          composePageUrl,
          normalizeFilePath,
        } = await import('./geoGenerator.js');

        const distDir = resolveDistDir(resolvedConfig, options.distDir);
        // Inline resolveRouteBasePath logic
        const routeBasePath = typeof options.routeBasePath === 'string'
          ? options.routeBasePath
          : (typeof resolvedConfig?.base === 'string' ? resolvedConfig.base : '');
        const packageJsonPath = options.packageJsonPath === undefined
          ? './package.json'
          : options.packageJsonPath;
        const sourceHtmlDir = resolveSourceHtmlDir(resolvedConfig, options.sourceHtmlDir);
        const sitemapCompatibility = resolveAstroSitemapCompatibility(
          resolvedConfig?.root || process.cwd(),
          options,
        );

        debug.log('Configuration:', {
          distDir,
          routeBasePath,
          packageJsonPath,
          sourceHtmlDir,
          stripPathPrefixes,
          sitemapCompatibility,
        });

        debug.time('HTML file discovery');
        const diskHtmlFiles = generatedInBundle
          ? findHtmlFiles(distDir)
          : await waitForStableHtmlFiles(
            findHtmlFiles,
            distDir,
            stabilityWaitMs,
            stabilityPollIntervalMs,
            stabilityRounds,
          );
        debug.timeEnd('HTML file discovery');

        const mergedHtmlFiles = Array.from(new Set([
          ...diskHtmlFiles,
          ...bundleCandidates,
        ])).filter((filePath) => existsSync(filePath));

        debug.log(`Found ${mergedHtmlFiles.length} HTML files (${diskHtmlFiles.length} from disk, ${bundleCandidates.length} from bundle)`);

        const dedupedHtmlFiles = dedupeHtmlFilesByPagePath(mergedHtmlFiles, distDir, {
          stripPathPrefixes,
        });

        debug.log(`After deduplication: ${dedupedHtmlFiles.length} HTML files`);

        if (dedupedHtmlFiles.length === 0) {
          console.warn('⚠️  No HTML files found in dist/ directory');
          return;
        }

        // Apply filtering (noindex detection + custom exclude patterns)
        debug.time('File filtering');
        const filterResult = await filterHtmlFiles(dedupedHtmlFiles, {
          excludePatterns: options.excludePatterns,
          distDir,
        });
        const htmlFiles = filterResult.included;
        debug.timeEnd('File filtering');
        
        debug.log(`After filtering: ${htmlFiles.length} included, ${filterResult.excluded.length} excluded`);

        if (htmlFiles.length === 0) {
          console.warn('⚠️  All HTML files were excluded by filters');
          return;
        }

        debug.time('Metadata extraction');
        const siteMetadata = resolveSiteMetadataFromBuildOutput(distDir, {
          domain: options.domain,
          packageJsonPath,
          htmlFiles,
          stripPathPrefixes,
        });
        debug.timeEnd('Metadata extraction');
        
        debug.log('Site metadata:', siteMetadata);

        console.log(`\n📄 Found ${htmlFiles.length} HTML file(s) to index`);

        const currentDate = new Date().toISOString();
        const seoOptions = {
          routeBasePath,
          stripPathPrefixes,
          sourceHtmlDir,
          lastmodStrategy: options.lastmodStrategy || 'file-mtime',
          prettyUrls: options.prettyUrls !== false,
          sitemapIndex: options.sitemapIndex !== false,
          sitemapMaxBytes: options.sitemapMaxBytes,
          hreflang: options.hreflang,
          llmsMdMirror: options.llmsMdMirror,
          llmsFull: options.llmsFull || false,
          llmsClassify: options.llmsClassify,
          llmsSections: options.llmsSections,
          sitemapUrl: sitemapCompatibility.sitemapUrl,
        };

        const generatedFiles = generatedInBundle ? [...generatedBundleFiles] : [];
        let sitemapStats = null;

        // Generate sitemap(s)
        if (!generatedInBundle && sitemapCompatibility.shouldGenerateSitemap) {
          try {
            debug.time('Sitemap generation');
            const sitemapFiles = generateSitemap(
              siteMetadata.url,
              htmlFiles,
              distDir,
              currentDate,
              seoOptions,
            );

            if (!sitemapCompatibility.sitemapUrlExplicit) {
              seoOptions.sitemapUrl = resolveGeneratedSitemapUrl(sitemapFiles);
            }

            // Write all sitemap files
            sitemapFiles.forEach(({ filename, content }) => {
              const filePath = resolve(distDir, filename);
              writeFileSync(filePath, content, 'utf-8');
              const { size } = existsSync(filePath) ? { size: content.length } : { size: 0 };

              // Count URLs in sitemap
              const urlCount = (content.match(/<url>/g) || []).length;
              generatedFiles.push({ filename, size, urlCount });

              console.log(`✅ Generated ${filename}`);
            });

            debug.timeEnd('Sitemap generation');

            // Calculate sitemap statistics
            const totalUrls = generatedFiles
              .filter(f => f.filename.startsWith('sitemap'))
              .reduce((sum, f) => sum + (f.urlCount || 0), 0);

            sitemapStats = {
              totalUrls,
              sitemapFiles: sitemapFiles.length,
              usedSitemapIndex: sitemapFiles.some(f => f.filename === 'sitemap_index.xml'),
            };
          } catch (error) {
            console.error('❌ Failed to generate sitemap:', error.message);
            if (debugEnabled) {
              console.error(error.stack);
            }
          }
        } else if (!generatedInBundle) {
          debug.log(`Skipping GEO sitemap generation; using ${seoOptions.sitemapUrl}`);
          if (sitemapCompatibility.detected) {
            console.log(`ℹ️  Detected @astrojs/sitemap; using ${seoOptions.sitemapUrl}`);
          }
        } else {
          debug.log('Skipping closeBundle static file generation because generateBundle emitted GEO assets.');
        }

        // Generate Markdown mirrors if enabled
        if (seoOptions.llmsMdMirror !== false) {
          try {
            debug.time('Markdown mirror generation');
            const mirrorMap = generateMarkdownMirrors(htmlFiles, distDir, seoOptions);
            debug.timeEnd('Markdown mirror generation');
            
            if (mirrorMap.size > 0) {
              console.log(`✅ Generated ${mirrorMap.size} Markdown mirror file(s)`);
            }
          } catch (error) {
            console.error('❌ Failed to generate Markdown mirrors:', error.message);
            if (debugEnabled) {
              console.error(error.stack);
            }
          }
        }

        // Generate llms.txt
        if (!generatedInBundle) try {
          debug.time('llms.txt generation');
          const llmsTxtContent = generateLlmsTxt(
            siteMetadata,
            htmlFiles,
            distDir,
            seoOptions,
          );
          const filePath = resolve(distDir, 'llms.txt');
          writeFileSync(filePath, llmsTxtContent, 'utf-8');
          generatedFiles.push({ filename: 'llms.txt', size: llmsTxtContent.length });
          debug.timeEnd('llms.txt generation');
          
          console.log('✅ Generated llms.txt');
        } catch (error) {
          console.error('❌ Failed to generate llms.txt:', error.message);
          if (debugEnabled) {
            console.error(error.stack);
          }
        }

        if (!generatedInBundle && options.llmsCtx === true) {
          try {
            debug.time('llms-ctx.txt generation');
            const llmsContextContent = generateLlmsContextTxt(
              siteMetadata,
              htmlFiles,
              distDir,
              {
                ...seoOptions,
                includeOptional: false,
              },
            );
            const filePath = resolve(distDir, 'llms-ctx.txt');
            writeFileSync(filePath, llmsContextContent, 'utf-8');
            generatedFiles.push({ filename: 'llms-ctx.txt', size: llmsContextContent.length });
            debug.timeEnd('llms-ctx.txt generation');

            console.log('✅ Generated llms-ctx.txt');
          } catch (error) {
            console.error('❌ Failed to generate llms-ctx.txt:', error.message);
            if (debugEnabled) {
              console.error(error.stack);
            }
          }
        }

        if (!generatedInBundle && options.llmsCtxFull === true) {
          try {
            debug.time('llms-ctx-full.txt generation');
            const llmsContextFullContent = generateLlmsContextTxt(
              siteMetadata,
              htmlFiles,
              distDir,
              {
                ...seoOptions,
                includeOptional: true,
              },
            );
            const filePath = resolve(distDir, 'llms-ctx-full.txt');
            writeFileSync(filePath, llmsContextFullContent, 'utf-8');
            generatedFiles.push({ filename: 'llms-ctx-full.txt', size: llmsContextFullContent.length });
            debug.timeEnd('llms-ctx-full.txt generation');

            console.log('✅ Generated llms-ctx-full.txt');
          } catch (error) {
            console.error('❌ Failed to generate llms-ctx-full.txt:', error.message);
            if (debugEnabled) {
              console.error(error.stack);
            }
          }
        }

        // Generate llms-full.md if enabled
        if (!generatedInBundle && seoOptions.llmsFull) {
          try {
            debug.time('llms-full.md generation');
            const llmsFullContent = generateLlmsFullMd(htmlFiles, distDir, {
              ...seoOptions,
              url: siteMetadata.url,
            });
            if (llmsFullContent) {
              const filePath = resolve(distDir, 'llms-full.md');
              writeFileSync(filePath, llmsFullContent, 'utf-8');
              generatedFiles.push({ filename: 'llms-full.md', size: llmsFullContent.length });
              debug.timeEnd('llms-full.md generation');
              
              console.log('✅ Generated llms-full.md');
            }
          } catch (error) {
            console.error('❌ Failed to generate llms-full.md:', error.message);
            if (debugEnabled) {
              console.error(error.stack);
            }
          }
        }

        // Generate robots.txt
        if (!generatedInBundle) try {
          debug.time('robots.txt generation');
          const robotsTxtContent = generateRobotsTxt(
            siteMetadata.url,
            {
              routeBasePath,
              prettyUrls: options.prettyUrls !== false,
              blockGoogleExtended: options.blockGoogleExtended || false,
              robotsDirectives: options.robotsDirectives || [],
              sitemapUrl: seoOptions.sitemapUrl,
            },
          );
          const filePath = resolve(distDir, 'robots.txt');
          writeFileSync(filePath, robotsTxtContent, 'utf-8');
          generatedFiles.push({ filename: 'robots.txt', size: robotsTxtContent.length });
          debug.timeEnd('robots.txt generation');
          
          console.log('✅ Generated robots.txt');
        } catch (error) {
          console.error('❌ Failed to generate robots.txt:', error.message);
          if (debugEnabled) {
            console.error(error.stack);
          }
        }

        // Generate humans.txt if enabled
        if (!generatedInBundle && options.generateHumans) {
          try {
            debug.time('humans.txt generation');
            
            if (packageJsonPath && packageJsonPath !== false) {
              const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
              const humansTxtContent = generateHumansTxt(packageJson, currentDate, {
                extractTeamInfoFromPackageJson,
                extractTechStackFromPackageJson,
              });
              const filePath = resolve(distDir, 'humans.txt');
              writeFileSync(filePath, humansTxtContent, 'utf-8');
              generatedFiles.push({ filename: 'humans.txt', size: humansTxtContent.length });
              debug.timeEnd('humans.txt generation');
              
              console.log('✅ Generated humans.txt');
            }
          } catch (error) {
            console.error('❌ Failed to generate humans.txt:', error.message);
            if (debugEnabled) {
              console.error(error.stack);
            }
          }
        }

        // Generate feed.xml by default (can be disabled with generateFeed: false)
        if (!generatedInBundle && options.generateFeed !== false) {
          try {
            debug.time('feed.xml generation');
            const { readFileSync } = await import('fs');
            const { relative } = await import('path');
            
            // Collect page metadata for feed
            const pages = htmlFiles.map((filePath) => {
              const htmlContent = readFileSync(filePath, 'utf-8');
              const metadata = extractPageMetadata(htmlContent);
              const relativePath = normalizeFilePath(relative(distDir, filePath));
              // Use unified resolvePagePath with prettyUrls option
              const pagePath = resolvePagePath(relativePath, {
                stripPathPrefixes,
                prettyUrls: options.prettyUrls !== false,
              });
              const url = composePageUrl(siteMetadata.url, pagePath, routeBasePath);
              const mtimeSourcePath = resolveLastmodSourcePath(filePath, distDir, seoOptions);
              const mtime = extractLastmod(
                mtimeSourcePath || filePath,
                options.lastmodStrategy || 'file-mtime',
                currentDate,
              );

              return {
                url,
                title: metadata.title || 'Untitled',
                description: metadata.description || '',
                mtime,
              };
            });

            const feedXmlContent = generateFeedXml(pages, siteMetadata, currentDate);
            const filePath = resolve(distDir, 'feed.xml');
            writeFileSync(filePath, feedXmlContent, 'utf-8');
            generatedFiles.push({ filename: 'feed.xml', size: feedXmlContent.length });
            debug.timeEnd('feed.xml generation');
            
            console.log('✅ Generated feed.xml');
          } catch (error) {
            console.error('❌ Failed to generate feed.xml:', error.message);
            if (debugEnabled) {
              console.error(error.stack);
            }
          }
        }

        // Inject RSS/Atom link tag into HTML files
        if (options.generateFeed !== false) {
          try {
            debug.time('RSS/Atom link injection');

            // 读取生成的 feed.xml 并检测格式
            const feedPath = resolve(distDir, 'feed.xml');
            let feedFormat = 'rss'; // 默认 RSS
            if (existsSync(feedPath)) {
              const feedContent = readFileSync(feedPath, 'utf-8');
              const { detectFeedFormat } = await import('./geoGenerator.js');
              feedFormat = detectFeedFormat(feedContent);
            }

            const feedHref = `${routeBasePath}feed.xml`;
            const feedType = feedFormat === 'atom' ? 'application/atom+xml' : 'application/rss+xml';
            const feedTitle = feedFormat === 'atom' ? 'Atom Feed' : 'RSS Feed';
            const newFeedLink = `<link rel="alternate" type="${feedType}" title="${feedTitle}" href="${feedHref}" />`;

            // 匹配已存在的 RSS Feed 或 Atom Feed link 标签（按 title 匹配）
            const existingFeedPattern = /<link[^>]*rel=["']alternate["'][^>]*title=["'](?:RSS Feed|Atom Feed)["'][^>]*>/i;

            let injectedCount = 0;
            for (const htmlFilePath of htmlFiles) {
              try {
                let htmlContent = readFileSync(htmlFilePath, 'utf-8');

                // 如果已存在相同 title 的 feed link，替换它
                if (existingFeedPattern.test(htmlContent)) {
                  htmlContent = htmlContent.replace(existingFeedPattern, newFeedLink);
                  writeFileSync(htmlFilePath, htmlContent, 'utf-8');
                  injectedCount++;
                  continue;
                }

                // 在 </head> 前插入
                if (/<\/head>/i.test(htmlContent)) {
                  htmlContent = htmlContent.replace(/<\/head>/i, `${newFeedLink}</head>`);
                  writeFileSync(htmlFilePath, htmlContent, 'utf-8');
                  injectedCount++;
                }
              } catch (fileError) {
                debug.log(`Failed to inject feed link into ${htmlFilePath}: ${fileError.message}`);
              }
            }

            debug.timeEnd('RSS/Atom link injection');
            if (injectedCount > 0) {
              console.log(`✅ Injected ${feedFormat.toUpperCase()} link into ${injectedCount} HTML file(s)`);
            }
          } catch (error) {
            console.error('❌ Failed to inject feed link:', error.message);
            if (debugEnabled) {
              console.error(error.stack);
            }
          }
        }

        const processingTimeMs = Date.now() - startTime;
        debug.timeEnd('Total GEO generation');
        
        // Log build summary
        logBuildSummary({
          totalHtmlFiles: dedupedHtmlFiles.length,
          includedFiles: htmlFiles.length,
          excludedFiles: filterResult.excluded.length,
          generatedFiles,
          processingTimeMs,
          sitemapStats,
        });

        console.log('');
      },
    },
  };
}

/**
 * Validate plugin configuration options.
 * Checks types, formats, and provides warnings for potential issues.
 *
 * @param {object} options - Plugin configuration options
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
function validatePluginOptions(options = {}) {
  const errors = [];
  const warnings = [];

  // Type validation for boolean options
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

  booleanOptions.forEach(optionName => {
    if (options[optionName] !== undefined && typeof options[optionName] !== 'boolean') {
      errors.push(`Option '${optionName}' must be a boolean, got ${typeof options[optionName]}`);
    }
  });

  // Type validation for string options
  const stringOptions = ['domain', 'distDir', 'routeBasePath', 'lastmodStrategy', 'packageJsonPath', 'sourceHtmlDir', 'sitemapUrl'];

  stringOptions.forEach(optionName => {
    if (options[optionName] !== undefined &&
        options[optionName] !== false &&
        typeof options[optionName] !== 'string') {
      errors.push(`Option '${optionName}' must be a string, got ${typeof options[optionName]}`);
    }
  });

  if (typeof options.domain === 'string' && options.domain.trim()) {
    try {
      normalizeSiteDomain(options.domain, 'domain');
    } catch (error) {
      errors.push(error.message);
    }
  }

  // Type validation for number options
  const numberOptions = ['stabilityWaitMs', 'stabilityPollIntervalMs', 'stabilityRounds', 'sitemapMaxBytes'];

  numberOptions.forEach(optionName => {
    if (options[optionName] !== undefined && typeof options[optionName] !== 'number') {
      errors.push(`Option '${optionName}' must be a number, got ${typeof options[optionName]}`);
    }
  });

  // Type validation for array options
  const arrayOptions = ['stripPathPrefixes', 'excludePatterns', 'robotsDirectives'];

  arrayOptions.forEach(optionName => {
    if (options[optionName] !== undefined && !Array.isArray(options[optionName])) {
      errors.push(`Option '${optionName}' must be an array, got ${typeof options[optionName]}`);
    }
  });

  if (options.llmsClassify !== undefined && typeof options.llmsClassify !== 'function') {
    errors.push(`Option 'llmsClassify' must be a function, got ${typeof options.llmsClassify}`);
  }

  if (
    options.llmsSections !== undefined &&
    (typeof options.llmsSections !== 'object' || Array.isArray(options.llmsSections) || options.llmsSections === null)
  ) {
    errors.push(`Option 'llmsSections' must be an object, got ${typeof options.llmsSections}`);
  }

  // Validate lastmodStrategy enum
  if (options.lastmodStrategy !== undefined) {
    const validStrategies = ['file-mtime', 'build', 'git'];
    if (!validStrategies.includes(options.lastmodStrategy)) {
      errors.push(`Option 'lastmodStrategy' must be one of: ${validStrategies.join(', ')}, got '${options.lastmodStrategy}'`);
    }
  }

  // Validate hreflang configuration
  if (options.hreflang !== undefined) {
    if (typeof options.hreflang !== 'object' || Array.isArray(options.hreflang)) {
      errors.push(`Option 'hreflang' must be an object, got ${typeof options.hreflang}`);
    } else {
      // Validate language codes (BCP 47 format)
      const bcp47Regex = /^[a-z]{2}(-[A-Z]{2})?$/;
      Object.keys(options.hreflang).forEach(langCode => {
        if (!bcp47Regex.test(langCode)) {
          warnings.push(`Invalid BCP 47 language code in hreflang: '${langCode}'. Expected format: 'en', 'zh-CN', 'es-ES'`);
        }
        if (typeof options.hreflang[langCode] !== 'string') {
          errors.push(`hreflang URL pattern for '${langCode}' must be a string, got ${typeof options.hreflang[langCode]}`);
        }
      });
    }
  }

  // Validate excludePatterns (glob patterns)
  if (options.excludePatterns && Array.isArray(options.excludePatterns)) {
    options.excludePatterns.forEach((pattern, index) => {
      if (typeof pattern !== 'string') {
        errors.push(`excludePatterns[${index}] must be a string, got ${typeof pattern}`);
      } else {
        // Basic glob pattern validation - check for invalid characters
        const invalidChars = /[<>"|]/;
        if (invalidChars.test(pattern)) {
          warnings.push(`excludePatterns[${index}] contains potentially invalid characters: '${pattern}'`);
        }
      }
    });
  }

  // Validate robotsDirectives
  if (options.robotsDirectives && Array.isArray(options.robotsDirectives)) {
    options.robotsDirectives.forEach((directive, index) => {
      if (typeof directive !== 'string') {
        errors.push(`robotsDirectives[${index}] must be a string, got ${typeof directive}`);
      }
    });
  }

  // Logic validation: warn if sitemapIndex is disabled but might be needed
  if (options.sitemapIndex === false) {
    warnings.push('sitemapIndex is disabled. If your site has more than 50,000 URLs, sitemap generation may fail or violate sitemaps.org protocol limits.');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}


/**
 * Create a debug logger that only logs when debug mode is enabled.
 *
 * @param {boolean} debugEnabled - Whether debug logging is enabled
 * @returns {object} Logger object with debug methods
 */
function createDebugLogger(debugEnabled) {
  return {
    log: (...args) => {
      if (debugEnabled) {
        console.log('🔍 [DEBUG]', ...args);
      }
    },
    group: (label) => {
      if (debugEnabled) {
        console.group(`🔍 [DEBUG] ${label}`);
      }
    },
    groupEnd: () => {
      if (debugEnabled) {
        console.groupEnd();
      }
    },
    time: (label) => {
      if (debugEnabled) {
        console.time(`🔍 [DEBUG] ${label}`);
      }
    },
    timeEnd: (label) => {
      if (debugEnabled) {
        console.timeEnd(`🔍 [DEBUG] ${label}`);
      }
    },
  };
}


/**
 * Log build summary with performance metrics and file statistics.
 * Provides a comprehensive overview of the GEO generation process.
 *
 * @param {object} results - Build results object
 * @param {number} results.totalHtmlFiles - Total HTML files discovered
 * @param {number} results.includedFiles - Files included in GEO generation
 * @param {number} results.excludedFiles - Files excluded by filters
 * @param {number} results.excludedByNoindex - Files excluded due to noindex
 * @param {number} results.excludedByPattern - Files excluded by custom patterns
 * @param {Array<{filename: string, size: number, urlCount?: number}>} results.generatedFiles - Generated GEO files
 * @param {number} results.processingTimeMs - Total processing time in milliseconds
 * @param {object} [results.sitemapStats] - Sitemap statistics (optional)
 */
function logBuildSummary(results) {
  const {
    totalHtmlFiles,
    includedFiles,
    excludedFiles,
    excludedByNoindex = 0,
    excludedByPattern = 0,
    generatedFiles = [],
    processingTimeMs,
    sitemapStats,
  } = results;

  console.log('\n📊 GEO Generation Summary');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // File statistics
  console.log('\n📄 File Statistics:');
  console.log(`   Total HTML files discovered: ${totalHtmlFiles}`);
  console.log(`   ✅ Included in GEO files: ${includedFiles}`);

  if (excludedFiles > 0) {
    console.log(`   🚫 Excluded files: ${excludedFiles}`);
    if (excludedByNoindex > 0) {
      console.log(`      - By noindex tag: ${excludedByNoindex}`);
    }
    if (excludedByPattern > 0) {
      console.log(`      - By exclude patterns: ${excludedByPattern}`);
    }
  }

  // Generated files
  if (generatedFiles.length > 0) {
    console.log('\n📝 Generated Files:');
    generatedFiles.forEach(({ filename, size, urlCount }) => {
      const sizeKB = (size / 1024).toFixed(2);
      let info = `   ✅ ${filename} (${sizeKB} KB)`;
      if (urlCount !== undefined) {
        info += ` - ${urlCount} URLs`;
      }
      console.log(info);
    });
  }

  // Sitemap statistics
  if (sitemapStats) {
    console.log('\n🗺️  Sitemap Statistics:');
    console.log(`   Total URLs: ${sitemapStats.totalUrls}`);
    console.log(`   Sitemap files: ${sitemapStats.sitemapFiles}`);
    if (sitemapStats.usedSitemapIndex) {
      console.log(`   ℹ️  Used sitemap index (exceeded 50,000 URL limit)`);
    }
  }

  // Performance metrics
  console.log('\n⚡ Performance:');
  const seconds = (processingTimeMs / 1000).toFixed(2);
  console.log(`   Total processing time: ${seconds}s`);

  if (includedFiles > 0) {
    const avgTimePerFile = (processingTimeMs / includedFiles).toFixed(2);
    console.log(`   Average time per file: ${avgTimePerFile}ms`);
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}


/**
 * Plugin version identifier
 */
export function resolvePluginVersion() {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
    );
    if (typeof packageJson.version === 'string' && packageJson.version.trim()) {
      return packageJson.version.trim();
    }
  } catch {
    // Fall through to the stable fallback below.
  }

  // Fallback keeps logs usable even if package.json is unavailable in an unusual runtime.
  return 'unknown';
}

const PLUGIN_VERSION = resolvePluginVersion();

/**
 * Log plugin version and configuration summary.
 * Helps users identify which version is running and what features are enabled.
 *
 * @param {object} options - Plugin configuration options
 */
function logPluginVersion(options = {}) {
  if (options.debug !== true) {
    return;
  }

  console.log(`\n🔧 vite-plugin-geo v${PLUGIN_VERSION}`);

  const resolvedSummary = {
    prettyUrls: options.prettyUrls !== false,
    lastmodStrategy: options.lastmodStrategy || 'file-mtime',
    sourceHtmlDir: options.sourceHtmlDir || 'src/pages',
    llmsMdMirror: options.llmsMdMirror !== false,
    llmsFull: options.llmsFull === true,
    llmsCtx: options.llmsCtx === true,
    llmsCtxFull: options.llmsCtxFull === true,
    sitemapIndex: options.sitemapIndex !== false,
    generateSitemap: options.generateSitemap !== false,
    generateHumans: options.generateHumans === true,
    generateFeed: options.generateFeed !== false,
    debug: options.debug === true,
  };

  const enabledOptions = [];

  if (resolvedSummary.prettyUrls) {
    enabledOptions.push('prettyUrls');
  }
  if (options.hreflang && Object.keys(options.hreflang).length > 0) {
    enabledOptions.push(`hreflang(${Object.keys(options.hreflang).length})`);
  }
  if (options.blockGoogleExtended) {
    enabledOptions.push('blockGoogleExtended');
  }
  if (options.robotsDirectives && options.robotsDirectives.length > 0) {
    enabledOptions.push(`robotsDirectives(${options.robotsDirectives.length})`);
  }
  if (resolvedSummary.llmsMdMirror) {
    enabledOptions.push('llmsMdMirror');
  }
  if (resolvedSummary.llmsFull) {
    enabledOptions.push('llmsFull');
  }
  if (resolvedSummary.llmsCtx) {
    enabledOptions.push('llmsCtx');
  }
  if (resolvedSummary.llmsCtxFull) {
    enabledOptions.push('llmsCtxFull');
  }
  if (resolvedSummary.sitemapIndex) {
    enabledOptions.push('sitemapIndex');
  }
  if (resolvedSummary.generateSitemap) {
    enabledOptions.push('generateSitemap');
  }
  if (resolvedSummary.generateHumans) {
    enabledOptions.push('generateHumans');
  }
  if (resolvedSummary.generateFeed) {
    enabledOptions.push('generateFeed');
  }
  if (resolvedSummary.debug) {
    enabledOptions.push('debug');
  }

  console.log(`   Defaults: prettyUrls=${resolvedSummary.prettyUrls ? 'true' : 'false'}, generateFeed=${resolvedSummary.generateFeed ? 'true' : 'false'}, lastmodStrategy=${resolvedSummary.lastmodStrategy}, sourceHtmlDir=${resolvedSummary.sourceHtmlDir}, llmsMdMirror=${resolvedSummary.llmsMdMirror ? 'true' : 'false'}`);
  console.log(`   Enabled options: ${enabledOptions.length > 0 ? enabledOptions.join(', ') : 'none'}`);
}
