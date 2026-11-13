import type { Plugin } from 'vite';

export type LastmodStrategy = 'none' | 'file-mtime' | 'build' | 'git';
export type LlmsMdMirrorStyle = 'append' | 'replace';
export type SitemapConflict = 'preserve' | 'error' | 'overwrite';
export type FileConflict = 'preserve' | 'error' | 'overwrite';
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

export interface GeoHreflangEntry {
  hreflang: string;
  href: string;
}

export interface GeoAuditFacts {
  titles: string[];
  descriptions: string[];
  lang: string;
  h1Count: number;
  canonicals: string[];
  baseHref: string | null;
  jsonLd: string[];
  missingAlt: number;
  anchors: Array<{ href: string; download: boolean }>;
  links: Array<{ rel: string; type: string; href: string; hreflang: string }>;
}

export interface GeoPageModel {
  filePath: string;
  relativePath: string;
  pagePath: string;
  pageUrl: string;
  filePageUrl: string;
  htmlContent: string;
  title: string;
  description: string;
  lang: string;
  noindex: boolean;
  hreflang: GeoHreflangEntry[];
  documentBaseUrl: string;
  markdown: string;
  mtime: string | null;
  audit?: GeoAuditFacts;
  excludeReason?: string;
  mirrorRelativePath?: string;
  markdownUrl?: string | null;
  hasExistingMarkdownAlternate?: boolean;
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
  /**
   * Plugin API only. Return a Date or a valid W3C Datetime string
   * (`2025-05-05`, `2025-05-05T00:00:00Z`, `2025-05-05T00:00:00+08:00`).
   * `null` omits lastmod and `undefined` falls through to the strategy.
   * Invalid values throw while the generation plan is built.
   */
  lastmodResolver?: (page: GeoPageModel) => Date | string | null | undefined;
  excludePatterns?: string[];
  hreflang?: Record<string, string>;
  /** Read per-page `hreflang` alternates from HTML instead of global patterns. */
  hreflangFromHtml?: boolean;
  sitemapIndex?: boolean;
  sitemapMaxBytes?: number;
  generateSitemap?: boolean;
  sitemapConflict?: SitemapConflict;
  /**
   * Policy when a generated companion file (llms.txt, feed.xml, humans.txt,
   * sku.md, or a Markdown mirror) already exists as a user file.
   * Defaults to 'preserve'. Sitemaps and robots.txt use their own options.
   */
  fileConflict?: FileConflict;
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

export interface GeoFileCompatibilityDecision {
  filename: string;
  decision: 'preserve' | 'overwrite';
}

export interface GeoFileCompatibility {
  policy: FileConflict;
  decisions: GeoFileCompatibilityDecision[];
}

export interface ReportWritableStream {
  write(chunk: string): unknown;
}

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
  preservedFiles: string[];
  fileCompatibility: GeoFileCompatibility | null;
}

export interface WriteReportOptions {
  format: ReportFormat;
  filePath?: string | null;
  report: GeoJsonReport | Record<string, unknown>;
  stdout?: ReportWritableStream;
}

export function createJsonReport(params?: {
  command?: 'generate' | 'verify';
  version?: string;
  siteUrl?: string | null;
  routeBasePath?: string;
  distDir?: string | null;
  audit?: GeoAuditReport | null;
  verify?: GeoVerifyResult | null;
  generatedFiles?: Array<string | { filename: string; size?: number }> | null;
  preservedFiles?: string[] | null;
  fileCompatibility?: GeoFileCompatibility | null;
  generatedAt?: string | null;
}): GeoJsonReport;

export function createSarifReport(params?: {
  version?: string;
  audit?: GeoAuditReport | null;
  verify?: GeoVerifyResult | null;
  projectRoot?: string | null;
  distDir?: string | null;
}): Record<string, unknown>;

export function writeReport(params: WriteReportOptions): {
  written: boolean;
  target: 'file' | 'stdout';
  filePath?: string;
};

export function createGeoGeneratorPlugin(options?: GeoGeneratorOptions): Plugin;
export const geo: typeof createGeoGeneratorPlugin;
export default geo;
