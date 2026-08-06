import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(path.join(tmpdir(), 'vite-plugin-geo-consumers-'))

async function install(root, dependencies) {
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...dependencies], {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
  })
}

try {
  const packDirectory = path.join(temporary, 'pack')
  await mkdir(packDirectory)
  const packed = JSON.parse((await run('npm', ['pack', '--json', '--pack-destination', packDirectory], { cwd: repository })).stdout)
  const packResult = Array.isArray(packed) ? packed[0] : packed['vite-plugin-geo']
  if (!packResult?.filename) throw new Error('npm pack did not return a tarball filename')
  const tarball = path.join(packDirectory, packResult.filename)

  const viteRoot = path.join(temporary, 'vite')
  await mkdir(path.join(viteRoot, 'src'), { recursive: true })
  await writeFile(path.join(viteRoot, 'package.json'), '{"name":"geo-vite-consumer","private":true,"type":"module"}\n')
  await writeFile(path.join(viteRoot, 'index.html'), '<div id="app"></div><script type="module" src="/src/main.js"></script>\n')
  await writeFile(path.join(viteRoot, 'src/main.js'), "document.querySelector('#app').textContent = 'vite geo'\n")
  await writeFile(path.join(viteRoot, 'vite.config.mjs'), "import { defineConfig } from 'vite'\nimport { geo } from 'vite-plugin-geo'\nexport default defineConfig({ plugins: [geo({ domain: 'https://example.com' })] })\n")
  await install(viteRoot, ['vite@8.1.5', tarball])
  await run('npx', ['vite', 'build'], { cwd: viteRoot })

  const astroRoot = path.join(temporary, 'astro')
  await mkdir(path.join(astroRoot, 'src/pages'), { recursive: true })
  await writeFile(path.join(astroRoot, 'package.json'), '{"name":"geo-astro-consumer","private":true,"type":"module"}\n')
  await writeFile(path.join(astroRoot, 'src/pages/index.astro'), '<h1>Astro GEO</h1>\n')
  await writeFile(path.join(astroRoot, 'astro.config.mjs'), "import { defineConfig } from 'astro/config'\nimport sitemap from '@astrojs/sitemap'\nimport geo from 'vite-plugin-geo/astro'\nexport default defineConfig({ site: 'https://example.com', integrations: [sitemap(), geo({ domain: 'https://example.com' })] })\n")
  await install(astroRoot, ['astro@7.1.5', '@astrojs/sitemap@3.7.3', tarball])
  await run('npx', ['astro', 'build'], { cwd: astroRoot })

  console.log('Packed vite-plugin-geo consumers: Vite 8 and Astro 7 builds passed.')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
