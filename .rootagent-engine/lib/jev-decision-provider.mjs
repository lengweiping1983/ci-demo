/**
 * RootAgent bounded Jev decision provider.
 *
 * Security model:
 * - Jev only chooses from caller-supplied stable IDs. It never emits shell commands,
 *   paths, selectors, code or state transitions.
 * - API keys are read from process environment and are never persisted.
 * - Quota/billing exhausted keys are remembered only by SHA-256 fingerprint under
 *   .rootagent/runtime so later calls skip them without storing the secret.
 * - Invalid/low-confidence model output fails closed to the caller's deterministic fallback.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const THIS_FILE = fileURLToPath(import.meta.url);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function readJevApiKeys(env = process.env) {
  const raw = env.ROOTAGENT_JEV_API_KEYS || env.TYPESAFE_API_KEYS || env.TYPESAFE_API_KEY || '';
  return unique(String(raw).split(/[\s,;]+/).map(x => x.trim()).filter(Boolean));
}

export function fingerprintJevKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 20);
}

function keyStateFile(cwd) {
  return path.join(cwd, '.rootagent', 'runtime', 'jev-key-state.json');
}

function readKeyState(cwd) {
  const file = keyStateFile(cwd);
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (value?.schemaVersion === 1 && value.disabled && typeof value.disabled === 'object') return value;
  } catch {}
  return { schemaVersion: 1, disabled: {} };
}

function writeKeyState(cwd, state) {
  const file = keyStateFile(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function availableJevKeys(cwd, env = process.env) {
  const state = readKeyState(cwd);
  return readJevApiKeys(env).filter(key => !state.disabled[fingerprintJevKey(key)]);
}

function disableKey(cwd, key, reason, status) {
  const state = readKeyState(cwd);
  const fingerprint = fingerprintJevKey(key);
  state.disabled[fingerprint] = {
    reason,
    status,
    disabledAt: new Date().toISOString(),
  };
  writeKeyState(cwd, state);
  return fingerprint;
}

function quotaExhausted(status) {
  // TypeSafe ecosystem examples treat 402 as billing and 429 as quota.
  return status === 402 || status === 429;
}

function transientProviderFailure(status) {
  return status === 503 || status === 529;
}

function finiteProbability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function validateJevChoice(answer, ids) {
  try {
    const probabilities = answer.probabilities;
    const values = [...Object.values(probabilities), answer.confidence];
    const valid = ids.includes(answer.choice)
      && probabilities && typeof probabilities === 'object'
      && Object.keys(probabilities).length === ids.length
      && ids.every(id => Object.prototype.hasOwnProperty.call(probabilities, id))
      && values.every(finiteProbability)
      && Math.abs(Object.values(probabilities).reduce((a, b) => a + b, 0) - 1) < 0.02
      && probabilities[answer.choice] >= Math.max(...Object.values(probabilities)) - 1e-6;
    if (!valid) throw new Error('invalid choice');
    return {
      choice: answer.choice,
      confidence: answer.confidence,
      probabilities: Object.fromEntries(ids.map(id => [id, probabilities[id]])),
    };
  } catch {
    const error = new Error('Invalid Jev choice response; no decision executed');
    error.code = 'JEV_RESPONSE_INVALID';
    throw error;
  }
}

function normalizeChoices(choices) {
  if (!Array.isArray(choices) || choices.length < 2) {
    const error = new Error('Jev bounded choice requires at least two candidates');
    error.code = 'JEV_CHOICES_INVALID';
    throw error;
  }
  const ids = new Set();
  return choices.map((choice, index) => {
    const id = String(choice?.id || '').trim();
    if (!id || !/^[A-Za-z0-9._:-]+$/.test(id) || ids.has(id)) {
      const error = new Error('Jev candidate IDs must be unique stable identifiers');
      error.code = 'JEV_CHOICES_INVALID';
      throw error;
    }
    ids.add(id);
    return {
      id,
      label: String(choice.label || id).slice(0, 300),
      context: choice.context && typeof choice.context === 'object' ? choice.context : {},
      ordinal: index,
    };
  });
}

function decisionBody({ objective, state, choices, model }) {
  const criteria = {};
  for (const choice of choices) {
    criteria[choice.id] = { label: choice.label, ...choice.context };
  }
  return {
    model: model || process.env.ROOTAGENT_JEV_MODEL || process.env.TYPESAFE_MODEL || 'jev-latest',
    state: state && typeof state === 'object' ? state : {},
    questions: {
      decision: {
        type: 'choice',
        criteria,
        instructions: {
          goal: String(objective || '').slice(0, 4000),
          rules: [
            'Choose exactly one supplied candidate ID.',
            'Do not invent actions, commands, files, or candidates.',
            'Prefer evidence-backed value; use lower cost/risk only after value and urgency.',
          ],
        },
      },
    },
  };
}

async function fetchJson(fetchImpl, key, body) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + key,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      if (response.ok) return { response, json, text };
      last = { response, json, text };
      if (quotaExhausted(response.status) || !transientProviderFailure(response.status) || attempt === 1) return last;
      await new Promise(resolve => setTimeout(resolve, 250 * (2 ** attempt)));
    } catch (error) {
      const wrapped = new Error('Jev provider connection failed; no decision executed');
      wrapped.code = 'JEV_CONNECTION_FAILED';
      wrapped.cause = error;
      throw wrapped;
    }
  }
  return last;
}

export async function chooseWithJev({
  cwd = process.cwd(),
  objective,
  state = {},
  choices,
  model,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, code: 'JEV_FETCH_UNAVAILABLE', reason: 'fetch is unavailable' };
  }
  const normalized = normalizeChoices(choices);
  const ids = normalized.map(x => x.id);
  const body = decisionBody({ objective, state, choices: normalized, model });
  const keys = availableJevKeys(cwd, env);
  if (!keys.length) {
    const configured = readJevApiKeys(env).length > 0;
    return {
      ok: false,
      code: configured ? 'JEV_KEYS_EXHAUSTED' : 'JEV_NOT_CONFIGURED',
      reason: configured ? 'All configured Jev keys are disabled for quota/billing' : 'No Jev API key configured',
    };
  }

  const disabled = [];
  const diagnostics = [];
  for (const key of keys) {
    const fingerprint = fingerprintJevKey(key);
    const result = await fetchJson(fetchImpl, key, body);
    const status = result?.response?.status ?? 0;

    if (result?.response?.ok) {
      let answer;
      try {
        answer = validateJevChoice(result.json?.answers?.decision, ids);
      } catch (error) {
        return { ok: false, code: error.code || 'JEV_RESPONSE_INVALID', reason: error.message, keyFingerprint: fingerprint };
      }
      return {
        ok: true,
        provider: 'jev',
        choiceId: answer.choice,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
        model: result.json?.model || body.model,
        usage: result.json?.usage || {},
        keyFingerprint: fingerprint,
        disabledKeyFingerprints: disabled,
      };
    }

    diagnostics.push({ keyFingerprint: fingerprint, status });
    if (quotaExhausted(status)) {
      disabled.push(disableKey(cwd, key, status === 402 ? 'billing_exhausted' : 'quota_exhausted', status));
      continue;
    }
    return {
      ok: false,
      code: 'JEV_PROVIDER_ERROR',
      reason: 'Jev provider returned HTTP ' + status,
      keyFingerprint: fingerprint,
      diagnostics,
    };
  }

  return {
    ok: false,
    code: 'JEV_KEYS_EXHAUSTED',
    reason: 'All configured Jev keys are quota/billing exhausted',
    disabledKeyFingerprints: disabled,
    diagnostics,
  };
}

export function chooseWithJevSync(cwd, input, options = {}) {
  const env = options.env || process.env;
  if (!readJevApiKeys(env).length) return { ok: false, code: 'JEV_NOT_CONFIGURED', reason: 'No Jev API key configured' };
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 15000;
  const child = spawnSync(process.execPath, [THIS_FILE, '--internal-choose', path.resolve(cwd)], {
    cwd,
    env,
    input: JSON.stringify(input || {}),
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  if (child.error || child.status !== 0) {
    return {
      ok: false,
      code: child.error?.code === 'ETIMEDOUT' ? 'JEV_TIMEOUT' : 'JEV_PROVIDER_FAILED',
      reason: child.error?.message || child.stderr?.trim() || 'Jev provider child failed',
    };
  }
  try {
    return JSON.parse(child.stdout);
  } catch {
    return { ok: false, code: 'JEV_PROVIDER_INVALID_OUTPUT', reason: 'Jev provider child returned invalid JSON' };
  }
}

export function selectImprovementOpportunitySync(cwd, opportunities, context = {}, options = {}) {
  if (!Array.isArray(opportunities) || !opportunities.length) throw new Error('No opportunities supplied');
  if (opportunities.length === 1) {
    return { chosen: opportunities[0], selection: { provider: 'deterministic', reason: 'single_candidate' } };
  }
  const ordered = [...opportunities].sort((a, b) => Number(!!b.blocking) - Number(!!a.blocking));
  const fallback = ordered[0];
  const choices = ordered.map((item, index) => ({
    id: 'op' + (index + 1),
    label: item.title || item.problem || ('Opportunity ' + (index + 1)),
    context: {
      blocking: !!item.blocking,
      level: item.level,
      problem: item.problem,
      projectValue: item.projectValue,
      expectedBenefit: item.expectedBenefit,
      cost: item.cost,
      risk: item.risk,
      rationale: item.rationale,
    },
  }));
  const result = chooseWithJevSync(cwd, {
    objective: 'Select the single improvement opportunity RootAgent should advance now. Prioritize blockers, concrete project/user value, urgency and expected benefit; then prefer lower implementation cost and risk. Select only from the supplied opportunities.',
    state: {
      baselineCommit: context.baselineCommit || null,
      cycle: context.cycle || null,
      target: context.target || null,
      previousDecisionCount: context.previousDecisionCount || 0,
    },
    choices,
  }, options);
  const minConfidenceRaw = Number(options.minConfidence ?? process.env.ROOTAGENT_JEV_MIN_CONFIDENCE ?? 0.55);
  const minConfidence = Number.isFinite(minConfidenceRaw) && minConfidenceRaw >= 0 && minConfidenceRaw <= 1 ? minConfidenceRaw : 0.55;
  if (!result.ok || result.confidence < minConfidence) {
    return {
      chosen: fallback,
      selection: {
        provider: 'deterministic',
        reason: result.ok ? 'jev_low_confidence' : (result.code || 'jev_unavailable'),
        jev: result.ok ? { confidence: result.confidence, choiceId: result.choiceId, model: result.model } : { code: result.code },
      },
    };
  }
  const index = choices.findIndex(x => x.id === result.choiceId);
  if (index < 0) {
    return { chosen: fallback, selection: { provider: 'deterministic', reason: 'jev_choice_unmapped' } };
  }
  return {
    chosen: ordered[index],
    selection: {
      provider: 'jev',
      confidence: result.confidence,
      model: result.model,
      choiceId: result.choiceId,
      probabilities: result.probabilities,
      keyFingerprint: result.keyFingerprint,
      disabledKeyFingerprints: result.disabledKeyFingerprints || [],
    },
  };
}

if (process.argv[2] === '--internal-choose') {
  const cwd = process.argv[3] || process.cwd();
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf-8') || '{}');
    const result = await chooseWithJev({ cwd, ...input });
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error.code || 'JEV_INTERNAL_ERROR', reason: error.message }));
  }
}
