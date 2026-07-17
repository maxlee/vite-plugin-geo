# 🌍 vite-plugin-geo

一个强大的 Vite 构建后插件，自动生成 GEO / SEO / AI 友好文件，让你的网站对搜索引擎、LLM 和用户都更友好。

当前版本：`vite-plugin-geo@0.1.1`。支持 Vite 5 / 6 / 7 / 8；在 Vite 8 中会检测 Rolldown 环境，并优先通过 `generateBundle` 输出新增静态文件。Astro 项目请使用专用的 `vite-plugin-geo/astro` 入口。

## ✨ 核心特性

- 🗺️ **sitemap.xml** — 自动生成搜索引擎索引，支持超过 50,000 URL 自动拆分；Astro 官方 sitemap 会自动兼容
- 🤖 **robots.txt** — 灵活的爬虫策略配置
- 📰 **feed.xml** — RSS/Atom 订阅源，自动注入 link 标签到所有 HTML
- 📝 **llms.txt** — 为 LLM 提供结构化内容入口
- 📄 **Markdown 镜像** — 每个 HTML 页面自动生成 `.md` 版本
- 🌐 **多语言支持** — hreflang 多语言站点映射
- ⚡ **零配置开箱** — 合理的默认值，无需繁琐配置

## 📦 安装

```bash
npm i -D vite-plugin-geo
```

```bash
yarn add -D vite-plugin-geo
```

```bash
bun add -d vite-plugin-geo
```

## 🚀 快速开始

### Vite 项目

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

`domain` 是站点公开访问地址，用于生成 sitemap、robots.txt、feed.xml 和 llms.txt 中的完整 URL。也可以把它写在项目 `package.json` 的 `domain` 字段中；如果两处都配置，`geo({ domain })` 优先。
如果两处都没有配置，插件会停止生成并提示补充 `domain`，避免产出错误的公开链接。

### Astro 项目

Astro 在内部 Vite 构建结束后才生成最终 HTML，因此不要把默认入口放进 `vite.plugins`。请使用 Astro 专用入口，并放进 `integrations`：

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import geo from 'vite-plugin-geo/astro';

export default defineConfig({
  site: 'https://example.com',
  integrations: [geo()],
});
```

Astro 集成会在静态页面全部生成后创建 GEO 文件。域名读取顺序为 `geo({ domain })`、Astro `site`、`package.json` 的 `domain`；通常已经配置 `site` 时无需重复填写 `domain`。

如果仍然在 `vite.plugins` 中使用默认入口，构建只会显示一次迁移提示，不会继续无效等待 `dist/` 中尚未生成的 HTML。

构建完成后，`dist/` 目录下会自动生成：

```
dist/
├── sitemap.xml
├── robots.txt
├── feed.xml
├── llms.txt
└── *.html.md  (每个 HTML 对应的 Markdown 镜像)
```

## 📄 输出文件

| 文件 | 默认 | 说明 |
|------|------|------|
| `sitemap.xml` | ✅ | 搜索引擎索引 |
| `robots.txt` | ✅ | 爬虫策略 |
| `feed.xml` | ✅ | RSS 订阅 + 自动注入 RSS/Atom link 标签 |
| `llms.txt` | ✅ | LLM 内容入口 |
| `*.html.md` | ✅ | 页面 Markdown 镜像 |
| `llms-full.md` | ❌ | 全站 Markdown 聚合 |
| `llms-ctx.txt` | ❌ | 不含 Optional 的 LLM 扩展上下文 |
| `llms-ctx-full.txt` | ❌ | 含 Optional 的 LLM 扩展上下文 |
| `humans.txt` | ❌ | 团队/技术信息 |
| `sitemap_index.xml` | 🔀 | URL 超过 50,000 时自动生成 |

## ⚙️ 配置项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `domain` | `string` | `package.json.domain` | 站点公开地址，插件配置优先 |
| `distDir` | `string` | Vite `build.outDir` | 构建输出目录 |
| `routeBasePath` | `string` | Vite `config.base` | URL 路径前缀 |
| `prettyUrls` | `boolean` | `true` | 无扩展名页面 URL |
| `lastmodStrategy` | `'file-mtime' \| 'build' \| 'git'` | `'file-mtime'` | 时间策略 |
| `excludePatterns` | `string[]` | `['404.html', '500.html']` | 排除规则 |
| `hreflang` | `Record<string, string>` | — | 多语言映射 |
| `generateSitemap` | `boolean` | 自动 | sitemap 生成开关，检测到 Astro 官方 sitemap 时自动关闭 |
| `sitemapUrl` | `string` | 自动 | robots.txt / llms.txt 引用的 sitemap 地址 |
| `llmsMdMirror` | `boolean` | `true` | Markdown 镜像 |
| `llmsFull` | `boolean` | `false` | 全站 Markdown |
| `llmsCtx` | `boolean` | `false` | 生成 `llms-ctx.txt` |
| `llmsCtxFull` | `boolean` | `false` | 生成 `llms-ctx-full.txt` |
| `llmsClassify` | `function` | 自动 | 自定义 llms.txt 分区 |
| `llmsSections` | `object` | 自动 | 按路径片段自定义 llms.txt 分区 |
| `generateFeed` | `boolean` | `true` | RSS 订阅 |
| `generateHumans` | `boolean` | `false` | humans.txt |
| `debug` | `boolean` | `false` | 调试日志 |

`distDir` 和三个 `stability*` 选项只用于普通 Vite 插件。Astro 集成始终使用 Astro 提供的最终输出目录，不需要等待配置。

<details>
<summary>📋 查看完整配置项</summary>

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `stripPathPrefixes` | `string[]` | `['src/pages/']` | URL 剥离前缀 |
| `sourceHtmlDir` | `string` | `'src/pages'` | 源码 HTML 目录 |
| `stabilityWaitMs` | `number` | `1500` | 文件稳定等待 |
| `stabilityPollIntervalMs` | `number` | `100` | 轮询间隔 |
| `stabilityRounds` | `number` | `2` | 稳定轮次 |
| `packageJsonPath` | `string \| false` | `'./package.json'` | 读取 `domain` 和团队信息 |
| `sitemapIndex` | `boolean` | `true` | 自动拆分 sitemap |
| `sitemapMaxBytes` | `number` | `52428800` | 单个 sitemap 未压缩大小上限 |
| `blockGoogleExtended` | `boolean` | `false` | 屏蔽 Google-Extended |
| `robotsDirectives` | `string[]` | `[]` | 自定义 robots 指令 |

</details>

## Astro 官方 Sitemap 兼容

如果 Astro 项目已经使用 `@astrojs/sitemap`，继续把两项集成都放在 `integrations` 中即可。`vite-plugin-geo` 会自动检测标准的 Astro sitemap 用法，并做三件事：

```js
import sitemap from '@astrojs/sitemap';
import geo from 'vite-plugin-geo/astro';

export default defineConfig({
  site: 'https://example.com',
  integrations: [sitemap(), geo()],
});
```

- 不再生成自己的 `sitemap.xml`
- 继续生成 `llms.txt`、`robots.txt`、`feed.xml` 等 GEO 文件
- 自动让 `robots.txt` 和 `llms.txt` 指向 Astro 官方入口 `sitemap-index.xml`

如果 Astro 配置中写了静态 `filenameBase`，例如：

```js
sitemap({
  filenameBase: 'site-map',
})
```

插件会自动引用 `site-map-index.xml`。

需要手动覆盖时，可以使用：

```js
geo({
  generateSitemap: true,
  sitemapUrl: 'sitemap.xml',
})
```

## 🔧 CLI 命令

除了 Vite 插件，也可以独立运行：

```bash
# 通过包管理器
npx vite-plugin-geo generate
bunx vite-plugin-geo generate

# 常用参数
vite-plugin-geo generate \
  --domain https://example.com \
  --dist-dir dist \
  --source-html-dir src/pages \
  --lastmod-strategy file-mtime \
  --no-generate-humans

# 使用配置文件
vite-plugin-geo generate --config ./geo.config.json
```

<details>
<summary>📖 CLI 详细说明</summary>

**本地调试（仓库内）：**

```bash
node packages/vite-plugin-geo/cli.js generate
```

**安装后使用：**

```bash
./node_modules/.bin/vite-plugin-geo generate
```

说明：
- 普通终端里，本地安装的包不会自动加入系统 PATH
- 在 npm script、`node_modules/.bin` 已进 PATH 的终端，或通过 `npx` / `yarn` / `bunx` 执行时，可以直接用命令名
- `generate` 是默认命令，`distDir` 默认是 `dist`

**支持的参数：**

| 参数 | 说明 |
|------|------|
| `--domain <url>` | 站点公开地址，优先于 `package.json.domain` |
| `--dist-dir <path>` | 构建输出目录 |
| `--route-base-path <path>` | URL 路径前缀 |
| `--source-html-dir <path>` | 源码 HTML 目录 |
| `--lastmod-strategy <value>` | 时间策略：`file-mtime`、`build` 或 `git` |
| `--sitemap-url <path-or-url>` | robots.txt / llms.txt 引用的 sitemap 地址 |
| `--pretty-urls / --no-pretty-urls` | URL 模式开关 |
| `--generate-sitemap / --no-generate-sitemap` | sitemap 生成开关 |
| `--llms-ctx / --no-llms-ctx` | llms-ctx.txt 生成开关 |
| `--llms-ctx-full / --no-llms-ctx-full` | llms-ctx-full.txt 生成开关 |
| `--generate-feed / --no-generate-feed` | RSS 生成开关 |
| `--generate-humans / --no-generate-humans` | humans.txt 开关 |
| `--config <path>` | JSON 配置文件路径 |

</details>

## 📝 行为契约

### 🔗 URL 生成规则

| 模式 | 输入 | 输出 |
|------|------|------|
| `prettyUrls: true` | `about.html` | `/about` |
| `prettyUrls: true` | `docs/index.html` | `/docs` |
| `prettyUrls: false` | `about.html` | `/about.html` |
| 首页 | `index.html` | `/` (始终) |

### 📰 RSS/Atom Link 注入

- 自动检测 feed 格式（RSS 2.0 / Atom）
- 根据格式注入正确的 MIME 类型
- 已存在的 link 标签会自动替换

### 🕐 时间来源

默认优先级：源码 HTML mtime → dist HTML mtime → 构建时间。

如果使用 `lastmodStrategy: 'git'`，插件会先读取对应文件的最新 Git 提交时间；如果当前目录不是 Git 仓库，或文件没有提交记录，会自动回到文件修改时间。

### 🧠 llms.txt 结构

`llms.txt` 按 llmstxt.org 提案生成：

- H1 使用站点名
- blockquote 使用站点描述
- 页面链接按 `Docs`、`Examples`、`API` 自动分区
- `Optional` 分区放 sitemap 和 robots.txt 等可跳过链接
- 默认链接到 `.html.md` Markdown mirror，便于 LLM 读取

需要自定义分区时：

```js
geo({
  domain: 'https://example.com',
  llmsSections: {
    Guides: ['guide', 'learn'],
    API: ['api', 'reference'],
  },
})
```

也可以用 `llmsClassify(page)` 完全接管分类。

## 💡 常见配置

### 基础配置

```js
geo({
  domain: 'https://example.com',
  distDir: 'dist',
  packageJsonPath: './package.json',
})
```

### 多语言站点

```js
geo({
  domain: 'https://example.com',
  hreflang: {
    en: 'https://example.com/{path}',
    'zh-CN': 'https://example.com/zh/{path}',
  },
})
```

### 完整功能

```js
geo({
  domain: 'https://example.com',
  prettyUrls: true,
  generateFeed: true,
  generateHumans: true,
  llmsFull: true,
})
```

### 兼容旧写法

旧版本文档中的命名导出仍然可用：

```js
import { createGeoGeneratorPlugin } from 'vite-plugin-geo';
```

新项目建议使用默认导出的 `geo()`。
