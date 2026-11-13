import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const VITE_RELEASES = Object.freeze(['7.0.0', '8.0.0', '8.2.1']);
export const ASTRO_RELEASES = Object.freeze(['7.0.0', '7.2.8']);
export const VITE_PLUS_RELEASES = Object.freeze(['1.6.0']);

export function assertGeneratedCoreFiles(distDir, expectedDomain) {
  for (const fileName of ['sitemap.xml', 'robots.txt', 'llms.txt']) {
    const filePath = join(distDir, fileName);
    if (!existsSync(filePath)) {
      throw new Error(`${fileName} was not generated`);
    }
    const content = readFileSync(filePath, 'utf-8');
    if (!content.includes(expectedDomain)) {
      throw new Error(`${fileName} does not reference ${expectedDomain}`);
    }
  }
}
