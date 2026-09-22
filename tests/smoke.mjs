import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync('index.html','utf8');
const game=fs.readFileSync('game.js','utf8');
const server=fs.readFileSync('server.mjs','utf8');
const all=html+'\n'+game+'\n'+server;

assert.ok(html.includes('<canvas id="game"'), 'real game canvas exists');
assert.ok(game.includes("getContext('webgl'"), 'real WebGL context is used');
assert.ok(game.includes('new PerspectiveCamera(') && game.includes('new Scene('), '3D scene and camera are constructed');
assert.ok(game.includes('AudioContext') && game.includes('createOscillator'), 'Web Audio feedback exists');
for(const id of ['CHASE','STRAFE','RETREAT','ATTACK','GUARD']) assert.ok(game.includes("'"+id+"'"), 'bounded JEV tactic '+id+' exists');
assert.ok(game.includes('questions:{decision:{type:\'choice\''), 'JEV request uses bounded choice question');
assert.ok(game.includes("this.apply(choice,'jev'"), 'JEV choice drives tactical state');
assert.ok(game.includes('fallback') && game.includes('catch(error)'), 'network failure has local fallback');
assert.ok(game.includes('__ROOTAGENT_PLAYTEST__') && game.includes('journey:') && game.includes('outcome:'), 'RootAgent runtime observation contract exists');
assert.ok(game.includes('ac-b83aaa8f4444') && game.includes('ac-629f35a094a5') && game.includes('ac-85e6b108536b'), 'runtime outcome IDs match frozen RootAgent contract');
assert.ok(server.includes('process.env.JEV_API_KEY') && server.includes("authorization:'Bearer '+key"), 'server reads JEV key from environment');
assert.ok(!all.includes('apikey_'), 'no real API key is committed to source');
assert.ok(!game.includes('localStorage') && !game.includes('sessionStorage'), 'browser session key is not persisted');
assert.ok(game.includes('requestAnimationFrame(loop)') && !/async\s+function\s+loop/.test(game), 'render loop is non-blocking');
console.log('ok - WebGL/JEV/input/security/playtest contract smoke checks pass');
