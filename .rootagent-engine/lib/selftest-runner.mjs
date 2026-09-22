#!/usr/bin/env node
// 并行执行彼此使用独立沙箱的测试套件；只向调用方返回结构化结果。
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

function runtimePath() {
  const execDir = path.dirname(process.execPath);
  const normalizedExecDir = path.normalize(execDir);
  const parentEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const sameRuntimeDir = entry => {
    const normalized = path.normalize(entry);
    return process.platform === 'win32'
      ? normalized.toLowerCase() === normalizedExecDir.toLowerCase()
      : normalized === normalizedExecDir;
  };
  return [execDir, ...parentEntries.filter(entry => !sameRuntimeDir(entry))].join(path.delimiter);
}

function suiteEnvironment(tempHome, parentMode) {
  const env = {
    PATH: runtimePath(), HOME: tempHome,
    TMPDIR: path.join(tempHome, 'tmp'), TEMP: path.join(tempHome, 'tmp'), TMP: path.join(tempHome, 'tmp'),
    ROOTAGENT_VALIDATE: '1', ROOTAGENT_SELFTEST_PARENT: parentMode,
  };
  for (const key of ['LANG', 'LC_ALL']) if (process.env[key] != null) env[key] = process.env[key];
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('ROOTAGENT_') || key === 'TRACEPARENT' || key === 'RA_RED') env[key] = String(value);
  }
  env.ROOTAGENT_SELFTEST_PARENT = parentMode;
  return env;
}

function runSuite(cwd, file, timeoutMs, parentMode) {
  return new Promise(resolve => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rootagent-selftest-'));
    fs.mkdirSync(path.join(tempHome, 'tmp'));
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(cwd, 'tests', file)], {
      cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: suiteEnvironment(tempHome, parentMode),
    });
    let output = ''; let finished = false; let timedOut = false;
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const finish = code => {
      if (finished) return; finished = true; clearTimeout(timer);
      try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* OS 最终回收 */ }
      resolve({ file, code: Number.isInteger(code) ? code : (timedOut ? 124 : 70), output, timedOut, durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.once('error', error => { output += String(error?.stack || error); finish(70); });
    child.once('close', code => finish(code));
  });
}

export async function runSelftestSuites({ cwd, files, timeoutMs, workers, parentMode }) {
  const results = new Array(files.length); let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const index = cursor++;
      results[index] = await runSuite(cwd, files[index], timeoutMs, parentMode);
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, files.length) }, () => worker()));
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const input = JSON.parse(process.argv[2] || '{}');
    const results = await runSelftestSuites(input);
    process.stdout.write(`${JSON.stringify({ ok: true, results })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.stack || error) })}\n`);
    process.exitCode = 70;
  }
}
