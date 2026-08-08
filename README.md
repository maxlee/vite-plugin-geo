# 🌍 vite-plugin-geo

一个强大的 Vite 构建后插件，自动生成 GEO / SEO / AI 友好文件，让你的网站对搜索引擎、LLM 和用户都更友好。

当前版本：`vite-plugin-geo@0.1.3`。支持 Vite 7 / 8，Node.js 要求 `^20.19.0 || >=22.12.0`。Vite 插件只在最终资源阶段生成文件；Astro 项目正式支持两种方式：使用专用的 `vite-plugin-geo/astro` 原生集成，或在构建后串联 `astro build && vite-plugin-geo generate`。Astro 7 以可选 Astro peer 声明，因此纯 Vite 项目不需要安装 Astro。

## ✨ 核心特性

- 🗺️ **sitemap.xml** — 自动生成搜索引擎索引，支持超过 50,000 URL 自动拆分；Astro 官方 sitemap 会自动兼容
- 🤖 **robots.txt** — 灵活的爬虫策略配置
- 📰 **feed.xml** — RSS 2.0 订阅源，自动注入 discovery link 到所有 HTML
- 📝 **llms.txt** — 为 LLM 提供结构化内容入口
- 📄 **Markdown 镜像** — 每个 HTML 页面自动生成 `.md` 版本
- 🌐 **多语言支持** — hreflang 多语言站点映射
- 🛍️ **sku.md** — 可选的实验性商品目录发现清单，默认关闭
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

#### 方式一：Astro 原生集成

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

#### 方式二：构建后串联 CLI

也可以在 Astro 构建完成后运行 `generate`，让 CLI 扫描最终生成的 HTML：

```json
{
  "domain": "https://example.com",
  "scripts": {
    "build": "astro build && vite-plugin-geo generate"
  }
}
```

`generate` 默认读取 `dist/`，并从 `package.json` 的 `domain` 字段获取站点域名。如果域名只配置在 `astro.config.mjs` 的 `site` 中，CLI 不会读取它，需要在构建命令中明确传入：

```json
{
  "scripts": {
    "build": "astro build && vite-plugin-geo generate --domain https://example.com"
  }
}
```

如果修改了 Astro 的输出目录，请追加 `--dist-dir <path>`，让 CLI 读取对应目录。

原生集成和构建后 CLI 串联二选一，不要同时配置，以免重复生成 GEO 文件。

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
| `feed.xml` | ✅ | RSS 2.0 订阅 + 自动注入 discovery link |
| `llms.txt` | ✅ | LLM 内容入口 |
| `*.html.md` | ✅ | 页面 Markdown 镜像 |
| `llms-full.md` | ❌ | 全站 Markdown 聚合 |
| `llms-ctx.txt` | ❌ | 不含 Optional 的 LLM 扩展上下文 |
| `llms-ctx-full.txt` | ❌ | 含 Optional 的 LLM 扩展上下文 |
| `humans.txt` | ❌ | 团队/技术信息 |
| `sku.md` | ❌ | 实验性 SKU.md `manifest-basic` 根清单 |
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
| `skuMd` | `object` | — | 开启实验性 SKU.md 根清单 |
| `debug` | `boolean` | `false` | 调试日志 |

`stabilityWaitMs`、`stabilityPollIntervalMs`、`stabilityRounds` 在 `0.1.2` 中仍可传入，但已经弃用且不再生效。Vite 不再轮询输出目录；Astro 集成始终使用 Astro 提供的最终输出目录。

<details>
<summary>📋 查看完整配置项</summary>

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `stripPathPrefixes` | `string[]` | `['src/pages/']` | URL 剥离前缀 |
| `sourceHtmlDir` | `string` | `'src/pages'` | 源码 HTML 目录 |
| `stabilityWaitMs` | `number` | — | 已弃用，仅兼容旧配置 |
| `stabilityPollIntervalMs` | `number` | — | 已弃用，仅兼容旧配置 |
| `stabilityRounds` | `number` | — | 已弃用，仅兼容旧配置 |
| `packageJsonPath` | `string \| false` | `'./package.json'` | 读取 `domain` 和团队信息 |
| `sitemapIndex` | `boolean` | `true` | 自动拆分 sitemap |
| `sitemapMaxBytes` | `number` | `52428800` | 单个 sitemap 未压缩大小上限 |
| `blockGoogleExtended` | `boolean` | `false` | 屏蔽 Google-Extended |
| `robotsDirectives` | `string[]` | `[]` | 自定义 robots 指令 |

</details>

## Astro 官方 Sitemap 兼容

如果 Astro 项目已经使用 `@astrojs/sitemap`，两项集成都放在 `integrations`，并确保 `sitemap()` 排在 `geo()` 前。`vite-plugin-geo` 不会分析配置源码，而是在自己的构建结束钩子中检查真实 Sitemap 产物：

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
- 自动让 `robots.txt` 和 `llms.txt` 指向实际发现的 Sitemap 文件，包括自定义 `filenameBase`

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

Astro 构建串联请参阅上方“[Astro 项目](#astro-项目)”中的“方式二：构建后串联 CLI”。

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

### 📰 RSS Link 注入

- 固定生成 RSS 2.0，并注入 `application/rss+xml`
- 已存在的 RSS 或 Atom discovery link 会按属性语义识别并替换，不依赖属性顺序
- 重复执行不会插入多个订阅链接

### 🕐 时间来源

默认优先级：源码 HTML mtime → dist HTML mtime → 构建时间。

如果使用 `lastmodStrategy: 'git'`，插件会先读取对应文件的最新 Git 提交时间；如果当前目录不是 Git 仓库，或文件没有提交记录，会自动回到文件修改时间。

### 🤖 robots 与 noindex 边界

`robots.txt` 是抓取提示，不是访问控制。自定义指令含控制字符时构建会失败。页面过滤只读取最终 HTML 中的 robots meta `noindex`；部署服务器后来添加的 `X-Robots-Tag` 无法在构建期识别。`blockGoogleExtended` 只控制 Google-Extended，不影响 Google Search 收录或排名。

### 🧠 llms.txt 结构

`llms.txt` 按 llmstxt.org 提案生成：

- H1 使用站点名
- blockquote 使用站点描述
- 页面链接按 `Docs`、`Examples`、`API` 自动分区
- `Optional` 分区放 sitemap 和 robots.txt 等可跳过链接
- 默认链接到 `.html.md` Markdown mirror，便于 LLM 读取

`llms.txt` 目前是社区提案，不是正式 Web 标准。`llms-ctx.txt`、`llms-ctx-full.txt` 和 `llms-full.md` 是本插件的扩展输出。

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
    'zh-Hans': 'https://example.com/zh-hans/{path}',
    'x-default': 'https://example.com/{path}',
  },
})
```

### 实验性 SKU.md 商品目录清单

```js
geo({
  domain: 'https://shop.example.com',
  skuMd: {
    merchantName: 'Example Store',
    catalogUrl: 'https://shop.example.com/collections/all',
    contentLanguage: 'zh-CN',
    market: 'CN',
  },
})
```

该功能固定生成 `sku.md/1.8-draft` 的 `manifest-basic`，只声明同源 HTTPS 商品目录入口，不联网检查目录，不生成商品文档，也不声明实时价格、库存、交易或结账能力。它是实验性社区提案，不能替代 Product JSON-LD、UCP、ACP 或店铺实时接口。

SKU.md 规范要求文件位于域名根路径 `/sku.md`，因此配置非根 `routeBasePath` 或 Vite `base` 时会直接失败。部署后还需检查：

- `/sku.md` 返回 HTTP 200；
- `Content-Type` 为 `text/markdown; charset=utf-8`；
- 缓存头符合店铺更新频率；
- `catalogUrl` 在公网真实可访问。

实现依据：[SKU.md v1.8 草案](https://sku.md)。截至本版本评审时，该规范仍是实验性提案，不应描述为已被主流平台采用。

## 0.1.3 发布说明

- npm 源码身份固定为 `https://github.com/maxlee/vite-plugin-geo.git`，并分别指向仓库 README 与 Issues。
- Vite Registry 扩展元数据明确声明 Vite 7 / 8 compatible，Rollup 与 Rolldown 保持 unknown。
- Astro 7 作为可选 peer 暴露；Vite、Astro 入口和生成算法保持不变。

## 0.1.2 兼容性说明

- 移除 Vite 5 / 6 支持，支持范围改为 Vite 7 / 8。
- Node.js 最低要求改为 `^20.19.0 || >=22.12.0`；Astro 7 另要求 Node.js 22.12+。
- 任一已启用输出生成或校验失败时，Vite、Astro 和 CLI 都会让整个构建失败，不再保留“部分成功”结果。
- 公开配置名、默认开关和现有输出文件名保持不变；三个 `stability*` 选项仅保留为弃用占位。

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
