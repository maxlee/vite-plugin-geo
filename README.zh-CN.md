# vite-plugin-geo

[![npm version](https://img.shields.io/npm/v/vite-plugin-geo.svg)](https://www.npmjs.com/package/vite-plugin-geo)
[![CI](https://github.com/maxlee/vite-plugin-geo/actions/workflows/ci.yml/badge.svg)](https://github.com/maxlee/vite-plugin-geo/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/node/v/vite-plugin-geo.svg)](./package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

[English](./README.md) | 简体中文

面向 Vite、[Vite+](https://viteplus.dev/) 与 Astro 静态站点的构建后发现文件生成与校验工具。基于统一的构建规划管线，自动生成 `sitemap.xml`、`robots.txt`、RSS 2.0 `feed.xml`、`llms.txt` v2、页面级纯净 Markdown 镜像，以及可选的 `humans.txt` 与 `sku.md` 根清单。

> **能力边界声明：** 本工具生成的产物仅作为机器可读的发现与抓取提示，不保证任何搜索引擎或 AI 系统抓取、索引、引用或优先展示页面，也不承诺搜索排名与流量效果。

## 目录

- [核心特性](#核心特性)
- [环境要求](#环境要求)
- [安装](#安装)
- [快速开始](#快速开始)
  - [Vite 项目](#vite-项目)
  - [Vite+ 项目](#vite-项目-1)
  - [Astro 项目](#astro-项目)
- [输出文件与冲突策略](#输出文件与冲突策略)
- [配置项](#配置项)
- [Astro 官方 Sitemap 兼容](#astro-官方-sitemap-兼容)
- [CLI 与 CI 产物校验](#cli-与-ci-产物校验)
- [构建诊断](#构建诊断)
- [常见配置示例](#常见配置示例)
- [规范契约与边界](#规范契约与边界)
- [参与贡献](#参与贡献)
- [更新日志](#更新日志)
- [开源协议](#开源协议)

## 核心特性

- **Sitemap 0.9 自动生成与分片：** 扫描构建 HTML 生成支持 `trailingSlash` 策略的标准 URL 集，超过 50,000 条 URL 或 `sitemapMaxBytes`（上限 50 MiB）自动拆分为分片与索引，原生兼容 `@astrojs/sitemap`。
- **RFC 9309 `robots.txt` 处理：** 默认逐字节保留手写 `robots.txt`；校验自定义指令的控制字符与 500 KiB 体积上限，始终写入站点根目录。
- **RSS 2.0 订阅发现：** 生成包含 Atom `self` 链接与稳定规范 URL `<guid>` 的 `feed.xml`（支持按路径过滤、上限截断、语言覆盖与 `feedByLocale` 分语言输出），并向 HTML 幂等注入 discovery `<link>`。
- **`llms.txt` v2 与纯净 Markdown 镜像：** 自动注入 `rel="describedby"` 与 `rel="alternate" type="text/markdown"`，支持通过 `llmsMdMirrorInclude` / `llmsMdMirrorExclude` 控制生成范围；优先提取 `<main>` 或唯一 `<article>` 正文，支持 GFM 表格、块级链接卡片归一化、`<details>/<summary>`、`data-geo-ignore`、`markdownStripSelectors` 与单 H1 规范化，并自动剔除导航与表单噪音。
- **多语言 `hreflang` 支持：** 支持全局路径模板映射，或通过 `hreflangFromHtml` 逐页解析 HTML 声明生成 Sitemap `xhtml:link`。
- **可选 `humans.txt` 与 `sku.md`（`1.0.0-beta`）：** 仅输出可验证的真实元数据与根目录纯 Markdown 商品目录入口，不编造缺失字段。
- **静态构建诊断与只读 `verify`：** 构建期默认输出静态页面诊断建议（`audit`），构建后可通过 `vite-plugin-geo verify` 只读校验最终 `dist/` 产物，支持导出 JSON（`schemaVersion: "1.0"`）与 SARIF 2.1.0 报告。
- **多端一致管线：** Vite / Vite+ 插件、Astro 集成与独立 CLI 共用同一套参数校验、冲突处理、路径规划与所有权识别逻辑。

## 环境要求

- **Node.js：** `^20.19.0 || >=22.12.0`（`vite-plus` 本身要求 `^22.18.0 || ^24.11.0 || >=26.0.0`）
- **Vite：** `^7.0.0 || ^8.0.0`（可选 Vite peer 依赖，纯 CLI 或仅 Astro 项目无需单独安装 Vite）
- **Vite+：** `vite-plus` `^1.x`（通过 `@voidzero-dev/vite-plus-core` 内置 Vite 8 与 Rolldown）
- **Astro：** `^7.0.0`（可选 Astro peer 依赖，纯 Vite 项目无需安装 Astro）

## 安装

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

在 Vite+ 工作区中安装：

```bash
vp add -D vite-plugin-geo
```

## 快速开始

### Vite 项目

在 `vite.config.js` 中注册默认导出：

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

`domain` 必须是仅包含协议、主机和可选端口的 HTTP(S) 站点源（如 `https://example.com`），不得包含凭据、路径、查询参数或片段；子路径部署请使用 `routeBasePath`。

你也可以在项目 `package.json` 中配置 `"domain"` 字段。两处同时配置时 `geo({ domain })` 优先。若 `package.json` 没有 `domain`，会改用绝对 URL 形式的 `homepage`（如 `"homepage": "https://example.com"`），同样须符合仅含站点源的规则；`"."` 等相对值会被忽略。以上均缺失时停止构建，防止产出错误的公开链接。

支持默认导出与命名导出：

```js
import geo, { createGeoGeneratorPlugin, verifyGeoOutput } from 'vite-plugin-geo';
```

Vite 构建说明：

- `distDir` 默认读取 Vite 解析后的 `build.outDir`，`routeBasePath` 默认读取 Vite `base`。
- 插件声明 `apply: 'build'` 并在 `generateBundle`（`enforce: 'post'`）通过 `this.emitFile` 写入产物，支持 `build.write: false`；当插件产物与 `publicDir` 文件重名时由插件输出覆盖，同时对无所有权标记的既有文件遵循 `fileConflict`、`sitemapConflict` 与 `generateRobots`。
- SSR、库模式及多环境构建中的服务端环境不产出静态 HTML，会自动跳过生成；多环境构建仅基于客户端 HTML 输出生成发现文件。

### Vite+ 项目

[Vite+](https://viteplus.dev/)（`vite-plus`）通过 `@voidzero-dev/vite-plus-core` 内置 Vite 8 与 Rolldown，因此在 `vite.config.ts` 中直接注册默认导出即可，无需额外的适配器子路径入口：

```ts
// vite.config.ts
import { defineConfig, lazyPlugins } from 'vite-plus';
import geo from 'vite-plugin-geo';

export default defineConfig({
  plugins: lazyPlugins(() => [
    geo({
      domain: 'https://example.com',
    }),
  ]),
});
```

Vite+ 使用说明：

- 建议使用 `'vite-plus'` 的 `lazyPlugins(() => [...])` 包裹插件数组，避免 `vp check`、`vp lint` 与 `vp fmt` 在读取配置元数据阶段（`VP_RESOLVING_CONFIG_METADATA=1`）提前初始化插件。
- 构建 Web 应用请使用 `vp build`（执行 Vite + Rolldown 构建管线）；`vp pack` 基于 `tsdown` 用于打包库或独立可执行文件，不会生成 HTML 页面。
- 由于 `vite-plus` 将 `vite` 映射为 `@voidzero-dev/vite-plus-core@1.x` 而非 `vite@7`/`8`，请保留 `vp create` 或 `vp migrate` 生成的 `overrides`（`npm` / `pnpm`）与 `pnpm.peerDependencyRules`。
- 若 Vite+ 项目的 `package.json` 仅声明 `vite-plus`（无直接 `vite` 依赖），开启 `generateHumans: true` 时会在 `humans.txt` 的 `Components:` 中写入 `vite-plus`。

### Astro 项目

Astro 在内部 Vite 构建结束后才落盘最终 HTML，请勿将本插件放入 `vite.plugins`。请在以下两种正式方式中二选一（不要同时启用）。

> **重要提示：** Astro `integrations` **必须** 从 `'vite-plugin-geo/astro'` 导入（`import geo from 'vite-plugin-geo/astro'`）。若误将 `'vite-plugin-geo'` 的默认 Vite 插件导出传入 `integrations`，插件会在 `astro:config:setup` 阶段立即抛出明确的错误并提示修改导入路径。

#### 方式一：Astro 原生集成（推荐）

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import geo from 'vite-plugin-geo/astro';

export default defineConfig({
  site: 'https://example.com',
  integrations: [geo()],
});
```

域名读取优先级依次为 `geo({ domain })`、Astro `site`、`package.json.domain`、绝对 URL 形式的 `package.json.homepage`。已配置 `site` 时无需重复填写 `domain`。

Astro 集成说明：

- 未显式传入 `prettyUrls` 且 Astro `build.format` 为 `'file'` 时，`vite-plugin-geo/astro` 会自动关闭 `prettyUrls` 以匹配 `.html` 输出路径。
- 未显式传入 `trailingSlash` 时，`vite-plugin-geo/astro` 会自动与 Astro 的 `config.trailingSlash` 保持一致（`'always' -> 'always'`、`'never' -> 'never'`、`'ignore' -> 'preserve'`）。Markdown 镜像路径始终保持 `/about.md`（不会变为 `/about/.md`）。
- Astro 声明的重定向路由（`route.type === 'redirect'`）及对应跳转页面会自动排除出 `sitemap.xml`、`llms.txt`、`feed.xml`、Markdown 镜像与构建审计。

#### 方式二：构建后串联 CLI

```json
{
  "domain": "https://example.com",
  "scripts": {
    "build": "astro build && vite-plugin-geo generate"
  }
}
```

CLI 默认扫描 `dist/` 且不解析 `astro.config.*`。若域名仅写在 Astro `site` 中，请传入 `--domain https://example.com`（自定义输出目录或 Astro `outDir` 请同时传入 `--dist-dir <path>`）。

默认输出结构：

```text
dist/
├── sitemap.xml
├── robots.txt
├── feed.xml
├── llms.txt
├── index.md
└── ...其他页面.md
```

## 输出文件与冲突策略

| 文件 | 默认状态 | 说明 |
|---|---|---|
| `sitemap.xml` | 开启（自动） | 收录符合 `trailingSlash` 策略的公开页面路由；超过 50,000 URL 或 `sitemapMaxBytes` 时自动分片。检测到外部 Sitemap 时默认跳过。 |
| `sitemap_index.xml` | 按需生成 | Sitemap 触发分片且 `sitemapIndex: true` 时自动生成。 |
| `robots.txt` | 自动 | 默认保留已有手写文件；无手写文件时根作用域（`/`）生成，非根作用域跳过；始终位于站点根路径 `/robots.txt`。 |
| `feed.xml` | 开启 | 生成含 Atom `self` 链接的 RSS 2.0 订阅源，并向 HTML 注入 discovery `<link>`；支持路径过滤、条数限制、语言覆盖与按语言拆分（`feedByLocale`）。 |
| `llms.txt` | 开启 | 当前 `routeBasePath` 单一作用域下的 `llms.txt` v2 索引；生成 `.md` 镜像时链接到对应镜像，镜像被排除时自动回退为页面 HTML 的 `pageUrl`。 |
| `*.md` | 开启 | 按公开 `pagePath` 派生的页面 Markdown 镜像，前置 `# <title>` 与 `> <description>`，并提取净化后的 `<main>` 或 `<article>` 正文；始终使用 `/about.md`（不会出现 `/about/.md`）。 |
| `humans.txt` | 关闭 | 仅输出显式配置或从 `package.json` 可确认的团队、版权与技术信息。 |
| `sku.md` | 关闭 | 配置 `skuMd` 后在站点根目录生成 SKU.md `1.0.0-beta` 纯 Markdown 目录清单。 |

**目录输出模式与镜像命名：** 在 `build.format: 'directory'`（或 `*/index.html` 目录形式）且开启 `prettyUrls: true` 时，目录首页会直接映射到与 `llms.txt` 公开路径一致的镜像文件名：`about/index.html -> about.md`、`zh/index.html -> zh.md`（根目录 `index.html -> index.md`）。即使对 HTML 页面启用了 `trailingSlash: 'always'`（如 `/about/`、`/zh/`），对应的 `.md` 镜像依然保持 `/about.md` 与 `/zh.md`，不会附加尾部斜杠。

**Markdown 镜像提取与净化：** 内容提取优先选择 `<main>`，其次唯一 `<article>`，最后回退到去除站点外框的 `<body>`。提取前会自动剔除 `[hidden]`、`[aria-hidden="true"]`、`[data-geo-ignore]`、`<form>`、`<input>`、`<select>`、`<textarea>`、`<button>`、`<nav>`、`[role="navigation"]`、面包屑导航及 `markdownStripSelectors` 匹配的元素。同时将 `<table>` 转为标准 GFM 管道表格（支持无 `<thead>` 表格）、将包含块级元素的 `<a>` 卡片规整为干净的 `[Title](href)` 与正文描述并修复相邻内联元素间的粘连空格、规范分隔 `<details>`/`<summary>`，并强制每个 `.md` 镜像至多保留一个顶层 `# ` 一级标题（去重匹配页面标题的首个 `<h1>`，并将代码块之外多余的 `#` 标题降级为 `##`）。

**RSS 订阅源使用建议：** 在默认的 `lastmodStrategy: 'none'` 下，RSS `<item>` 会省略 `<pubDate>` 并按 URL 确定性排序。对于非博客类网站或工具站，建议显式设置 `generateFeed: false`，或通过 `feedIncludePatterns` 仅收录文章/更新日志页面（如需按发布时间排序，请同时开启 `lastmodStrategy: 'git'` 或 `'file-mtime'`，或使用 `lastmodResolver`）。

**所有权标记与冲突保护：** 插件生成的产物带有精确格式的 `Generated by vite-plugin-geo` 标记，再次构建时按新配置更新；移除该标记即视为用户自有文件。遇到用户自有 `llms.txt`、`feed.xml`、`humans.txt`、`sku.md` 或 `*.md` 镜像时，`fileConflict` 默认 `'preserve'`（保留用户文件并告警，其余产物继续生成；若在生成 `.md` 镜像的同时保留了手写 `llms.txt`，构建日志会输出提醒警告，提示你手动同步 `llms.txt` 中的镜像链接）。设为 `'error'` 可在写入前报错中止，设为 `'overwrite'` 可显式覆盖。`sitemap.xml` 与 `robots.txt` 分别由 `sitemapConflict` 与 `generateRobots` 控制。

## 配置项

| 选项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `domain` | `string` | `package.json.domain`，其次 `package.json.homepage` | 不含凭据、路径、查询参数或片段的 HTTP(S) 站点源。 |
| `distDir` | `string` | Vite `build.outDir` | 构建输出目录（`vite-plugin-geo/astro` 自动读取构建目录，无需配置）。 |
| `routeBasePath` | `string` | Vite 或 Astro `base` | 单一公开路径作用域（如 `'/docs/'`）；传完整 URL 会报错。 |
| `prettyUrls` | `boolean` | `true` | 公开页面 URL 是否去除 `.html` 后缀。 |
| `trailingSlash` | `'never' \| 'always' \| 'preserve'` | `'never'`（Astro 默认同步 `config.trailingSlash`） | 根路径及无扩展名公开 URL 的尾部斜杠策略；带扩展名的文件（`.md`、`.html`、`.xml`、`.txt`）永远不加尾部斜杠。`'preserve'` 会保留页面 `<link rel="canonical">` 的斜杠形态。 |
| `lastmodStrategy` | `'none' \| 'file-mtime' \| 'build' \| 'git'` | `'none'` | Sitemap `<lastmod>` 与 RSS `<pubDate>` 时间来源。 |
| `excludePatterns` | `string[]` | `['404.html', '500.html']` | 排除页面的 glob 规则。 |
| `hreflang` | `Record<string, string>` | `undefined` | 使用 `{path}` 占位符的全局多语言映射。 |
| `hreflangFromHtml` | `boolean` | `false` | 从每页 HTML 的 `rel="alternate" hreflang` 提取 Sitemap `xhtml:link`；未声明页面回退到 `hreflang`。 |
| `generateSitemap` | `boolean` | 自动 | 检测到外部 Sitemap 时默认关闭。 |
| `sitemapConflict` | `'preserve' \| 'error' \| 'overwrite'` | 自动 | 检测到外部 Sitemap 时的处理策略，默认保留并打印样例告警。 |
| `sitemapUrl` | `string` | 自动 | `robots.txt` 与 `llms.txt` 引用的 Sitemap 地址。 |
| `fileConflict` | `'preserve' \| 'error' \| 'overwrite'` | `'preserve'` | 已有用户文件时的冲突策略（适用于 `llms.txt`、`feed.xml`、`humans.txt`、`sku.md` 与 `*.md`）。 |
| `routeConflict` | `'error' \| 'first' \| 'last'` | `'error'` | 多个 HTML 映射到同一公开路由时抛错或按顺序保留。 |
| `llmsMdMirror` | `boolean` | `true` | 是否为缺少有效 Markdown alternate 的页面生成镜像。 |
| `llmsMdMirrorStyle` | `'append' \| 'replace'` | `'append'` | 镜像命名方式：`prettyUrls: false` 时 `append` 生成 `about.html.md`，`replace` 生成 `about.md`。 |
| `llmsMdMirrorInclude` | `string[]` | `undefined` | 指定需要生成 `.md` 镜像及 Markdown `alternate` 链接的页面 glob 列表；未匹配页面在 `llms.txt` 中回退为 HTML URL。 |
| `llmsMdMirrorExclude` | `string[]` | `undefined` | 排除不生成 `.md` 镜像的页面 glob 列表；被排除页面在 `llms.txt` 中回退为 HTML URL。 |
| `markdownStripSelectors` | `string[]` | `[]` | 在转换为 Markdown 镜像前额外剔除的 CSS 选择器列表（在 `data-geo-ignore`、表单、按钮、隐藏元素与导航剔除之外生效）。 |
| `llmsClassify` | `(page: LlmsPageInfo) => string \| null \| undefined` | 自动 | 自定义 `llms.txt` 分区函数。 |
| `llmsSections` | `Record<string, string \| string[]>` | 自动 | 按路径前缀配置 `llms.txt` 分区。 |
| `generateRobots` | `boolean` | 自动 | 默认保留手写文件，否则仅在根作用域生成；显式 `true` 与手写文件冲突时抛错。 |
| `robotsDirectives` | `string[]` | `[]` | 自定义 `robots.txt` 指令。 |
| `generateFeed` | `boolean` | `true` | RSS 2.0 订阅源生成开关。 |
| `feedIncludePatterns` | `string[]` | `undefined` | 限定纳入 RSS 订阅源的页面 glob 列表。 |
| `feedExcludePatterns` | `string[]` | `undefined` | 从 RSS 订阅源排除的页面 glob 列表。 |
| `feedMaxItems` | `number` | `undefined` | 每个 RSS 订阅源最多输出的 `<item>` 条数（正整数）。 |
| `feedLanguage` | `string` | 首页 `<html lang>` 或 `'en'` | 显式指定 RSS `<language>` 的 BCP 47 语言标签（同时作为 `feedByLocale: true` 的回退语言）。 |
| `feedByLocale` | `boolean` | `false` | 按页面语言分别生成独立的分语言 RSS 订阅源，避免多语言页面混入同一份 `feed.xml`。 |
| `generateHumans` | `boolean` | `false` | `humans.txt` 生成开关。 |
| `skuMd` | `SkuMdOptions` | `undefined` | SKU.md `1.0.0-beta` 根清单配置。 |
| `audit` | `boolean` | `true` | 构建期静态页面诊断开关。 |
| `auditFailOn` | `'warning' \| 'advice'` | 关闭 | 诊断达到指定级别时在写入前中止构建。 |
| `debug` | `boolean` | `false` | 打印解析后的站点地址、排除原因、Sitemap 决策与镜像摘要。 |

<details>
<summary>查看进阶配置项</summary>

| 选项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `stripPathPrefixes` | `string[]` | `['src/pages/']` | 计算公开 URL 时剥离的源码路径前缀。 |
| `sourceHtmlDir` | `string` | `'src/pages'` | `file-mtime` 与 `git` 策略查找源码 HTML 的目录。 |
| `packageJsonPath` | `string \| false` | `'./package.json'` | `package.json` 路径；设为 `false` 跳过读取。 |
| `sitemapIndex` | `boolean` | `true` | 是否允许自动分片并生成 `sitemap_index.xml`。 |
| `sitemapMaxBytes` | `number` | `52428800` | 单个未压缩 Sitemap 分片的字节上限（最大 50 MiB）。 |
| `lastmodIgnore` | `string[]` | `[]` | 跳过 `lastmod` 解析的 glob 列表。 |
| `lastmodResolver` | `(page: GeoPageModel) => Date \| string \| null \| undefined` | `undefined` | 仅限插件 API：返回 `Date` 或有效 W3C Datetime 字符串；`null` 省略字段，`undefined` 回退策略，非法值直接报错。 |
| `skuMd.merchantName` | `string` | 首页 `<title>` | 商户标题；缺失且无法从首页推导时构建失败。 |
| `skuMd.summary` | `string` | 首页 description | 商户摘要；缺失且无法从首页推导时构建失败。 |
| `skuMd.catalog` | `Array<{ label: string; url: string }>` | 必填 | 至少一个同源 HTTPS 目录链接。 |

</details>

已废弃的旧配置项（`llmsFull`、`llmsCtx`、`llmsCtxFull`、`blockGoogleExtended`、`stability*` 以及旧版 `skuMd` 的 `catalogUrl`、`contentLanguage`、`market`）均会直接抛出配置错误，不会静默忽略。

## Astro 官方 Sitemap 兼容

若 Astro 项目已使用 `@astrojs/sitemap`，请将 `sitemap()` 放在 `geo()` 之前，确保 `@astrojs/sitemap` 先写出 Sitemap 文件，随后 `vite-plugin-geo/astro` 在 `astro:build:done` 扫描 `dist/`（若顺序相反，`astro:config:done` 会输出顺序告警）：

```js
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import geo from 'vite-plugin-geo/astro';

export default defineConfig({
  site: 'https://example.com',
  integrations: [sitemap(), geo()],
});
```

插件会在 `astro:build:done` 阶段检查磁盘上的真实 Sitemap 产物，默认保留外部 Sitemap（打印文件名、来源、`<loc>` 数量与前 3 条样例），并让 `robots.txt` 与 `llms.txt` 自动指向实际检测到的 Sitemap（支持自定义 `filenameBase`）。如需显式接管，请同时配置 `generateSitemap: true` 与 `sitemapConflict: 'overwrite'`。

## CLI 与 CI 产物校验

除了作为构建插件，也可直接通过命令行运行生成与只读校验：

```bash
# 从 dist/ 生成发现文件
npx vite-plugin-geo generate --domain https://example.com --dist-dir dist

# 使用 JSON 配置文件
npx vite-plugin-geo generate --config ./geo.config.json

# 只读校验最终 dist/ 产物（不受第三方 closeBundle 覆盖时序影响）
npx vite-plugin-geo verify --dist-dir dist --domain https://example.com
npx vite-plugin-geo verify --dist-dir dist --report json > geo-report.json
npx vite-plugin-geo verify --dist-dir dist --report sarif --report-file geo.sarif
npx vite-plugin-geo verify --dist-dir dist --fail-on-verify warning

# 生成后立即校验，并开启审计门禁
npx vite-plugin-geo generate --verify --fail-on-audit warning
```

`verify` 只读取最终 `dist/` 目录而不修改任何文件，检查范围涵盖 Sitemap `<loc>` 数量、首页收录、构建中间前缀残留（如 `/src/pages/`）、`.html` 扩展名泄漏、重复 `<loc>`、`<loc>` 到产物文件映射、`robots.txt` 的 `Sitemap:` 一致性、canonical 对齐、`llms.txt`、`feed.xml` 与 Markdown 镜像（递归解析最多 5 层 Sitemap 索引）。当报告输出到 stdout 时，人类可读日志自动分流至 stderr，便于管道解析。

Vite+ 项目可通过 `vp exec` 或 `vpx` 调用 CLI：

```bash
vp build
vp exec vite-plugin-geo verify --dist-dir dist --domain https://example.com
```

在 Vite+ Monorepo 中从仓库根目录调用 CLI 时，默认读取当前目录的 `./package.json`；针对子包构建产物请显式传入 `--domain` 或 `--package-json-path`：

```bash
vp build apps/web
vp exec vite-plugin-geo verify --dist-dir apps/web/dist --package-json-path apps/web/package.json
```

如使用 Vite Task（`vite.config.ts` 中的 `run.tasks`）并开启缓存，建议将 GEO 生成保留在 `vp build`（Vite 插件）内，并将 `vite-plugin-geo verify` 配在通过 `dependsOn` 串联的下游校验任务中，避免多个任务并发或二次改写同一 `dist/` 文件。

GitHub Actions 接入 SARIF 示例：

```yaml
- run: npm run build
- run: npx vite-plugin-geo verify --dist-dir dist --domain https://example.com --report sarif --report-file geo.sarif --fail-on-verify warning
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: geo.sarif
```

<details>
<summary>查看完整 CLI 参数表</summary>

省略子命令时默认执行 `generate`。

| 参数 | 说明 |
|---|---|
| `--domain <url>` | 公开站点源，优先于 `package.json.domain` 与 `homepage`。 |
| `--dist-dir <path>` | 构建输出目录，默认 `dist`。 |
| `--route-base-path <path>` | 单一公开路径前缀。 |
| `--source-html-dir <path>` | 源码 HTML 目录，默认 `src/pages`。 |
| `--package-json-path <path>` | `package.json` 路径，支持 `--package-json-path=false`。 |
| `--strip-path-prefixes <list>` | 逗号分隔的剥离路径前缀。 |
| `--exclude-patterns <list>` | 逗号分隔的排除规则。 |
| `--trailing-slash <mode>` | `never`、`always` 或 `preserve`（默认 `never`）。 |
| `--lastmod-strategy <value>` | `none`、`file-mtime`、`build` 或 `git`。 |
| `--lastmod-ignore <list>` | 逗号分隔的 `lastmod` 跳过规则。 |
| `--llms-md-mirror-style <value>` | `append` 或 `replace`。 |
| `--llms-md-mirror-include <list>` | 逗号分隔的 `.md` 镜像包含 glob 列表。 |
| `--llms-md-mirror-exclude <list>` | 逗号分隔的 `.md` 镜像排除 glob 列表。 |
| `--markdown-strip-selectors <list>` | 逗号分隔的 CSS 选择器，转换 Markdown 前从正文中剔除。 |
| `--robots-directives <list>` | 逗号分隔的通用 `robots.txt` 指令。 |
| `--sitemap-url <path-or-url>` | `robots.txt` / `llms.txt` 引用的 Sitemap 地址。 |
| `--sitemap-conflict <mode>` | `preserve`、`error` 或 `overwrite`。 |
| `--file-conflict <mode>` | `preserve`、`error` 或 `overwrite`（默认 `preserve`）。 |
| `--route-conflict <mode>` | `error`、`first` 或 `last`（默认 `error`）。 |
| `--hreflang-from-html / --no-hreflang-from-html` | 逐页 HTML `hreflang` 解析开关。 |
| `--fail-on-audit <level>` | `none`、`warning` 或 `advice`（默认 `none`）。 |
| `--fail-on-verify <level>` | `none`、`error` 或 `warning`（默认 `error`）。 |
| `--report <json\|sarif>` | 输出机器可读报告（`json` 或 `sarif`）。 |
| `--report-file <path>` | 报告写入文件路径（默认 stdout）。 |
| `--verify / --no-verify` | `generate` 完成后立即执行 `verify` 的开关。 |
| `--pretty-urls / --no-pretty-urls` | `.html` 后缀剥离开关。 |
| `--sitemap-index / --no-sitemap-index` | Sitemap 自动拆分开关。 |
| `--generate-sitemap / --no-generate-sitemap` | Sitemap 生成开关。 |
| `--generate-robots / --no-generate-robots` | `robots.txt` 生成开关。 |
| `--llms-md-mirror / --no-llms-md-mirror` | Markdown 镜像生成开关。 |
| `--generate-feed / --no-generate-feed` | RSS 订阅源开关。 |
| `--feed-include-patterns <list>` | 逗号分隔的 RSS 收录页面 glob 列表。 |
| `--feed-exclude-patterns <list>` | 逗号分隔的 RSS 排除页面 glob 列表。 |
| `--feed-max-items <number>` | 每个 RSS 订阅源最多包含的条目数。 |
| `--feed-language <tag>` | 显式指定 RSS `<language>` 的 BCP 47 语言标签。 |
| `--feed-by-locale / --no-feed-by-locale` | 按语言拆分生成独立 RSS 订阅源的开关。 |
| `--generate-humans / --no-generate-humans` | `humans.txt` 生成开关。 |
| `--audit / --no-audit` | 构建诊断开关（亦支持 `--audit=true\|false`）。 |
| `--debug / --no-debug` | 调试摘要开关。 |
| `--config <path>` | JSON 配置文件路径。 |

</details>

## 构建诊断

Vite、Astro 与 CLI 默认开启 `audit: true`，按页面路径与规则编号稳定输出静态检查提示，默认不中断构建、不改写页面；配置 `auditFailOn`（`--fail-on-audit`）后可作为 CI 硬门禁。

检查规则覆盖：`<title>` 与 meta description 缺失/重复、`<html lang>` 缺失或格式异常、`<h1>` 缺失或多个、[Google canonical 指南](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)边界下的 canonical 冲突与提示、JSON-LD 语法合法性、`<img>` 缺失 `alt`、指向 `noindex` 页面或本地缺失目标的链接、`prettyUrls` 下残留 `.html` 的站内链接、无入站静态链接的孤儿页面、`hreflang` 互指与自引用，以及发现 `<link>` 一致性。诊断仅检查本地构建产物，不发起网络请求，也不验证 CDN、WAF 或线上 HTTP 响应头。

## 常见配置示例

### 子路径部署与 `replace` 镜像

```js
geo({
  domain: 'https://example.com',
  routeBasePath: '/docs/',
  llmsMdMirrorStyle: 'replace',
  generateRobots: false,
})
```

### 多语言站点（`hreflang` 与 `hreflangFromHtml`）

独立子域等共享相同路径形态的站点可使用全局模板：

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

路径前缀型多语言站点（如 `/about` 与 `/zh/about`）请在每页 HTML `<head>` 中声明 alternate 簇并开启 `hreflangFromHtml: true`。

### SKU.md 商户根清单

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

### 成熟站点仅补充内容页 Markdown 镜像

如果你的站点已经维护了自有的 `sitemap.xml`、`robots.txt` 或 `llms.txt`（或不需要 RSS 订阅源），可保留全部既有 SEO 产物，仅针对内容路由生成干净的 `.md` 镜像：

```js
geo({
  domain: 'https://example.com',
  generateFeed: false,
  sitemapConflict: 'preserve',
  fileConflict: 'preserve',
  llmsMdMirrorInclude: ['docs/**', 'guides/**', 'blog/**'],
  markdownStripSelectors: ['.toc', '.breadcrumb', '[data-promo]'],
})
```

你也可以直接在页面 HTML 节点上添加 `data-geo-ignore` 属性，在生成 `.md` 镜像时跳过侧边组件或交互条：

```html
<aside data-geo-ignore>不会写入 .md 镜像的交互组件</aside>
```

提示：当 `fileConflict: 'preserve'` 保留手写 `llms.txt` 并同时生成了新的 `.md` 镜像时，构建输出会打印一条提醒警告，提示你手动同步手写 `llms.txt` 中的镜像地址。

### 多语言 Astro 站点

在 `astro.config.mjs` 中务必从 `'vite-plugin-geo/astro'` 导入（切勿使用 `'vite-plugin-geo'` 默认导出）：

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import geo from 'vite-plugin-geo/astro';

export default defineConfig({
  site: 'https://example.com',
  trailingSlash: 'always',
  integrations: [
    geo({
      hreflangFromHtml: true,
      feedIncludePatterns: ['blog/**', 'zh/blog/**'],
      feedByLocale: true,
      feedLanguage: 'en',
      excludePatterns: ['**/404.html', '500.html'],
    }),
  ],
});
```

多语言 Astro 配置要点：

- **`trailingSlash` 自动对齐：** `vite-plugin-geo/astro` 会自动同步 Astro 的 `config.trailingSlash`（`'always' -> 'always'`、`'never' -> 'never'`、`'ignore' -> 'preserve'`），而 `.md` 镜像始终输出为 `/about.md`、`/zh/about.md`（不会出现 `/about/.md`）。
- **搭配 `@astrojs/sitemap`：** 若同时使用 `@astrojs/sitemap`，请确保 `sitemap()` 位于 `geo()` 之前（`integrations: [sitemap(), geo()]`）。默认情况下插件会保留 `@astrojs/sitemap` 的产物；若希望由 `vite-plugin-geo` 生成包含 `hreflangFromHtml: true` 的 Sitemap，请移除 `sitemap()` 或显式设置 `generateSitemap: true` 与 `sitemapConflict: 'overwrite'`。
- **分语言 RSS 订阅源：** 使用 `feedIncludePatterns` 排除着陆页和工具页，开启 `feedByLocale: true` 按语言分别生成独立订阅源而非混入同一份 `feed.xml`，并用 `feedLanguage` 提供默认语言回退。
- **多语言 `404.html`：** 根目录 `404.html` 与 `500.html` 默认排除；若站点额外生成了子语言错误页（如 `zh/404.html`、`en/404.html`），请将 `'**/404.html'` 加入 `excludePatterns`（并声明 `noindex`）避免进入发现产物，同时保留根目录 `dist/404.html` 以防止静态托管平台返回软 404。
- **构建后脚本执行顺序：** 先执行 `astro build`（在 `astro:build:done` 钩子内运行 `vite-plugin-geo/astro`）-> 再执行自定义后处理脚本（若改用 CLI 执行 `vite-plugin-geo generate`，请放在会修改 HTML 的后处理脚本之后）-> 最后在 CI 末尾运行 `vite-plugin-geo verify`，确保校验覆盖最终落盘的 `dist/` 产物。

### 静态托管平台 `Content-Type` 响应头配置（`_headers` 与 `vercel.json`）

许多静态托管平台默认将 `.md` 返回为无 `charset=utf-8` 的 `text/plain`（或 `application/octet-stream`），或未为 `feed.xml` 设置 `application/rss+xml; charset=utf-8`。在启用 `X-Content-Type-Options: nosniff` 或站点包含非 ASCII（如中文）内容时，可能导致浏览器、RSS 阅读器或 AI 客户端乱码或拒绝解析。

**Cloudflare Pages / Netlify（`public/_headers`）：**

```text
/*.md
  Content-Type: text/markdown; charset=utf-8

/feed.xml
  Content-Type: application/rss+xml; charset=utf-8
```

在 Cloudflare Pages 中，`*` 可跨 `/` 匹配，因此 `/*.md` 会覆盖 `/zh/about.md` 等嵌套路径；在 Netlify 或开启 `feedByLocale: true` 时，如果平台按单级路径匹配 `*`，请补充对应的目录规则（例如 `/docs/*.md`、`/zh/*.md` 与 `/zh/feed.xml`）。

**Vercel（`vercel.json`）：**

```json
{
  "headers": [
    {
      "source": "/(.*)\\.md$",
      "headers": [
        { "key": "Content-Type", "value": "text/markdown; charset=utf-8" }
      ]
    },
    {
      "source": "/feed.xml",
      "headers": [
        { "key": "Content-Type", "value": "application/rss+xml; charset=utf-8" }
      ]
    }
  ]
}
```

若启用 `feedByLocale: true` 生成 `/zh/feed.xml` 等分语言订阅源，可补充 `"source": "/:locale/feed.xml"` 的 `Content-Type: application/rss+xml; charset=utf-8` 规则。

### 部署注意事项

- **防范托管平台软 404：** Cloudflare Pages 等静态平台仅在构建根目录存在 `404.html` 时才对未知路径返回真实 `404`，否则会返回 `200` 加首页内容。请确保产物包含 `404.html`，并在 CI 中接入 `vite-plugin-geo verify`。
- **避免与 `closeBundle` 写 Sitemap 的插件混用：** 本插件在 `generateBundle` 阶段输出产物，无法阻止其他插件在后续 `closeBundle` 钩子中覆盖文件；建议在 CI 中运行 `verify` 兜底校验。

## 规范契约与边界

公开规范审核快照日期：`2026-08-12`。

| 文件或机制 | 规范状态 | 本项目实现边界 |
|---|---|---|
| [`llms.txt` v2](https://llmstxt.org/)（[变更记录](https://llmstxt.org/changes.html)） | 社区开放提案，不是 IETF/W3C 标准 | 单一路径作用域索引、[RFC 8288](https://www.rfc-editor.org/rfc/rfc8288) / [IANA](https://www.iana.org/assignments/link-relations/link-relations.xhtml) `describedby` 与 Markdown `alternate` 链接、`<main>` / `<article>` 正文镜像 |
| [`robots.txt`（RFC 9309）](https://www.rfc-editor.org/rfc/rfc9309) | IETF Standards Track | 固定根路径 `/robots.txt`、手写文件保护、控制字符与 500 KiB 校验 |
| [Sitemap 0.9](https://www.sitemaps.org/protocol.html) | 行业协议，不是 IETF/W3C 标准 | 标准 URL 集、`hreflang`、50,000 URL / 50 MiB 自动分片，省略被搜索引擎忽略的 `priority` 与 `changefreq` |
| [RSS 2.0.11](https://www.rssboard.org/rss-specification) | 稳定公开规范 | RSS 2.0、Atom `self` link、规范 URL 稳定 `<guid>`，无可靠时间时省略条目 `pubDate` |
| [`humans.txt`](https://humanstxt.org/Standard.html) | 社区非正式约定 | 可选生成，仅写入可验证信息 |
| [SKU.md `1.0.0-beta`](https://sku.md/spec/1.0.0-beta/sku-md-spec.md)（[变更记录](https://sku.md/spec/1.0.0-beta/changelog.md)） | 实验性社区提案 | 可选生成根目录纯 Markdown 目录清单（上限 65,536 UTF-8 字节） |

### URL 与镜像路径解析规则

| 模式 | 输入 HTML | 公开页面 URL 路径 | Markdown 镜像 |
|---|---|---|---|
| `prettyUrls: true`、`trailingSlash: 'never'`（默认） | `about.html` 或 `about/index.html` | `/about` | `/about.md` |
| `prettyUrls: true`、`trailingSlash: 'always'` | `about.html` 或 `about/index.html` | `/about/` | `/about.md` |
| `prettyUrls: true`、`trailingSlash: 'preserve'` | `docs/index.html` | 与页面 `<link rel="canonical">` 的尾部斜杠一致 | `/docs.md` |
| `prettyUrls: false` | `about.html` | `/about.html` | `/about.html.md`（`append`）/ `/about.md`（`replace`） |
| 首页 | `index.html` | `/`（始终保留；`'always'` 下 `routeBasePath` 根路径为 `/docs/`） | `/index.md` |

### 已审核但不生成的提案

| 提案或机制 | 审核结论 |
|---|---|
| [IETF AIPREF](https://datatracker.ietf.org/group/aipref/) | 词汇表仍处于草案阶段（`draft-ietf-aipref-vocab-06`），尚未成为正式 RFC。 |
| [Cloudflare Content Signals](https://developers.cloudflare.com/bots/additional-configurations/managed-robots-txt/) | 特定平台扩展指令，并非通用 IETF 标准。 |
| [W3C TDM Reservation Protocol](https://www.w3.org/community/reports/tdmrep/CG-FINAL-tdmrep-20240510/) | W3C Community Group Final Report，不是 W3C Recommendation。 |
| `ai.txt` | 零散社区草案，缺乏稳定的跨平台部署共识。 |
| [Shopify `agents.md`](https://shopify.dev/changelog/customize-llmstxt-llms-fulltxt-and-agentsmd) | Shopify 店面专属约定，不适合作为通用 Vite 站点默认产物。 |
| [WebMCP Draft Community Group Report](https://webmachinelearning.github.io/webmcp/) | 浏览器运行时 API 草案，不属于静态构建产物。 |

## 参与贡献

欢迎通过 [GitHub Issues](https://github.com/maxlee/vite-plugin-geo/issues) 与 Pull Requests 参与共建。

仓库目录结构：

```text
vite-plugin-geo/
├── src/        # 运行时入口、核心生成管线、诊断/校验与 .d.ts 类型声明
├── tests/      # 单元测试与 Vite 7/8、Astro 7 真实构建集成测试
├── scripts/    # Vite Registry 元数据与真实消费者安装校验脚本
└── .github/    # GitHub Actions CI 工作流
```

本地开发使用 [Bun](https://bun.sh/) 运行测试套件，并使用 Node.js（`^20.19.0 || >=22.12.0`）执行真实消费者兼容性矩阵：

```bash
# 安装依赖
bun install

# 运行完整测试与覆盖率
bun test
bun test --coverage

# 校验 Vite Plugin Registry 扩展元数据 Schema
bun run verify:registry-metadata

# 使用打包产物验证 Vite 7/8、Astro 7 与 Vite+ 1.x 真实项目安装构建（含 TypeScript 类型检查）
bun run verify:consumers

# 预览 npm 发包文件清单
npm run pack:dry-run
```

提交信息请遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/) 规范（如 `feat:`、`fix:`、`docs:`、`test:`、`chore:`），并在提交前运行 `git diff --check` 确保无尾随空白。

## 更新日志

各版本详细变更与迁移指南请参阅 [CHANGELOG.md](./CHANGELOG.md)。

## 开源协议

[MIT](./LICENSE) © maxlee
