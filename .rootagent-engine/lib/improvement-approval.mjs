import os from 'os';
import fs from 'fs';
import path from 'path';
import { atomicWriteJson, readJson, sha256 } from './trust-core.mjs';
import { requireThat, seal, verify } from './improvement-evidence.mjs';
const file = (cwd, sessionId, digest) => path.join(os.homedir(), '.rootagent', 'trust', 'improvement', sha256(fs.realpathSync(cwd)), sessionId, digest + '.json');
// Only the interactive CLI exposes issuance. Host role outputs never issue this record.
// Like existing `review --approve`, operator authentication belongs to the host/OS.
export function grantImprovementApproval(cwd, sessionId, candidateDigest, issuer) {
  requireThat(/^[a-zA-Z0-9_-]+$/.test(sessionId) && /^[a-f0-9]{64}$/.test(candidateDigest) && typeof issuer === 'string' && issuer.trim(), 'IMPROVE_APPROVAL_INVALID', 'Session, full Candidate digest and human issuer required');
  const record = seal({ schemaVersion: 1, kind: 'HUMAN_CLI', project: fs.realpathSync(cwd), sessionId, candidateDigest, issuer, at: new Date().toISOString() });
  atomicWriteJson(file(cwd, sessionId, candidateDigest), record); return record;
}
export function hasImprovementApproval(cwd, sessionId, candidateDigest) {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId || '') || !/^[a-f0-9]{64}$/.test(candidateDigest || '')) return false;
  const record = readJson(file(cwd, sessionId, candidateDigest)); if (!record) return false;
  verify(record);
  return record.kind === 'HUMAN_CLI' && record.project === fs.realpathSync(cwd) && record.sessionId === sessionId && record.candidateDigest === candidateDigest;
}
