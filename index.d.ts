import type { Plugin } from 'vite';

export type LastmodStrategy = 'none' | 'file-mtime' | 'build' | 'git';
export type LlmsMdMirrorStyle = 'append' | 'replace';

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
  excludePatterns?: string[];
  hreflang?: Record<string, string>;
  sitemapIndex?: boolean;
  sitemapMaxBytes?: number;
  generateSitemap?: boolean;
  sitemapUrl?: string;
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
  debug?: boolean;
}

export function createGeoGeneratorPlugin(options?: GeoGeneratorOptions): Plugin;
export const geo: typeof createGeoGeneratorPlugin;
export default geo;
