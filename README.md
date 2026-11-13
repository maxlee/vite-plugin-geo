# vite-plugin-geo

[![npm version](https://img.shields.io/npm/v/vite-plugin-geo.svg)](https://www.npmjs.com/package/vite-plugin-geo)
[![CI](https://github.com/maxlee/vite-plugin-geo/actions/workflows/ci.yml/badge.svg)](https://github.com/maxlee/vite-plugin-geo/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/node/v/vite-plugin-geo.svg)](./package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

English | [简体中文](./README.zh-CN.md)

Post-build discovery file generator and static verifier for Vite and Astro sites. Generates `sitemap.xml`, `robots.txt`, RSS 2.0 `feed.xml`, `llms.txt` v2, clean per-page Markdown mirrors, and optional `humans.txt` and `sku.md` manifests from a single validated build plan.

> **Scope note:** Generated files are machine-readable discovery and crawl hints. They do not guarantee crawling, indexing, ranking, AI citation, or traffic outcomes from any search engine or AI system.

## Table of contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
  - [Vite](#vite)
  - [Astro](#astro)
- [Generated files](#generated-files)
- [Configuration](#configuration)
- [Astro sitemap compatibility](#astro-sitemap-compatibility)
- [CLI and CI verification](#cli-and-ci-verification)
- [Build diagnostics](#build-diagnostics)
- [Common recipes](#common-recipes)
- [Specification contract](#specification-contract)
- [Contributing](#contributing)
- [Changelog](#changelog)
- [License](#license)

## Features

- **Sitemap 0.9 generation and splitting.** Builds URL sets from emitted HTML, splits files automatically above 50,000 URLs or `sitemapMaxBytes` (up to 50 MiB), and coexists with `@astrojs/sitemap`.
- **RFC 9309 `robots.txt` handling.** Preserves hand-written `robots.txt` byte-for-byte by default, validates custom directives against control characters and the 500 KiB limit, and writes only to the site root.
- **RSS 2.0 feed discovery.** Emits `feed.xml` with an Atom `self` link and canonical URL `<guid>` values, and injects `<link rel="alternate" type="application/rss+xml">` into HTML pages idempotently.
- **`llms.txt` v2 and Markdown mirrors.** Injects `rel="describedby"` and `rel="alternate" type="text/markdown"` links, preserves existing user alternates, and extracts clean `<main>` or single-`<article>` prose into `.md` mirrors without site navigation noise.
- **Multilingual `hreflang` support.** Populates Sitemap `xhtml:link` alternates from global route templates or per-page HTML `<link rel="alternate" hreflang="...">` tags (`hreflangFromHtml`).
- **Optional `humans.txt` and `sku.md` (`1.0.0-beta`).** Emits verified team metadata and root-level pure Markdown merchant catalogs without fabricating missing fields.
- **Static build diagnostics and read-only `verify`.** Prints deterministic page and link diagnostics during builds (`audit`), and verifies final `dist/` outputs after all plugins finish (`vite-plugin-geo verify`) with JSON (`schemaVersion: "1.0"`) and SARIF 2.1.0 reports.
- **Shared pipeline across Vite, Astro, and CLI.** Runs identical option validation, conflict resolution, planning, and ownership checks across all three entry points.

## Requirements

- **Node.js:** `^20.19.0 || >=22.12.0`
- **Vite:** `^7.0.0 || ^8.0.0`
- **Astro:** `^7.0.0` (optional peer dependency; pure Vite projects do not need Astro installed)

## Installation

```bash
npm install -D vite-plugin-geo
```

```bash
pnpm add -D vite-plugin-geo
```

```bash
yarn add -D vite-plugin-geo
```

```bash
bun add -d vite-plugin-geo
```

## Quick start

### Vite

Add the default plugin export to `vite.config.js`:

```js
// vite.config.js
import { defineConfig } from 'vite';
import geo from 'vite-plugin-geo';

export default defineConfig({
  plugins: [
    geo({
      domain: 'https://example.com',
    }),
  ],
});
```

`domain` must be an HTTP(S) origin containing only scheme, host, and optional port (for example, `https://example.com`). Do not include credentials, paths, query strings, or fragments. Express subpath deployments with `routeBasePath`.

You can also store `domain` in your project `package.json`. When both exist, `geo({ domain })` wins. When neither exists, the build stops instead of emitting broken public URLs.

Named exports are also available:

```js
import geo, { createGeoGeneratorPlugin, verifyGeoOutput } from 'vite-plugin-geo';
```

### Astro

Astro emits final HTML after its internal Vite build completes. Do not register `vite-plugin-geo` inside `vite.plugins` in Astro projects. Choose one of the two supported workflows below (do not combine both).

#### Option 1: Native Astro integration (recommended)

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import geo from 'vite-plugin-geo/astro';

export default defineConfig({
  site: 'https://example.com',
  integrations: [geo()],
});
```

Domain resolution order in Astro is `geo({ domain })`, then Astro `site`, then `package.json.domain`.

#### Option 2: Post-build CLI

```json
{
  "domain": "https://example.com",
  "scripts": {
    "build": "astro build && vite-plugin-geo generate"
  }
}
```

The CLI scans `dist/` by default and does not parse `astro.config.*`. If your origin is set only in Astro `site`, pass `--domain https://example.com` (and `--dist-dir <path>` for custom output directories).

Default build output:

```text
dist/
├── sitemap.xml
├── robots.txt
├── feed.xml
├── llms.txt
├── index.md
└── ...other-pages.md
```

## Generated files

| File | Default | Behavior |
|---|---|---|
| `sitemap.xml` | Enabled (auto) | Lists public page URLs; splits and writes `sitemap_index.xml` above 50,000 URLs or `sitemapMaxBytes`. Skips automatically when an external Sitemap is detected. |
| `sitemap_index.xml` | Conditional | Emitted automatically when Sitemap sharding triggers and `sitemapIndex: true`. |
| `robots.txt` | Auto | Preserves any hand-written `robots.txt`; otherwise generates at the root scope (`/`) and skips non-root `routeBasePath` scopes. Always targets `/robots.txt`. |
| `feed.xml` | Enabled | Emits RSS 2.0 with Atom `self` link and injects HTML discovery `<link>` tags. |
| `llms.txt` | Enabled | Emits the single-scope `llms.txt` v2 index for the configured `routeBasePath`. |
| `*.md` | Enabled | Per-page Markdown mirrors derived from public `pagePath`, containing `# <title>`, `> <description>`, and extracted `<main>` or `<article>` content. |
| `humans.txt` | Disabled | Emits verified author, license, and runtime details derived from explicit config and `package.json`. |
| `sku.md` | Disabled | Emits a root-level SKU.md `1.0.0-beta` catalog manifest when `skuMd` is configured. |

**Ownership and conflict handling:** Files written by this plugin carry a format-specific `Generated by vite-plugin-geo` marker and are regenerated on subsequent builds. Removing the marker marks a file as user-owned. When a user-owned `llms.txt`, `feed.xml`, `humans.txt`, `sku.md`, or `*.md` mirror already exists, `fileConflict` defaults to `'preserve'` (warns and keeps the user file while generating remaining outputs). Set `fileConflict: 'error'` to fail before writing, or `'overwrite'` to replace user files. `sitemap.xml` and `robots.txt` use `sitemapConflict` and `generateRobots`.

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `domain` | `string` | `package.json.domain` | Public HTTP(S) origin without credentials, path, query, or hash. |
| `distDir` | `string` | Vite `build.outDir` | Build output directory (not applicable to `vite-plugin-geo/astro`). |
| `routeBasePath` | `string` | Vite or Astro `base` | Single public path scope (for example, `'/docs/'`). Rejects full URLs. |
| `prettyUrls` | `boolean` | `true` | Strip `.html` extensions from public page URLs. |
| `lastmodStrategy` | `'none' \| 'file-mtime' \| 'build' \| 'git'` | `'none'` | Timestamp source for Sitemap `<lastmod>` and RSS `<pubDate>`. |
| `excludePatterns` | `string[]` | `['404.html', '500.html']` | Glob patterns excluded from discovery outputs and link injection. |
| `hreflang` | `Record<string, string>` | `undefined` | Global language alternate URL templates using `{path}`. |
| `hreflangFromHtml` | `boolean` | `false` | Read per-page `<link rel="alternate" hreflang>` tags for Sitemap `xhtml:link`; falls back to `hreflang` on pages without HTML declarations. |
| `generateSitemap` | `boolean` | Auto | Disabled automatically when an external Sitemap is present. |
| `sitemapConflict` | `'preserve' \| 'error' \| 'overwrite'` | Auto | Policy when an external Sitemap is found; preserves with a warning by default. |
| `sitemapUrl` | `string` | Auto | Explicit Sitemap URL or path referenced in `robots.txt` and `llms.txt`. |
| `fileConflict` | `'preserve' \| 'error' \| 'overwrite'` | `'preserve'` | Conflict policy for user-owned `llms.txt`, `feed.xml`, `humans.txt`, `sku.md`, and `*.md` mirrors. |
| `routeConflict` | `'error' \| 'first' \| 'last'` | `'error'` | Fail or deterministically pick one file when multiple HTML files map to the same public route. |
| `llmsMdMirror` | `boolean` | `true` | Generate Markdown mirrors for pages lacking a valid Markdown alternate. |
| `llmsMdMirrorStyle` | `'append' \| 'replace'` | `'append'` | Mirror filename derivation. Under `prettyUrls: false`, `append` produces `about.html.md` and `replace` produces `about.md`. |
| `llmsClassify` | `(page: LlmsPageInfo) => string \| null \| undefined` | Auto | Custom section classifier for `llms.txt`. |
| `llmsSections` | `Record<string, string \| string[]>` | Auto | Path-prefix to section mapping for `llms.txt`. |
| `generateRobots` | `boolean` | Auto | Preserves hand-written `robots.txt`; otherwise generates on `/` scope only. Explicit `true` throws if a hand-written file exists. |
| `robotsDirectives` | `string[]` | `[]` | Custom `robots.txt` directives validated against RFC 9309 constraints. |
| `generateFeed` | `boolean` | `true` | Enable RSS 2.0 `feed.xml` generation and HTML discovery link injection. |
| `generateHumans` | `boolean` | `false` | Enable `humans.txt` generation. |
| `skuMd` | `SkuMdOptions` | `undefined` | Root `/sku.md` (`1.0.0-beta`) merchant manifest configuration. |
| `audit` | `boolean` | `true` | Run static HTML and discovery diagnostics during the build. |
| `auditFailOn` | `'warning' \| 'advice'` | Disabled | Fail the build before writing files when diagnostics reach this severity. |
| `debug` | `boolean` | `false` | Print resolved URLs, excluded pages, Sitemap decisions, and mirror summaries. |

<details>
<summary>Advanced options</summary>

| Option | Type | Default | Description |
|---|---|---|---|
| `stripPathPrefixes` | `string[]` | `['src/pages/']` | Source path prefixes stripped when computing public URLs. |
| `sourceHtmlDir` | `string` | `'src/pages'` | Source HTML directory used by `file-mtime` and `git` timestamp lookups. |
| `packageJsonPath` | `string \| false` | `'./package.json'` | Path to `package.json`, or `false` to disable reading package metadata. |
| `sitemapIndex` | `boolean` | `true` | Allow automatic Sitemap sharding and `sitemap_index.xml` generation. |
| `sitemapMaxBytes` | `number` | `52428800` | Maximum uncompressed bytes per Sitemap shard (up to 50 MiB). |
| `lastmodIgnore` | `string[]` | `[]` | Glob patterns skipped during `lastmod` resolution. |
| `lastmodResolver` | `(page: GeoPageModel) => Date \| string \| null \| undefined` | `undefined` | Plugin API only. Return a `Date` or valid W3C Datetime string; `null` omits `lastmod`, `undefined` falls back to `lastmodStrategy`, and invalid values throw during planning. |
| `skuMd.merchantName` | `string` | Home page `<title>` | Merchant heading; fails the build if neither configured nor derivable. |
| `skuMd.summary` | `string` | Home page description | Merchant summary; fails the build if neither configured nor derivable. |
| `skuMd.catalog` | `Array<{ label: string; url: string }>` | Required | One or more same-origin HTTPS catalog entry links. |

</details>

Removed legacy keys (`llmsFull`, `llmsCtx`, `llmsCtxFull`, `blockGoogleExtended`, `stability*`, and legacy `skuMd` fields `catalogUrl`, `contentLanguage`, `market`) throw explicit configuration errors rather than being silently ignored.

## Astro sitemap compatibility

If your Astro project already uses `@astrojs/sitemap`, place `sitemap()` before `geo()`:

```js
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import geo from 'vite-plugin-geo/astro';

export default defineConfig({
  site: 'https://example.com',
  integrations: [sitemap(), geo()],
});
```

During `astro:build:done`, `vite-plugin-geo` inspects emitted Sitemap artifacts on disk:

- Preserves the external Sitemap by default and logs its filename, source, `<loc>` count, and up to 3 sample URLs.
- Continues generating `llms.txt`, `robots.txt`, `feed.xml`, and Markdown mirrors.
- Points `robots.txt` and `llms.txt` to the detected Sitemap index or file (including custom `filenameBase` names).

To replace an external Sitemap intentionally, declare both `generateSitemap: true` and `sitemapConflict: 'overwrite'`:

```js
geo({
  generateSitemap: true,
  sitemapConflict: 'overwrite',
  sitemapUrl: 'sitemap.xml',
})
```

## CLI and CI verification

Run generation or post-build verification directly from the command line:

```bash
# Generate discovery files from dist/
npx vite-plugin-geo generate --domain https://example.com --dist-dir dist

# Use a JSON config file
npx vite-plugin-geo generate --config ./geo.config.json

# Read-only verification of final dist/ artifacts
npx vite-plugin-geo verify --dist-dir dist --domain https://example.com
npx vite-plugin-geo verify --dist-dir dist --report json > geo-report.json
npx vite-plugin-geo verify --dist-dir dist --report sarif --report-file geo.sarif
npx vite-plugin-geo verify --dist-dir dist --fail-on-verify warning

# Generate, verify immediately, and gate on audit warnings
npx vite-plugin-geo generate --verify --fail-on-audit warning
```

`verify` reads the final `dist/` directory without writing files, making it immune to third-party `closeBundle` overwrite races. It checks Sitemap `<loc>` counts, home page presence, leaked build prefixes (such as `/src/pages/`), `.html` extension leaks, duplicate `<loc>` entries, `<loc>`-to-file mapping, `robots.txt` `Sitemap:` consistency, canonical alignment, `llms.txt`, `feed.xml`, and Markdown mirrors (recursing Sitemap indexes up to 5 levels).

When `--report json` or `--report sarif` writes to stdout, human-readable logs route to stderr automatically so stdout stays valid for pipes.

GitHub Actions SARIF workflow example:

```yaml
- run: npm run build
- run: npx vite-plugin-geo verify --dist-dir dist --domain https://example.com --report sarif --report-file geo.sarif --fail-on-verify warning
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: geo.sarif
```

<details>
<summary>Full CLI flag reference</summary>

`generate` is the default command when no subcommand is given.

| Flag | Description |
|---|---|
| `--domain <url>` | Public site origin; overrides `package.json.domain`. |
| `--dist-dir <path>` | Build output directory (default: `dist`). |
| `--route-base-path <path>` | Single public URL subpath prefix. |
| `--source-html-dir <path>` | Source HTML directory (default: `src/pages`). |
| `--package-json-path <path>` | Path to `package.json`, or `--package-json-path=false`. |
| `--strip-path-prefixes <list>` | Comma-separated source path prefixes to strip. |
| `--exclude-patterns <list>` | Comma-separated exclusion globs. |
| `--lastmod-strategy <value>` | `none`, `file-mtime`, `build`, or `git`. |
| `--lastmod-ignore <list>` | Comma-separated globs skipped by `lastmod`. |
| `--llms-md-mirror-style <value>` | `append` or `replace`. |
| `--robots-directives <list>` | Comma-separated custom `robots.txt` directives. |
| `--sitemap-url <path-or-url>` | Sitemap URL or path referenced by `robots.txt` and `llms.txt`. |
| `--sitemap-conflict <mode>` | `preserve`, `error`, or `overwrite`. |
| `--file-conflict <mode>` | `preserve`, `error`, or `overwrite` (default: `preserve`). |
| `--route-conflict <mode>` | `error`, `first`, or `last` (default: `error`). |
| `--hreflang-from-html / --no-hreflang-from-html` | Toggle per-page HTML `hreflang` extraction. |
| `--fail-on-audit <level>` | `none`, `warning`, or `advice` (default: `none`). |
| `--fail-on-verify <level>` | `none`, `error`, or `warning` (default: `error`). |
| `--report <json\|sarif>` | Emit a machine-readable report (`json` or `sarif`). |
| `--report-file <path>` | Write the report to a file instead of stdout. |
| `--verify` | Run `verify` immediately after `generate`. |
| `--pretty-urls / --no-pretty-urls` | Toggle `.html` extension stripping. |
| `--sitemap-index / --no-sitemap-index` | Toggle automatic Sitemap index sharding. |
| `--generate-sitemap / --no-generate-sitemap` | Toggle Sitemap generation. |
| `--generate-robots / --no-generate-robots` | Toggle `robots.txt` generation. |
| `--llms-md-mirror / --no-llms-md-mirror` | Toggle Markdown mirror generation. |
| `--generate-feed / --no-generate-feed` | Toggle RSS 2.0 `feed.xml` generation. |
| `--generate-humans / --no-generate-humans` | Toggle `humans.txt` generation. |
| `--audit / --no-audit` | Toggle build diagnostics (also accepts `--audit=true\|false`). |
| `--debug / --no-debug` | Toggle verbose planning summary. |
| `--config <path>` | Load options from a JSON file. |

</details>

## Build diagnostics

`audit` is enabled by default in Vite, Astro, and CLI builds. Diagnostics print sorted by page path and rule ID without modifying HTML or failing builds unless `auditFailOn` (`--fail-on-audit`) is set.

Checked rules cover:

- Missing, empty, multiple, or duplicate `<title>` and meta description tags across included pages.
- Missing or malformed `<html lang>` tags and missing or multiple `<h1>` headings.
- Invalid, conflicting, missing, relative, or cross-origin `canonical` links (following [Google canonical guidelines](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)).
- Malformed JSON-LD syntax (validates JSON parsing, arrays, and `@graph` without asserting Schema.org rich-result eligibility).
- Missing `alt` attributes on `<img>` elements (`alt=""` is accepted for decorative images).
- Internal links, canonicals, or `hreflang` links targeting known `noindex` pages, missing local build targets, or `.html` suffixes when `prettyUrls: true`.
- Orphan non-home pages with zero incoming static links, non-reciprocal or missing self-referential `hreflang` clusters, and discovery `<link>` consistency.

Diagnostics inspect local build artifacts only. They never send HTTP requests or verify live status codes, CDN rewrites, WAF rules, or response headers such as `X-Robots-Tag`.

## Common recipes

### Subpath deployment with `replace` mirrors

```js
geo({
  domain: 'https://example.com',
  routeBasePath: '/docs/',
  llmsMdMirrorStyle: 'replace',
  generateRobots: false,
})
```

### Multilingual sites (`hreflang` and `hreflangFromHtml`)

For subdomain deployments sharing identical path shapes, configure global templates:

```js
geo({
  domain: 'https://en.example.com',
  hreflang: {
    en: 'https://en.example.com/{path}',
    'zh-CN': 'https://zh.example.com/{path}',
    'x-default': 'https://en.example.com/{path}',
  },
})
```

For path-prefixed locales (such as `/about` and `/zh/about`), declare alternates in each page's HTML `<head>` and enable `hreflangFromHtml`:

```js
geo({
  domain: 'https://example.com',
  hreflangFromHtml: true,
})
```

### Merchant root manifest (`sku.md`)

```js
geo({
  domain: 'https://shop.example.com',
  skuMd: {
    merchantName: 'Example Store',
    summary: 'Independent tea catalog.',
    catalog: [
      {
        label: 'All products',
        url: 'https://shop.example.com/collections/all',
      },
    ],
  },
})
```

### Deployment checklist

- **Prevent host soft-404 responses:** Static hosts such as Cloudflare Pages return `200 OK` with the home page for unknown paths unless `404.html` exists at the output root. Ensure your build emits `404.html` and run `vite-plugin-geo verify` in CI.
- **Avoid `closeBundle` Sitemap writers:** `vite-plugin-geo` emits assets during `generateBundle` and cannot prevent another plugin from overwriting `sitemap.xml` later in `closeBundle`. Run `vite-plugin-geo verify` in CI to catch post-bundle overwrites.

## Specification contract

Specification review snapshot: `2026-08-12`.

| Mechanism | Specification status | Plugin behavior |
|---|---|---|
| [`llms.txt` v2](https://llmstxt.org/) ([changes](https://llmstxt.org/changes.html)) | Community proposal, not an IETF or W3C standard | Single-scope index, [RFC 8288](https://www.rfc-editor.org/rfc/rfc8288) / [IANA](https://www.iana.org/assignments/link-relations/link-relations.xhtml) `describedby` and Markdown `alternate` links, clean `<main>` / `<article>` mirrors |
| [`robots.txt` (RFC 9309)](https://www.rfc-editor.org/rfc/rfc9309) | IETF Standards Track | Root `/robots.txt` only, user-file preservation, control-character and 500 KiB validation |
| [Sitemap 0.9](https://www.sitemaps.org/protocol.html) | Industry protocol, not an IETF or W3C standard | URL sets, `hreflang` alternates, 50,000 URL / 50 MiB sharding, no ignored `priority` or `changefreq` tags |
| [RSS 2.0.11](https://www.rssboard.org/rss-specification) | Public specification | RSS 2.0 feed, Atom `self` link, canonical `<guid>`, no fabricated item `pubDate` |
| [`humans.txt`](https://humanstxt.org/Standard.html) | Informal community convention | Opt-in output containing only verified metadata |
| [SKU.md `1.0.0-beta`](https://sku.md/spec/1.0.0-beta/sku-md-spec.md) ([changelog](https://sku.md/spec/1.0.0-beta/changelog.md)) | Experimental community proposal | Opt-in root `/sku.md` pure Markdown catalog under 65,536 UTF-8 bytes |

### URL resolution rules

| Mode | HTML input | Public URL path |
|---|---|---|
| `prettyUrls: true` | `about.html` | `/about` |
| `prettyUrls: true` | `docs/index.html` | `/docs` |
| `prettyUrls: false` | `about.html` | `/about.html` |
| Home page | `index.html` | `/` (always) |

### Reviewed and intentionally not generated

| Proposal or mechanism | Review conclusion |
|---|---|
| [IETF AIPREF](https://datatracker.ietf.org/group/aipref/) | Vocabulary remains an active Internet-Draft (`draft-ietf-aipref-vocab-06`) and is not yet an RFC. |
| [Cloudflare Content Signals](https://developers.cloudflare.com/bots/additional-configurations/managed-robots-txt/) | Vendor-specific directive rather than an interoperable IETF standard. |
| [W3C TDM Reservation Protocol](https://www.w3.org/community/reports/tdmrep/CG-FINAL-tdmrep-20240510/) | W3C Community Group Final Report, not a W3C Recommendation. |
| `ai.txt` | Fragmented community drafts without stable cross-vendor adoption. |
| [Shopify `agents.md`](https://shopify.dev/changelog/customize-llmstxt-llms-fulltxt-and-agentsmd) | Platform-specific storefront convention unsuitable as a generic Vite default. |
| [WebMCP Draft Community Group Report](https://webmachinelearning.github.io/webmcp/) | Browser runtime API draft rather than a static build artifact. |

## Contributing

Issues and pull requests are welcome at [github.com/maxlee/vite-plugin-geo](https://github.com/maxlee/vite-plugin-geo).

Repository layout:

```text
vite-plugin-geo/
├── src/        # Runtime entry points, core pipeline, audit/verify, and .d.ts types
├── tests/      # Unit and real-framework integration tests (Vite 7/8 and Astro 7)
├── scripts/    # Registry metadata and packed-tarball consumer verifiers
└── .github/    # GitHub Actions CI workflows
```

Local development uses [Bun](https://bun.sh/) for test execution and Node.js (`^20.19.0 || >=22.12.0`) for consumer matrix verification:

```bash
# Install dependencies
bun install

# Run the test suite and coverage
bun test
bun test --coverage

# Validate Vite Plugin Registry schema metadata
bun run verify:registry-metadata

# Verify packed tarball against real Vite 7/8 and Astro 7 consumers
bun run verify:consumers

# Inspect the npm publish file list
npm run pack:dry-run
```

Follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`, `chore:`) when submitting pull requests, and ensure `git diff --check` reports no whitespace errors.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release notes and migration guides.

## License

[MIT](./LICENSE) © maxlee
