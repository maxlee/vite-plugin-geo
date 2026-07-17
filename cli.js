#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  composePageUrl,
  dedupeHtmlFilesByPagePath,
  detectFeedFormat,
  extractLastmod,
  extractPageMetadata,
  filterHtmlFiles,
  findHtmlFiles,
  generateFeedXml,
  generateLlmsContextTxt,
  generateHumansTxt,
  generateLlmsFullMd,
  generateLlmsTxt,
  generateMarkdownMirrors,
  generateRobotsTxt,
  generateSitemap,
  normalizeFilePath,
  resolveLastmodSourcePath,
  resolvePagePath,
} from './geoGenerator.js';
import {
  extractTeamInfoFromPackageJson,
  extractTechStackFromPackageJson,
  resolveSiteMetadataFromBuildOutput,
} from './geoMetadataResolver.js';
import {
  resolveAstroSitemapCompatibility,
  resolveGeneratedSitemapUrl,
} from './astroSitemapCompatibility.js';

const USAGE = `
Usage:
  vite-plugin-geo [generate] [options]

Options:
  --domain <url>              Public site domain, overrides package.json domain
  --dist-dir <path>            Dist directory (default: dist)
  --route-base-path <path>     URL base path (default: '')
  --source-html-dir <path>     Source HTML directory for mtime (default: src/pages)
  --package-json-path <path>   package.json path (default: ./package.json)
  --strip-path-prefixes <list> Comma-separated prefixes (default: src/pages/)
  --exclude-patterns <list>    Comma-separated glob patterns
  --lastmod-strategy <value>   file-mtime | build | git (default: file-mtime)
  --robots-directives <list>   Comma-separated robots directives
  --sitemap-url <path-or-url>  Public sitemap URL/path used by robots.txt and llms.txt
  --pretty-urls / --no-pretty-urls
  --sitemap-index / --no-sitemap-index
  --generate-sitemap / --no-generate-sitemap
  --llms-md-mirror / --no-llms-md-mirror
  --llms-full / --no-llms-full
  --llms-ctx / --no-llms-ctx
  --llms-ctx-full / --no-llms-ctx-full
  --generate-humans / --no-generate-humans
  --generate-feed / --no-generate-feed
  --block-google-extended / --no-block-google-extended
  --debug / --no-debug
  --config <path>              JSON config file path
  -h, --help                   Show help
`;

function parseListValue(value) {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBooleanValue(value, flagName) {
  if (typeof value !== 'string') {
    throw new Error(`Missing value for ${flagName}`);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid boolean for ${flagName}: ${value}. Use true or false.`);
}

function parseNonBooleanValue(args, index, flagName) {
  const token = args[index];
  if (token?.includes('=')) {
    const value = token.split('=').slice(1).join('=');
    if (value === '') {
      throw new Error(`Missing value for ${flagName}`);
    }
    return { value, nextIndex: index };
  }

  const nextValue = args[index + 1];
  if (!nextValue || nextValue.startsWith('-')) {
    throw new Error(`Missing value for ${flagName}`);
  }

  return { value: nextValue, nextIndex: index + 1 };
}

function mergeConfigWithCliOptions(configOptions, cliOptions) {
  const merged = { ...configOptions };
  Object.entries(cliOptions).forEach(([key, value]) => {
    if (value !== undefined) {
      merged[key] = value;
    }
  });
  return merged;
}

// CLI argument definitions for table-driven parsing
const CLI_ARG_DEFS = [
  // String arguments
  { flag: '--config', key: 'config' },
  { flag: '--domain', key: 'domain' },
  { flag: '--dist-dir', key: 'distDir' },
  { flag: '--route-base-path', key: 'routeBasePath' },
  { flag: '--source-html-dir', key: 'sourceHtmlDir' },
  { flag: '--package-json-path', key: 'packageJsonPath' },
  { flag: '--lastmod-strategy', key: 'lastmodStrategy' },
  { flag: '--sitemap-url', key: 'sitemapUrl' },
  // List arguments (comma-separated)
  { flag: '--strip-path-prefixes', key: 'stripPathPrefixes', parse: parseListValue },
  { flag: '--exclude-patterns', key: 'excludePatterns', parse: parseListValue },
  { flag: '--robots-directives', key: 'robotsDirectives', parse: parseListValue },
  // Boolean flags (positive)
  { flag: '--pretty-urls', key: 'prettyUrls', value: true },
  { flag: '--sitemap-index', key: 'sitemapIndex', value: true },
  { flag: '--generate-sitemap', key: 'generateSitemap', value: true },
  { flag: '--llms-md-mirror', key: 'llmsMdMirror', value: true },
  { flag: '--llms-full', key: 'llmsFull', value: true },
  { flag: '--llms-ctx', key: 'llmsCtx', value: true },
  { flag: '--llms-ctx-full', key: 'llmsCtxFull', value: true },
  { flag: '--generate-humans', key: 'generateHumans', value: true },
  { flag: '--generate-feed', key: 'generateFeed', value: true },
  { flag: '--block-google-extended', key: 'blockGoogleExtended', value: true },
  { flag: '--debug', key: 'debug', value: true },
  // Boolean flags (negative)
  { flag: '--no-pretty-urls', key: 'prettyUrls', value: false },
  { flag: '--no-sitemap-index', key: 'sitemapIndex', value: false },
  { flag: '--no-generate-sitemap', key: 'generateSitemap', value: false },
  { flag: '--no-llms-md-mirror', key: 'llmsMdMirror', value: false },
  { flag: '--no-llms-full', key: 'llmsFull', value: false },
  { flag: '--no-llms-ctx', key: 'llmsCtx', value: false },
  { flag: '--no-llms-ctx-full', key: 'llmsCtxFull', value: false },
  { flag: '--no-generate-humans', key: 'generateHumans', value: false },
  { flag: '--no-generate-feed', key: 'generateFeed', value: false },
  { flag: '--no-block-google-extended', key: 'blockGoogleExtended', value: false },
  { flag: '--no-debug', key: 'debug', value: false },
];

export function parseCliArgs(argv = []) {
  const args = [...argv];
  const options = {};
  let command = 'generate';
  let showHelp = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === 'generate') {
      command = 'generate';
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      showHelp = true;
      continue;
    }

    // Handle special =false/=true cases
    if (arg === '--package-json-path=false') {
      options.packageJsonPath = false;
      continue;
    }
    if (arg === '--llms-md-mirror=false' || arg === '--llms-md-mirror=true') {
      options.llmsMdMirror = parseBooleanValue(arg.split('=')[1], '--llms-md-mirror');
      continue;
    }
    if (arg === '--llms-ctx=false' || arg === '--llms-ctx=true') {
      options.llmsCtx = parseBooleanValue(arg.split('=')[1], '--llms-ctx');
      continue;
    }
    if (arg === '--llms-ctx-full=false' || arg === '--llms-ctx-full=true') {
      options.llmsCtxFull = parseBooleanValue(arg.split('=')[1], '--llms-ctx-full');
      continue;
    }
    if (arg === '--generate-feed=false' || arg === '--generate-feed=true') {
      options.generateFeed = parseBooleanValue(arg.split('=')[1], '--generate-feed');
      continue;
    }
    if (arg === '--generate-sitemap=false' || arg === '--generate-sitemap=true') {
      options.generateSitemap = parseBooleanValue(arg.split('=')[1], '--generate-sitemap');
      continue;
    }

    // Table-driven argument matching
    let matched = false;
    for (const def of CLI_ARG_DEFS) {
      if (arg === def.flag || arg.startsWith(`${def.flag}=`)) {
        if (def.value !== undefined) {
          // Boolean flag
          options[def.key] = def.value;
        } else {
          // String/list argument
          const { value, nextIndex } = parseNonBooleanValue(args, i, def.flag);
          options[def.key] = def.parse ? def.parse(value) : value;
          i = nextIndex;
        }
        matched = true;
        break;
      }
    }

    if (!matched) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    command,
    options,
    showHelp,
  };
}

function resolvePathFromCwd(cwd, maybePath) {
  if (!maybePath) {
    return maybePath;
  }
  return isAbsolute(maybePath) ? maybePath : resolve(cwd, maybePath);
}

export async function runSeoCliGenerate(rawOptions = {}, runtime = {}) {
  const cwd = runtime.cwd || process.cwd();
  const logger = runtime.logger || console;
  const configOptions = rawOptions.config
    ? JSON.parse(readFileSync(resolvePathFromCwd(cwd, rawOptions.config), 'utf-8'))
    : {};
  const options = mergeConfigWithCliOptions(configOptions, rawOptions);
  delete options.config;

  const distDir = resolvePathFromCwd(cwd, options.distDir || 'dist');
  const routeBasePath = typeof options.routeBasePath === 'string' ? options.routeBasePath : '';
  const sourceHtmlDir = resolvePathFromCwd(cwd, options.sourceHtmlDir || 'src/pages');
  const packageJsonPath = options.packageJsonPath === false
    ? false
    : resolvePathFromCwd(cwd, options.packageJsonPath || './package.json');
  const stripPathPrefixes = Array.isArray(options.stripPathPrefixes)
    ? options.stripPathPrefixes
    : ['src/pages/'];
  const lastmodStrategy = options.lastmodStrategy || 'file-mtime';
  const sitemapCompatibility = resolveAstroSitemapCompatibility(cwd, options);

  if (!['file-mtime', 'build', 'git'].includes(lastmodStrategy)) {
    throw new Error(`Invalid lastmodStrategy: ${lastmodStrategy}`);
  }

  if (!existsSync(distDir)) {
    throw new Error(`Dist directory not found: ${distDir}`);
  }

  const allHtmlFiles = findHtmlFiles(distDir);
  const dedupedHtmlFiles = dedupeHtmlFilesByPagePath(allHtmlFiles, distDir, {
    stripPathPrefixes,
  });

  if (dedupedHtmlFiles.length === 0) {
    logger.warn('⚠️  No HTML files found in dist directory');
    return { generatedFiles: [] };
  }

  const filterResult = await filterHtmlFiles(dedupedHtmlFiles, {
    excludePatterns: options.excludePatterns,
    distDir,
  });
  const htmlFiles = filterResult.included;

  if (htmlFiles.length === 0) {
    logger.warn('⚠️  All HTML files were excluded by filters');
    return { generatedFiles: [] };
  }

  const siteMetadata = resolveSiteMetadataFromBuildOutput(distDir, {
    domain: options.domain,
    packageJsonPath,
    htmlFiles,
    stripPathPrefixes,
  });

  const currentDate = new Date().toISOString();
  const seoOptions = {
    routeBasePath,
    stripPathPrefixes,
    sourceHtmlDir,
    lastmodStrategy,
    prettyUrls: options.prettyUrls !== false,
    sitemapIndex: options.sitemapIndex !== false,
    sitemapMaxBytes: options.sitemapMaxBytes,
    hreflang: options.hreflang,
    llmsMdMirror: options.llmsMdMirror,
    llmsFull: options.llmsFull === true,
    llmsClassify: options.llmsClassify,
    llmsSections: options.llmsSections,
    sitemapUrl: sitemapCompatibility.sitemapUrl,
  };

  const generatedFiles = [];

  if (sitemapCompatibility.shouldGenerateSitemap) {
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

    sitemapFiles.forEach(({ filename, content }) => {
      const filePath = resolve(distDir, filename);
      writeFileSync(filePath, content, 'utf-8');
      generatedFiles.push(filename);
      logger.log(`✅ Generated ${filename}`);
    });
  } else if (sitemapCompatibility.detected) {
    logger.log(`ℹ️  Detected @astrojs/sitemap; using ${seoOptions.sitemapUrl}`);
  }

  if (seoOptions.llmsMdMirror !== false) {
    const mirrorMap = generateMarkdownMirrors(htmlFiles, distDir, seoOptions);
    if (mirrorMap.size > 0) {
      logger.log(`✅ Generated ${mirrorMap.size} Markdown mirror file(s)`);
    }
  }

  const llmsTxtContent = generateLlmsTxt(
    siteMetadata,
    htmlFiles,
    distDir,
    seoOptions,
  );
  writeFileSync(resolve(distDir, 'llms.txt'), llmsTxtContent, 'utf-8');
  generatedFiles.push('llms.txt');
  logger.log('✅ Generated llms.txt');

  if (options.llmsCtx === true) {
    const llmsContextContent = generateLlmsContextTxt(
      siteMetadata,
      htmlFiles,
      distDir,
      {
        ...seoOptions,
        includeOptional: false,
      },
    );
    writeFileSync(resolve(distDir, 'llms-ctx.txt'), llmsContextContent, 'utf-8');
    generatedFiles.push('llms-ctx.txt');
    logger.log('✅ Generated llms-ctx.txt');
  }

  if (options.llmsCtxFull === true) {
    const llmsContextFullContent = generateLlmsContextTxt(
      siteMetadata,
      htmlFiles,
      distDir,
      {
        ...seoOptions,
        includeOptional: true,
      },
    );
    writeFileSync(resolve(distDir, 'llms-ctx-full.txt'), llmsContextFullContent, 'utf-8');
    generatedFiles.push('llms-ctx-full.txt');
    logger.log('✅ Generated llms-ctx-full.txt');
  }

  if (seoOptions.llmsFull) {
    const llmsFullContent = generateLlmsFullMd(htmlFiles, distDir, {
      ...seoOptions,
      url: siteMetadata.url,
    });
    if (llmsFullContent) {
      writeFileSync(resolve(distDir, 'llms-full.md'), llmsFullContent, 'utf-8');
      generatedFiles.push('llms-full.md');
      logger.log('✅ Generated llms-full.md');
    }
  }

  const robotsTxtContent = generateRobotsTxt(siteMetadata.url, {
    routeBasePath,
    prettyUrls: options.prettyUrls !== false,
    blockGoogleExtended: options.blockGoogleExtended || false,
    robotsDirectives: options.robotsDirectives || [],
    sitemapUrl: seoOptions.sitemapUrl,
  });
  writeFileSync(resolve(distDir, 'robots.txt'), robotsTxtContent, 'utf-8');
  generatedFiles.push('robots.txt');
  logger.log('✅ Generated robots.txt');

  if (options.generateHumans === true && packageJsonPath && existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const humansTxtContent = generateHumansTxt(packageJson, currentDate, {
      extractTeamInfoFromPackageJson,
      extractTechStackFromPackageJson,
    });
    writeFileSync(resolve(distDir, 'humans.txt'), humansTxtContent, 'utf-8');
    generatedFiles.push('humans.txt');
    logger.log('✅ Generated humans.txt');
  }

  if (options.generateFeed !== false) {
    const pages = htmlFiles.map((filePath) => {
      const htmlContent = readFileSync(filePath, 'utf-8');
      const metadata = extractPageMetadata(htmlContent);
      const relativePath = normalizeFilePath(relative(distDir, filePath));
      const pagePath = resolvePagePath(relativePath, {
        stripPathPrefixes,
        prettyUrls: options.prettyUrls !== false,
      });
      const url = composePageUrl(siteMetadata.url, pagePath, routeBasePath);
      const mtimeSourcePath = resolveLastmodSourcePath(filePath, distDir, seoOptions);
      const mtime = extractLastmod(
        mtimeSourcePath || filePath,
        lastmodStrategy,
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
    writeFileSync(resolve(distDir, 'feed.xml'), feedXmlContent, 'utf-8');
    generatedFiles.push('feed.xml');
    logger.log('✅ Generated feed.xml');
  }

  // Inject RSS/Atom link tag into HTML files
  if (options.generateFeed !== false) {
    // 读取生成的 feed.xml 并检测格式
    const feedPath = resolve(distDir, 'feed.xml');
    let feedFormat = 'rss'; // 默认 RSS
    if (existsSync(feedPath)) {
      const feedContent = readFileSync(feedPath, 'utf-8');
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
        // Ignore file errors
      }
    }

    if (injectedCount > 0) {
      logger.log(`✅ Injected ${feedFormat.toUpperCase()} link into ${injectedCount} HTML file(s)`);
    }
  }

  logger.log(`\n🎉 GEO generation complete. ${generatedFiles.length} file(s) updated.`);
  return {
    distDir,
    generatedFiles,
    includedHtmlFiles: htmlFiles.length,
    excludedHtmlFiles: filterResult.excluded.length,
  };
}

export async function runCli(argv = process.argv.slice(2), runtime = {}) {
  try {
    const parsed = parseCliArgs(argv);

    if (parsed.showHelp) {
      (runtime.logger || console).log(USAGE.trim());
      return 0;
    }

    if (parsed.command !== 'generate') {
      throw new Error(`Unsupported command: ${parsed.command}`);
    }

    await runSeoCliGenerate(parsed.options, runtime);
    return 0;
  } catch (error) {
    const logger = runtime.logger || console;
    logger.error(`❌ ${error.message}`);
    logger.error('\nUse --help to view command usage.');
    return 1;
  }
}

function resolveExecutablePath(filePath) {
  if (!filePath) {
    return null;
  }

  const absolutePath = resolve(filePath);

  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

export function isCliEntrypoint({
  argv = process.argv,
  metaUrl = import.meta.url,
  importMetaMain = import.meta.main,
} = {}) {
  if (importMetaMain === true) {
    return true;
  }

  const argvPath = argv[1];
  const modulePath = fileURLToPath(metaUrl);

  // 防止 null === null 返回 true 的边缘情况
  if (!argvPath || !modulePath) {
    return false;
  }

  return resolveExecutablePath(argvPath) === resolveExecutablePath(modulePath);
}

const isDirectRun = isCliEntrypoint();

if (isDirectRun) {
  runCli().then((code) => {
    process.exit(code);
  });
}
