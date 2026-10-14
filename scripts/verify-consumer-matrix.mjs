import { spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASTRO_RELEASES,
  VITE_RELEASES,
  assertGeneratedCoreFiles,
} from './consumer-matrix-contract.mjs';

const EXPECTED_DOMAIN = 'https://example.test/';
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const expectedPluginVersion = JSON.parse(
  await readFile(join(repositoryRoot, 'package.json'), 'utf-8'),
).version;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    if (options.capture) {
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(
        `${command} ${args.join(' ')} exited with ${code}${stderr ? `\n${stderr}` : ''}`,
      ));
    });
  });
}

async function installFixture(root, dependencies) {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({
      name: 'vite-plugin-geo-consumer',
      private: true,
      type: 'module',
      dependencies,
    }, null, 2)}\n`,
    'utf-8',
  );
  await run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        npm_config_ignore_scripts: 'true',
      },
    },
  );
}

async function readInstalledManifest(root, packageName) {
  return JSON.parse(
    await readFile(join(root, 'node_modules', packageName, 'package.json'), 'utf-8'),
  );
}

async function readInstalledVersion(root, packageName) {
  return (await readInstalledManifest(root, packageName)).version;
}

async function verifyViteRelease(root, tarballPath, viteVersion) {
  await installFixture(root, {
    vite: viteVersion,
    'vite-plugin-geo': `file:${tarballPath}`,
  });
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><html lang="en"><head><title>GEO Vite consumer</title><meta name="description" content="Consumer matrix"></head><body><h1>Home</h1><a href="/about.html">About</a></body></html>',
    'utf-8',
  );
  await writeFile(
    join(root, 'about.html'),
    '<!doctype html><html lang="en"><head><title>About GEO</title><meta name="description" content="About consumer matrix"></head><body><h1>About</h1></body></html>',
    'utf-8',
  );
  await writeFile(
    join(root, 'vite.config.mjs'),
    `import { defineConfig } from 'vite';\nimport { geo } from 'vite-plugin-geo';\nexport default defineConfig({ plugins: [geo({ domain: '${EXPECTED_DOMAIN}' })], build: { rollupOptions: { input: ['index.html', 'about.html'] } } });\n`,
    'utf-8',
  );

  const installedVite = await readInstalledVersion(root, 'vite');
  const installedGeo = await readInstalledVersion(root, 'vite-plugin-geo');
  if (installedVite !== viteVersion || installedGeo !== expectedPluginVersion) {
    throw new Error(
      `Unexpected Vite fixture versions: vite=${installedVite}, geo=${installedGeo}`,
    );
  }

  await run(
    process.execPath,
    [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'],
    { cwd: root },
  );
  assertGeneratedCoreFiles(join(root, 'dist'), EXPECTED_DOMAIN);
}

async function verifyAstroRelease(root, tarballPath, astroVersion) {
  const viteVersion = astroVersion === '7.0.0' ? '8.0.0' : '8.2.1';
  await installFixture(root, {
    astro: astroVersion,
    vite: viteVersion,
    'vite-plugin-geo': `file:${tarballPath}`,
  });
  await mkdir(join(root, 'src', 'pages'), { recursive: true });
  await writeFile(
    join(root, 'src', 'pages', 'index.astro'),
    '<html lang="en"><head><title>GEO Astro consumer</title><meta name="description" content="Consumer matrix"></head><body><h1>Home</h1><a href="/about/">About</a></body></html>',
    'utf-8',
  );
  await writeFile(
    join(root, 'src', 'pages', 'about.astro'),
    '<html lang="en"><head><title>About GEO</title><meta name="description" content="About consumer matrix"></head><body><h1>About</h1></body></html>',
    'utf-8',
  );
  await writeFile(
    join(root, 'astro.config.mjs'),
    `import { defineConfig } from 'astro/config';\nimport geo from 'vite-plugin-geo/astro';\nexport default defineConfig({ site: '${EXPECTED_DOMAIN}', integrations: [geo({ llmsMdMirror: false, generateFeed: false })] });\n`,
    'utf-8',
  );

  const installedAstro = await readInstalledVersion(root, 'astro');
  const installedVite = await readInstalledVersion(root, 'vite');
  const installedGeo = await readInstalledVersion(root, 'vite-plugin-geo');
  if (
    installedAstro !== astroVersion
    || installedVite !== viteVersion
    || installedGeo !== expectedPluginVersion
  ) {
    throw new Error(
      `Unexpected Astro fixture versions: astro=${installedAstro}, vite=${installedVite}, geo=${installedGeo}`,
    );
  }

  await run(
    process.execPath,
    [
      join(
        root,
        'node_modules',
        'astro',
        (await readInstalledManifest(root, 'astro')).bin.astro,
      ),
      'build',
    ],
    { cwd: root },
  );
  assertGeneratedCoreFiles(join(root, 'dist'), EXPECTED_DOMAIN);
}

async function packRelease(tempRoot) {
  const packDir = join(tempRoot, 'package');
  await mkdir(packDir, { recursive: true });
  const result = await run(
    'npm',
    ['pack', '--json', '--pack-destination', packDir],
    {
      cwd: repositoryRoot,
      capture: true,
      env: {
        ...process.env,
        npm_config_cache: join(tempRoot, 'npm-cache'),
      },
    },
  );
  const parsed = JSON.parse(result.stdout);
  const packResult = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  return {
    tarballPath: join(packDir, packResult.filename),
    packResult,
  };
}

export async function verifyConsumerMatrix() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'vite-plugin-geo-consumers-'));
  try {
    const { tarballPath, packResult } = await packRelease(tempRoot);
    for (const viteVersion of VITE_RELEASES) {
      await verifyViteRelease(
        join(tempRoot, `vite-${viteVersion}`),
        tarballPath,
        viteVersion,
      );
    }
    for (const astroVersion of ASTRO_RELEASES) {
      await verifyAstroRelease(
        join(tempRoot, `astro-${astroVersion}`),
        tarballPath,
        astroVersion,
      );
    }
    return {
      package: `${packResult.name}@${packResult.version}`,
      integrity: packResult.integrity,
      vite: [...VITE_RELEASES],
      astro: [...ASTRO_RELEASES],
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await verifyConsumerMatrix();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
