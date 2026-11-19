#!/usr/bin/env node

import { assertAuditGate, assertVerifyGate, logGeoAudit, safeText } from './geoAudit.js';
import { readFileSync, realpathSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  applyGeoGenerationPlanToDisk,
  buildGeoGenerationPlanFromDisk,
  formatGeoDebugSummary,
  logFileCompatibility,
  logRobotsPreservation,
  logSitemapCompatibility,
  summarizeExcludedReasons,
  validateGeoOptions,
} from './geoBuildPipeline.js';
import { sanitizeControlChars } from './geoGenerator.js';
import { verifyGeoOutput } from './geoVerify.js';
import { createJsonReport, createSarifReport, writeReport } from './geoReport.js';
import { resolvePluginVersion } from './viteGeoGeneratorPlugin.js';

const USAGE = `
Usage:
  vite-plugin-geo [generate] [options]
  vite-plugin-geo verify [options]

Options:
  --domain <url>              Public site domain, overrides package.json domain/homepage
  --dist-dir <path>            Dist directory (default: dist)
  --route-base-path <path>     URL base path (default: '')
  --source-html-dir <path>     Source HTML directory for mtime (default: src/pages)
  --package-json-path <path>   package.json path (default: ./package.json)
  --strip-path-prefixes <list> Comma-separated prefixes (default: src/pages/)
  --exclude-patterns <list>    Comma-separated glob patterns
  --trailing-slash <mode>      never | always | preserve (default: never)
  --lastmod-strategy <value>   none | file-mtime | build | git (default: none)
  --lastmod-ignore <list>      Comma-separated glob patterns skipped by lastmod
  --llms-md-mirror-style <value> append | replace (default: append)
  --llms-md-mirror-include <list> Comma-separated globs selecting pages for .md mirrors
  --llms-md-mirror-exclude <list> Comma-separated globs excluding pages from .md mirrors
  --markdown-strip-selectors <list> Comma-separated CSS selectors stripped before Markdown conversion
  --robots-directives <list>   Comma-separated robots directives
  --sitemap-url <path-or-url>  Public sitemap URL/path used by robots.txt and llms.txt
  --sitemap-conflict <mode>    preserve | error | overwrite (default: preserve when unset)
  --file-conflict <mode>       preserve | error | overwrite (default: preserve)
  --route-conflict <mode>      error | first | last (default: error)
  --pretty-urls / --no-pretty-urls
  --sitemap-index / --no-sitemap-index
  --generate-sitemap / --no-generate-sitemap
  --generate-robots / --no-generate-robots
  --llms-md-mirror / --no-llms-md-mirror
  --generate-humans / --no-generate-humans
  --generate-feed / --no-generate-feed
  --feed-include-patterns <list> Comma-separated globs limiting pages included in RSS feeds
  --feed-exclude-patterns <list> Comma-separated globs excluding pages from RSS feeds
  --feed-max-items <number>    Maximum number of items emitted per RSS feed
  --feed-language <tag>        Explicit BCP 47 <language> tag for generated RSS feeds
  --feed-by-locale / --no-feed-by-locale Toggle per-locale RSS feed generation
  --hreflang-from-html / --no-hreflang-from-html
  --audit / --no-audit        Build diagnostics (default: enabled; never fails on findings)
  --fail-on-audit <level>     none | warning | advice (default: none)
  --fail-on-verify <level>    none | error | warning (default: error)
  --report <json|sarif>       Write a machine-readable report
  --report-file <path>        Report output path (default: stdout)
  --verify / --no-verify      Run verification after generation
  --debug / --no-debug
  --config <path>              JSON config file path
  -h, --help                   Show help
`;

const REPORT_FORMATS = ['json', 'sarif'];
const FAIL_ON_AUDIT_VALUES = ['none', 'warning', 'advice'];
const FAIL_ON_VERIFY_VALUES = ['none', 'error', 'warning'];
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function parseListValue(value) {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseStrictIntegerValue(value) {
  const trimmed = String(value).trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

function parseBooleanValue(value, flagName) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing value for ${flagName}`);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid boolean for ${flagName}: ${value}. Use true or false.`);
}

function parseNonBooleanValue(args, index, flagName, { allowEmpty = false } = {}) {
  const token = args[index];
  if (token?.includes('=')) {
    const value = token.split('=').slice(1).join('=');
    if (value === '' && !allowEmpty) {
      throw new Error(`Missing value for ${flagName}`);
    }
    return { value, nextIndex: index };
  }

  const nextValue = args[index + 1];
  if (nextValue === undefined || (!allowEmpty && nextValue === '') || nextValue.startsWith('-')) {
    throw new Error(`Missing value for ${flagName}`);
  }

  return { value: nextValue, nextIndex: index + 1 };
}

function sanitizeConfigValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeConfigValue(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const clean = {};
  Object.entries(value).forEach(([key, entry]) => {
    if (!UNSAFE_OBJECT_KEYS.has(key)) {
      clean[key] = sanitizeConfigValue(entry);
    }
  });
  return clean;
}

function readJsonConfig(configPath, cwd) {
  const resolvedPath = resolvePathFromCwd(cwd, configPath);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolvedPath, 'utf-8'));
  } catch (error) {
    throw new Error(`Invalid GEO config file (${resolvedPath}): ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid GEO config file (${resolvedPath}): top-level JSON value must be an object.`);
  }
  return sanitizeConfigValue(parsed);
}

function mergeConfigWithCliOptions(configOptions, cliOptions) {
  const merged = sanitizeConfigValue(configOptions);
  Object.entries(cliOptions).forEach(([key, value]) => {
    if (value !== undefined && !UNSAFE_OBJECT_KEYS.has(key)) {
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
  { flag: '--route-base-path', key: 'routeBasePath', allowEmpty: true },
  { flag: '--source-html-dir', key: 'sourceHtmlDir' },
  {
    flag: '--package-json-path',
    key: 'packageJsonPath',
    parse: (value) => (value === 'false' ? false : value),
  },
  { flag: '--lastmod-strategy', key: 'lastmodStrategy' },
  { flag: '--trailing-slash', key: 'trailingSlash' },
  { flag: '--llms-md-mirror-style', key: 'llmsMdMirrorStyle' },
  { flag: '--feed-language', key: 'feedLanguage' },
  { flag: '--feed-max-items', key: 'feedMaxItems', parse: parseStrictIntegerValue },
  { flag: '--sitemap-url', key: 'sitemapUrl' },
  { flag: '--sitemap-conflict', key: 'sitemapConflict' },
  { flag: '--file-conflict', key: 'fileConflict' },
  { flag: '--route-conflict', key: 'routeConflict' },
  { flag: '--fail-on-audit', key: 'failOnAudit' },
  { flag: '--fail-on-verify', key: 'failOnVerify' },
  { flag: '--report', key: 'report' },
  { flag: '--report-file', key: 'reportFile' },
  // List arguments (comma-separated)
  { flag: '--strip-path-prefixes', key: 'stripPathPrefixes', parse: parseListValue },
  { flag: '--exclude-patterns', key: 'excludePatterns', parse: parseListValue },
  { flag: '--robots-directives', key: 'robotsDirectives', parse: parseListValue },
  { flag: '--lastmod-ignore', key: 'lastmodIgnore', parse: parseListValue },
  { flag: '--markdown-strip-selectors', key: 'markdownStripSelectors', parse: parseListValue },
  { flag: '--llms-md-mirror-include', key: 'llmsMdMirrorInclude', parse: parseListValue },
  { flag: '--llms-md-mirror-exclude', key: 'llmsMdMirrorExclude', parse: parseListValue },
  { flag: '--feed-include-patterns', key: 'feedIncludePatterns', parse: parseListValue },
  { flag: '--feed-exclude-patterns', key: 'feedExcludePatterns', parse: parseListValue },
  // Boolean flags (positive)
  { flag: '--pretty-urls', key: 'prettyUrls', value: true },
  { flag: '--sitemap-index', key: 'sitemapIndex', value: true },
  { flag: '--generate-sitemap', key: 'generateSitemap', value: true },
  { flag: '--generate-robots', key: 'generateRobots', value: true },
  { flag: '--llms-md-mirror', key: 'llmsMdMirror', value: true },
  { flag: '--generate-humans', key: 'generateHumans', value: true },
  { flag: '--generate-feed', key: 'generateFeed', value: true },
  { flag: '--feed-by-locale', key: 'feedByLocale', value: true },
  { flag: '--hreflang-from-html', key: 'hreflangFromHtml', value: true },
  { flag: '--audit', key: 'audit', value: true },
  { flag: '--debug', key: 'debug', value: true },
  { flag: '--verify', key: 'verify', value: true },
  // Boolean flags (negative)
  { flag: '--no-pretty-urls', key: 'prettyUrls', value: false },
  { flag: '--no-sitemap-index', key: 'sitemapIndex', value: false },
  { flag: '--no-generate-sitemap', key: 'generateSitemap', value: false },
  { flag: '--no-generate-robots', key: 'generateRobots', value: false },
  { flag: '--no-llms-md-mirror', key: 'llmsMdMirror', value: false },
  { flag: '--no-generate-humans', key: 'generateHumans', value: false },
  { flag: '--no-generate-feed', key: 'generateFeed', value: false },
  { flag: '--no-feed-by-locale', key: 'feedByLocale', value: false },
  { flag: '--no-hreflang-from-html', key: 'hreflangFromHtml', value: false },
  { flag: '--no-audit', key: 'audit', value: false },
  { flag: '--no-verify', key: 'verify', value: false },
  { flag: '--no-debug', key: 'debug', value: false },
];

function validateCliOptions(options, { requireReportForFile = true } = {}) {
  if (options.verify !== undefined && typeof options.verify !== 'boolean') {
    throw new Error("Option 'verify' must be a boolean.");
  }
  if (options.report !== undefined && !REPORT_FORMATS.includes(options.report)) {
    throw new Error(`Invalid report format: ${options.report}. Use json or sarif.`);
  }
  if (options.reportFile !== undefined && (typeof options.reportFile !== 'string' || !options.reportFile.trim())) {
    throw new Error("Option 'reportFile' must be a non-empty string.");
  }
  if (requireReportForFile && options.reportFile !== undefined && options.report === undefined) {
    throw new Error('--report-file requires --report <json|sarif>.');
  }
  if (options.failOnAudit !== undefined && !FAIL_ON_AUDIT_VALUES.includes(options.failOnAudit)) {
    throw new Error(`Invalid --fail-on-audit value: ${options.failOnAudit}. Use none, warning, or advice.`);
  }
  if (options.failOnVerify !== undefined && !FAIL_ON_VERIFY_VALUES.includes(options.failOnVerify)) {
    throw new Error(`Invalid --fail-on-verify value: ${options.failOnVerify}. Use none, error, or warning.`);
  }
}

export function parseCliArgs(argv = []) {
  const args = [...argv];
  const options = {};
  let command = 'generate';
  let hasCommand = false;
  let showHelp = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      showHelp = true;
      continue;
    }

    if (!arg.startsWith('-')) {
      if ((arg === 'generate' || arg === 'verify') && !hasCommand) {
        command = arg;
        hasCommand = true;
        continue;
      }
      throw new Error(hasCommand ? `Unexpected extra command: ${arg}` : `Unsupported command: ${arg}`);
    }

    // Table-driven argument matching
    let matched = false;
    for (const def of CLI_ARG_DEFS) {
      const isExact = arg === def.flag;
      const hasValue = arg.startsWith(`${def.flag}=`);
      if (!isExact && !hasValue) continue;

      if (def.value !== undefined) {
        // Boolean flag
        if (!hasValue) {
          options[def.key] = def.value;
        } else if (def.value === false) {
          const positiveFlag = def.flag.replace(/^--no-/, '--');
          throw new Error(`${def.flag} does not accept a value. Use ${positiveFlag}=true|false.`);
        } else {
          options[def.key] = parseBooleanValue(arg.slice(def.flag.length + 1), def.flag);
        }
      } else {
        // String/list argument
        const { value, nextIndex } = parseNonBooleanValue(args, i, def.flag, { allowEmpty: def.allowEmpty });
        options[def.key] = def.parse ? def.parse(value) : value;
        i = nextIndex;
      }
      matched = true;
      break;
    }

    if (!matched) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  validateCliOptions(options, { requireReportForFile: options.config === undefined });

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

function resolveCliOptions(rawOptions = {}, cwd = process.cwd()) {
  const configOptions = rawOptions.config
    ? readJsonConfig(rawOptions.config, cwd)
    : {};
  const options = mergeConfigWithCliOptions(configOptions, rawOptions);
  delete options.config;

  validateCliOptions(options, { requireReportForFile: true });
  validateGeoOptions(options);

  if (options.sourceHtmlDir) {
    options.sourceHtmlDir = resolvePathFromCwd(cwd, options.sourceHtmlDir);
  }
  options.packageJsonPath = options.packageJsonPath === false
    ? false
    : resolvePathFromCwd(cwd, options.packageJsonPath || './package.json');

  return options;
}

export async function runSeoCliGenerate(rawOptions = {}, runtime = {}) {
  const cwd = runtime.cwd || process.cwd();
  const logger = runtime.logger || console;
  const options = resolveCliOptions(rawOptions, cwd);

  const distDir = resolvePathFromCwd(cwd, options.distDir || 'dist');
  const plan = await buildGeoGenerationPlanFromDisk({
    projectRoot: cwd,
    distDir,
    options,
  });
  const preservedFiles = plan.report.preservedFiles
    || (plan.report.fileCompatibility?.decisions || [])
      .filter(({ decision }) => decision === 'preserve')
      .map(({ filename }) => filename);

  logGeoAudit(plan.report.audit, logger);

  if (options.debug === true) {
    logger.log(formatGeoDebugSummary({
      projectRoot: cwd,
      distDir,
      sourceHtmlDir: options.sourceHtmlDir || resolve(cwd, 'src/pages'),
      report: plan.report,
      options,
    }));
  }

  if (plan.report.totalHtmlFiles === 0) {
    logger.warn(
      '⚠️  No HTML files found in dist directory. '
      + `distDir=${safeText(distDir)} sourceHtmlDir=${safeText(options.sourceHtmlDir || 'src/pages')} `
      + 'include=**/*.html',
    );
    return { distDir, generatedFiles: [], preservedFiles, plan };
  }
  if (plan.report.includedHtmlFiles === 0) {
    logger.warn(
      `⚠️  All ${plan.report.totalHtmlFiles} HTML file(s) were excluded by filters. `
      + `Reasons: ${safeText(summarizeExcludedReasons(plan.report.excludedDetails) || 'unknown')}`,
    );
    return { distDir, generatedFiles: [], preservedFiles, plan };
  }
  (plan.report.routeConflicts || []).forEach(({ route, files, chosen }) => {
    const safeFiles = files.map((file) => safeText(file)).join('、');
    logger.warn(`⚠️  Route conflict for ${safeText(route)}: ${safeFiles}; kept ${safeText(chosen)}.`);
  });

  try {
    assertAuditGate(plan.report.audit, options.failOnAudit ?? options.auditFailOn);
  } catch (error) {
    error.plan = plan;
    throw error;
  }

  applyGeoGenerationPlanToDisk(plan, { distDir });
  logSitemapCompatibility(plan.report.sitemapCompatibility, logger);
  logRobotsPreservation(plan.report.robotsCompatibility, logger);
  logFileCompatibility(plan.report.fileCompatibility, logger);
  const generatedFiles = plan.files.map(({ filename }) => filename);
  generatedFiles.forEach((filename) => logger.log(`✅ Generated ${filename}`));
  if (plan.htmlUpdates.length > 0) {
    logger.log(`✅ Injected discovery metadata into ${plan.htmlUpdates.length} HTML file(s)`);
  }
  const preservedSummary = preservedFiles.length > 0
    ? `, ${preservedFiles.length} user file(s) preserved`
    : '';
  logger.log(`\n🎉 GEO generation complete. ${generatedFiles.length} file(s) updated${preservedSummary}.`);
  return {
    distDir,
    generatedFiles,
    preservedFiles,
    includedHtmlFiles: plan.report.includedHtmlFiles,
    excludedHtmlFiles: plan.report.excludedHtmlFiles,
    plan,
  };
}

export async function runSeoCliVerify(rawOptions = {}, runtime = {}) {
  const cwd = runtime.cwd || process.cwd();
  const logger = runtime.logger || console;
  const options = resolveCliOptions(rawOptions, cwd);
  const distDir = resolvePathFromCwd(cwd, options.distDir || 'dist');

  const result = await verifyGeoOutput({
    projectRoot: cwd,
    distDir,
    options,
  });

  const writeError = logger.error
    ? (message) => logger.error(message)
    : (message) => logger.log(message);
  const writeWarning = logger.warn
    ? (message) => logger.warn(message)
    : (message) => logger.log(message);

  result.errors.forEach((item) => writeError(
    `[GEO verify] [错误] ${safeText(item.path)} [${safeText(item.rule)}] ${safeText(item.evidence)}`,
  ));
  result.warnings.forEach((item) => writeWarning(
    `[GEO verify] [警告] ${safeText(item.path)} [${safeText(item.rule)}] ${safeText(item.evidence)}`,
  ));
  (logger.log || console.log)(
    `[GEO verify] 已检查 ${result.checks.checkedPages} 个页面，${result.checks.checkedLocs} 条 sitemap loc；`
    + `${result.errors.length} 项错误，${result.warnings.length} 项警告。`,
  );

  return { distDir, ...result };
}

function createReportStdoutLogger(logger) {
  const sink = (...args) => (logger.error || logger.log || console.error)(...args);
  return { log: sink, warn: sink, error: sink };
}

function resolveReportSiteUrl(options, verification, plan) {
  if (verification?.summary?.siteUrl) return verification.summary.siteUrl;
  if (plan?.report?.siteUrl) return plan.report.siteUrl;
  return typeof options.domain === 'string' ? options.domain : undefined;
}

export async function runCli(argv = process.argv.slice(2), runtime = {}) {
  const baseLogger = runtime.logger || console;

  try {
    const parsed = parseCliArgs(argv);

    if (parsed.showHelp) {
      baseLogger.log(USAGE.trim());
      return 0;
    }

    const cwd = runtime.cwd || process.cwd();
    const options = resolveCliOptions(parsed.options, cwd);
    const reportToStdout = Boolean(options.report) && !options.reportFile;
    const logger = reportToStdout ? createReportStdoutLogger(baseLogger) : baseLogger;
    const runtimeInfo = { ...runtime, logger };

    let generateResult = null;
    let generateError = null;
    let verification = null;

    if (parsed.command === 'generate') {
      try {
        generateResult = await runSeoCliGenerate(options, runtimeInfo);
      } catch (error) {
        if (error.plan) {
          generateError = error;
          generateResult = {
            distDir: resolvePathFromCwd(cwd, options.distDir || 'dist'),
            generatedFiles: [],
            preservedFiles: error.plan.report?.preservedFiles || [],
            plan: error.plan,
          };
        } else {
          throw error;
        }
      }

      if (options.verify && !generateError) {
        verification = await runSeoCliVerify(options, runtimeInfo);
      }
    } else {
      verification = await runSeoCliVerify(options, runtimeInfo);
    }

    if (options.report) {
      const distDir = generateResult?.distDir
        || resolvePathFromCwd(cwd, options.distDir || 'dist');
      const audit = generateResult?.plan?.report?.audit;
      const reportedGeneratedFiles = !generateError && (generateResult?.generatedFiles?.length || 0) > 0
        ? (generateResult?.plan?.report?.generatedFiles || generateResult.generatedFiles)
        : [];
      const report = options.report === 'sarif'
        ? createSarifReport({
            version: resolvePluginVersion(),
            audit,
            verify: verification,
            projectRoot: cwd,
            distDir,
          })
        : createJsonReport({
            command: parsed.command,
            version: resolvePluginVersion(),
            siteUrl: resolveReportSiteUrl(options, verification, generateResult?.plan),
            routeBasePath: verification?.summary?.routeBasePath || options.routeBasePath || '',
            distDir,
            audit,
            verify: verification,
            generatedFiles: reportedGeneratedFiles,
            preservedFiles: generateResult?.preservedFiles || [],
            fileCompatibility: generateResult?.plan?.report?.fileCompatibility || null,
          });
      const written = writeReport({
        format: options.report,
        filePath: options.reportFile ? resolvePathFromCwd(cwd, options.reportFile) : null,
        report,
        stdout: runtime.stdout || process.stdout,
      });
      if (written.target === 'file') {
        logger.log(`✅ Wrote ${options.report.toUpperCase()} report to ${safeText(written.filePath)}`);
      }
    }

    if (generateError) {
      throw generateError;
    }
    if (verification) {
      assertVerifyGate(verification, options.failOnVerify || 'error');
    }
    return 0;
  } catch (error) {
    baseLogger.error(`❌ ${sanitizeControlChars(error.message || String(error))}`);
    baseLogger.error('\nUse --help to view command usage.');
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

function normalizeExecutablePath(filePath, platform = process.platform) {
  if (!filePath) {
    return null;
  }
  return platform === 'win32' ? filePath.toLowerCase() : filePath;
}

export function isCliEntrypoint({
  argv = process.argv,
  metaUrl = import.meta.url,
  importMetaMain = import.meta.main,
  platform = process.platform,
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

  const resolvedModule = normalizeExecutablePath(resolveExecutablePath(modulePath), platform);
  const candidates = [argvPath, `${argvPath}.js`, `${argvPath}.mjs`];
  return candidates.some(
    (candidate) => normalizeExecutablePath(resolveExecutablePath(candidate), platform) === resolvedModule,
  );
}

const isDirectRun = isCliEntrypoint();

if (isDirectRun) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`❌ ${sanitizeControlChars(error?.message || String(error))}`);
      process.exitCode = 1;
    });
}
