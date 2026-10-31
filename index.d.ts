import type { Plugin } from 'vite';

export type LastmodStrategy = 'none' | 'file-mtime' | 'build' | 'git';
export type LlmsMdMirrorStyle = 'append' | 'replace';
export type SitemapConflict = 'preserve' | 'error' | 'overwrite';
export type RouteConflict = 'error' | 'first' | 'last';
export type AuditFailOn = 'warning' | 'advice';
export type VerifyFailOn = 'error' | 'warning' | 'none';
export type ReportFormat = 'json' | 'sarif';
export type DiagnosticSeverity = 'error' | 'warning' | 'advice';

export interface LlmsPageInfo {
  filePath: string;
  relativePath: string;
  pagePath: string;
  url: string;
  title: string;
  description: string;
  isHome: boolean;
}

export interface GeoPageModel {
  filePath: string;
  relativePath: string;
  pagePath: string;
  pageUrl: string;
  title: string;
  description: string;
  lang: string;
  noindex: boolean;
  mtime: string | null;
}

export interface SkuMdOptions {
  merchantName?: string;
  summary?: string;
  catalog: Array<{
    label: string;
    url: string;
  }>;
}

export interface GeoGeneratorOptions {
  domain?: string;
  distDir?: string;
  routeBasePath?: string;
  stripPathPrefixes?: string[];
  sourceHtmlDir?: string;
  packageJsonPath?: string | false;
  prettyUrls?: boolean;
  lastmodStrategy?: LastmodStrategy;
  lastmodIgnore?: string[];
  /** Plugin API only. `null` omits lastmod; `undefined` falls through to the strategy. */
  lastmodResolver?: (page: GeoPageModel) => Date | string | null | undefined;
  excludePatterns?: string[];
  hreflang?: Record<string, string>;
  /** Read per-page `hreflang` alternates from HTML instead of global patterns. */
  hreflangFromHtml?: boolean;
  sitemapIndex?: boolean;
  sitemapMaxBytes?: number;
  generateSitemap?: boolean;
  sitemapConflict?: SitemapConflict;
  sitemapUrl?: string;
  routeConflict?: RouteConflict;
  llmsMdMirror?: boolean;
  llmsMdMirrorStyle?: LlmsMdMirrorStyle;
  llmsSections?: Record<string, string | string[]>;
  llmsClassify?: (page: LlmsPageInfo) => string | null | undefined;
  generateFeed?: boolean;
  generateHumans?: boolean;
  generateRobots?: boolean;
  robotsDirectives?: string[];
  skuMd?: SkuMdOptions;
  audit?: boolean;
  /** Fail the build when audit findings reach this severity. Unset never fails. */
  auditFailOn?: AuditFailOn;
  debug?: boolean;
}

export interface GeoDiagnostic {
  path: string;
  rule: string;
  severity: DiagnosticSeverity;
  evidence: string;
  suggestion: string;
}

export interface GeoAuditReport {
  checkedPages: number;
  diagnostics: GeoDiagnostic[];
}

export interface GeoVerifyChecks {
  checkedPages: number;
  excludedHtmlFiles: number;
  checkedLocs: number;
  sitemapChecked: boolean;
  sitemapFiles: string[];
  markdownMirrorPaths: string[];
}

export interface GeoVerifySummary {
  siteUrl: string;
  routeBasePath: string;
  distDir: string;
  sitemapFile: string | null;
  sitemapLocCount: number;
  pageCount: number;
  errorCount: number;
  warningCount: number;
}

export interface GeoVerifyResult {
  ok: boolean;
  errors: GeoDiagnostic[];
  warnings: GeoDiagnostic[];
  checks: GeoVerifyChecks;
  summary: GeoVerifySummary;
}

export interface VerifyGeoOutputOptions {
  projectRoot?: string;
  distDir: string;
  options?: GeoGeneratorOptions;
  siteUrl?: string;
  routeBasePath?: string;
}

export function verifyGeoOutput(params: VerifyGeoOutputOptions): GeoVerifyResult;

export interface GeoJsonReport {
  schemaVersion: '1.0';
  tool: { name: string; version: string };
  command: 'generate' | 'verify';
  generatedAt: string;
  siteUrl: string | null;
  routeBasePath: string;
  distDir: string | null;
  summary: { errors: number; warnings: number; advice: number };
  verify: {
    ok: boolean;
    errors: GeoDiagnostic[];
    warnings: GeoDiagnostic[];
    checks: GeoVerifyChecks;
    summary: GeoVerifySummary;
  } | null;
  audit: GeoAuditReport | null;
  generatedFiles: Array<{ filename: string; size?: number }>;
}

export interface WriteReportOptions {
  format: ReportFormat;
  filePath?: string | null;
  report: GeoJsonReport | Record<string, unknown>;
  stdout?: NodeJS.WritableStream;
}

export function createJsonReport(params: {
  command?: 'generate' | 'verify';
  version?: string;
  siteUrl?: string;
  routeBasePath?: string;
  distDir?: string;
  audit?: GeoAuditReport;
  verify?: GeoVerifyResult;
  generatedFiles?: Array<string | { filename: string; size?: number }>;
  generatedAt?: string;
}): GeoJsonReport;

export function createSarifReport(params: {
  version?: string;
  audit?: GeoAuditReport;
  verify?: GeoVerifyResult;
  projectRoot?: string;
  distDir?: string;
}): Record<string, unknown>;

export function writeReport(params: WriteReportOptions): {
  written: boolean;
  target: 'file' | 'stdout';
  filePath?: string;
};

export function createGeoGeneratorPlugin(options?: GeoGeneratorOptions): Plugin;
export const geo: typeof createGeoGeneratorPlugin;
export default geo;
