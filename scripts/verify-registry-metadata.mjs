import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function loadSchema(uri) {
  const response = await fetch(uri, {
    headers: {
      accept: 'application/schema+json, application/json',
      'user-agent': 'vite-plugin-geo-release-verifier',
    },
  });
  if (response.status !== 200) {
    throw new Error(`Schema request failed with HTTP ${response.status}: ${uri}`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Schema response was not JSON: ${uri}`);
  }
}

export async function verifyRegistryMetadata() {
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, 'package.json'), 'utf-8'),
  );
  const ajv = new Ajv({
    allErrors: true,
    loadSchema,
    strict: false,
  });
  addFormats(ajv);
  const validate = await ajv.compileAsync(await loadSchema(manifest.$schema));
  if (!validate(manifest)) {
    throw new Error(
      `package.json does not satisfy the Vite Registry schema:\n${ajv.errorsText(validate.errors, { separator: '\n' })}`,
    );
  }
  return {
    schema: manifest.$schema,
    package: `${manifest.name}@${manifest.version}`,
    compatiblePackages: manifest.compatiblePackages,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    console.log(JSON.stringify(await verifyRegistryMetadata(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
