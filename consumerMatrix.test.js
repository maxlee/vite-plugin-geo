import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  ASTRO_RELEASES,
  VITE_RELEASES,
  assertGeneratedCoreFiles,
} from './scripts/consumer-matrix-contract.mjs';

const fixtureRoot = join(process.cwd(), 'tempfiles', '__consumer-matrix-contract__');

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('published consumer matrix', () => {
  it('pins the supported floors and the reviewed current releases', () => {
    expect(VITE_RELEASES).toEqual(['7.0.0', '8.0.0', '8.2.1']);
    expect(ASTRO_RELEASES).toEqual(['7.0.0', '7.2.0']);
  });

  it('runs the reviewed consumer matrix in CI', () => {
    const workflow = readFileSync(
      join(process.cwd(), '.github', 'workflows', 'ci.yml'),
      'utf-8',
    );
    expect(workflow).toContain('- run: bun run verify:consumers');
    expect(workflow).toContain('- run: bun run verify:registry-metadata');
  });

  it('requires every core output to reference the expected domain', () => {
    mkdirSync(fixtureRoot, { recursive: true });
    for (const fileName of ['sitemap.xml', 'robots.txt', 'llms.txt']) {
      writeFileSync(
        join(fixtureRoot, fileName),
        `${fileName}: https://example.test/`,
        'utf-8',
      );
    }

    expect(() => assertGeneratedCoreFiles(fixtureRoot, 'https://example.test/'))
      .not.toThrow();

    writeFileSync(join(fixtureRoot, 'llms.txt'), 'wrong domain', 'utf-8');
    expect(() => assertGeneratedCoreFiles(fixtureRoot, 'https://example.test/'))
      .toThrow(/llms\.txt/);
  });
});
