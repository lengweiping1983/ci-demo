import * as THREE from 'https://unpkg.com/three@0.181.1/build/three.module.js';

const mount = document.getElementById('game');
const hpEl = document.getElementById('hp');
const waveEl = document.getElementById('wave');
const scoreEl = document.getElementById('score');
const aiModeEl = document.getElementById('aiMode');
const aiDot = document.getElementById('aiDot');
const decisionEl = document.getElementById('decision');
const confidenceEl = document.getElementById('confidence');
const startCard = document.getElementById('startCard');
const startBtn = document.getElementById('startBtn');
const startFallbackBtn = document.getElementById('startFallbackBtn');
const keyInput = document.getElementById('jevKey');
const gameOverEl = document.getElementById('gameOver');
const finalScoreEl = document.getElementById('finalScore');
const restartBtn = document.getElementById('restartBtn');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060b);
scene.fog = new THREE.FogExp2(0x05060b, 0.028);

const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 180);
camera.position.set(0, 16, 18);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.8));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
mount.appendChild(renderer.domElement);

const hemi = new THREE.HemisphereLight(0x7088ff, 0x07080c, 1.5);
scene.add(hemi);
const keyLight = new THREE.DirectionalLight(0xffffff, 2.8);
keyLight.position.set(8, 18, 7);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
scene.add(keyLight);
const cyanLight = new THREE.PointLight(0x3defff, 25, 34, 2);
cyanLight.position.set(-8, 5, 0);
scene.add(cyanLight);
const violetLight = new THREE.PointLight(0x8d5cff, 20, 30, 2);
violetLight.position.set(9, 4, -8);
scene.add(violetLight);

const arena = new THREE.Mesh(
  new THREE.CylinderGeometry(18, 18, 0.5, 72),
  new THREE.MeshStandardMaterial({ color: 0x0b0e17, metalness: 0.72, roughness: 0.42 })
);
arena.position.y = -0.5;
arena.receiveShadow = true;
scene.add(arena);

const grid = new THREE.GridHelper(36, 24, 0x25496a, 0x182233);
grid.position.y = -0.23;
grid.material.transparent = true;
grid.material.opacity = 0.5;
scene.add(grid);

const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x2ecde0, transparent: true, opacity: 0.24 });
for (const radius of [6, 12, 17.1]) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius - 0.025, radius + 0.025, 96), ringMaterial);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -0.19;
  scene.add(ring);
}

const starGeo = new THREE.BufferGeometry();
const starPositions = new Float32Array(420 * 3);
for (let i = 0; i < 420; i++) {
  const r = 28 + Math.random() * 65;
  const a = Math.random() * Math.PI * 2;
  starPositions[i * 3] = Math.cos(a) * r;
  starPositions[i * 3 + 1] = 4 + Math.random() * 34;
  starPositions[i * 3 + 2] = Math.sin(a) * r;
}
starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x93bfff, size: 0.08, transparent: true, opacity: 0.6 })));

function makeShip() {
  const group = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.ConeGeometry(0.72, 1.9, 7),
    new THREE.MeshStandardMaterial({ color: 0xeefcff, emissive: 0x14485d, emissiveIntensity: 2.2, metalness: 0.66, roughness: 0.22 })
  );
  core.rotation.x = Math.PI / 2;
  core.castShadow = true;
  group.add(core);
  const glow = new THREE.Mesh(
    new THREE.TorusGeometry(0.58, 0.06, 12, 32),
    new THREE.MeshBasicMaterial({ color: 0x6ef5ff })
  );
  glow.rotation.x = Math.PI / 2;
  glow.position.z = 0.3;
  group.add(glow);
  const wingMat = new THREE.MeshStandardMaterial({ color: 0x515b79, metalness: 0.8, roughness: 0.24 });
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 0.45), wingMat);
    wing.position.set(side * 0.65, 0, 0.25);
    wing.rotation.z = side * -0.16;
    wing.castShadow = true;
    group.add(wing);
  }
  group.rotation.y = Math.PI;
  return group;
}

const player = makeShip();
player.position.set(0, 0.18, 5);
scene.add(player);

const state = {
  running: false,
  hp: 100,
  score: 0,
  wave: 1,
  lastShotAt: 0,
  dashUntil: 0,
  invulnerableUntil: 0,
  jevKey: '',
  aiMode: 'LOCAL FALLBACK',
  aiDecision: 'CHASE',
  aiConfidence: null,
  aiBusy: false,
  nextAiDecisionAt: 0,
  startedAt: 0,
  gameOver: false,
};

const keys = new Set();
const mouse = new THREE.Vector2();
const aimPoint = new THREE.Vector3(0, 0, 0);
const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

const enemies = [];
const bullets = [];
const particles = [];

function makeEnemy(index = 0) {
  const group = new THREE.Group();
  const shell = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.68, 1),
    new THREE.MeshStandardMaterial({
      color: 0x3a1730,
      emissive: 0xff2e75,
      emissiveIntensity: 1.6,
      metalness: 0.62,
      roughness: 0.28,
    })
  );
  shell.castShadow = true;
  group.add(shell);
  const eye = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0xffa7cb })
  );
  eye.position.z = 0.62;
  group.add(eye);
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(0.86, 0.035, 8, 28),
    new THREE.MeshBasicMaterial({ color: 0xff4f8a })
  );
  halo.rotation.x = Math.PI / 2;
  group.add(halo);
  const a = (index / Math.max(1, 4 + state.wave)) * Math.PI * 2 + Math.random() * 0.7;
  const r = 13 + Math.random() * 3;
  group.position.set(Math.cos(a) * r, 0.55, Math.sin(a) * r);
  group.userData = {
    hp: 35 + state.wave * 6,
    cooldown: Math.random(),
    phase: Math.random() * Math.PI * 2,
    strafe: Math.random() > 0.5 ? 1 : -1,
  };
  scene.add(group);
  enemies.push(group);
}

function spawnWave() {
  const count = Math.min(4 + state.wave, 10);
  for (let i = 0; i < count; i++) makeEnemy(i);
  state.nextAiDecisionAt = 0;
}

function explode(position, color = 0x7bf5ff, amount = 14) {
  for (let i = 0; i < amount; i++) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.045 + Math.random() * 0.06, 6, 6),
      new THREE.MeshBasicMaterial({ color })
    );
    mesh.position.copy(position);
    mesh.userData.velocity = new THREE.Vector3(
      (Math.random() - 0.5) * 6,
      Math.random() * 3,
      (Math.random() - 0.5) * 6
    );
    mesh.userData.life = 0.45 + Math.random() * 0.55;
    scene.add(mesh);
    particles.push(mesh);
  }
}

let audioCtx = null;
function beep(freq = 220, duration = 0.08, gain = 0.04, type = 'sawtooth') {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
  }
  const osc = audioCtx.createOscillator();
  const amp = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  amp.gain.setValueAtTime(gain, audioCtx.currentTime);
  amp.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
  osc.connect(amp).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + duration);
}

function shoot(origin, direction, hostile = false) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(hostile ? 0.09 : 0.075, 8, 8),
    new THREE.MeshBasicMaterial({ color: hostile ? 0xff577f : 0x7bf5ff })
  );
  mesh.position.copy(origin);
  mesh.userData.velocity = direction.clone().normalize().multiplyScalar(hostile ? 8.2 : 13.5);
  mesh.userData.hostile = hostile;
  mesh.userData.life = hostile ? 2.5 : 1.5;
  scene.add(mesh);
  bullets.push(mesh);
}

function firePlayer() {
  if (!state.running || state.gameOver) return;
  const now = performance.now();
  if (now - state.lastShotAt < 130) return;
  state.lastShotAt = now;
  const direction = aimPoint.clone().sub(player.position).setY(0).normalize();
  if (!Number.isFinite(direction.x) || direction.lengthSq() < 0.1) direction.set(0, 0, -1);
  shoot(player.position.clone().add(new THREE.Vector3(0, 0.2, 0)), direction, false);
  beep(520, 0.06, 0.028, 'square');
}

function hurtPlayer(amount) {
  const now = performance.now();
  if (now < state.invulnerableUntil || state.gameOver) return;
  state.hp = Math.max(0, state.hp - amount);
  state.invulnerableUntil = now + 220;
  hpEl.textContent = Math.ceil(state.hp);
  document.body.classList.remove('flash');
  void document.body.offsetWidth;
  document.body.classList.add('flash');
  beep(95, 0.14, 0.07, 'sawtooth');
  explode(player.position, 0xff6a93, 8);
  if (state.hp <= 0) finishGame();
}

function finishGame() {
  state.gameOver = true;
  state.running = false;
  finalScoreEl.textContent = String(state.score);
  gameOverEl.classList.remove('hidden');
}

function resetGame() {
  for (const e of enemies.splice(0)) scene.remove(e);
  for (const b of bullets.splice(0)) scene.remove(b);
  for (const p of particles.splice(0)) scene.remove(p);
  state.hp = 100;
  state.score = 0;
  state.wave = 1;
  state.gameOver = false;
  state.aiDecision = 'CHASE';
  state.aiConfidence = null;
  state.startedAt = performance.now();
  player.position.set(0, 0.18, 5);
  hpEl.textContent = '100';
  scoreEl.textContent = '0000';
  waveEl.textContent = '1';
  gameOverEl.classList.add('hidden');
  spawnWave();
}

function localDecision(snapshot) {
  if (snapshot.playerHealth < 30 && snapshot.enemyCount > 3) return 'ATTACK';
  if (snapshot.closestEnemyDistance < 3.1) return snapshot.playerHealth > 55 ? 'RETREAT' : 'GUARD';
  if (snapshot.closestEnemyDistance > 9) return 'CHASE';
  if (snapshot.enemyCount >= 5) return 'FLANK';
  return Math.random() > 0.52 ? 'ATTACK' : 'STRAFE';
}

function gameSnapshot() {
  let closest = 99;
  for (const e of enemies) closest = Math.min(closest, e.position.distanceTo(player.position));
  return {
    playerHealth: Math.round(state.hp),
    enemyCount: enemies.length,
    closestEnemyDistance: Number(closest.toFixed(2)),
    wave: state.wave,
    score: state.score,
    timeAliveSeconds: Math.round((performance.now() - state.startedAt) / 1000),
    currentTactic: state.aiDecision,
  };
}

async function askJev(snapshot) {
  if (!state.jevKey || state.aiBusy) return null;
  state.aiBusy = true;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1800);
    const response = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + state.jevKey,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'jev-latest',
        state: snapshot,
        questions: {
          decision: {
            type: 'choice',
            criteria: {
              CHASE: { label: 'Close distance aggressively' },
              STRAFE: { label: 'Move laterally and pressure' },
              RETREAT: { label: 'Create distance and reposition' },
              ATTACK: { label: 'Fire immediately' },
              GUARD: { label: 'Hold formation and defend' },
            },
            instructions: {
              goal: 'Choose one tactical action for the enemy drone squad in a fast 3D arena shooter. Keep pressure on the player without suicidal behavior.',
              rules: ['Choose exactly one supplied action ID.'],
            },
          },
        },
      }),
    });
    clearTimeout(timeout);
    if (!response.ok) throw new Error('JEV HTTP ' + response.status);
    const data = await response.json();
    const answer = data?.answers?.decision;
    const allowed = ['CHASE', 'STRAFE', 'RETREAT', 'ATTACK', 'GUARD'];
    if (!answer || !allowed.includes(answer.choice)) throw new Error('Invalid JEV decision');
    return {
      choice: answer.choice,
      confidence: typeof answer.confidence === 'number' ? answer.confidence : null,
    };
  } finally {
    state.aiBusy = false;
  }
}

async function refreshAiDecision(now) {
  if (now < state.nextAiDecisionAt || state.aiBusy || enemies.length === 0) return;
  state.nextAiDecisionAt = now + 3600;
  const snapshot = gameSnapshot();
  let result = null;
  if (state.jevKey) {
    try {
      result = await askJev(snapshot);
      if (result) {
        state.aiMode = 'JEV LIVE';
        state.aiDecision = result.choice;
        state.aiConfidence = result.confidence;
        aiDot.classList.add('live');
      }
    } catch (error) {
      state.aiMode = 'LOCAL FALLBACK';
      state.aiDecision = localDecision(snapshot);
      state.aiConfidence = null;
      aiDot.classList.remove('live');
      console.warn('JEV fallback:', error.message);
    }
  } else {
    state.aiMode = 'LOCAL FALLBACK';
    state.aiDecision = localDecision(snapshot);
    state.aiConfidence = null;
    aiDot.classList.remove('live');
  }
  aiModeEl.textContent = state.aiMode;
  decisionEl.textContent = 'TACTIC: ' + state.aiDecision;
  confidenceEl.textContent = state.aiConfidence == null ? 'confidence —' : 'confidence ' + state.aiConfidence.toFixed(2);
}

function updatePlayer(dt, now) {
  const dir = new THREE.Vector3(
    (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0),
    0,
    (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0)
  );
  if (dir.lengthSq() > 0) dir.normalize();
  let speed = 7;
  if (now < state.dashUntil) speed = 16;
  player.position.addScaledVector(dir, speed * dt);
  const radius = Math.hypot(player.position.x, player.position.z);
  if (radius > 16.3) {
    player.position.x *= 16.3 / radius;
    player.position.z *= 16.3 / radius;
  }
  const look = aimPoint.clone();
  look.y = player.position.y;
  if (look.distanceToSquared(player.position) > 0.5) player.lookAt(look);
}

function updateEnemies(dt, now) {
  const tactic = state.aiDecision;
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    const toPlayer = player.position.clone().sub(e.position);
    const distance = toPlayer.length();
    const radial = toPlayer.clone().setY(0).normalize();
    const tangent = new THREE.Vector3(-radial.z, 0, radial.x).multiplyScalar(e.userData.strafe);
    let velocity = new THREE.Vector3();

    if (tactic === 'CHASE') velocity.addScaledVector(radial, distance > 2.6 ? 3.1 : -1.2);
    if (tactic === 'STRAFE' || tactic === 'FLANK') velocity.addScaledVector(tangent, 3.4).addScaledVector(radial, distance > 6 ? 1.2 : -0.5);
    if (tactic === 'RETREAT') velocity.addScaledVector(radial, distance < 9 ? -3.2 : 0.5);
    if (tactic === 'ATTACK') velocity.addScaledVector(tangent, 1.4).addScaledVector(radial, distance > 7 ? 1.2 : 0);
    if (tactic === 'GUARD') velocity.addScaledVector(tangent, 1.2).addScaledVector(radial, distance < 4 ? -1.8 : 0.2);

    e.position.addScaledVector(velocity, dt);
    e.position.y = 0.55 + Math.sin(now * 0.003 + e.userData.phase) * 0.16;
    e.rotation.y += dt * 1.4;
    e.userData.cooldown -= dt;

    const shouldShoot = tactic === 'ATTACK' || tactic === 'GUARD' || distance < 6.5;
    if (shouldShoot && distance < 11 && e.userData.cooldown <= 0) {
      const spread = new THREE.Vector3((Math.random() - 0.5) * 0.12, 0, (Math.random() - 0.5) * 0.12);
      shoot(e.position.clone(), radial.clone().add(spread), true);
      e.userData.cooldown = Math.max(0.55, 1.35 - state.wave * 0.05) + Math.random() * 0.6;
    }

    if (distance < 1.15) {
      hurtPlayer(12 * dt);
    }
  }
}

function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.position.addScaledVector(b.userData.velocity, dt);
    b.userData.life -= dt;
    if (b.userData.life <= 0) {
      scene.remove(b);
      bullets.splice(i, 1);
      continue;
    }

    if (b.userData.hostile) {
      if (b.position.distanceTo(player.position) < 0.62) {
        hurtPlayer(8 + state.wave * 0.8);
        scene.remove(b);
        bullets.splice(i, 1);
      }
      continue;
    }

    for (let j = enemies.length - 1; j >= 0; j--) {
      const e = enemies[j];
      if (b.position.distanceTo(e.position) < 0.72) {
        e.userData.hp -= 18;
        explode(b.position, 0x7bf5ff, 5);
        scene.remove(b);
        bullets.splice(i, 1);
        if (e.userData.hp <= 0) {
          explode(e.position, 0xff4f8a, 16);
          scene.remove(e);
          enemies.splice(j, 1);
          state.score += 100 + state.wave * 20;
          scoreEl.textContent = String(state.score).padStart(4, '0');
          beep(170, 0.1, 0.04, 'triangle');
        }
        break;
      }
    }
  }
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.position.addScaledVector(p.userData.velocity, dt);
    p.userData.velocity.y -= 3.2 * dt;
    p.userData.life -= dt;
    p.scale.setScalar(Math.max(0.01, p.userData.life));
    if (p.userData.life <= 0) {
      scene.remove(p);
      particles.splice(i, 1);
    }
  }
}

function updateWave() {
  if (state.running && enemies.length === 0 && !state.gameOver) {
    state.wave += 1;
    waveEl.textContent = String(state.wave);
    state.hp = Math.min(100, state.hp + 14);
    hpEl.textContent = Math.ceil(state.hp);
    spawnWave();
    beep(660, 0.18, 0.05, 'sine');
  }
}

function updateAim() {
  raycaster.setFromCamera(mouse, camera);
  raycaster.ray.intersectPlane(groundPlane, aimPoint);
}

function updateCamera(dt) {
  const target = player.position.clone();
  const desired = target.clone().add(new THREE.Vector3(0, 15.5, 16.5));
  camera.position.lerp(desired, 1 - Math.pow(0.001, dt));
  camera.lookAt(target.x, 0, target.z - 1.7);
}

let previous = performance.now();
function animate(now = performance.now()) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.033, (now - previous) / 1000);
  previous = now;

  updateAim();
  if (state.running && !state.gameOver) {
    updatePlayer(dt, now);
    updateEnemies(dt, now);
    updateBullets(dt);
    updateParticles(dt);
    updateWave();
    refreshAiDecision(now);
  } else {
    updateParticles(dt);
  }

  cyanLight.intensity = 23 + Math.sin(now * 0.002) * 4;
  violetLight.intensity = 18 + Math.cos(now * 0.0017) * 3;
  updateCamera(dt);
  renderer.render(scene, camera);
}
animate();

function begin(useKey) {
  state.jevKey = useKey ? keyInput.value.trim() : '';
  state.aiMode = state.jevKey ? 'JEV CONNECTING' : 'LOCAL FALLBACK';
  aiModeEl.textContent = state.aiMode;
  aiDot.classList.toggle('live', !!state.jevKey);
  startCard.classList.add('hidden');
  resetGame();
  state.running = true;
  audioCtx?.resume?.();
}

startBtn.addEventListener('click', () => begin(true));
startFallbackBtn.addEventListener('click', () => begin(false));
restartBtn.addEventListener('click', () => {
  resetGame();
  state.running = true;
});

addEventListener('keydown', (event) => {
  keys.add(event.code);
  if (event.code === 'Space') {
    event.preventDefault();
    firePlayer();
  }
  if ((event.code === 'ShiftLeft' || event.code === 'ShiftRight') && state.running) {
    state.dashUntil = performance.now() + 180;
    state.invulnerableUntil = performance.now() + 180;
    beep(220, 0.07, 0.025, 'triangle');
  }
});
addEventListener('keyup', (event) => keys.delete(event.code));
addEventListener('pointermove', (event) => {
  mouse.x = (event.clientX / innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / innerHeight) * 2 + 1;
});
addEventListener('pointerdown', (event) => {
  if (event.button === 0) firePlayer();
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

window.__ROOTAGENT_PLAYTEST__ = {
  observe() {
    let closest = null;
    for (const e of enemies) {
      const d = e.position.distanceTo(player.position);
      closest = closest == null ? d : Math.min(closest, d);
    }
    return {
      running: state.running,
      hp: Math.round(state.hp),
      score: state.score,
      wave: state.wave,
      enemyCount: enemies.length,
      closestEnemyDistance: closest == null ? null : Number(closest.toFixed(2)),
      playerPosition: {
        x: Number(player.position.x.toFixed(2)),
        z: Number(player.position.z.toFixed(2)),
      },
      tactic: state.aiDecision,
      aiMode: state.aiMode,
    };
  }
};
