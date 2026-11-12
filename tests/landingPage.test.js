import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const projectDir = process.cwd();
const siteDir = join(projectDir, 'site');
const hasLandingPage = existsSync(join(siteDir, 'index.html'));
const describeLandingPage = hasLandingPage ? describe : describe.skip;
const readSiteFile = (path) => readFileSync(join(siteDir, path), 'utf-8');
const tailwindCdn = 'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.3';
const jqueryCdn = 'https://code.jquery.com/jquery-4.0.0.min.js';
const jqueryIntegrity = 'sha256-OaVG6prZf4v69dPg6PhVattBXkcOWQB62pdZ3ORyrao=';

describeLandingPage('landing page source contract', () => {
  it('provides a single-file Tailwind CSS 4 and jQuery 4 CDN site without Vite tooling', () => {
    const manifest = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8'));
    const html = readSiteFile('index.html');
    const siteFiles = readdirSync(siteDir).sort();

    expect(Object.keys(manifest.scripts).filter((name) => name.startsWith('site:'))).toEqual([]);
    expect(manifest.devDependencies?.['@tailwindcss/vite']).toBeUndefined();
    expect(manifest.devDependencies?.tailwindcss).toBeUndefined();
    expect(manifest.devDependencies?.jquery).toBeUndefined();
    expect(manifest.devDependencies?.vite).toBeUndefined();
    expect(manifest.peerDependencies.vite).toBe('^7.0.0 || ^8.0.0');

    expect(siteFiles).toEqual(['index.html']);
    expect(existsSync(join(siteDir, 'index.html'))).toBe(true);
    expect(existsSync(join(siteDir, 'vite.config.js'))).toBe(false);
    expect(existsSync(join(siteDir, 'src'))).toBe(false);
    expect(existsSync(join(projectDir, 'site-dist'))).toBe(false);

    expect(html).toContain(`<script src="${tailwindCdn}"></script>`);
    expect(html).toContain('<style type="text/tailwindcss">');
    expect(html).toContain(`src="${jqueryCdn}"`);
    expect(html).toContain(`integrity="${jqueryIntegrity}"`);
    expect(html).toContain('crossorigin="anonymous"');
    expect(html).not.toContain('/src/main.js');
    expect(html).not.toContain('@import "tailwindcss"');
    expect(html).not.toContain('@source');
  });

  it('uses semantic sections, real destinations, and accessible controls', () => {
    const html = readSiteFile('index.html');

    expect(html).toContain('<header');
    expect(html).toContain('<main');
    expect(html).toContain('<footer');
    expect(html).toContain('id="features"');
    expect(html).toContain('id="workflows"');
    expect(html).toContain('id="outputs"');
    expect(html).toContain('id="install"');
    expect(html).toContain('Ship every site');
    expect(html).toContain('Make every build discoverable.');
    expect(html).toContain('https://github.com/maxlee/vite-plugin-geo');
    expect(html).toContain('https://www.npmjs.com/package/vite-plugin-geo');
    expect(html).not.toMatch(/href=["']#["']/);
    expect(html).not.toMatch(/lorem ipsum/i);

    expect(html).toContain('aria-controls="mobile-menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('<title>vite-plugin-geo');
    expect(html).toContain('name="description"');
  });

  it('removes the compatibility metrics and sizes SVG cards from their rendered copy', () => {
    const html = readSiteFile('index.html');

    expect(html).not.toContain('Compatibility and scale');
    expect(html).not.toContain('data-count');
    expect(html).not.toContain('renderCounter');

    expect(html.match(/<g[^>]+data-orbit-card/g)).toHaveLength(4);
    expect(html.match(/<rect[^>]+data-card-background/g)).toHaveLength(4);
    expect(html.match(/<g[^>]+data-card-content/g)).toHaveLength(4);
    expect(html.match(/data-card-background[^>]+filter="url\(#card-shadow\)"/g)).toHaveLength(4);
    expect(html).not.toMatch(/<g[^>]+filter="url\(#card-shadow\)"/);

    expect(html).toContain('function sizeOrbitCards');
    expect(html).toContain('getBBox()');
    expect(html).toContain('document.fonts.ready');
    expect(html).toContain('data-card-min-width');
  });

  it('defines the approved visual system and reduced-motion behavior', () => {
    const html = readSiteFile('index.html');

    expect(html).toContain('@theme');
    expect(html).toContain('--color-canvas:');
    expect(html).toContain('--color-ink:');
    expect(html).toContain('--color-mint:');
    expect(html).toContain('--color-coral:');
    expect(html).toContain('--color-sun:');
    expect(html).toContain('--font-sans:');
    expect(html).toContain('prefers-reduced-motion: reduce');
    expect(html).not.toContain('transition: all');
    expect(html).not.toContain('background-clip: text');

    expect(html).toContain('class="orbit-track orbit-track-mint"');
    expect(html).toContain('class="generator-line');
    expect(html).toContain('class="sitemap-progress');
    expect(html).toContain('class="llms-status-dot');
    expect(html).toContain('@keyframes orbit-track-breathe');
    expect(html).toContain('@keyframes generator-line-cycle');
    expect(html).toContain('@keyframes status-signal');
    expect(html).toContain('@keyframes progress-signal');
    expect(html).toContain('animation: none !important');
    expect(html).toContain('.orbit-card,\n  .orbit-track,\n  .orbit-particle');
  });

  it('uses jQuery for the planned interactions without a UI framework', () => {
    const html = readSiteFile('index.html');

    expect(html).toContain('$(function initializeLandingPage()');
    expect(html).toContain('if (window.jQuery)');
    expect(html).toContain("document.documentElement.classList.remove('js')");
    expect(html).not.toContain("import $ from 'jquery'");
    expect(html).toContain('data-mobile-toggle');
    expect(html).toContain('data-workflow-tab');
    expect(html).toContain('data-copy');
    expect(html).toContain('IntersectionObserver');
    expect(html).toContain('prefers-reduced-motion');
    expect(html).toContain('pointermove');
    expect(html).not.toMatch(/\b(React|Vue|Svelte)\b/);
  });

  it('keeps the directly deployable static page outside the npm package', () => {
    const manifest = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8'));
    const html = readSiteFile('index.html');

    expect(manifest.files).not.toContain('site');
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('Ship every site');
    expect(html).not.toMatch(/(?:src|href)=["']\/?src\//);
    expect(html).not.toMatch(/href=["']#["']/);
  });
});
