import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { applyGeoGenerationPlanToDisk, buildGeoGenerationPlanFromDisk } from '../src/geoBuildPipeline.js';
import { verifyGeoOutput } from '../src/geoVerify.js';

const roots = [];
const siteUrl = 'https://example.test';

function page(title) {
  return `<html lang="en"><head><title>${title}</title><meta name="description" content="${title} desc"></head><body><h1>${title}</h1></body></html>`;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'geo-verify-'));
  roots.push(root);
  const distDir = join(root, 'dist');
  mkdirSync(join(distDir, 'src/pages'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'verify-fixture', domain: siteUrl }));
  writeFileSync(join(distDir, 'src/pages/index.html'), page('Home'));
  writeFileSync(join(distDir, 'src/pages/about.html'), page('About'));
  return { root, distDir };
}

async function generate(f, options = {}) {
  const plan = await buildGeoGenerationPlanFromDisk({
    projectRoot: f.root,
    distDir: f.distDir,
    currentDate: '2026-10-01T00:00:00.000Z',
    options,
  });
  applyGeoGenerationPlanToDisk(plan, { distDir: f.distDir });
  return plan;
}

function verify(f, options = {}) {
  return verifyGeoOutput({ projectRoot: f.root, distDir: f.distDir, options });
}

function snapshot(dir) {
  const files = new Map();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else files.set(relative(dir, entryPath), readFileSync(entryPath));
    }
  };
  visit(dir);
  return files;
}

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('geo verify', () => {
  it('accepts a healthy generated build and never writes to dist', async () => {
    const f = fixture();
    await generate(f);
    const before = snapshot(f.distDir);

    const result = verify(f);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.summary).toMatchObject({
      siteUrl,
      sitemapFile: 'sitemap.xml',
      sitemapLocCount: 2,
      pageCount: 2,
      errorCount: 0,
      warningCount: 0,
    });
    expect(snapshot(f.distDir)).toEqual(before);
  });

  it('catches a third-party sitemap that replaced the generated one', async () => {
    const f = fixture();
    await generate(f);
    const ghostLocs = Array.from(
      { length: 95 },
      (_, index) => `<url><loc>https://example.test/src/pages/ghost-${index}.html</loc></url>`,
    ).join('');
    writeFileSync(join(f.distDir, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?><urlset>${ghostLocs}<url><loc>https://example.test/src/pages/index.html</loc></url><url><loc>https://example.test/src/pages/index.html</loc></url></urlset>`);

    const result = verify(f);
    const rules = result.errors.map((item) => item.rule);

    expect(result.ok).toBe(false);
    expect(result.summary.sitemapLocCount).toBe(97);
    expect(rules).toEqual(expect.arrayContaining([
      'sitemap-intermediate-prefix',
      'sitemap-html-extension',
      'sitemap-unmapped-loc',
      'sitemap-duplicate-loc',
      'sitemap-homepage-missing',
      'sitemap-missing-page',
    ]));
  });

  it('reports a loc count below the number of pages', async () => {
    const f = fixture();
    await generate(f);
    writeFileSync(
      join(f.distDir, 'sitemap.xml'),
      `<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>${siteUrl}</loc></url></urlset>`,
    );

    const result = verify(f);

    expect(result.errors.map((item) => item.rule)).toContain('sitemap-url-count');
    expect(result.errors.map((item) => item.rule)).toContain('sitemap-missing-page');
  });

  it('follows sitemap indexes and counts child locs', async () => {
    const f = fixture();
    await generate(f);
    const generated = readFileSync(join(f.distDir, 'sitemap.xml'), 'utf-8');
    writeFileSync(join(f.distDir, 'sitemap-a.xml'), generated);
    unlinkSync(join(f.distDir, 'sitemap.xml'));
    writeFileSync(
      join(f.distDir, 'sitemap_index.xml'),
      `<?xml version="1.0" encoding="UTF-8"?><sitemapindex><sitemap><loc>${siteUrl}/sitemap-a.xml</loc></sitemap></sitemapindex>`,
    );

    const result = verify(f);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary.sitemapFile).toBe('sitemap_index.xml');
    expect(result.summary.sitemapLocCount).toBe(2);
    expect(result.checks.sitemapFiles).toEqual(expect.arrayContaining(['sitemap_index.xml', 'sitemap-a.xml']));
    // robots.txt still points at sitemap.xml
    expect(result.warnings.map((item) => item.rule)).toContain('robots-sitemap-mismatch');
  });

  it('warns about robots mismatches, missing mirrors, and broken llms links', async () => {
    const f = fixture();
    await generate(f);
    unlinkSync(join(f.distDir, 'about.md'));
    writeFileSync(join(f.distDir, 'robots.txt'), 'User-agent: *\nAllow: /\nSitemap: https://example.test/other.xml\n');

    const result = verify(f);
    const rules = result.warnings.map((item) => item.rule);

    expect(result.ok).toBe(true);
    expect(rules).toEqual(expect.arrayContaining([
      'robots-sitemap-mismatch',
      'markdown-mirror-missing',
      'llms-link-invalid',
    ]));
  });

  it('prefers sitemap-index.xml over @astrojs/sitemap child shard sitemap-0.xml', async () => {
    const f = fixture();
    await generate(f, { stripPathPrefixes: [] });
    // Recreate dist with clean pretty routes + @astrojs/sitemap layout
    const dist2 = join(f.root, 'dist-astro');
    mkdirSync(join(dist2, 'about'), { recursive: true });
    writeFileSync(join(dist2, 'index.html'), page('Home'));
    writeFileSync(join(dist2, 'about/index.html'), page('About'));
    await generate({ root: f.root, distDir: dist2 });
    unlinkSync(join(dist2, 'sitemap.xml'));
    writeFileSync(
      join(dist2, 'sitemap-0.xml'),
      `<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>${siteUrl}/</loc></url></urlset>`,
    );
    writeFileSync(
      join(dist2, 'sitemap-1.xml'),
      `<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>${siteUrl}/about</loc></url></urlset>`,
    );
    writeFileSync(
      join(dist2, 'sitemap-index.xml'),
      `<?xml version="1.0" encoding="UTF-8"?><sitemapindex><sitemap><loc>${siteUrl}/sitemap-0.xml</loc></sitemap><sitemap><loc>${siteUrl}/sitemap-1.xml</loc></sitemap></sitemapindex>`,
    );
    writeFileSync(join(dist2, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${siteUrl}/sitemap-index.xml\n`);

    const result = verify({ root: f.root, distDir: dist2 });
    expect(result.ok).toBe(true);
    expect(result.summary.sitemapFile).toBe('sitemap-index.xml');
    expect(result.summary.sitemapLocCount).toBe(2);
    expect(result.checks.sitemapFiles).toEqual(['sitemap-index.xml', 'sitemap-0.xml', 'sitemap-1.xml']);
  });

  it('generates and verifies with package.json homepage when domain is absent', async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'package.json'), JSON.stringify({ name: 'homepage-only', homepage: `${siteUrl}/` }));
    await generate(f);
    expect(readFileSync(join(f.distDir, 'sitemap.xml'), 'utf-8')).toContain(`${siteUrl}/`);

    const result = verify(f);
    expect(result.ok).toBe(true);
    expect(result.summary.siteUrl).toBe(siteUrl);

    writeFileSync(join(f.root, 'package.json'), JSON.stringify({ name: 'relative-homepage', homepage: '.' }));
    expect(verify(f).summary.siteUrl).toBe(siteUrl);
  });

  it('infers siteUrl from dist output or rejects malformed package.json and invalid options', async () => {
    const f = fixture();
    await generate(f);

    // Infer from sitemap.xml when package.json lacks domain
    writeFileSync(join(f.root, 'package.json'), JSON.stringify({ name: 'no-domain' }));
    const inferred = verify(f);
    expect(inferred.ok).toBe(true);
    expect(inferred.summary.siteUrl).toBe(siteUrl);

    // Infer from index.html canonical when sitemap is also absent
    unlinkSync(join(f.distDir, 'sitemap.xml'));
    writeFileSync(
      join(f.distDir, 'index.html'),
      `<html lang="en"><head><title>Home</title><link rel="canonical" href="${siteUrl}/"></head><body><h1>Home</h1></body></html>`,
    );
    const missingSitemap = verify({ root: f.root, distDir: f.distDir }, { generateSitemap: false });
    expect(missingSitemap.summary.siteUrl).toBe(siteUrl);

    // Surface malformed package.json rather than silently falling back
    writeFileSync(join(f.root, 'package.json'), '{ invalid json');
    expect(() => verify(f)).toThrow(/package\.json/);

    // Enforce validateGeoOptions inside verifyGeoOutput
    writeFileSync(join(f.root, 'package.json'), JSON.stringify({ name: 'valid', domain: siteUrl }));
    expect(() => verify(f, { routeConflict: 'invalid-mode' })).toThrow(/Invalid GEO configuration/);
  });

  it('handles sitemapUrl with routeBasePath, base href, llms pretty URLs, and RSS non-permalink guids', async () => {
    const f = fixture();
    await generate(f, {
      routeBasePath: '/docs',
      sitemapUrl: '/docs/custom-sitemap.xml',
      llmsMdMirror: false,
    });
    const generated = readFileSync(join(f.distDir, 'sitemap.xml'), 'utf-8');
    unlinkSync(join(f.distDir, 'sitemap.xml'));
    writeFileSync(join(f.distDir, 'custom-sitemap.xml'), generated);
    writeFileSync(
      join(f.distDir, 'robots.txt'),
      `User-agent: *\nAllow: /\nSitemap: ${siteUrl}/docs/custom-sitemap.xml\n`,
    );

    // Non-permalink guid in feed.xml should not cause feed-link-invalid
    writeFileSync(
      join(f.distDir, 'feed.xml'),
      `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><item><link>${siteUrl}/docs/about</link><guid isPermaLink="false">post-about-1</guid></item></channel></rss>`,
    );

    const healthy = verify(f, {
      routeBasePath: '/docs',
      sitemapUrl: '/docs/custom-sitemap.xml',
      llmsMdMirror: false,
    });
    expect(healthy.ok).toBe(true);
    expect(healthy.summary.sitemapFile).toBe('custom-sitemap.xml');
    expect(healthy.warnings.map((w) => w.rule)).not.toContain('feed-link-invalid');

    // Extensionless pretty-URL in llms.txt absent from sitemap must warn llms-link-invalid
    writeFileSync(
      join(f.distDir, 'custom-sitemap.xml'),
      `<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>${siteUrl}/docs</loc></url></urlset>`,
    );
    const mismatch = verify(f, {
      routeBasePath: '/docs',
      sitemapUrl: '/docs/custom-sitemap.xml',
      llmsMdMirror: false,
    });
    expect(mismatch.warnings.map((w) => w.rule)).toContain('llms-link-invalid');
  });

  it('strips XML comments, preserves literal CDATA &amp;, handles out-of-range entities, and bounds index depth', async () => {
    const f = fixture();
    await generate(f, { llmsMdMirror: false, generateFeed: false });

    writeFileSync(
      join(f.distDir, 'index.html'),
      `<html lang="en"><head><title>Home</title><base href="/sub/"><link rel="canonical" href="${siteUrl}/"><link rel="describedby" type="text/markdown" href="/llms.txt"></head><body><h1>Home</h1></body></html>`,
    );
    writeFileSync(
      join(f.distDir, 'sitemap.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>
      <!-- <url><loc>https://example.test/commented-out</loc></url> -->
      <urlset>
        <url><loc><![CDATA[${siteUrl}/missing?q=1&amp;2=3]]></loc></url>
        <url><loc>${siteUrl}/?a=1&amp;b=2</loc></url>
        <url><loc>${siteUrl}/about</loc></url>
      </urlset>`,
    );
    writeFileSync(
      join(f.distDir, 'about.html'),
      `<html lang="en"><head><title>About &#99999999;</title><link rel="canonical" href="${siteUrl}/about"><link rel="describedby" type="text/markdown" href="/llms.txt"></head><body><h1>About</h1></body></html>`,
    );

    const parsedResult = verify(f, { llmsMdMirror: false, generateFeed: false });
    expect(parsedResult.errors.map((e) => e.rule)).toContain('sitemap-homepage-missing');
    expect(parsedResult.errors.map((e) => e.rule)).toContain('sitemap-unmapped-loc');
    const unmappedEvidence = parsedResult.errors.find((e) => e.rule === 'sitemap-unmapped-loc')?.evidence || '';
    expect(unmappedEvidence).toContain('?q=1&amp;2=3');
    const allEvidence = parsedResult.errors.map((e) => e.evidence).join('\n');
    expect(allEvidence).not.toContain('commented-out');
    expect(parsedResult.checks.sitemapFiles).toEqual(['sitemap.xml']);
    expect(parsedResult.summary.sitemapLocCount).toBe(3);
    // Verify depth limit > 5
    for (let d = 1; d <= 7; d += 1) {
      const child = d === 7 ? 'sitemap-leaf.xml' : `sitemap-d${d + 1}.xml`;
      const xml = d === 7
        ? `<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>${siteUrl}</loc></url><url><loc>${siteUrl}/about</loc></url></urlset>`
        : `<?xml version="1.0" encoding="UTF-8"?><sitemapindex><sitemap><loc>${siteUrl}/${child}</loc></sitemap></sitemapindex>`;
      writeFileSync(join(f.distDir, d === 1 ? 'sitemap.xml' : `sitemap-d${d}.xml`), xml);
    }
    const depthResult = verify(f, { llmsMdMirror: false, generateFeed: false });
    expect(depthResult.warnings.map((w) => w.rule)).toContain('sitemap-index-depth');
  });
});
