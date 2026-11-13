import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import {
  ASTRO_RELEASES,
  VITE_RELEASES,
  assertGeneratedCoreFiles,
} from '../scripts/consumer-matrix-contract.mjs';

const fixtureRoot = join(process.cwd(), 'tempfiles', '__consumer-matrix-contract__');
const ignoredSourceDirectories = new Set([
  '.git',
  '.trae',
  'coverage',
  'dist',
  'docs',
  'node_modules',
  'site',
  'tempfiles',
]);

function findUnresolvedMergeMarkers(root) {
  const matches = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredSourceDirectories.has(entry.name)) {
      continue;
    }
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      matches.push(...findUnresolvedMergeMarkers(entryPath));
      continue;
    }
    if (!entry.isFile()) continue;

    const content = readFileSync(entryPath, 'utf-8');
    if (/^(<<<<<<< |>>>>>>> )/m.test(content)) {
      matches.push(entryPath);
    }
  }

  return matches;
}

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('published consumer matrix', () => {
  it('pins the supported floors and the reviewed current releases', () => {
    expect(VITE_RELEASES).toEqual(['7.0.0', '8.0.0', '8.2.1']);
    expect(ASTRO_RELEASES).toEqual(['7.0.0', '7.2.8']);
  });

  it('runs the reviewed consumer matrix in CI', () => {
    const workflow = readFileSync(
      join(process.cwd(), '.github', 'workflows', 'ci.yml'),
      'utf-8',
    );
    expect(workflow).toContain('- run: bun run verify:consumers');
    expect(workflow).toContain('- run: bun run verify:registry-metadata');
    expect(workflow).toContain('- run: bun audit');
    const verifier = readFileSync(
      join(process.cwd(), 'scripts', 'verify-consumer-matrix.mjs'),
      'utf-8',
    );
    expect(verifier).toContain('installedGeo !== expectedPluginVersion');
    expect(verifier).toContain("await readFile(join(repositoryRoot, 'package.json'), 'utf-8')");
    expect(verifier).not.toMatch(/installedGeo !== ['"]\d+\.\d+\.\d+['"]/);
  });

  it('removes the superseded packed-consumer gate', () => {
    const workflow = readFileSync(
      join(process.cwd(), '.github', 'workflows', 'ci.yml'),
      'utf-8',
    );

    expect(workflow).not.toContain('verify:packed-consumers');
    expect(
      existsSync(join(process.cwd(), 'scripts', 'verify-packed-consumers.mjs')),
    ).toBe(false);
  });

  it('keeps tracked source free of unresolved merge markers', () => {
    expect(findUnresolvedMergeMarkers(process.cwd())).toEqual([]);
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
