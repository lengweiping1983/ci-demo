/**
 * Game Feel / Continuous Interaction Quality V1
 *
 * High-confidence findings from a short real-browser continuous interaction
 * scenario. V1 avoids subjective 'fun' scoring and only flags clearly poor
 * responsiveness or frame pacing.
 */

function percentile(values, p) {
  if (!Array.isArray(values) || !values.length) return null;
  const sorted = [...values].filter(Number.isFinite).sort((a,b)=>a-b);
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

export function validateFeelObservation(custom) {
  const feel = custom?.feel;
  if (!feel || typeof feel !== 'object') return null;
  const player = feel.playerPosition;
  const camera = feel.cameraPosition;
  const attackCount = Number(feel.attackCount);
  if (!player || !Number.isFinite(Number(player.x)) || !Number.isFinite(Number(player.z))) return null;
  if (!camera || !Number.isFinite(Number(camera.x)) || !Number.isFinite(Number(camera.z))) return null;
  if (!Number.isFinite(attackCount) || attackCount < 0) return null;
  return {
    playerPosition: { x: Number(player.x), z: Number(player.z) },
    cameraPosition: { x: Number(camera.x), z: Number(camera.z) },
    attackCount,
  };
}

export function buildGameFeelFindings(feelScenario) {
  if (!feelScenario || feelScenario.available !== true) return [];
  const findings = [];
  const responseMs = Number(feelScenario.movementResponseMs);
  if (Number.isFinite(responseMs) && responseMs > 180) {
    findings.push({
      id: 'INPUT_RESPONSE_SLOW',
      label: 'Player movement response is too slow after input begins',
      severity: 'high',
      confidence: 1,
      evidence: [{ movementResponseMs: responseMs, thresholdMs: 180 }],
    });
  }

  const attackMs = Number(feelScenario.attackResponseMs);
  if (Number.isFinite(attackMs) && attackMs > 180) {
    findings.push({
      id: 'ATTACK_RESPONSE_SLOW',
      label: 'Attack feedback is too slow after attack input',
      severity: 'high',
      confidence: 1,
      evidence: [{ attackResponseMs: attackMs, thresholdMs: 180 }],
    });
  }

  const samples = Array.isArray(feelScenario.movementSamples) ? feelScenario.movementSamples : [];
  if (samples.length >= 8) {
    const offsets = samples.map(sample => ({
      x: Number(sample.cameraPosition?.x) - Number(sample.playerPosition?.x),
      z: Number(sample.cameraPosition?.z) - Number(sample.playerPosition?.z),
    })).filter(item => Number.isFinite(item.x) && Number.isFinite(item.z));
    const jumps = [];
    for (let i = 1; i < offsets.length; i++) {
      jumps.push(Math.hypot(offsets[i].x - offsets[i - 1].x, offsets[i].z - offsets[i - 1].z));
    }
    if (jumps.length >= 7) {
      const medianJump = percentile(jumps, 0.5);
      const p95Jump = percentile(jumps, 0.95);
      const spikeThreshold = Math.max(0.45, medianJump * 4);
      const spikeRatio = jumps.filter(v => v > spikeThreshold).length / jumps.length;
      if (p95Jump > spikeThreshold && spikeRatio >= 0.14) {
        findings.push({
          id: 'CAMERA_FOLLOW_JITTER',
          label: 'Camera follow offset contains abrupt jitter spikes during steady movement',
          severity: 'high',
          confidence: 0.95,
          evidence: [{ medianOffsetStep: medianJump, p95OffsetStep: p95Jump, spikeRatio, spikeThreshold, sampleCount: offsets.length }],
        });
      }
    }
  }

  const frames = (feelScenario.frameTimesMs || []).filter(v => Number.isFinite(v) && v > 0 && v < 1000);
  if (frames.length >= 20) {
    const median = percentile(frames, 0.5);
    const p95 = percentile(frames, 0.95);
    const hitchThreshold = Math.max(40, median * 2.5);
    const hitchCount = frames.filter(v => v > hitchThreshold).length;
    const hitchRatio = hitchCount / frames.length;
    if (p95 > Math.max(50, median * 3) && hitchRatio >= 0.12) {
      findings.push({
        id: 'FRAME_PACING_UNSTABLE',
        label: 'Frame pacing is unstable during continuous interaction',
        severity: 'high',
        confidence: 0.98,
        evidence: [{ medianFrameMs: median, p95FrameMs: p95, hitchRatio, hitchThresholdMs: hitchThreshold, sampleCount: frames.length }],
      });
    }
  }

  return findings;
}

export function summarizeGameFeel(feelScenario) {
  if (!feelScenario || feelScenario.available !== true) return null;
  const frames = (feelScenario.frameTimesMs || []).filter(Number.isFinite);
  return {
    movementResponseMs: feelScenario.movementResponseMs ?? null,
    attackResponseMs: feelScenario.attackResponseMs ?? null,
    frameMedianMs: percentile(frames, 0.5),
    frameP95Ms: percentile(frames, 0.95),
    postReleaseDrift: feelScenario.postReleaseDrift ?? null,
    cameraSampleCount: Array.isArray(feelScenario.movementSamples) ? feelScenario.movementSamples.length : 0,
  };
}
