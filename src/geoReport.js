/**
 * Machine-readable reports for CI consumers.
 *
 * JSON reports are versioned; SARIF reports follow 2.1.0 so GitHub code
 * scanning, GitLab and other CI systems can ingest them directly.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { pathToFileURL } from 'url';
import { compareCodeUnits, isWithinDir, sanitizeControlChars } from './geoGenerator.js';

const TOOL_NAME = 'vite-plugin-geo';
const JSON_SCHEMA_VERSION = '1.0';
const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const SARIF_VERSION = '2.1.0';

function auditCounts(audit) {
  const diagnostics = audit?.diagnostics || [];
  return {
    warnings: diagnostics.filter((item) => item.severity === 'warning').length,
    advice: diagnostics.filter((item) => item.severity === 'advice').length,
  };
}

function sanitizeText(value) {
  return sanitizeControlChars(value, { preserveNewlines: false });
}

function normalizeDiagnostic(diagnostic, fallbackSeverity) {
  return {
    path: sanitizeText(diagnostic.path || ''),
    rule: sanitizeText(diagnostic.rule || 'unknown'),
    severity: diagnostic.severity || fallbackSeverity,
    evidence: sanitizeText(diagnostic.evidence || ''),
    suggestion: sanitizeText(diagnostic.suggestion || ''),
  };
}

/**
 * Create the versioned JSON report.
 *
 * @param {object} [params={}]
 * @param {'generate'|'verify'} [params.command='generate']
 * @param {string} [params.version='unknown']
 * @param {string|null} [params.siteUrl]
 * @param {string} [params.routeBasePath='']
 * @param {string|null} [params.distDir]
 * @param {object|null} [params.audit] - auditGeoPlan result
 * @param {object|null} [params.verify] - verifyGeoOutput result
 * @param {Array<string|{filename: string, size?: number}>} [params.generatedFiles=[]]
 * @param {string[]} [params.preservedFiles=[]]
 * @param {object|null} [params.fileCompatibility=null]
 * @param {string} [params.generatedAt]
 * @returns {object}
 */
export function createJsonReport({
  command = 'generate',
  version = 'unknown',
  siteUrl,
  routeBasePath = '',
  distDir,
  audit,
  verify,
  generatedFiles = [],
  preservedFiles = [],
  fileCompatibility = null,
  generatedAt,
} = {}) {
  const auditSummary = auditCounts(audit);
  const verifyErrors = verify?.errors?.length || 0;
  const verifyWarnings = verify?.warnings?.length || 0;

  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    tool: {
      name: TOOL_NAME,
      version,
    },
    command,
    generatedAt: generatedAt || new Date().toISOString(),
    siteUrl: siteUrl || verify?.summary?.siteUrl || null,
    routeBasePath: routeBasePath || verify?.summary?.routeBasePath || '',
    distDir: distDir || verify?.summary?.distDir || null,
    summary: {
      errors: verifyErrors,
      warnings: verifyWarnings + auditSummary.warnings,
      advice: auditSummary.advice,
    },
    verify: verify
      ? {
          ok: verify.ok,
          errors: (verify.errors || []).map((item) => normalizeDiagnostic(item, 'error')),
          warnings: (verify.warnings || []).map((item) => normalizeDiagnostic(item, 'warning')),
          checks: verify.checks || {},
          summary: verify.summary || {},
        }
      : null,
    audit: audit
      ? {
          checkedPages: audit.checkedPages || 0,
          diagnostics: (audit.diagnostics || []).map((item) => normalizeDiagnostic(item, 'advice')),
        }
      : null,
    generatedFiles: (generatedFiles || []).map((entry) => (
      typeof entry === 'string'
        ? { filename: sanitizeText(entry) }
        : { ...entry, filename: sanitizeText(entry?.filename || '') }
    )),
    preservedFiles: Array.isArray(preservedFiles)
      ? preservedFiles.map((filename) => sanitizeText(filename))
      : [],
    fileCompatibility: fileCompatibility ?? null,
  };
}

function encodeRelativeUri(relativePath) {
  const segments = String(relativePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) return null;
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

function resolveArtifactLocation(pathValue, projectRoot, distDir) {
  const raw = sanitizeText(pathValue).replace(/\\/g, '/').trim();
  if (!raw) return null;

  if (/^(?:file|https?):\/\//i.test(raw)) {
    return { uri: raw };
  }

  const resolvedProjectRoot = projectRoot ? resolve(projectRoot) : null;

  if (isAbsolute(raw)) {
    const resolvedTarget = resolve(raw);
    if (resolvedProjectRoot && isWithinDir(resolvedProjectRoot, resolvedTarget)) {
      const encoded = encodeRelativeUri(relative(resolvedProjectRoot, resolvedTarget));
      if (encoded) {
        return { uri: encoded, uriBaseId: '%SRCROOT%' };
      }
    }
    return { uri: pathToFileURL(resolvedTarget).href };
  }

  const normalized = raw.replace(/^\.?\//, '');
  if (!resolvedProjectRoot) {
    const encoded = encodeRelativeUri(normalized);
    return encoded ? { uri: encoded } : null;
  }

  const baseDir = distDir ? resolve(resolvedProjectRoot, distDir) : resolvedProjectRoot;
  const resolvedTarget = resolve(baseDir, normalized);
  if (isWithinDir(resolvedProjectRoot, resolvedTarget)) {
    const encoded = encodeRelativeUri(relative(resolvedProjectRoot, resolvedTarget));
    if (encoded) {
      return { uri: encoded, uriBaseId: '%SRCROOT%' };
    }
  }

  return { uri: pathToFileURL(resolvedTarget).href };
}

/**
 * Create a SARIF 2.1.0 report.
 *
 * @param {object} [params={}]
 * @param {string} [params.version='unknown']
 * @param {object|null} [params.audit]
 * @param {object|null} [params.verify]
 * @param {string} [params.projectRoot]
 * @param {string|null} [params.distDir]
 * @returns {object}
 */
export function createSarifReport({
  version = 'unknown',
  audit,
  verify,
  projectRoot,
  distDir,
} = {}) {
  const results = [];
  const rules = new Map();

  const addResult = (diagnostic, level, fallbackSeverity) => {
    const normalized = normalizeDiagnostic(diagnostic, fallbackSeverity);
    if (!rules.has(normalized.rule)) {
      rules.set(normalized.rule, {
        id: normalized.rule,
        name: normalized.rule,
        shortDescription: { text: normalized.rule },
        defaultConfiguration: { level },
      });
    }

    const location = resolveArtifactLocation(normalized.path, projectRoot, distDir);
    const message = normalized.evidence
      ? `${normalized.evidence}${normalized.suggestion ? `；${normalized.suggestion}` : ''}`
      : normalized.rule;

    const result = {
      ruleId: normalized.rule,
      level,
      message: { text: message },
    };
    if (location) {
      result.locations = [{
        physicalLocation: {
          artifactLocation: location,
        },
      }];
    }
    results.push(result);
  };

  for (const diagnostic of audit?.diagnostics || []) {
    addResult(diagnostic, diagnostic.severity === 'warning' ? 'warning' : 'note', 'note');
  }
  for (const diagnostic of verify?.errors || []) {
    addResult(diagnostic, 'error', 'error');
  }
  for (const diagnostic of verify?.warnings || []) {
    addResult(diagnostic, 'warning', 'warning');
  }

  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [{
      tool: {
        driver: {
          name: TOOL_NAME,
          informationUri: 'https://github.com/maxlee/vite-plugin-geo',
          version,
          rules: [...rules.values()].sort((a, b) => compareCodeUnits(a.id, b.id)),
        },
      },
      ...(projectRoot
        ? {
            originalUriBaseIds: {
              '%SRCROOT%': { uri: `${pathToFileURL(resolve(projectRoot)).href.replace(/\/+$/, '')}/` },
            },
          }
        : {}),
      results,
    }],
  };
}

/**
 * Write a report to disk or stdout.
 *
 * @param {object} params
 * @param {'json'|'sarif'} params.format
 * @param {string|null} [params.filePath]
 * @param {object} params.report
 * @param {{write: (chunk: string) => unknown}} [params.stdout]
 * @returns {{written: boolean, target: 'file'|'stdout', filePath?: string}}
 */
export function writeReport({ format, filePath, report, stdout = process.stdout }) {
  if (format !== 'json' && format !== 'sarif') {
    throw new Error(`Unsupported report format: ${format}. Use json or sarif.`);
  }

  const content = `${JSON.stringify(report, null, 2)}\n`;
  if (filePath) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf-8');
    return { written: true, target: 'file', filePath };
  }

  stdout.write(content);
  return { written: true, target: 'stdout' };
}
