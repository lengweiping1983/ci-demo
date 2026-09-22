import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { atomicWriteJson, currentCommit, isRootAgentControlPath, sha256 } from './trust-core.mjs';

function normalizeProjectPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}

export function isDurableRootAgentPath(value) {
  const normalized = normalizeProjectPath(value);
  if (!isRootAgentControlPath(normalized)) return false;
  if (normalized === '.rootagent/runtime' || normalized.startsWith('.rootagent/runtime/')) return false;
  if (/^\.rootagent\/improvement\/(engines|candidates|experiments)(\/|$)/.test(normalized)) return false;
  return !normalized.split('/').some(part => part.includes('.tmp.'));
}

function isAuditSealManifestPath(value) {
  const normalized = normalizeProjectPath(value);
  return normalized.startsWith('.rootagent/audit/seals/') && normalized.endsWith('.json');
}

function isReceiptPath(value) {
  const normalized = normalizeProjectPath(value);
  return normalized.startsWith('.rootagent/receipts/') && normalized.endsWith('.json');
}

function auditError(code, message, data = {}) {
  const error = new Error(message);
  error.code = code;
  error.data = data;
  return error;
}

function gitStatusRecords(cwd) {
  const output = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], {
    cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return output.split('\0').filter(Boolean).map(line => ({
    status: line.slice(0, 2),
    path: normalizeProjectPath(line.slice(3)),
  }));
}

function rawCommitPaths(cwd, commit) {
  return execFileSync('git', ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit, '--'], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
  }).split('\n').filter(Boolean).map(normalizeProjectPath).sort();
}

// Merge commits need -m: without it git diff-tree may emit no paths at all and falsely
// classify a merge that introduced .rootagent state as a pure Product Commit.
function commitControlPathsAcrossParents(cwd, commit) {
  try {
    const output = execFileSync('git', ['diff-tree', '-m', '--root', '--no-commit-id', '--name-only', '-r', commit, '--'], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return [...new Set(output.split('\n').filter(Boolean).map(normalizeProjectPath).filter(isRootAgentControlPath))].sort();
  } catch {
    return [];
  }
}

function samePaths(a, b) {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

function verifyManifestDigest(manifest) {
  const claimed = manifest?.digest;
  const unsigned = { ...manifest };
  delete unsigned.digest;
  return typeof claimed === 'string' && claimed === sha256(unsigned);
}

function readCommitJson(cwd, commit, rel, code) {
  try {
    return JSON.parse(execFileSync('git', ['show', `${commit}:${rel}`], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch (error) {
    throw auditError(code, `无法读取 ${rel}：${error.message}`, { path: rel });
  }
}

function verifyReceiptDigest(receipt) {
  const claimed = receipt?.digest;
  const unsigned = { ...receipt };
  delete unsigned.digest;
  return typeof claimed === 'string' && claimed === sha256(unsigned);
}

function commitResolvable(cwd, commit) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/i.test(commit)) return false;
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function auditSealState(cwd) {
  try {
    const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (inside !== 'true') return { ready: false, code: 'AUDIT_GIT_REQUIRED', paths: [], blockers: [] };
  } catch {
    return { ready: false, code: 'AUDIT_GIT_REQUIRED', paths: [], blockers: [] };
  }

  const changed = [...new Set(gitStatusRecords(cwd).map(record => record.path))].sort();
  const productPaths = changed.filter(value => !isRootAgentControlPath(value));
  if (productPaths.length) return { ready: false, code: 'AUDIT_PRODUCT_DIRTY', paths: [], blockers: productPaths };

  const ephemeralPaths = changed.filter(value => isRootAgentControlPath(value) && !isDurableRootAgentPath(value));
  if (ephemeralPaths.length) return { ready: false, code: 'AUDIT_EPHEMERAL_DIRTY', paths: [], blockers: ephemeralPaths };

  const durablePaths = changed.filter(isDurableRootAgentPath);
  if (!durablePaths.length) return { ready: false, code: 'AUDIT_NOTHING_TO_SEAL', paths: [], blockers: [] };

  const parentHead = currentCommit(cwd);
  const parentControlPaths = parentHead ? commitControlPathsAcrossParents(cwd, parentHead) : [];
  if (parentControlPaths.length) return { ready: false, code: 'AUDIT_PARENT_NOT_PRODUCT_COMMIT', paths: [], blockers: parentControlPaths };

  return { ready: true, code: 'READY', paths: durablePaths, blockers: [] };
}

export function createAuditSeal(cwd, metadata = {}) {
  const state = auditSealState(cwd);
  if (!state.ready) {
    const messages = {
      AUDIT_GIT_REQUIRED: 'Audit Seal 要求 Git 工作树',
      AUDIT_PARENT_NOT_PRODUCT_COMMIT: 'Audit Seal 的父提交必须是纯 Product Commit',
      AUDIT_PRODUCT_DIRTY: '存在未提交产品修改，拒绝 Audit Seal',
      AUDIT_EPHEMERAL_DIRTY: 'runtime/tmp 等临时控制状态不得进入 Audit Seal',
      AUDIT_NOTHING_TO_SEAL: '没有待提交的 durable .rootagent 状态',
    };
    throw auditError(state.code, messages[state.code] || state.code, { paths: state.blockers });
  }

  const parentHead = currentCommit(cwd);
  let durablePaths = [...state.paths];
  const pendingSeals = durablePaths.filter(isAuditSealManifestPath);
  if (pendingSeals.length > 1) {
    throw auditError('AUDIT_PENDING_SEAL_CONFLICT', '存在多个未提交 Audit Seal manifest，拒绝猜测', { paths: pendingSeals });
  }

  let manifestRel;
  let manifest;
  if (pendingSeals.length === 1) {
    manifestRel = pendingSeals[0];
    manifest = JSON.parse(fs.readFileSync(path.join(cwd, manifestRel), 'utf-8'));
    if (!verifyManifestDigest(manifest)) {
      throw auditError('AUDIT_PENDING_SEAL_CORRUPT', '待提交 Audit Seal manifest 摘要无效', { path: manifestRel });
    }
    if (manifest.parentHead !== parentHead) {
      throw auditError('AUDIT_PENDING_SEAL_STALE', '待提交 Audit Seal 已不再绑定当前 HEAD', {
        path: manifestRel, expected: parentHead, actual: manifest.parentHead,
      });
    }
    if (!samePaths(manifest.paths || [], durablePaths)) {
      throw auditError('AUDIT_PENDING_SEAL_STALE', '待提交 Audit Seal 与当前 durable 变更集合不一致', {
        path: manifestRel, expectedPaths: durablePaths, manifestPaths: manifest.paths || [],
      });
    }
  } else {
    const sealId = `seal_${crypto.randomUUID()}`;
    manifestRel = `.rootagent/audit/seals/${sealId}.json`;
    durablePaths = [...new Set([...durablePaths, manifestRel])].sort();
    manifest = {
      schemaVersion: 1,
      sealId,
      parentHead,
      taskId: metadata.taskId || null,
      taskStatus: metadata.taskStatus || null,
      stateRevision: Number.isInteger(metadata.stateRevision) ? metadata.stateRevision : null,
      attemptId: metadata.attemptId || null,
      fencingToken: metadata.fencingToken ?? null,
      candidateDigest: metadata.candidateDigest || null,
      receiptDigest: metadata.receiptDigest || null,
      paths: durablePaths,
      createdAt: new Date().toISOString(),
    };
    manifest.digest = sha256(manifest);
    atomicWriteJson(path.join(cwd, manifestRel), manifest);
  }

  execFileSync('git', ['add', '-A', '--', ...durablePaths], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stagedPaths = execFileSync('git', ['diff', '--cached', '--name-only', '-z', '--'], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
  }).split('\0').filter(Boolean).map(normalizeProjectPath).sort();

  const invalidStaged = stagedPaths.filter(value => !isDurableRootAgentPath(value));
  if (invalidStaged.length) {
    throw auditError('AUDIT_STAGE_CONTAMINATED', 'Git index 含非 durable RootAgent 路径，拒绝 Audit Seal', { paths: invalidStaged });
  }
  if (!samePaths(stagedPaths, manifest.paths || [])) {
    throw auditError('AUDIT_STAGE_MISMATCH', 'Audit Seal 暂存集合与 manifest 不一致', {
      stagedPaths, manifestPaths: manifest.paths || [],
    });
  }

  const label = metadata.taskId || 'control';
  execFileSync('git', ['commit', '-m', `chore(rootagent): seal ${label} audit state`], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  });

  const auditCommit = currentCommit(cwd);
  const actualParent = execFileSync('git', ['rev-parse', `${auditCommit}^`], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const committedPaths = rawCommitPaths(cwd, auditCommit);

  if (actualParent !== parentHead || !samePaths(committedPaths, manifest.paths || [])) {
    throw auditError('AUDIT_COMMIT_MISMATCH', '已创建的 Audit Seal commit 与 manifest 不一致', {
      auditCommit, parentHead, actualParent, committedPaths, manifestPaths: manifest.paths || [],
    });
  }

  return { auditCommit, parentHead, manifestPath: manifestRel, manifestDigest: manifest.digest, paths: committedPaths };
}

export function verifyAuditSeal(cwd, commit = 'HEAD') {
  let auditCommit;
  try {
    auditCommit = execFileSync('git', ['rev-parse', commit], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw auditError('AUDIT_COMMIT_NOT_FOUND', `找不到 Audit Seal commit：${commit}`);
  }

  let parentHead;
  try {
    parentHead = execFileSync('git', ['rev-parse', `${auditCommit}^`], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw auditError('AUDIT_PARENT_MISSING', 'Audit Seal commit 必须有父提交');
  }

  const committedPaths = rawCommitPaths(cwd, auditCommit);
  const invalid = committedPaths.filter(value => !isDurableRootAgentPath(value));
  if (invalid.length) {
    throw auditError('AUDIT_COMMIT_CONTAMINATED', 'Audit Seal commit 混入产品或临时路径', { paths: invalid });
  }

  const manifests = committedPaths.filter(isAuditSealManifestPath);
  if (manifests.length !== 1) {
    throw auditError('AUDIT_MANIFEST_COUNT', 'Audit Seal commit 必须且只能包含一个 seal manifest', { manifests });
  }

  const manifest = readCommitJson(cwd, auditCommit, manifests[0], 'AUDIT_MANIFEST_INVALID');

  if (!verifyManifestDigest(manifest)) throw auditError('AUDIT_MANIFEST_CORRUPT', 'Audit Seal manifest 摘要无效');
  if (manifest.parentHead !== parentHead) {
    throw auditError('AUDIT_PARENT_MISMATCH', 'Audit Seal manifest parentHead 与 Git 父提交不一致', {
      expected: parentHead, actual: manifest.parentHead,
    });
  }
  if (!samePaths(manifest.paths || [], committedPaths)) {
    throw auditError('AUDIT_PATH_MISMATCH', 'Audit Seal manifest 路径集合与 commit 不一致', {
      committedPaths, manifestPaths: manifest.paths || [],
    });
  }

  const receiptPaths = committedPaths.filter(isReceiptPath);
  let receiptPath = null;
  let receiptDigest = null;
  let portability = {
    status: 'NOT_APPLICABLE',
    code: 'AUDIT_RECEIPT_NOT_REQUIRED',
    baseCommit: null,
    baseCommitResolved: null,
    productCommit: parentHead,
  };

  if (manifest.receiptDigest) {
    const receipts = receiptPaths.map(rel => ({ rel, receipt: readCommitJson(cwd, auditCommit, rel, 'AUDIT_RECEIPT_INVALID') }));
    const matches = receipts.filter(({ receipt }) => receipt?.digest === manifest.receiptDigest);
    if (matches.length !== 1) {
      throw auditError('AUDIT_RECEIPT_COUNT', 'Audit Seal 必须且只能包含一个与 manifest 绑定的 Receipt', {
        receiptDigest: manifest.receiptDigest, receiptPaths,
      });
    }

    const selected = matches[0];
    const receipt = selected.receipt;
    if (!verifyReceiptDigest(receipt)) {
      throw auditError('AUDIT_RECEIPT_CORRUPT', 'Audit Seal Receipt 摘要无效', { path: selected.rel });
    }
    if (receipt.taskId !== manifest.taskId || receipt.candidate?.digest !== manifest.candidateDigest) {
      throw auditError('AUDIT_RECEIPT_SUBJECT_MISMATCH', 'Audit Seal Receipt 与 manifest 的任务或 Candidate 不一致', {
        path: selected.rel,
        expectedTaskId: manifest.taskId,
        actualTaskId: receipt.taskId,
        expectedCandidateDigest: manifest.candidateDigest,
        actualCandidateDigest: receipt.candidate?.digest || null,
      });
    }
    if (receipt.candidate?.commit !== parentHead) {
      throw auditError('AUDIT_RECEIPT_PRODUCT_MISMATCH', 'Audit Seal Receipt candidate.commit 与 Product 父提交不一致', {
        path: selected.rel, expected: parentHead, actual: receipt.candidate?.commit || null,
      });
    }

    const baseCommit = receipt.candidate?.baseCommit || null;
    const baseCommitResolved = commitResolvable(cwd, baseCommit);
    receiptPath = selected.rel;
    receiptDigest = receipt.digest;
    portability = {
      status: baseCommitResolved ? 'PORTABLE' : 'LIMITED',
      code: baseCommitResolved ? 'AUDIT_HISTORY_COMPLETE' : 'AUDIT_BASE_COMMIT_UNRESOLVED',
      baseCommit,
      baseCommitResolved,
      productCommit: parentHead,
    };
  } else if (receiptPaths.length) {
    throw auditError('AUDIT_RECEIPT_UNEXPECTED', 'Audit Seal 包含 Receipt，但 manifest 未声明 receiptDigest', { receiptPaths });
  }

  return {
    auditCommit,
    parentHead,
    manifestPath: manifests[0],
    manifestDigest: manifest.digest,
    receiptPath,
    receiptDigest,
    portability,
    manifest,
    paths: committedPaths,
  };
}
