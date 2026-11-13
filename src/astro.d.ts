import type { AstroIntegration } from 'astro';
import type { GeoGeneratorOptions } from './index.js';

export type AstroGeoOptions = Omit<
  GeoGeneratorOptions,
  'distDir'
>;

export function createAstroGeoIntegration(options?: AstroGeoOptions): AstroIntegration;

export default createAstroGeoIntegration;
