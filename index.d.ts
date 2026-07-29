import type { Plugin } from 'vite';

export type LastmodStrategy = 'file-mtime' | 'build' | 'git';

export interface LlmsPageInfo {
  filePath: string;
  relativePath: string;
  pagePath: string;
  url: string;
  title: string;
  description: string;
  isHome: boolean;
}

export interface SkuMdOptions {
  merchantName: string;
  catalogUrl: string;
  contentLanguage?: string;
  market?: string;
}

export interface GeoGeneratorOptions {
  domain?: string;
  distDir?: string;
  routeBasePath?: string;
  stripPathPrefixes?: string[];
  sourceHtmlDir?: string;
  /** @deprecated Accepted for compatibility; Vite generation no longer polls the output directory. */
  stabilityWaitMs?: number;
  /** @deprecated Accepted for compatibility; Vite generation no longer polls the output directory. */
  stabilityPollIntervalMs?: number;
  /** @deprecated Accepted for compatibility; Vite generation no longer polls the output directory. */
  stabilityRounds?: number;
  packageJsonPath?: string | false;
  prettyUrls?: boolean;
  lastmodStrategy?: LastmodStrategy;
  excludePatterns?: string[];
  hreflang?: Record<string, string>;
  sitemapIndex?: boolean;
  sitemapMaxBytes?: number;
  generateSitemap?: boolean;
  sitemapUrl?: string;
  llmsMdMirror?: boolean;
  llmsFull?: boolean;
  llmsCtx?: boolean;
  llmsCtxFull?: boolean;
  llmsSections?: Record<string, string | string[]>;
  llmsClassify?: (page: LlmsPageInfo) => string | null | undefined;
  generateFeed?: boolean;
  generateHumans?: boolean;
  blockGoogleExtended?: boolean;
  robotsDirectives?: string[];
  skuMd?: SkuMdOptions;
  debug?: boolean;
}

export function createGeoGeneratorPlugin(options?: GeoGeneratorOptions): Plugin;
export const geo: typeof createGeoGeneratorPlugin;
export default geo;
