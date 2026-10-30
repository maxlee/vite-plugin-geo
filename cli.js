#!/usr/bin/env node

import { logGeoAudit } from './geoAudit.js';

import { readFileSync, realpathSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  applyGeoGenerationPlanToDisk,
  buildGeoGenerationPlanFromDisk,
  logRobotsPreservation,
} from './geoBuildPipeline.js';

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
  --lastmod-strategy <value>   none | file-mtime | build | git (default: none)
  --llms-md-mirror-style <value> append | replace (default: append)
  --robots-directives <list>   Comma-separated robots directives
  --sitemap-url <path-or-url>  Public sitemap URL/path used by robots.txt and llms.txt
  --pretty-urls / --no-pretty-urls
  --sitemap-index / --no-sitemap-index
  --generate-sitemap / --no-generate-sitemap
  --generate-robots / --no-generate-robots
  --llms-md-mirror / --no-llms-md-mirror
  --generate-humans / --no-generate-humans
  --generate-feed / --no-generate-feed
  --audit / --no-audit        Build diagnostics (default: enabled; never fails on findings)
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
  { flag: '--llms-md-mirror-style', key: 'llmsMdMirrorStyle' },
  { flag: '--sitemap-url', key: 'sitemapUrl' },
  // List arguments (comma-separated)
  { flag: '--strip-path-prefixes', key: 'stripPathPrefixes', parse: parseListValue },
  { flag: '--exclude-patterns', key: 'excludePatterns', parse: parseListValue },
  { flag: '--robots-directives', key: 'robotsDirectives', parse: parseListValue },
  // Boolean flags (positive)
  { flag: '--pretty-urls', key: 'prettyUrls', value: true },
  { flag: '--sitemap-index', key: 'sitemapIndex', value: true },
  { flag: '--generate-sitemap', key: 'generateSitemap', value: true },
  { flag: '--generate-robots', key: 'generateRobots', value: true },
  { flag: '--llms-md-mirror', key: 'llmsMdMirror', value: true },
  { flag: '--generate-humans', key: 'generateHumans', value: true },
  { flag: '--generate-feed', key: 'generateFeed', value: true },
  { flag: '--audit', key: 'audit', value: true },
  { flag: '--debug', key: 'debug', value: true },
  // Boolean flags (negative)
  { flag: '--no-pretty-urls', key: 'prettyUrls', value: false },
  { flag: '--no-sitemap-index', key: 'sitemapIndex', value: false },
  { flag: '--no-generate-sitemap', key: 'generateSitemap', value: false },
  { flag: '--no-generate-robots', key: 'generateRobots', value: false },
  { flag: '--no-llms-md-mirror', key: 'llmsMdMirror', value: false },
  { flag: '--no-generate-humans', key: 'generateHumans', value: false },
  { flag: '--no-generate-feed', key: 'generateFeed', value: false },
  { flag: '--no-audit', key: 'audit', value: false },
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

    if (arg.startsWith('--audit=')) {
      options.audit = parseBooleanValue(arg.slice('--audit='.length), '--audit');
      continue;
    }
    if (arg.startsWith('--no-audit=')) {
      throw new Error('--no-audit does not accept a value. Use --audit=true|false.');
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
    if (arg === '--generate-feed=false' || arg === '--generate-feed=true') {
      options.generateFeed = parseBooleanValue(arg.split('=')[1], '--generate-feed');
      continue;
    }
    if (arg === '--generate-sitemap=false' || arg === '--generate-sitemap=true') {
      options.generateSitemap = parseBooleanValue(arg.split('=')[1], '--generate-sitemap');
      continue;
    }
    if (arg === '--generate-robots=false' || arg === '--generate-robots=true') {
      options.generateRobots = parseBooleanValue(arg.split('=')[1], '--generate-robots');
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
  const plan = await buildGeoGenerationPlanFromDisk({
    projectRoot: cwd,
    distDir,
    options: {
      ...options,
      sourceHtmlDir: options.sourceHtmlDir
        ? resolvePathFromCwd(cwd, options.sourceHtmlDir)
        : undefined,
      packageJsonPath: options.packageJsonPath === false
        ? false
        : resolvePathFromCwd(cwd, options.packageJsonPath || './package.json'),
    },
  });

  logGeoAudit(plan.report.audit, logger);

  if (plan.report.totalHtmlFiles === 0) {
    logger.warn('⚠️  No HTML files found in dist directory');
    return { generatedFiles: [] };
  }
  if (plan.report.includedHtmlFiles === 0) {
    logger.warn('⚠️  All HTML files were excluded by filters');
    return { generatedFiles: [] };
  }

  applyGeoGenerationPlanToDisk(plan, { distDir });
  logRobotsPreservation(plan.report.robotsCompatibility, logger);
  const generatedFiles = plan.files.map(({ filename }) => filename);
  generatedFiles.forEach((filename) => logger.log(`✅ Generated ${filename}`));
  if (plan.htmlUpdates.length > 0) {
    logger.log(`✅ Injected discovery metadata into ${plan.htmlUpdates.length} HTML file(s)`);
  }
  logger.log(`\n🎉 GEO generation complete. ${generatedFiles.length} file(s) updated.`);
  return {
    distDir,
    generatedFiles,
    includedHtmlFiles: plan.report.includedHtmlFiles,
    excludedHtmlFiles: plan.report.excludedHtmlFiles,
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
