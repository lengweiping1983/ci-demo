/**
 * Bounded action selection for RootAgent headless game playtests.
 *
 * Jev may only choose one action from this fixed allowlist. The selected action is
 * advisory runtime evidence; it never owns RootAgent completion/security state.
 */
import { chooseWithJev } from './jev-decision-provider.mjs';

export const GAME_PLAYTEST_ACTIONS = Object.freeze([
  Object.freeze({ id: 'MOVE_FORWARD', label: 'Move forward', key: 'w', code: 'KeyW', keyCode: 87, holdMs: 180 }),
  Object.freeze({ id: 'MOVE_BACKWARD', label: 'Move backward', key: 's', code: 'KeyS', keyCode: 83, holdMs: 140 }),
  Object.freeze({ id: 'MOVE_LEFT', label: 'Move left', key: 'a', code: 'KeyA', keyCode: 65, holdMs: 140 }),
  Object.freeze({ id: 'MOVE_RIGHT', label: 'Move right', key: 'd', code: 'KeyD', keyCode: 68, holdMs: 140 }),
  Object.freeze({ id: 'ATTACK', label: 'Perform primary action or attack', key: ' ', code: 'Space', keyCode: 32, holdMs: 70 }),
  Object.freeze({ id: 'DODGE', label: 'Dodge or sprint', key: 'Shift', code: 'ShiftLeft', keyCode: 16, holdMs: 100 }),
  Object.freeze({ id: 'WAIT', label: 'Wait briefly and observe', key: null, code: null, keyCode: null, holdMs: 180 }),
]);

export const GAME_PLAYTEST_SCENARIO = Object.freeze([
  Object.freeze({
    id: 'ORIENT',
    objective: 'Establish that basic control works and obtain an initial spatial response.',
    preferredActions: Object.freeze(['MOVE_FORWARD', 'MOVE_RIGHT', 'WAIT']),
  }),
  Object.freeze({
    id: 'EXPLORE',
    objective: 'Explore the nearby space with varied movement and observe how the world responds.',
    preferredActions: Object.freeze(['MOVE_FORWARD', 'MOVE_LEFT', 'MOVE_RIGHT']),
  }),
  Object.freeze({
    id: 'CORE_ACTION',
    objective: 'Exercise the primary gameplay action when appropriate and observe meaningful feedback.',
    preferredActions: Object.freeze(['ATTACK', 'MOVE_FORWARD', 'WAIT']),
  }),
  Object.freeze({
    id: 'ADAPT',
    objective: 'React to the current state using movement, dodge, or another safe action rather than repeating blindly.',
    preferredActions: Object.freeze(['DODGE', 'MOVE_LEFT', 'MOVE_RIGHT', 'ATTACK']),
  }),
  Object.freeze({
    id: 'ADVANCE',
    objective: 'Choose the action most likely to advance the observed user journey or product outcome.',
    preferredActions: Object.freeze(['MOVE_FORWARD', 'ATTACK', 'DODGE', 'MOVE_RIGHT']),
  }),
  Object.freeze({
    id: 'VERIFY',
    objective: 'Re-check the resulting state and choose a safe action that can confirm progress or expose stagnation.',
    preferredActions: Object.freeze(['ATTACK', 'MOVE_FORWARD', 'WAIT']),
  }),
]);

function scenarioPhaseForStep(stepIndex) {
  const index = Math.max(0, Number(stepIndex) || 0);
  if (index === 0) return GAME_PLAYTEST_SCENARIO[0];
  if (index <= 2) return GAME_PLAYTEST_SCENARIO[1];
  if (index <= 4) return GAME_PLAYTEST_SCENARIO[2];
  if (index === 5) return GAME_PLAYTEST_SCENARIO[3];
  if (index <= 8) return GAME_PLAYTEST_SCENARIO[4];
  return GAME_PLAYTEST_SCENARIO[5];
}

const FALLBACK_SEQUENCE = Object.freeze([
  'MOVE_FORWARD',
  'MOVE_RIGHT',
  'MOVE_FORWARD',
  'ATTACK',
  'ATTACK',
  'DODGE',
  'MOVE_FORWARD',
  'ATTACK',
  'MOVE_RIGHT',
  'WAIT',
]);

export function gamePlaytestActionById(id) {
  return GAME_PLAYTEST_ACTIONS.find(action => action.id === id) || null;
}

function clampConfidence(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.55;
}

export function deterministicPlaytestAction(history = [], phase = null) {
  const preferred = Array.isArray(phase?.preferredActions) ? phase.preferredActions : [];
  const phaseChoice = preferred[history.length % Math.max(1, preferred.length)] || null;
  const id = phaseChoice || FALLBACK_SEQUENCE[history.length % FALLBACK_SEQUENCE.length];
  return gamePlaytestActionById(id);
}

export async function selectHeadlessPlaytestAction({
  cwd = process.cwd(),
  state = {},
  history = [],
  env = process.env,
  fetchImpl = globalThis.fetch,
  minConfidence,
  scenarioPhase = null,
} = {}) {
  const phase = scenarioPhase || scenarioPhaseForStep(history.length);
  const fallback = deterministicPlaytestAction(history, phase);
  const boundedFetch = typeof fetchImpl === 'function'
    ? (url, init = {}) => fetchImpl(url, { ...init, signal: init.signal || AbortSignal.timeout(1500) })
    : fetchImpl;
  const result = await chooseWithJev({
    cwd,
    env,
    fetchImpl: boundedFetch,
    objective: [
      'Choose the next safe action for a bounded scenario-based game playtest.',
      'Act like a player progressing through the current scenario phase instead of sampling unrelated buttons.',
      'Use observed journey/outcome state when available; prefer actions that can advance or falsify progress.',
      'Avoid repeating an ineffective action when recent evidence shows no effect.',
      'Choose exactly one supplied action ID.',
    ].join(' '),
    state: {
      ...state,
      previousActions: history.slice(-6).map(item => item.actionId || item),
      step: history.length + 1,
      scenarioPhase: {
        id: phase.id,
        objective: phase.objective,
        preferredActions: phase.preferredActions,
      },
    },
    choices: GAME_PLAYTEST_ACTIONS.map(action => ({
      id: action.id,
      label: action.label,
      context: {
        input: action.key ? `keyboard:${action.code}` : 'no-input',
        holdMs: action.holdMs,
        safeBoundedAction: true,
        preferredForCurrentPhase: phase.preferredActions.includes(action.id),
      },
    })),
  });

  const threshold = clampConfidence(
    minConfidence
      ?? env.ROOTAGENT_JEV_PLAYTEST_MIN_CONFIDENCE
      ?? env.ROOTAGENT_JEV_MIN_CONFIDENCE
      ?? 0.55
  );

  if (!result.ok || result.confidence < threshold) {
    return {
      action: fallback,
      selection: {
        provider: 'deterministic',
        reason: result.ok ? 'jev_low_confidence' : (result.code || 'jev_unavailable'),
        ...(result.ok ? { jevConfidence: result.confidence } : {}),
      },
    };
  }

  const action = gamePlaytestActionById(result.choiceId);
  if (!action) {
    return {
      action: fallback,
      selection: { provider: 'deterministic', reason: 'jev_choice_unmapped' },
    };
  }

  return {
    action,
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
