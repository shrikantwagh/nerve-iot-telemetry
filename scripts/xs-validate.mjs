#!/usr/bin/env node
/**
 * XanoScript validator — drives @xano/developer-mcp directly over stdio.
 *
 * The Xano Developer MCP is registered with the agent, but MCP servers only load at
 * agent startup, so its `xano_validate_xanoscript` tool isn't callable mid-session.
 * That tool is pure local validation (no network, no credentials), so we can spawn the
 * server ourselves and speak JSON-RPC to it — which means every `.xs` file gets checked
 * before it ever reaches the workspace, instead of discovering syntax errors from a
 * failed push.
 *
 * Usage:
 *   node scripts/xs-validate.mjs --tools                  # list what the MCP exposes
 *   node scripts/xs-validate.mjs backend/table/device.xs  # validate specific files
 *   node scripts/xs-validate.mjs --all                    # validate every .xs under backend/
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class McpStdioClient {
  constructor(command, args) {
    this.proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: command === "npx" && process.platform === "win32", // only the npx fallback needs a shell
    });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
    this.proc.on('exit', (code) => {
      for (const [, { reject }] of this.pending) {
        reject(new Error(`MCP server exited (code ${code}). stderr:\n${this.stderr.slice(-2000)}`));
      }
      this.pending.clear();
    });
  }

  /**
   * Newline-delimited JSON framing. The spec also allows Content-Length headers;
   * handle both so we don't break if the server switches framing.
   */
  onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line || line.startsWith('Content-Length:')) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // server log noise on stdout
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    }
  }

  send(method, params) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(payload);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout waiting for '${method}'. stderr:\n${this.stderr.slice(-1500)}`));
        }
      }, 120000);
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async initialize() {
    const result = await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'nerve-xs-validator', version: '1.0.0' },
    });
    this.notify('notifications/initialized', {});
    return result;
  }

  /**
   * Killing the spawned process is not enough on Windows: `npx` runs via a `.cmd`
   * shim, so `proc.kill()` reaps the shell while the actual node grandchild survives
   * and keeps our event loop alive. That made every invocation hang until the caller's
   * timeout — validation finished in seconds but the command took two minutes. So we
   * kill the whole process tree, unref the streams, and (in `main`) exit explicitly.
   */
  close() {
    try {
      this.proc.stdin.end();
    } catch {
      /* already closed */
    }
    try {
      if (process.platform === 'win32' && this.proc.pid) {
        // /T kills the tree, /F forces it. Detached and silenced so it cannot itself
        // become the thing holding the loop open.
        spawn('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], {
          stdio: 'ignore',
          detached: true,
        }).unref();
      } else {
        this.proc.kill('SIGKILL');
      }
    } catch {
      /* already gone */
    }
    try {
      this.proc.stdout?.destroy();
      this.proc.stderr?.destroy();
      this.proc.unref();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Locate the MCP server.
 *
 * `npx -y @xano/developer-mcp` works but re-checks the npm registry on every
 * invocation, which cost ~60s per call — brutal when validating dozens of files. If the
 * package is installed (globally or locally) we run its entry point directly with the
 * current node binary, which starts in well under a second. npx stays as the fallback so
 * a fresh clone still works with no install step.
 */
function resolveServerCommand() {
  const candidates = [
    // npm global prefix on Windows and on POSIX.
    path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@xano', 'developer-mcp', 'dist', 'index.js'),
    path.join(process.env.npm_config_prefix ?? '', 'lib', 'node_modules', '@xano', 'developer-mcp', 'dist', 'index.js'),
    '/usr/local/lib/node_modules/@xano/developer-mcp/dist/index.js',
    // A local devDependency, if someone adds one.
    path.join(ROOT, 'node_modules', '@xano', 'developer-mcp', 'dist', 'index.js'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return [process.execPath, [c]];
  }
  return ['npx', ['-y', '@xano/developer-mcp']];
}

function collectXsFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectXsFiles(full));
    else if (entry.name.endsWith('.xs')) out.push(full);
  }
  return out;
}

/** Pull readable text out of an MCP tool result, whatever shape it uses. */
function resultText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result.content)) {
    return result.content.map((c) => (typeof c === 'string' ? c : c.text ?? JSON.stringify(c))).join('\n');
  }
  if (result.structuredContent) return JSON.stringify(result.structuredContent, null, 2);
  return JSON.stringify(result, null, 2);
}

async function main() {
  const args = process.argv.slice(2);
  const wantTools = args.includes('--tools');
  const wantAll = args.includes('--all');
  const jsonOut = args.includes('--json');
  const files = args.filter((a) => !a.startsWith('--'));

  const client = new McpStdioClient(...resolveServerCommand());
  try {
    const init = await client.initialize();
    const serverName = init?.serverInfo?.name ?? 'unknown';
    const serverVersion = init?.serverInfo?.version ?? '?';
    if (!jsonOut) console.error(`MCP: ${serverName} v${serverVersion}`);

    const toolList = await client.send('tools/list', {});
    const tools = toolList?.tools ?? [];

    if (wantTools) {
      for (const t of tools) {
        console.log(`\n=== ${t.name} ===`);
        console.log(t.description?.slice(0, 600) ?? '(no description)');
        console.log('inputSchema:', JSON.stringify(t.inputSchema, null, 2));
      }
      return;
    }

    // --docs <topic|index> : the MCP ships the authoritative XanoScript reference.
    // Cheaper and more trustworthy than re-deriving syntax from the public docs site.
    const docsIdx = args.indexOf('--docs');
    if (docsIdx !== -1) {
      const topic = args[docsIdx + 1];
      const docTool = tools.find((t) => /xanoscript_docs/.test(t.name));
      if (!docTool) {
        console.error('No docs tool available.');
        process.exitCode = 1;
        return;
      }
      const callArgs = !topic || topic.startsWith('--') ? { mode: 'index' } : { topic };
      const res = await client.send('tools/call', { name: docTool.name, arguments: callArgs });
      console.log(resultText(res));
      return;
    }

    const validator = tools.find((t) => /validate/i.test(t.name));
    if (!validator) {
      console.error(`No validation tool found. Available: ${tools.map((t) => t.name).join(', ')}`);
      process.exitCode = 1;
      return;
    }

    const targets = wantAll ? collectXsFiles(path.join(ROOT, 'backend')) : files;
    if (targets.length === 0) {
      console.error('Nothing to validate. Pass file paths or --all.');
      process.exitCode = 1;
      return;
    }

    // The tool accepts `file_paths` for batch validation — one round trip for the whole
    // tree instead of one per file, and it reports line/column positions.
    const absTargets = targets.map((f) => (path.isAbsolute(f) ? f : path.join(ROOT, f)));
    const missing = absTargets.filter((f) => !fs.existsSync(f));
    for (const m of missing) console.error(`MISSING  ${path.relative(ROOT, m)}`);
    const present = absTargets.filter((f) => fs.existsSync(f));

    const res = await client.send('tools/call', {
      name: validator.name,
      arguments: { file_paths: present },
    });
    const text = resultText(res);

    if (jsonOut) {
      console.log(JSON.stringify({ files: present.map((p) => path.relative(ROOT, p)), isError: res?.isError === true, detail: text }, null, 2));
    } else {
      console.log(text);
      console.log(`\nvalidated ${present.length} file(s)${missing.length ? `, ${missing.length} missing` : ''}`);
    }

    // Fail the process on any reported error so this is usable as a pre-push gate.
    const failed = res?.isError === true || /\b(\d+)\s+(?:file[s]?\s+)?(?:with\s+)?error/i.test(text) || /"valid"\s*:\s*false/i.test(text);
    if (failed || missing.length) process.exitCode = 1;
  } finally {
    client.close();
  }
}

main()
  .catch((err) => {
    console.error(`validator error: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    // Exit explicitly. Even with the tree killed, a lingering stdio handle can keep
    // node alive; the work is done by here, so there is nothing to lose by leaving now.
    // Flush first, or the last lines of output can be dropped on Windows pipes.
    const code = process.exitCode ?? 0;
    const flush = (stream) =>
      new Promise((resolve) => {
        if (stream.writableLength === 0) resolve();
        else stream.write('', () => resolve());
      });
    Promise.all([flush(process.stdout), flush(process.stderr)]).then(() => process.exit(code));
  });
