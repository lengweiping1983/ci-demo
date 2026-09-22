import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js';

const TACTICS = Object.freeze(['CHASE','STRAFE','RETREAT','ATTACK','GUARD']);
const API_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const $ = id => document.getElementById(id);
const ui = {
  hp: $('hpFill'), hpText: $('hpText'), score: $('score'), wave: $('wave'),
  tactic: $('tactic'), provider: $('provider'), status: $('status'), enemies: $('enemies'),
  hint: $('hint'), flash: $('flash'), restart: $('restart'), gameover: $('gameover'),
  finalScore: $('finalScore'), connect: $('connectJev'), dialog: $('jevDialog'),
  keyInput: $('jevKey'), keySave: $('jevSave'), keyCancel: $('jevCancel'),
};

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x030711);
scene.fog = new THREE.FogExp2(0x07111f, 0.024);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 220);
camera.position.set(0, 11, 14);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.outputColorSpace = THREE.SRGBColorSpace;
$('stage').appendChild(renderer.domElement);

const hemi = new THREE.HemisphereLight(0x8fd8ff, 0x07111c, 1.45);
scene.add(hemi);
const keyLight = new THREE.DirectionalLight(0x9ec9ff, 3.1);
keyLight.position.set(7, 13, 5);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(512, 512);
scene.add(keyLight);
const rim = new THREE.PointLight(0x5df6ff, 22, 42, 2);
rim.position.set(0, 5, 0);
scene.add(rim);

const arena = new THREE.Group();
scene.add(arena);
const floor = new THREE.Mesh(
  new THREE.CylinderGeometry(25, 27, 0.8, 64),
  new THREE.MeshStandardMaterial({ color: 0x07111c, metalness: 0.76, roughness: 0.38 })
);
floor.receiveShadow = true;
floor.position.y = -0.6;
arena.add(floor);

const ringMat = new THREE.MeshBasicMaterial({ color: 0x1bc8ff, transparent: true, opacity: 0.28 });
for (const radius of [6, 12, 18, 24]) {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.035, 8, 96), ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.16;
  arena.add(ring);
}
for (let i = 0; i < 16; i++) {
  const a = (i / 16) * Math.PI * 2;
  const p = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 3.4 + (i % 3), 0.7),
    new THREE.MeshStandardMaterial({
      color: i % 2 ? 0x14253b : 0x102a36,
      emissive: i % 2 ? 0x06131f : 0x06262e,
      emissiveIntensity: 0.9,
      metalness: 0.8,
      roughness: 0.26,
    })
  );
  p.position.set(Math.cos(a) * 22.5, 1.2, Math.sin(a) * 22.5);
  p.castShadow = true;
  arena.add(p);
}

const core = new THREE.Group();
const coreShell = new THREE.Mesh(
  new THREE.IcosahedronGeometry(1.1, 2),
  new THREE.MeshStandardMaterial({ color: 0x8ef8ff, emissive: 0x10cbe8, emissiveIntensity: 2.4, metalness: 0.2, roughness: 0.18 })
);
coreShell.position.y = 1.55;
core.add(coreShell);
const coreHalo = new THREE.Mesh(new THREE.TorusGeometry(1.8, 0.06, 10, 96), ringMat.clone());
coreHalo.position.y = 1.55;
coreHalo.rotation.x = Math.PI / 2;
core.add(coreHalo);
scene.add(core);

const starGeo = new THREE.BufferGeometry();
const starCount = 520;
const positions = new Float32Array(starCount * 3);
for (let i = 0; i < starCount; i++) {
  const r = 35 + Math.random() * 65;
  const a = Math.random() * Math.PI * 2;
  positions[i * 3] = Math.cos(a) * r;
  positions[i * 3 + 1] = 4 + Math.random() * 45;
  positions[i * 3 + 2] = Math.sin(a) * r;
}
starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x8bdfff, size: 0.08, transparent: true, opacity: 0.72 })));

function makePlayer() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.58, 1.35, 8, 18),
    new THREE.MeshStandardMaterial({ color: 0xeaf8ff, emissive: 0x16354d, emissiveIntensity: 0.8, metalness: 0.7, roughness: 0.2 })
  );
  body.rotation.x = Math.PI / 2;
  body.castShadow = true;
  g.add(body);
  const wingMat = new THREE.MeshStandardMaterial({ color: 0x0fb8d8, emissive: 0x0a7691, emissiveIntensity: 1.25, metalness: 0.64, roughness: 0.24 });
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.12, 0.52), wingMat);
    wing.position.set(side * 0.88, -0.04, 0.18);
    wing.rotation.z = side * 0.1;
    g.add(wing);
  }
  const glow = new THREE.PointLight(0x19e9ff, 5, 7, 2);
  glow.position.set(0, 0.1, 1.1);
  g.add(glow);
  g.position.set(0, 0.6, 8);
  scene.add(g);
  return g;
}
const player = makePlayer();

function makeEnemy(index) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: index % 2 ? 0xff596e : 0xff9f43,
    emissive: index % 2 ? 0x561524 : 0x5c2b06,
    emissiveIntensity: 1.45,
    metalness: 0.55,
    roughness: 0.3,
  });
  const hull = new THREE.Mesh(new THREE.OctahedronGeometry(0.72, 0), mat);
  hull.castShadow = true;
  g.add(hull);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.055, 7, 36), new THREE.MeshBasicMaterial({ color: mat.color, transparent: true, opacity: 0.7 }));
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  const a = Math.random() * Math.PI * 2;
  const r = 15 + Math.random() * 5;
  g.position.set(Math.cos(a) * r, 0.85, Math.sin(a) * r);
  scene.add(g);
  return {
    mesh: g, hp: 42, maxHp: 42, tactic: 'CHASE', tacticUntil: 0,
    speed: 2.6 + Math.random() * 0.8, cooldown: Math.random(), strafeSign: Math.random() > .5 ? 1 : -1,
    shield: 0, id: 'enemy-' + (++state.enemySerial),
  };
}

const state = {
  health: 100, score: 0, wave: 1, enemies: [], projectiles: [], enemyShots: [], sparks: [],
  gameOver: false, attackCount: 0, dodgeCount: 0, kills: 0, decisionCount: 0,
  jevDecisionCount: 0, fallbackCount: 0, lastTactic: 'CHASE', provider: 'LOCAL',
  distanceMoved: 0, stateVersion: 0, enemySerial: 0, lastShotAt: 0, lastDodgeAt: 0,
  sessionKey: '', audioReady: false, startedAt: performance.now(),
};
const keys = new Set();
const velocity = new THREE.Vector3();
const tmp = new THREE.Vector3();
const camTarget = new THREE.Vector3();

function addSpark(pos, color = 0x7befff, count = 7) {
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.035 + Math.random() * 0.035, 6, 6),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 })
    );
    mesh.position.copy(pos);
    scene.add(mesh);
    state.sparks.push({ mesh, life: 0.35 + Math.random() * 0.3, v: new THREE.Vector3((Math.random()-.5)*5, Math.random()*3, (Math.random()-.5)*5) });
  }
}

let audioCtx = null;
function tone(freq = 220, duration = 0.05, gain = 0.035) {
  try {
    audioCtx ||= new AudioContext();
    const osc = audioCtx.createOscillator();
    const amp = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    amp.gain.setValueAtTime(gain, audioCtx.currentTime);
    amp.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
    osc.connect(amp).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch {}
}

function spawnWave() {
  const n = Math.min(3 + state.wave, 9);
  for (let i = 0; i < n; i++) state.enemies.push(makeEnemy(i));
  state.stateVersion++;
}

function clampArena(object, radius = 22) {
  const d = Math.hypot(object.position.x, object.position.z);
  if (d > radius) {
    object.position.x *= radius / d;
    object.position.z *= radius / d;
  }
}

function fire() {
  if (state.gameOver) return;
  const now = performance.now();
  state.attackCount++;
  state.stateVersion++;
  if (now - state.lastShotAt < 70) {
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(player.quaternion).normalize();
    addSpark(player.position.clone().addScaledVector(dir, 0.9), 0x71efff, 2);
    return;
  }
  state.lastShotAt = now;
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(player.quaternion).normalize();
  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(0.11, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0x9ffaff })
  );
  orb.position.copy(player.position).addScaledVector(dir, 1.15);
  orb.position.y = 0.7;
  scene.add(orb);
  state.projectiles.push({ mesh: orb, v: dir.multiplyScalar(24), life: 1.5 });
  addSpark(orb.position, 0x7ef6ff, 4);
  tone(520, 0.04, 0.025);
}

function dodge() {
  if (state.gameOver) return;
  const now = performance.now();
  if (now - state.lastDodgeAt < 650) return;
  state.lastDodgeAt = now;
  state.dodgeCount++;
  state.stateVersion++;
  const dir = velocity.lengthSq() > 0.01 ? velocity.clone().normalize() : new THREE.Vector3(0,0,-1).applyQuaternion(player.quaternion);
  velocity.addScaledVector(dir, 10.5);
  addSpark(player.position, 0x58f5ff, 14);
  tone(180, 0.09, 0.04);
}

function localTactic(enemy) {
  const d = enemy.mesh.position.distanceTo(player.position);
  if (enemy.hp < 13) return 'RETREAT';
  if (d > 10) return 'CHASE';
  if (d < 4.2) return 'GUARD';
  if (Math.random() < .34) return 'STRAFE';
  return d < 7 ? 'ATTACK' : 'CHASE';
}

function jevBody(enemy) {
  const d = enemy.mesh.position.distanceTo(player.position);
  const criteria = Object.fromEntries(TACTICS.map(id => [id, {
    label: id,
    distanceToPlayer: Number(d.toFixed(2)),
    enemyHp: enemy.hp,
    playerHp: state.health,
    wave: state.wave,
    nearbyAllies: state.enemies.filter(e => e !== enemy && e.mesh.position.distanceTo(enemy.mesh.position) < 5).length,
  }]));
  return {
    model: 'jev-latest',
    state: {
      arena: 'Aegis Drift',
      enemy: enemy.id,
      distanceToPlayer: Number(d.toFixed(2)),
      enemyHp: enemy.hp,
      playerHp: state.health,
      wave: state.wave,
      score: state.score,
    },
    questions: {
      decision: {
        type: 'choice',
        criteria,
        instructions: {
          goal: 'Choose one tactical behavior that pressures the player while preserving believable combat spacing.',
          rules: ['Choose exactly one supplied candidate ID.','Do not invent actions or code.']
        }
      }
    }
  };
}

async function fetchJev(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    if (new URLSearchParams(location.search).get('jev_proxy') === '1') {
      const r = await fetch('/api/jev', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body), signal:controller.signal });
      if (!r.ok) throw new Error('proxy ' + r.status);
      return await r.json();
    }
    if (!state.sessionKey) throw new Error('no-session-key');
    const r = await fetch(API_ENDPOINT, {
      method:'POST',
      headers:{ authorization:'Bearer ' + state.sessionKey, 'content-type':'application/json' },
      body:JSON.stringify(body),
      signal:controller.signal,
    });
    if (!r.ok) throw new Error('jev ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function decideTactic(enemy) {
  if (enemy.pendingDecision || state.gameOver) return;
  enemy.pendingDecision = true;
  const fallback = localTactic(enemy);
  try {
    const json = await fetchJev(jevBody(enemy));
    const answer = json?.answers?.decision;
    const choice = answer?.choice;
    if (!TACTICS.includes(choice)) throw new Error('invalid-choice');
    const probs = answer?.probabilities || {};
    if (!TACTICS.every(t => Number.isFinite(Number(probs[t])))) throw new Error('invalid-probabilities');
    enemy.tactic = choice;
    enemy.confidence = Number(answer.confidence || 0);
    state.provider = 'JEV';
    state.jevDecisionCount++;
  } catch {
    enemy.tactic = fallback;
    enemy.confidence = 1;
    state.provider = 'LOCAL';
    state.fallbackCount++;
  } finally {
    enemy.tacticUntil = performance.now() + 1500 + Math.random() * 900;
    enemy.pendingDecision = false;
    state.lastTactic = enemy.tactic;
    state.decisionCount++;
    state.stateVersion++;
  }
}

function shootEnemy(enemy) {
  const dir = player.position.clone().sub(enemy.mesh.position).normalize();
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.095, 7, 7), new THREE.MeshBasicMaterial({ color: 0xff6d78 }));
  mesh.position.copy(enemy.mesh.position);
  mesh.position.y = 0.85;
  scene.add(mesh);
  state.enemyShots.push({ mesh, v: dir.multiplyScalar(10.8), life: 2.2 });
  tone(120, 0.045, 0.02);
}

function updateEnemy(enemy, dt, now) {
  if (now > enemy.tacticUntil) decideTactic(enemy);
  const toPlayer = player.position.clone().sub(enemy.mesh.position);
  const distance = Math.max(0.001, toPlayer.length());
  const forward = toPlayer.normalize();
  const side = new THREE.Vector3(-forward.z, 0, forward.x).multiplyScalar(enemy.strafeSign);
  let move = new THREE.Vector3();
  if (enemy.tactic === 'CHASE') move.copy(forward);
  if (enemy.tactic === 'STRAFE') move.copy(side).addScaledVector(forward, distance > 8 ? .35 : -.08);
  if (enemy.tactic === 'RETREAT') move.copy(forward).multiplyScalar(-1);
  if (enemy.tactic === 'ATTACK') move.copy(side).multiplyScalar(.35).addScaledVector(forward, distance > 7 ? .4 : 0);
  if (enemy.tactic === 'GUARD') move.copy(forward).multiplyScalar(distance > 6 ? .25 : -.22);
  enemy.mesh.position.addScaledVector(move.normalize(), enemy.speed * dt * (enemy.tactic === 'RETREAT' ? 1.2 : 1));
  enemy.mesh.lookAt(player.position.x, enemy.mesh.position.y, player.position.z);
  enemy.mesh.children[1].rotation.z += dt * (enemy.tactic === 'GUARD' ? 4.5 : 1.4);
  enemy.shield = enemy.tactic === 'GUARD' ? 0.62 : Math.max(0, enemy.shield - dt);
  enemy.cooldown -= dt;
  if ((enemy.tactic === 'ATTACK' || (enemy.tactic === 'CHASE' && distance < 5.4)) && enemy.cooldown <= 0) {
    shootEnemy(enemy);
    enemy.cooldown = enemy.tactic === 'ATTACK' ? 0.78 : 1.2;
  }
  clampArena(enemy.mesh, 23);
}

function damagePlayer(amount) {
  if (state.gameOver) return;
  state.health = Math.max(0, state.health - amount);
  state.stateVersion++;
  ui.flash.classList.remove('hit');
  void ui.flash.offsetWidth;
  ui.flash.classList.add('hit');
  tone(72, 0.11, 0.055);
  if (state.health <= 0) endGame();
}

function endGame() {
  state.gameOver = true;
  state.stateVersion++;
  ui.finalScore.textContent = String(state.score);
  ui.gameover.classList.add('show');
}

function restartGame() {
  for (const e of state.enemies) scene.remove(e.mesh);
  for (const p of [...state.projectiles, ...state.enemyShots]) scene.remove(p.mesh);
  state.enemies = [];
  state.projectiles = [];
  state.enemyShots = [];
  state.health = 100; state.score = 0; state.wave = 1; state.kills = 0;
  state.attackCount = 0; state.dodgeCount = 0; state.gameOver = false;
  state.distanceMoved = 0; state.startedAt = performance.now(); state.stateVersion++;
  player.position.set(0,0.6,8); velocity.set(0,0,0);
  ui.gameover.classList.remove('show');
  spawnWave();
}

function updatePlayer(dt) {
  if (state.gameOver) return;
  const input = new THREE.Vector3(
    (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0),
    0,
    (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0)
  );
  if (input.lengthSq() > 0) {
    input.normalize();
    velocity.addScaledVector(input, 18 * dt);
  }
  const speed = velocity.length();
  if (speed > 8.5) velocity.multiplyScalar(8.5 / speed);
  const before = player.position.clone();
  player.position.addScaledVector(velocity, dt);
  velocity.multiplyScalar(Math.pow(0.025, dt));
  clampArena(player, 21);
  const moved = before.distanceTo(player.position);
  if (moved > 0.0001) {
    state.distanceMoved += moved;
    state.stateVersion++;
  }
  if (velocity.lengthSq() > .02) {
    const targetYaw = Math.atan2(-velocity.x, -velocity.z);
    let diff = targetYaw - player.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    player.rotation.y += diff * Math.min(1, dt * 8);
  }
  player.position.y = 0.62 + Math.sin(performance.now() * 0.004) * 0.055;
}

function updateProjectiles(list, dt, enemyShot = false) {
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    p.mesh.position.addScaledVector(p.v, dt);
    p.life -= dt;
    if (!enemyShot) {
      for (let e = state.enemies.length - 1; e >= 0; e--) {
        const enemy = state.enemies[e];
        if (p.mesh.position.distanceTo(enemy.mesh.position) < 0.9) {
          const damage = 16 * (enemy.shield ? 0.38 : 1);
          enemy.hp -= damage;
          addSpark(enemy.mesh.position, enemy.shield ? 0x72d9ff : 0xff9a74, enemy.shield ? 6 : 10);
          scene.remove(p.mesh); list.splice(i,1); p.life = -1;
          state.score += 12; state.stateVersion++;
          if (enemy.hp <= 0) {
            addSpark(enemy.mesh.position, 0xff6075, 22);
            scene.remove(enemy.mesh); state.enemies.splice(e,1);
            state.kills++; state.score += 100; state.stateVersion++;
            tone(270, 0.13, 0.04);
          }
          break;
        }
      }
    } else if (p.mesh.position.distanceTo(player.position) < 0.75) {
      damagePlayer(9);
      addSpark(player.position, 0xff5168, 10);
      scene.remove(p.mesh); list.splice(i,1); p.life = -1;
    }
    if (p.life <= 0) {
      scene.remove(p.mesh);
      const idx = list.indexOf(p);
      if (idx >= 0) list.splice(idx,1);
    }
  }
}

function updateSparks(dt) {
  for (let i = state.sparks.length - 1; i >= 0; i--) {
    const s = state.sparks[i]; s.life -= dt;
    s.mesh.position.addScaledVector(s.v, dt);
    s.v.y -= 6 * dt;
    s.mesh.material.opacity = Math.max(0, s.life * 2);
    if (s.life <= 0) { scene.remove(s.mesh); state.sparks.splice(i,1); }
  }
}

function advanceWave() {
  if (!state.gameOver && state.enemies.length === 0) {
    state.wave++;
    state.health = Math.min(100, state.health + 18);
    state.score += 250;
    state.stateVersion++;
    spawnWave();
  }
}

function updateCamera(dt) {
  const forward = new THREE.Vector3(0,0,-1).applyQuaternion(player.quaternion);
  camTarget.copy(player.position).add(new THREE.Vector3(0, 8.8, 11.5)).addScaledVector(forward, -1.5);
  camera.position.lerp(camTarget, 1 - Math.pow(0.0008, dt));
  const look = player.position.clone().addScaledVector(forward, 4.1);
  look.y = 0.4;
  camera.lookAt(look);
}

function updateUI() {
  const hp = Math.round(state.health);
  ui.hp.style.width = hp + '%';
  ui.hpText.textContent = hp + '%';
  ui.score.textContent = String(state.score).padStart(5,'0');
  ui.wave.textContent = String(state.wave);
  ui.enemies.textContent = String(state.enemies.length);
  ui.tactic.textContent = state.lastTactic;
  ui.provider.textContent = state.provider;
  ui.provider.dataset.mode = state.provider;
  ui.status.textContent = state.provider === 'JEV' ? 'JEV live decisions' : (state.sessionKey ? 'JEV fallback active' : 'Local fallback · connect JEV');
}

function journeyProgress() {
  const movement = Math.min(0.18, state.distanceMoved / 80);
  const action = Math.min(0.18, state.attackCount / 36);
  const combat = Math.min(0.34, state.kills / 8);
  const wave = Math.min(0.3, Math.max(0, state.wave - 1) / 2);
  return Math.min(1, movement + action + combat + wave);
}
function outcomeState() {
  const controlsMet = state.distanceMoved > 1 && state.attackCount > 0;
  const decisionMet = state.decisionCount > 0 && (state.jevDecisionCount > 0 || state.fallbackCount > 0);
  const loopMet = state.wave >= 2 || state.kills >= 4;
  const all = controlsMet && decisionMet && loopMet;
  return {
    id: 'aegis-drift-outcome',
    status: all ? 'satisfied' : 'pending',
    criteria: [
      { id:'ac-0e3cb03b14e8', met:controlsMet, evidence: controlsMet ? 'movement and primary attack observed' : 'waiting for movement + attack' },
      { id:'ac-dc1e758d370b', met:decisionMet, evidence: `decisions=${state.decisionCount}, jev=${state.jevDecisionCount}, fallback=${state.fallbackCount}` },
      { id:'ac-5512e204c4de', met:loopMet, evidence: `wave=${state.wave}, kills=${state.kills}, score=${state.score}` },
    ]
  };
}

window.__ROOTAGENT_PLAYTEST__ = {
  observe() {
    const progress = journeyProgress();
    return {
      health: state.health,
      score: state.score,
      wave: state.wave,
      enemies: state.enemies.length,
      tactic: state.lastTactic,
      provider: state.provider,
      decisionCount: state.decisionCount,
      jevDecisionCount: state.jevDecisionCount,
      fallbackCount: state.fallbackCount,
      kills: state.kills,
      dodgeCount: state.dodgeCount,
      stateVersion: state.stateVersion,
      journey: {
        id: 'aegis-drift-core-loop',
        status: progress >= 0.999 ? 'succeeded' : (state.gameOver ? 'failed' : 'in_progress'),
        progress,
        milestone: state.wave >= 2 ? 'wave-advanced' : state.kills ? 'enemy-destroyed' : state.attackCount ? 'weapon-fired' : state.distanceMoved > 1 ? 'movement-established' : 'ready',
      },
      outcome: outcomeState(),
      feel: {
        playerPosition: { x: player.position.x, z: player.position.z },
        cameraPosition: { x: camera.position.x, z: camera.position.z },
        attackCount: state.attackCount,
      },
    };
  }
};

addEventListener('keydown', e => {
  const wasDown = keys.has(e.code);
  keys.add(e.code);
  if (!wasDown && ['KeyW','KeyA','KeyS','KeyD'].includes(e.code) && !state.gameOver) {
    const impulse = new THREE.Vector3(
      e.code === 'KeyD' ? 1 : e.code === 'KeyA' ? -1 : 0,
      0,
      e.code === 'KeyS' ? 1 : e.code === 'KeyW' ? -1 : 0
    ).normalize();
    velocity.addScaledVector(impulse, 2.25);
    state.stateVersion++;
  }
  if (e.code === 'Space') { e.preventDefault(); fire(); }
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') dodge();
  if (e.code === 'KeyR' && state.gameOver) restartGame();
});
addEventListener('keyup', e => keys.delete(e.code));
renderer.domElement.addEventListener('pointerdown', e => {
  if (e.button === 0) fire();
  state.audioReady = true;
});
ui.restart.addEventListener('click', restartGame);
ui.connect.addEventListener('click', () => {
  ui.dialog.showModal();
  ui.keyInput.value = '';
  setTimeout(() => ui.keyInput.focus(), 50);
});
ui.keyCancel.addEventListener('click', () => ui.dialog.close());
ui.keySave.addEventListener('click', () => {
  const value = ui.keyInput.value.trim();
  state.sessionKey = value;
  ui.keyInput.value = '';
  ui.dialog.close();
  state.status = value ? 'JEV session configured' : 'Local fallback';
  state.stateVersion++;
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

spawnWave();
let last = performance.now();
function animate(now) {
  const dt = Math.min(0.035, (now - last) / 1000 || 0.016);
  last = now;
  core.rotation.y += dt * 0.65;
  coreHalo.rotation.z += dt * 0.42;
  updatePlayer(dt);
  for (const enemy of state.enemies) updateEnemy(enemy, dt, now);
  updateProjectiles(state.projectiles, dt, false);
  updateProjectiles(state.enemyShots, dt, true);
  updateSparks(dt);
  advanceWave();
  updateCamera(dt);
  updateUI();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
