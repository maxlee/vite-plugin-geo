# 🌍 vite-plugin-geo

一个面向 Vite 与 Astro 静态站点的构建后插件，自动生成 Sitemap、robots.txt、RSS、llms.txt 和页面 Markdown 镜像。

当前版本：`vite-plugin-geo@0.2.0`。支持 Vite 7 / 8，Node.js 要求 `^20.19.0 || >=22.12.0`。Astro 7 是可选 Astro peer，纯 Vite 项目无需安装 Astro。

> 这些文件用于机器发现和抓取提示，不证明任何搜索引擎、AI 产品或模型会读取、采用、索引或优先展示内容，也不承诺排名、收录或转化效果。

## ✨ 核心特性

- 🗺️ **Sitemap** — 自动生成 URL 集，超过 50,000 URL 或大小限制时自动拆分；兼容 Astro 官方 Sitemap
- 🤖 **robots.txt** — 根路径生成、通用自定义指令、控制字符与 500 KiB 限制校验
- 📰 **RSS 2.0** — 自动注入 discovery link，包含 Atom self link 和稳定 GUID
- 🧠 **llms.txt v2** — 页面 Markdown 发现关系、单路径作用域，以及 append / replace 两种镜像命名
- 📄 **Markdown 镜像** — 保留已有有效 alternate，只为缺失页面生成镜像
- 🌐 **多语言支持** — Sitemap hreflang 映射
- 👥 **humans.txt** — 可选生成，只输出可确认信息
- 🛍️ **SKU.md** — 可选生成 `1.0.0-beta` 纯 Markdown 根清单
- 🔎 **构建诊断** — 默认在终端提示静态页面问题与改进建议，默认不中断构建，可按需设置 CI 门禁；另有 `verify` 子命令校验最终产物
- 🧱 **统一行为** — Vite、Astro 和 CLI 共用同一套校验、规划与写入规则

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

`domain` 必须是完整的 HTTP(S) 站点源，只能包含协议、主机和可选端口，例如 `https://example.com`。不能包含账号、路径、查询参数或片段；子路径部署统一使用 `routeBasePath` 表达。

也可以把站点源写在项目 `package.json` 的 `domain` 字段中；如果两处都配置，`geo({ domain })` 优先。如果两处都没有配置，插件会停止生成，避免产出错误的公开链接。

### Astro 项目

Astro 正式支持以下两种方式，二选一，不能同时配置。

#### 方式一：Astro 原生集成

Astro 在内部 Vite 构建结束后才生成最终 HTML，因此不要把默认入口放入 `vite.plugins`。请使用 Astro 专用入口：

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import geo from 'vite-plugin-geo/astro';

export default defineConfig({
  site: 'https://example.com',
  integrations: [geo()],
});
```

域名读取顺序为显式 `geo({ domain })`、Astro `site`、`package.json.domain`。通常已经配置 `site` 时无需重复填写 `domain`。

#### 方式二：构建后串联 CLI

```json
{
  "domain": "https://example.com",
  "scripts": {
    "build": "astro build && vite-plugin-geo generate"
  }
}
```

CLI 默认扫描 `dist/`。如果域名只配置在 Astro `site` 中，CLI 不会读取它，需要追加 `--domain https://example.com`。自定义输出目录使用 `--dist-dir <path>`。

默认构建结果：

```text
dist/
├── sitemap.xml
├── robots.txt
├── feed.xml
├── llms.txt
├── index.md
└── ...其他页面.md
```

## 📄 输出文件

| 文件 | 默认 | 说明 |
|---|---:|---|
| `sitemap.xml` | ✅ | 50,000 URL 或配置大小超限时拆分并生成索引 |
| `robots.txt` | 自动 | 默认保留已有手写文件；无文件时根作用域生成，非根作用域关闭；始终位于站点根目录 |
| `feed.xml` | ✅ | RSS 2.0 订阅源，并向 HTML 注入 discovery link |
| `llms.txt` | ✅ | 当前单一作用域的 llms.txt v2 内容索引 |
| `*.md` | ✅ | 基于公开 pagePath 的 Markdown 镜像，默认 append，可改为 replace 风格 |
| `humans.txt` | ❌ | 可确认的团队、版权和技术信息 |
| `sku.md` | ❌ | SKU.md `1.0.0-beta` 根目录发现清单 |
| `sitemap_index.xml` | 🔀 | Sitemap 超限时按配置自动生成 |

0.1.4 不再生成 `llms-full.md`、`llms-ctx.txt` 或 `llms-ctx-full.txt`。

## ⚙️ 配置项

| 选项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `domain` | `string` | `package.json.domain` | 无凭据、路径、查询或片段的 HTTP(S) 站点源 |
| `distDir` | `string` | Vite `build.outDir` | 构建输出目录 |
| `routeBasePath` | `string` | Vite / Astro base | 单一公开路径作用域 |
| `prettyUrls` | `boolean` | `true` | 页面公开 URL 是否移除 `.html` |
| `lastmodStrategy` | `'none' \| 'file-mtime' \| 'build' \| 'git'` | `'none'` | Sitemap 与 RSS 条目时间来源 |
| `excludePatterns` | `string[]` | `['404.html', '500.html']` | 排除页面规则 |
| `hreflang` | `Record<string, string>` | — | Sitemap 全局多语言映射 |
| `hreflangFromHtml` | `boolean` | `false` | 从每页 HTML 的 `rel="alternate"` + `hreflang` 声明生成 sitemap `xhtml:link`；未声明的页面回退到 `hreflang` |
| `generateSitemap` | `boolean` | 自动 | 检测到已有 Sitemap 时默认关闭 |
| `sitemapConflict` | `'preserve' \| 'error' \| 'overwrite'` | 自动 | 检测到外部 Sitemap 时的处理策略；未设置且自动模式时保留并告警 |
| `sitemapUrl` | `string` | 自动 | robots.txt / llms.txt 引用的 Sitemap 地址 |
| `routeConflict` | `'error' \| 'first' \| 'last'` | `'error'` | 多个 HTML 映射到同一公开路由时抛错或确定性选择 |
| `llmsMdMirror` | `boolean` | `true` | 是否为缺少 alternate 的页面生成 Markdown 镜像 |
| `llmsMdMirrorStyle` | `'append' \| 'replace'` | `'append'` | 公开路径派生镜像：`about` 均生成 `about.md`；`prettyUrls: false` 时 append 为 `about.html.md`、replace 为 `about.md` |
| `llmsClassify` | `function` | 自动 | 自定义 llms.txt 页面分区 |
| `llmsSections` | `Record<string, string \| string[]>` | 自动 | 按路径片段配置 llms.txt 分区 |
| `generateRobots` | `boolean` | 自动 | 默认保留已有手写文件，否则按作用域生成；显式 `true` 与手写文件冲突时失败 |
| `robotsDirectives` | `string[]` | `[]` | 通用 robots.txt 自定义指令 |
| `generateFeed` | `boolean` | `true` | RSS 订阅源开关 |
| `generateHumans` | `boolean` | `false` | humans.txt 开关 |
| `skuMd` | `SkuMdOptions` | — | SKU.md 根清单配置 |
| `audit` | `boolean` | `true` | 构建诊断；关闭后跳过额外检查 |
| `auditFailOn` | `'warning' \| 'advice'` | 关闭 | 诊断达到该严重级别时使构建失败；未设置时永不失败 |
| `debug` | `boolean` | `false` | 输出最终配置、sitemap 决策、镜像与产物摘要 |

<details>
<summary>📋 查看完整配置项</summary>

| 选项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `stripPathPrefixes` | `string[]` | `['src/pages/']` | 计算公开 URL 时剥离的源码路径前缀 |
| `sourceHtmlDir` | `string` | `'src/pages'` | `file-mtime` 与 Git 时间解析使用的源码 HTML 目录 |
| `packageJsonPath` | `string \| false` | `'./package.json'` | 项目元数据路径；`false` 表示不读取 |
| `sitemapIndex` | `boolean` | `true` | 是否允许自动拆分 Sitemap |
| `sitemapMaxBytes` | `number` | `52428800` | 单个未压缩 Sitemap 的字节上限，不能超过 50 MiB |
| `lastmodIgnore` | `string[]` | `[]` | 跳过 lastmod 解析的 glob（匹配相对路径或公开 pagePath） |
| `lastmodResolver` | `function` | — | 仅插件 API：`(page) => Date \| string \| null \| undefined`，`null` 省略 lastmod，`undefined` 继续按策略解析 |
| `skuMd.merchantName` | `string` | 首页真实标题 | 商户名称；无法可靠推导时构建失败 |
| `skuMd.summary` | `string` | 首页真实描述 | 商户摘要；无法可靠推导时构建失败 |
| `skuMd.catalog` | `{ label; url }[]` | 必填 | 至少一个同源 HTTPS 目录链接 |

</details>

旧配置键不会被忽略或兼容映射。`llmsFull`、`llmsCtx`、`llmsCtxFull`、`blockGoogleExtended`、三个 `stability*` 选项，以及 SKU.md 的 `catalogUrl`、`contentLanguage`、`market` 都会明确报错。

## Astro 官方 Sitemap 兼容

如果 Astro 项目已经使用 `@astrojs/sitemap`，请把 `sitemap()` 放在 `geo()` 前面：

```js
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import geo from 'vite-plugin-geo/astro';

export default defineConfig({
  site: 'https://example.com',
  integrations: [sitemap(), geo()],
});
```

插件在 Astro 的最终构建阶段检查真实 Sitemap 产物：

- 检测到外部 Sitemap 时默认保留，并打印文件名、来源、loc 数量、前 3 条样例与判定原因；
- 继续生成 llms.txt、robots.txt、RSS 等已开启文件；
- 让 robots.txt 和 llms.txt 指向实际发现的 Sitemap，包括自定义 `filenameBase`。

需要手动接管时，必须同时声明冲突策略；仅设置 `generateSitemap: true` 会报错并点名疑似第三方 Sitemap：

```js
geo({
  generateSitemap: true,
  sitemapConflict: 'overwrite',
  sitemapUrl: 'sitemap.xml',
})
```

也可以使用 `sitemapConflict: 'error'` 让任何外部 Sitemap 直接失败，或用 `'preserve'` 显式保留。

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
  --lastmod-strategy none \
  --llms-md-mirror-style append \
  --generate-robots

# 使用 JSON 配置文件
vite-plugin-geo generate --config ./geo.config.json

# 构建后校验最终产物（只读 dist）
vite-plugin-geo verify --dist-dir dist --domain https://example.com
vite-plugin-geo verify --dist-dir dist --report json > geo-report.json
vite-plugin-geo verify --dist-dir dist --report sarif --report-file geo.sarif
vite-plugin-geo verify --dist-dir dist --fail-on-verify warning

# 生成后立即校验，并让诊断门禁生效
vite-plugin-geo generate --verify --fail-on-audit warning
```

`verify` 读取最终 `dist`，不受第三方 `closeBundle` 写入时序影响，也不会写入任何文件。它检查：sitemap `<loc>` 数量、首页、中间构建前缀、`.html` 扩展名、重复 loc、loc 与产物文件映射、`robots.txt` 的 `Sitemap:`、canonical、llms.txt、feed.xml 与 Markdown 镜像一致性。Sitemap 索引会递归解析（最多 5 层）。

`--fail-on-verify` 默认 `error`；`--fail-on-verify warning` 把警告也作为硬门禁；`--fail-on-verify none` 只报告。`--report json` 输出带 `schemaVersion: "1.0"` 的机器可读报告，`--report sarif` 输出 SARIF 2.1.0。报告写到 stdout 时，人类可读日志自动转到 stderr，保证 stdout 可直接管道解析。`--report-file` 可改为写入文件。

CI 示例（GitHub Actions）：

```yaml
- run: npm run build
- run: npx vite-plugin-geo verify --dist-dir dist --domain https://example.com --report sarif --report-file geo.sarif --fail-on-verify warning
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: geo.sarif
```

Astro 构建串联请参阅上方“[Astro 项目](#astro-项目)”中的“方式二：构建后串联 CLI”。

<details>
<summary>📖 CLI 详细说明</summary>

`generate` 是默认命令。安装后可以通过 `npx`、`bunx`、npm script 或 `./node_modules/.bin/vite-plugin-geo` 运行。

| 参数 | 说明 |
|---|---|
| `--domain <url>` | 站点源，优先于 `package.json.domain` |
| `--dist-dir <path>` | 构建输出目录，默认 `dist` |
| `--route-base-path <path>` | URL 单一作用域前缀 |
| `--source-html-dir <path>` | 源码 HTML 目录 |
| `--package-json-path <path>` | package.json 路径；也支持 `--package-json-path=false` |
| `--strip-path-prefixes <list>` | 逗号分隔的路径前缀 |
| `--exclude-patterns <list>` | 逗号分隔的排除规则 |
| `--lastmod-strategy <value>` | `none`、`file-mtime`、`build` 或 `git` |
| `--lastmod-ignore <list>` | 逗号分隔的 lastmod 跳过规则 |
| `--llms-md-mirror-style <value>` | `append` 或 `replace` |
| `--robots-directives <list>` | 逗号分隔的通用 robots 指令 |
| `--sitemap-url <path-or-url>` | robots.txt / llms.txt 引用的 Sitemap 地址 |
| `--sitemap-conflict <mode>` | `preserve`、`error` 或 `overwrite` |
| `--route-conflict <mode>` | `error`、`first` 或 `last` |
| `--hreflang-from-html / --no-hreflang-from-html` | 逐页 hreflang 开关 |
| `--fail-on-audit <level>` | `none`、`warning` 或 `advice`，默认 `none` |
| `--fail-on-verify <level>` | `none`、`error` 或 `warning`，默认 `error` |
| `--report <json\|sarif>` | 输出机器可读报告 |
| `--report-file <path>` | 报告写入文件（默认 stdout） |
| `--verify` | `generate` 完成后立即运行 verify |
| `--pretty-urls / --no-pretty-urls` | URL 模式开关 |
| `--sitemap-index / --no-sitemap-index` | Sitemap 自动拆分开关 |
| `--generate-sitemap / --no-generate-sitemap` | Sitemap 生成开关 |
| `--generate-robots / --no-generate-robots` | robots.txt 生成开关 |
| `--llms-md-mirror / --no-llms-md-mirror` | Markdown 镜像开关 |
| `--generate-feed / --no-generate-feed` | RSS 开关 |
| `--generate-humans / --no-generate-humans` | humans.txt 开关 |
| `--audit / --no-audit` | 构建诊断开关，默认开启；也支持 `--audit=true` / `--audit=false` |
| `--debug / --no-debug` | 调试摘要开关 |
| `--config <path>` | JSON 配置文件路径 |

被删除的旧参数会以 unknown argument 失败。

</details>

## 🔎 构建诊断与门禁（0.2.0）

Vite、Astro 和 CLI 默认开启 `audit: true`。警告与建议直接显示在构建终端，无需开启 `debug`；每项包含页面路径、规则、发现依据和处理建议，按页面路径和规则稳定排序，完整列出发现项。诊断不新增报告文件，不自动修改页面，也不改变现有文件生成默认值。

默认情况下诊断发现不会使构建失败；设置 `auditFailOn: 'warning' | 'advice'`（CLI：`--fail-on-audit`）后，达到阈值的发现会在写入产物前中止构建。原有配置错误、文件冲突和读写失败仍按原有规则处理。

| 检查项 | 提示内容与边界 |
|---|---|
| 标题 | 缺少、空标题、多个标题，以及纳入页面之间重复的标题 |
| 页面描述 | 缺少、空描述或重复描述时给出建议 |
| 页面语言 | `<html lang>` 缺失或语言标签无法识别 |
| 主标题 | H1 缺少或多个时给出内容结构建议，不据此断言排名影响 |
| canonical | 无效地址、互相冲突的声明给出警告；缺失、相对地址、跨域地址给出建议，后两种可能是合法配置 |
| JSON-LD | 只检查 JSON 语法，接受数组与 `@graph`；不验证 Schema.org 语义或富媒体搜索资格 |
| 图片 | 缺少 `alt` 属性；允许装饰图片使用 `alt=""` |
| 首页元数据 | 提醒站点元数据使用了回退值，便于核对标题和描述 |
| 本地引用 | 检查链接、canonical、hreflang 是否指向已知 `noindex` 页面；本地目标缺失时提示“构建产物中未找到，需确认线上路由” |
| `.html` 站内链接 | `prettyUrls` 开启时，指向已知页面却仍以 `.html` 结尾的站内链接 |
| Markdown 镜像路径 | 镜像地址包含 `src/pages/` 等中间前缀，或 pretty URLs 下出现 `x.html.md` 双扩展名 |
| 孤儿页面 | 构建产物中没有任何其他页面静态链接指向的非首页 |
| hreflang 互指 | 页面声明了 hreflang，但目标页面没有指回 |
| hreflang 自引用 | 页面声明了 hreflang，却缺少指向自身的条目 |
| 生成文件与发现链接 | 检查本次生成计划中的引用，以及页面中的 Markdown、llms.txt、RSS 发现链接是否一致 |

基础检查只针对纳入本次生成的页面。引用检查会利用扫描中已知的 `noindex` 页面，但不会对被排除页面进行完整内容诊断。相对地址会结合页面 `<base href>` 和公开路径作用域解析；没有找到静态文件不等于线上 404，动态路由、重写与重定向需在部署环境确认。

canonical 的处理依据 [Google canonical 指南](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)：推荐绝对地址，但相对地址可以解析；跨域 canonical 也可能有合理用途。诊断只提示核对，不把它们一概判为错误。

此功能不发送 HTTP 请求，不验证线上状态码、响应头、CDN 或防火墙，不完整审计第三方 Sitemap/XML，不模拟 robots 匹配引擎；跨站 hreflang 只检查站内目标是否能被解析。

终端示例（同页缺少 `alt` 的图片合并计数）：

```text
[GEO audit] 已检查 1 个页面；0 项警告，1 项建议。仅检查构建产物；第三方 sitemap、robots 规则和线上状态未验证。
[GEO audit] [建议] index.html [image-alt-missing] 1 张图片缺少 alt 属性；提供图片说明；装饰图片可使用空 alt。
```

本地目标查找忽略查询参数和片段；canonical 声明自身的比较保留这些信息，避免将不同查询页面误当成同一首选地址。

关闭诊断：

```js
geo({ domain: 'https://example.com', audit: false })
```

```bash
vite-plugin-geo generate --no-audit
# 等价写法
vite-plugin-geo generate --audit=false
```

将诊断作为 CI 硬门禁：

```js
geo({ domain: 'https://example.com', audit: true, auditFailOn: 'warning' })
```

```bash
vite-plugin-geo generate --fail-on-audit warning --report json --report-file geo.json
```

## 📝 行为契约

审核日期：2026-08-12。该日期表示 v0.1.4 的公开资料审核快照，不代表第三方规范以后不会变化。

| 文件或机制 | 状态 | v0.1.4 处理 |
|---|---|---|
| `llms.txt` v2 | 社区开放提案，不是 IETF/W3C 标准 | 单作用域索引、Markdown alternate 和 describedby 发现链接 |
| `robots.txt` | IETF Standards Track，RFC 9309 | 根文件、通用指令、控制字符和 500 KiB 校验 |
| Sitemap 0.9 | 行业协议，不是 IETF/W3C 标准 | URL 集、hreflang、自动拆分和索引 |
| RSS 2.0.11 | 稳定公开规范，不是 IETF 标准 | RSS 2.0、Atom self link、稳定 GUID |
| `humans.txt` | 社区约定 | 可选生成，仅包含可确认信息 |
| SKU.md `1.0.0-beta` | 实验性社区提案 | 可选生成根目录发现清单 |

### 🔗 URL 生成规则

| 模式 | 输入 | 输出 |
|---|---|---|
| `prettyUrls: true` | `about.html` | `/about` |
| `prettyUrls: true` | `docs/index.html` | `/docs` |
| `prettyUrls: false` | `about.html` | `/about.html` |
| 首页 | `index.html` | `/`（始终） |

`domain` 只表示站点源；所有子路径由 `routeBasePath` 表达。插件先规划并校验全部目标路径，再统一写入。配置或路径冲突，以及需要生成的目标与用户文件冲突，都会在写入前停止，避免留下半成品。默认保留已有手写 robots.txt 是例外：插件跳过该文件的生成，不触发冲突。

### 🧠 llms.txt v2

实现依据：[llms.txt proposal](https://llmstxt.org/)、[变更记录](https://llmstxt.org/changes.html)、[IANA Link Relation Types](https://www.iana.org/assignments/link-relations/link-relations.xhtml)、[RFC 8288 Web Linking](https://www.rfc-editor.org/rfc/rfc8288) 和 [Chrome Lighthouse llms.txt audit](https://developer.chrome.com/docs/lighthouse/agentic-browsing/llms-txt)。

llms.txt v2 是 2026-08-10 更新的社区提案，不是正式 Web 标准。v0.1.4 的约定如下：

- 每个收录页面注入 `rel="describedby" type="text/markdown"`，指向当前作用域的 llms.txt；
- 缺少 Markdown alternate 时生成镜像，并注入 `rel="alternate" type="text/markdown"`；
- 已有有效 Markdown alternate 时保留原标签，在 llms.txt 中采用第一个有效地址，不重复生成镜像；
- 镜像路径由公开 pagePath 派生：pretty URLs 下 `about` → `about.md`；`prettyUrls: false` 时 append 为 `about.html.md`、replace 为 `about.md`；不会出现 `src/pages/` 等中间路径；
- `routeBasePath: '/docs/'` 生成 `/docs/llms.txt`，但不会自动创建更深层作用域；
- `noindex`、404 / 500 和匹配 `excludePatterns` 的页面不注入、不收录；
- 重复执行不追加重复标签，目标路径与手写文件冲突时构建停止。

提案没有标准版本字段，因此生成文件不会写 `version: 2`。`Optional` 只是内容组织约定，没有机器可执行语义。`llmsMdMirror: false` 会关闭自动镜像；已有 alternate 仍会采用，没有 alternate 的页面则使用 HTML URL。

插件只负责静态 HTML 的 `<link>`。HTTP `Link` 响应头属于托管平台或服务器职责，插件不会模拟它。

### 🗺️ Sitemap

实现依据：[Sitemaps protocol](https://www.sitemaps.org/protocol.html) 和 [Google Sitemap 指南](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)。

- 单个 Sitemap 最多 50,000 URL，未压缩大小最多 50 MB；超过限制时生成分片与 Sitemap index；
- 默认 `lastmodStrategy: 'none'`。仅在显式选择 `git`、`file-mtime` 或 `build` 时尝试写入；选定来源无法提供可信单页时间时省略该字段；
- 不生成 `priority` 或 `changefreq`，Google 明确说明会忽略这两个值；
- Sitemap 可以帮助发现 URL，但不保证抓取或索引。

### 🤖 robots 与 noindex 边界

实现依据：[RFC 9309](https://www.rfc-editor.org/rfc/rfc9309)、[Google robots.txt 文档](https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt) 和 [OpenAI crawler 说明](https://developers.openai.com/api/docs/bots)。

- robots.txt 的公开位置始终是站点源的 `/robots.txt`，不能由子路径文件代替；
- 默认检测构建输出中的 robots.txt：已有手写文件时逐字节保留，不合并、不添加标记、不改写 Sitemap 行；终端提示跳过生成，不依赖 `audit` 或 `debug`；
- 没有手写文件时，根作用域默认生成，非根作用域默认关闭；已有插件标记的文件按当前配置更新，仍遵循作用域设置；
- `generateRobots: false` 不生成也不修改已有文件；`generateRobots: true` 与手写文件冲突时，构建在写入前失败，并提示关闭生成或移除重复来源；
- 保留文件时不会应用 `robotsDirectives`，配置了这些指令会明确提示未应用；llms.txt 仍可引用已有的 robots.txt；
- Vite 同时检查 bundle 与实际启用的 `publicDir`；Astro 和 CLI 检查最终输出目录。即使显式开启生成，robots.txt 也仍写到站点根目录；
- 自定义指令含控制字符或生成内容超过 500 KiB 时，构建会失败；
- robots.txt 是抓取提示，不是授权或安全机制，敏感资源仍需身份验证和服务端访问控制；
- 页面过滤读取最终 HTML 中的 robots meta `noindex`；部署后添加的 `X-Robots-Tag` 无法在构建期识别。

Astro 可以把手写文件放在 `public/robots.txt`，并正常使用 `integrations: [sitemap(), geo()]`。插件会保留这份文件。仍在使用 0.1.4 时，可以先显式关闭生成：

```js
integrations: [sitemap(), geo({ generateRobots: false })]
```

该配置仅控制生成，不负责修正手写文件中的 Sitemap 地址。

OpenAI 将 OAI-SearchBot 用于搜索，GPTBot 用于可能进入基础模型训练的抓取，ChatGPT-User 用于用户触发的访问。允许搜索抓取与允许训练抓取是独立选择；用户触发的 ChatGPT-User 访问不属于自动抓取，其访问未必适用 robots.txt。插件不内置厂商快捷开关，请用通用 `robotsDirectives` 分别配置。

robots.txt 表达抓取规则，`noindex` 表达索引意图；抓取被阻止时，机器人可能无法读取页面中的 `noindex`。CDN/WAF、登录和服务器限制决定请求实际能否到达，即使 robots.txt 允许也不代表可访问。构建诊断无法确认这些线上条件。llms.txt、Markdown 镜像和结构化数据也不保证 AI 引用或搜索排名。

### 📰 RSS Link 与时间

实现依据：[RSS 2.0.11 specification](https://www.rssboard.org/rss-specification)。

- 生成 RSS 2.0，并向页面注入 `application/rss+xml` discovery link；
- 已存在的 RSS 或 Atom discovery link 按属性语义识别并替换，重复执行不会注入多份；
- Feed 包含 Atom self link，以页面规范 URL 作为稳定 GUID；
- `lastBuildDate` 表示本次生成时间；没有可信页面时间时省略条目 `pubDate`。

### 👥 humans.txt

实现依据：[humans.txt convention](https://humanstxt.org/Standard.html)。它是非正式社区约定。文件只包含明确配置或可从 `package.json`、构建过程可靠推导的信息，不写 `TODO`、示例联系人或猜测的技术栈。

### 🛍️ SKU.md 1.0.0-beta

实现依据：[SKU.md 1.0.0-beta specification](https://sku.md/spec/1.0.0-beta/sku-md-spec.md) 和 [changelog](https://sku.md/spec/1.0.0-beta/changelog.md)。这是不兼容旧 YAML 草案的实验性纯 Markdown 格式。

- 固定生成到站点根路径 `/sku.md`，不支持非根 `routeBasePath`；
- 包含 `1.0.0-beta` 版本行、一个商户标题与摘要、Website、Catalog，以及至少一个同源 HTTPS 目录链接；
- 总大小不超过 65,536 UTF-8 字节，单行不超过 8,192 字节；
- `merchantName` 和 `summary` 可从首页真实元数据推导，否则构建失败；`catalog` 必须明确提供且非空；
- 只声明目录入口，不生成商品知识文档，也不声明价格、库存、税费、配送、支付、交易或结账能力。

## 💡 常见配置

### 基础配置

```js
geo({
  domain: 'https://example.com',
  distDir: 'dist',
  packageJsonPath: './package.json',
})
```

### 子路径与 replace 镜像

```js
geo({
  domain: 'https://example.com',
  routeBasePath: '/docs/',
  llmsMdMirrorStyle: 'replace',
  generateRobots: false,
})
```

此配置生成 `/docs/llms.txt` 与 `about.md` 风格镜像。非根作用域默认不生成 robots.txt；示例显式写出该选择，便于审阅。

### 多语言站点

```js
geo({
  domain: 'https://example.com',
  hreflang: {
    en: 'https://example.com/{path}',
    'zh-CN': 'https://example.com/zh/{path}',
    'x-default': 'https://example.com/{path}',
  },
})
```

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

如果省略 `merchantName` 或 `summary`，插件只会采用首页真实 `title` 和 description；无法可靠推导时停止构建，不会编造内容。

## 🔭 已审核但不生成

| 提案或机制 | 审核结论 |
|---|---|
| [IETF AIPREF](https://datatracker.ietf.org/group/aipref/) | 截至审核日，词汇表仍是 `draft-ietf-aipref-vocab-06`，HTTP 关联草案已过期；尚未成为 RFC |
| [Cloudflare Content Signals](https://developers.cloudflare.com/bots/additional-configurations/managed-robots-txt/) | 平台特定实现；`content-use` 仍标为测试功能，不是通用 IETF Content-Usage 标准 |
| [W3C TDM Reservation Protocol](https://www.w3.org/community/reports/tdmrep/CG-FINAL-tdmrep-20240510/) | W3C Community Group Final Report，不是 W3C Recommendation |
| `ai.txt` | 个别 Internet-Draft / 社区方案，没有稳定的通用部署约定 |
| [Shopify `agents.md`](https://shopify.dev/changelog/customize-llmstxt-llms-fulltxt-and-agentsmd) | Shopify 店面约定，不应扩展为所有 Vite 网站的默认文件 |
| [WebMCP Draft Community Group Report](https://webmachinelearning.github.io/webmcp/) | 浏览器运行时工具 API，不是静态规范文件，也不是 W3C 标准或标准轨道文档 |

v0.1.4 不会生成以上文件，也不会把它们映射成 robots.txt 或 llms.txt 的别名。

## 🆕 0.2.0 发布说明

这是一次有意的破坏性版本：修正会静默产出错误站点的默认行为，并提供把结果当作 CI 门禁的能力。

**迁移要点**

1. **Markdown 镜像改用公开路径**：pretty URLs 下 `about.html` 的镜像由 `about.html.md` 变为 `about.md`；首页镜像统一为 `index.md`。生成文件、`llms.txt` 链接和注入的 alternate 使用同一个解析器。若已部署旧镜像，请同步更新外部引用。
2. **重复路由默认抛错**：多个 HTML 映射到同一公开地址时构建失败并列出冲突文件。需要保留旧行为时显式设置 `routeConflict: 'first'` 或 `'last'`，构建会打印保留的文件。
3. **绝对 URL 的 Vite/Astro `base` 抛错**：`base: 'https://cdn.example.com/'` 之类不再被拼成 `/https:/...`；请显式设置 `routeBasePath`。
4. **外部 Sitemap 冲突默认保留并告警**：检测到第三方 Sitemap 时会打印文件名、来源、loc 数量与前 3 条样例。需要接管时设置 `sitemapConflict: 'overwrite'`；显式 `generateSitemap: true` 且未设置策略时会报错并点名“疑似由其他插件生成”。
5. **审计仍默认不失败**：只有设置 `auditFailOn` / `--fail-on-audit` 才会阻断构建。

**新增能力**

- `vite-plugin-geo verify`：只读最终 `dist`，校验 Sitemap、robots、canonical、llms.txt、feed 与 Markdown 镜像的一致性；
- `--report json|sarif`：JSON 报告带 `schemaVersion: "1.0"`，另提供 SARIF 2.1.0；
- `--fail-on-audit`、`--fail-on-verify`、`--verify`：覆盖生成与校验的 CI 门禁；
- `hreflangFromHtml`：逐页读取 HTML alternate 并生成 sitemap `xhtml:link`，自动补自引用，不虚构 `x-default`；
- `lastmodIgnore`、`lastmodResolver`：跳过生成页并支持项目自定义时间；Git 缺失告警聚合为一条；
- 新审计规则：`.html` 站内链接、镜像路径、孤儿页面、hreflang 互指与自引用；
- `debug: true` 输出最终 `siteUrl`、`routeBasePath`、页面/排除原因、Sitemap 决策、镜像与产物摘要；
- `public/` 中的受管文件与 Sitemap 现在参与冲突检测。

**部署检查清单**

- 主机软 404：Cloudflare Pages 只有在产物根目录存在 `404.html` 时才对未知路径返回真实 404，否则回退为 `200 + 首页`，会把坏 Sitemap 中的每条 URL 伪装成首页副本。请确认构建产物包含 `404.html`，或用 `verify` 校验 loc 与产物映射。
- 不要与任何在 `closeBundle` 中写 Sitemap 的插件共存；`geo` 在 `generateBundle` 写入后无法阻止后续覆盖。`verify` 是唯一不受该时序影响的安全网，建议放入 CI。
- 多 output、`build.ssr`、`build.lib`、`--watch` 与可复现构建时间（`SOURCE_DATE_EPOCH` / feed 过滤）尚未覆盖，计划在 0.3.0 处理。

## 🆕 0.1.5 发布说明

- 修复已有手写 robots.txt 导致默认 Astro 构建失败：默认保留已有文件，显式生成冲突继续保护用户文件；

- 新增默认开启的静态构建诊断，Vite、Astro 与 CLI 使用相同规则；
- 唯一新增公共选项为 `audit?: boolean`，默认 `true`，支持 CLI `--audit`、`--no-audit`、`--audit=true|false`；
- 终端完整显示警告和建议，包含路径、规则、依据与建议，无需 `debug`；诊断发现不会使构建失败；
- 关闭诊断会跳过额外检查；不自动修复、不生成 JSON 报告、不改变输出默认值；
- 消费者安装验证从本包清单读取预期版本，避免版本升级遗漏校验脚本；
- 更新开发工具链的安全修复版本及锁文件，运行时依赖保持不变。

## 🆕 0.1.4 发布说明

- 完整实现 llms.txt v2 的 HTML 发现关系、单路径作用域和 append / replace 镜像；
- 删除三类旧 llms 扩展文件与对应配置；
- Sitemap 默认不写 `lastmod`，并删除 `priority`、`changefreq`；
- 新增独立 `generateRobots` 开关，非根作用域默认不生成 robots.txt；
- RSS 增加 Atom self link 和稳定 GUID，不再编造条目时间；
- SKU.md 从旧 YAML 草案切换到 `1.0.0-beta` 纯 Markdown 根清单；
- 删除 `blockGoogleExtended`、三个 `stability*` 选项及旧 SKU.md 配置，不提供兼容层。

发布前应在本地完成完整测试、覆盖率、消费者矩阵、注册表元数据、打包清单、依赖安全和差异格式检查。发布、推送和部署必须另行取得明确批准。

默认导出和现有命名导出均可使用：

```js
import geo, { createGeoGeneratorPlugin } from 'vite-plugin-geo';
```
