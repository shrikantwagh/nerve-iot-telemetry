#!/usr/bin/env node
/**
 * Build and deploy the SPA to Xano static hosting.
 *
 * Wraps the three-step CLI lifecycle (create host -> push build -> deploy build to an
 * environment) so a deploy is one reproducible command instead of three with an id
 * copied between them.
 *
 * Deliberate choices:
 *   - We push the PRE-BUILT `static/dist`, not `static/` itself. Xano runs your `build`
 *     script server-side when the pushed directory contains a package.json; pushing the
 *     built output instead keeps the bundle byte-identical to what was tested locally.
 *   - `dev` is the default target. Promoting to `prod` requires an explicit `--prod`,
 *     because that is the URL people may already be looking at.
 *
 * Usage:
 *   node scripts/deploy-web.mjs                      # build + deploy to dev
 *   node scripts/deploy-web.mjs --prod               # build + deploy to prod
 *   node scripts/deploy-web.mjs --skip-build         # reuse the existing dist/
 *   node scripts/deploy-web.mjs --host my-nerve      # non-default host name
 *   node scripts/deploy-web.mjs --api-base https://x.xano.io
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_DIR = path.join(ROOT, 'static');
const DIST_DIR = path.join(STATIC_DIR, 'dist');

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

const HOST = String(arg('host', 'nerve'));
const TO_PROD = Boolean(arg('prod', false));
const SKIP_BUILD = Boolean(arg('skip-build', false));
const API_BASE = arg('api-base', process.env.VITE_XANO_API_BASE);

/** Run a command, streaming output, and return its stdout. Throws on failure. */
function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) {
    throw new Error(`${cmd} exited ${res.status}`);
  }
  return res.stdout ?? '';
}

function xanoAvailable() {
  try {
    execFileSync('xano', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  if (!xanoAvailable()) {
    console.error('The `xano` CLI is not on PATH. Install it with:  npm i -g @xano/cli');
    process.exit(1);
  }

  if (!API_BASE) {
    console.error(
      'No API base configured. Pass --api-base https://<instance>.xano.io, or set\n' +
        'VITE_XANO_API_BASE in the environment or static/.env.\n' +
        'Without it the built bundle falls back to a hardcoded instance, which is almost\n' +
        'certainly not the one you want to ship.'
    );
    process.exit(1);
  }

  if (!SKIP_BUILD) {
    if (!fs.existsSync(path.join(STATIC_DIR, 'node_modules'))) {
      run('npm', ['install'], { cwd: STATIC_DIR });
    }
    run('npm', ['run', 'build'], {
      cwd: STATIC_DIR,
      env: { VITE_XANO_API_BASE: String(API_BASE) },
    });
  }

  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    console.error(`No build found at ${DIST_DIR}. Drop --skip-build, or run the build first.`);
    process.exit(1);
  }

  // Creating a host that already exists is an error, not a no-op, so check first.
  const hosts = (() => {
    try {
      return run('xano', ['static_host', 'list', '-o', 'json']);
    } catch {
      return '';
    }
  })();

  if (!hosts.includes(`"${HOST}"`) && !new RegExp(`\\b${HOST}\\b`).test(hosts)) {
    console.log(`\nHost '${HOST}' not found — creating it.`);
    run('xano', ['static_host', 'create', HOST, '--description', 'Nerve - IoT fleet telemetry']);
  } else {
    console.log(`\nHost '${HOST}' already exists — reusing it.`);
  }

  // Name the build from the current commit, so a deployed URL is traceable to a revision.
  const version = (() => {
    try {
      const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: ROOT,
        encoding: 'utf8',
      }).trim();
      return `git-${sha}`;
    } catch {
      return `build-${process.env.NERVE_BUILD_TAG ?? 'local'}`;
    }
  })();

  const pushOut = run('xano', ['static_host', 'build', 'push', HOST, '-d', './static/dist', '-n', version]);

  // The CLI prints the new build id; grab it rather than making the user copy it across.
  const buildId = pushOut.match(/build[_ ]?id[^0-9]{0,10}(\d+)/i)?.[1] ?? pushOut.match(/\b(\d{2,})\b/)?.[1];

  if (!buildId) {
    console.error(
      '\nBuild pushed, but the build id could not be parsed from the CLI output above.\n' +
        `Find it with:  xano static_host build list ${HOST}\n` +
        `Then deploy:   xano static_host deploy ${HOST} --build_id <id> --env ${TO_PROD ? 'prod' : 'dev'}`
    );
    process.exit(1);
  }

  const env = TO_PROD ? 'prod' : 'dev';
  run('xano', ['static_host', 'deploy', HOST, '--build_id', buildId, '--env', env]);

  console.log(`\nDeployed build ${buildId} (${version}) to ${env}.`);
  console.log(`Read the live URL with:  xano static_host get ${HOST}`);
  console.log(
    'A freshly deployed URL can 404 for a few seconds while the build propagates — that is\n' +
      'not a failed deploy, so give it a moment before retrying.'
  );
  if (!TO_PROD) console.log('\nThis went to dev. Re-run with --prod when you are happy with it.');
}

try {
  main();
} catch (err) {
  console.error(`\nDeploy failed: ${err.message}`);
  process.exit(1);
}
