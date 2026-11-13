/**
 * Machine-readable reports for CI consumers.
 *
 * JSON reports are versioned; SARIF reports follow 2.1.0 so GitHub code
 * scanning, GitLab and other CI systems can ingest them directly.
 */

import { writeFileSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';
import { pathToFileURL } from 'url';

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

function normalizeDiagnostic(diagnostic, fallbackSeverity) {
  return {
    path: String(diagnostic.path || ''),
    rule: String(diagnostic.rule || 'unknown'),
    severity: diagnostic.severity || fallbackSeverity,
    evidence: String(diagnostic.evidence || ''),
    suggestion: String(diagnostic.suggestion || ''),
  };
}

/**
 * Create the versioned JSON report.
 *
 * @param {object} params
 * @param {'generate'|'verify'} [params.command='generate']
 * @param {string} [params.version='unknown']
 * @param {string} [params.siteUrl]
 * @param {string} [params.routeBasePath='']
 * @param {string} [params.distDir]
 * @param {object} [params.audit] - auditGeoPlan result
 * @param {object} [params.verify] - verifyGeoOutput result
 * @param {string[]} [params.generatedFiles=[]]
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
    generatedFiles: generatedFiles.map((entry) => (
      typeof entry === 'string' ? { filename: entry } : entry
    )),
  };
}

function resolveArtifactUri(pathValue, projectRoot, distDir) {
  const raw = String(pathValue || '').replace(/\\/g, '/');
  if (!raw) return null;
  if (isAbsolute(pathValue)) {
    return pathToFileURL(pathValue).href;
  }

  const normalized = raw.replace(/^\.?\//, '');
  if (!projectRoot || !distDir) return normalized;

  const distRelative = relative(resolve(projectRoot), resolve(distDir)).replace(/\\/g, '/');
  return distRelative && distRelative !== '.'
    ? `${distRelative.replace(/\/+$/, '')}/${normalized}`
    : normalized;
}

/**
 * Create a SARIF 2.1.0 report.
 *
 * @param {object} params
 * @param {string} [params.version='unknown']
 * @param {object} [params.audit]
 * @param {object} [params.verify]
 * @param {string} [params.projectRoot]
 * @param {string} [params.distDir]
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

    const uri = resolveArtifactUri(normalized.path, projectRoot, distDir);
    const message = normalized.evidence
      ? `${normalized.evidence}${normalized.suggestion ? `；${normalized.suggestion}` : ''}`
      : normalized.rule;

    const result = {
      ruleId: normalized.rule,
      level,
      message: { text: message },
    };
    if (uri) {
      result.locations = [{
        physicalLocation: {
          artifactLocation: {
            uri,
            ...(projectRoot ? { uriBaseId: '%SRCROOT%' } : {}),
          },
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
          rules: [...rules.values()].sort((a, b) => a.id.localeCompare(b.id)),
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
 * @param {NodeJS.WritableStream} [params.stdout]
 * @returns {{written: boolean, target: 'file'|'stdout', filePath?: string}}
 */
export function writeReport({ format, filePath, report, stdout = process.stdout }) {
  if (format !== 'json' && format !== 'sarif') {
    throw new Error(`Unsupported report format: ${format}. Use json or sarif.`);
  }

  const content = `${JSON.stringify(report, null, 2)}\n`;
  if (filePath) {
    writeFileSync(filePath, content, 'utf-8');
    return { written: true, target: 'file', filePath };
  }

  stdout.write(content);
  return { written: true, target: 'stdout' };
}
