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

export interface GeoGeneratorOptions {
  domain?: string;
  distDir?: string;
  routeBasePath?: string;
  stripPathPrefixes?: string[];
  sourceHtmlDir?: string;
  stabilityWaitMs?: number;
  stabilityPollIntervalMs?: number;
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
  debug?: boolean;
}

export function createGeoGeneratorPlugin(options?: GeoGeneratorOptions): Plugin;
export const geo: typeof createGeoGeneratorPlugin;
export default geo;
