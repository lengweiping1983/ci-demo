import fs from 'node:fs';
import assert from 'node:assert/strict';

const html = fs.readFileSync('index.html', 'utf8');
const js = fs.readFileSync('game.js', 'utf8');
const css = fs.readFileSync('styles.css', 'utf8');

assert.ok(html.includes('JEV // NEON ARENA'), 'game title missing');
assert.ok(js.includes('THREE.WebGLRenderer'), 'real WebGL renderer required');
assert.ok(js.includes('requestAnimationFrame'), 'non-blocking game loop required');
assert.ok(js.includes('AudioContext') || js.includes('webkitAudioContext'), 'Web Audio feedback required');
assert.ok(js.includes('__ROOTAGENT_PLAYTEST__'), 'RootAgent runtime observation hook required');
assert.ok(js.includes('MOVE_FORWARD') === false, 'game must not contain RootAgent tester action implementation');
assert.ok(js.includes("'CHASE'") && js.includes("'ATTACK'") && js.includes("'RETREAT'"), 'bounded JEV tactics missing');
assert.ok(js.includes('api.typesafe.ai/v1/systemone'), 'JEV runtime integration missing');
assert.ok(js.includes('LOCAL FALLBACK'), 'offline decision fallback missing');
assert.ok(!/apikey_[a-zA-Z0-9_]+/.test(html + js + css), 'API key must never be committed to static site');
assert.ok(js.includes('keydown') && js.includes('keyup'), 'keyboard controls required');
assert.ok(js.includes('gameOver') && js.includes('restart'), 'complete gameplay loop required');

console.log('ci-demo smoke: PASS');
