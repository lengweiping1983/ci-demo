const canvas = document.getElementById('game');
const gl = canvas.getContext('webgl', { antialias: true, alpha: false });
if (!gl) throw new Error('WebGL is required');

const ui = {
  hp: document.getElementById('hp'), hpfill: document.getElementById('hpfill'),
  score: document.getElementById('score'), wave: document.getElementById('wave'),
  tactic: document.getElementById('tacticName'), source: document.getElementById('jevSource'),
  key: document.getElementById('jevKey'), direct: document.getElementById('directBtn'),
  proxy: document.getElementById('proxyBtn'), message: document.getElementById('message'),
  gameover: document.getElementById('gameover'), finalScore: document.getElementById('finalScore'),
  restart: document.getElementById('restartBtn')
};

const OUTCOME_CONTROL = 'ac-b83aaa8f4444';
const OUTCOME_JEV = 'ac-629f35a094a5';
const OUTCOME_LOOP = 'ac-85e6b108536b';
const TACTICS = Object.freeze(['CHASE','STRAFE','RETREAT','ATTACK','GUARD']);
const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
const length2 = (x,z) => Math.hypot(x,z) || 1;
const random = (a,b) => a + Math.random() * (b-a);

class Scene { constructor(){ this.entities=[]; } add(v){ this.entities.push(v); return v; } }
class PerspectiveCamera {
  constructor(fov=Math.PI/3, near=.1, far=100){ this.fov=fov; this.near=near; this.far=far; this.position={x:0,y:10,z:14}; this.target={x:0,y:0,z:0}; this.viewProj=new Float32Array(16); }
  update(aspect){ const p=matPerspective(this.fov,aspect,this.near,this.far); const v=matLookAt([this.position.x,this.position.y,this.position.z],[this.target.x,this.target.y,this.target.z],[0,1,0]); this.viewProj=matMul(p,v); }
}
class PointLight { constructor(){this.position={x:0,y:4,z:0};this.intensity=1;} }
class DirectionalLight { constructor(){this.direction=[-.4,-1,-.25];this.intensity=1;} }

function matPerspective(fovy,aspect,near,far){
  const f=1/Math.tan(fovy/2), nf=1/(near-far), o=new Float32Array(16);
  o[0]=f/aspect;o[5]=f;o[10]=(far+near)*nf;o[11]=-1;o[14]=2*far*near*nf;return o;
}
function matLookAt(eye,center,up){
  let zx=eye[0]-center[0],zy=eye[1]-center[1],zz=eye[2]-center[2];let l=Math.hypot(zx,zy,zz)||1;zx/=l;zy/=l;zz/=l;
  let xx=up[1]*zz-up[2]*zy,xy=up[2]*zx-up[0]*zz,xz=up[0]*zy-up[1]*zx;l=Math.hypot(xx,xy,xz)||1;xx/=l;xy/=l;xz/=l;
  const yx=zy*xz-zz*xy,yy=zz*xx-zx*xz,yz=zx*xy-zy*xx;
  const o=new Float32Array(16);o[0]=xx;o[1]=yx;o[2]=zx;o[4]=xy;o[5]=yy;o[6]=zy;o[8]=xz;o[9]=yz;o[10]=zz;o[12]=-(xx*eye[0]+xy*eye[1]+xz*eye[2]);o[13]=-(yx*eye[0]+yy*eye[1]+yz*eye[2]);o[14]=-(zx*eye[0]+zy*eye[1]+zz*eye[2]);o[15]=1;return o;
}
function matMul(a,b){ const o=new Float32Array(16); for(let c=0;c<4;c++)for(let r=0;r<4;r++)o[c*4+r]=a[0*4+r]*b[c*4+0]+a[1*4+r]*b[c*4+1]+a[2*4+r]*b[c*4+2]+a[3*4+r]*b[c*4+3]; return o; }
function matModel(x,y,z,sx,sy,sz){ const o=new Float32Array(16);o[0]=sx;o[5]=sy;o[10]=sz;o[12]=x;o[13]=y;o[14]=z;o[15]=1;return o; }

const VS = `
attribute vec3 aPosition; attribute vec3 aNormal;
uniform mat4 uViewProj; uniform mat4 uModel; varying vec3 vNormal; varying vec3 vWorld;
void main(){ vec4 world=uModel*vec4(aPosition,1.0); vWorld=world.xyz; vNormal=normalize(mat3(uModel)*aNormal); gl_Position=uViewProj*world; }`;
const FS = `
precision mediump float; varying vec3 vNormal; varying vec3 vWorld;
uniform vec3 uColor; uniform vec3 uLightDir; uniform float uPulse;
void main(){ float d=max(.18,dot(normalize(vNormal),normalize(-uLightDir))); float glow=.18+.16*sin(uPulse+vWorld.x*.25+vWorld.z*.2); vec3 c=uColor*(d+glow); gl_FragColor=vec4(c,1.0); }`;
function shader(type,src){ const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s; }
const program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,VS));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,FS));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
const cube = new Float32Array([
-1,-1,-1, 0,0,-1, 1,-1,-1,0,0,-1, 1,1,-1,0,0,-1, -1,-1,-1,0,0,-1, 1,1,-1,0,0,-1, -1,1,-1,0,0,-1,
-1,-1,1,0,0,1, 1,1,1,0,0,1, 1,-1,1,0,0,1, -1,-1,1,0,0,1, -1,1,1,0,0,1, 1,1,1,0,0,1,
-1,1,-1,0,1,0, 1,1,-1,0,1,0, 1,1,1,0,1,0, -1,1,-1,0,1,0, 1,1,1,0,1,0, -1,1,1,0,1,0,
-1,-1,-1,0,-1,0, 1,-1,1,0,-1,0, 1,-1,-1,0,-1,0, -1,-1,-1,0,-1,0, -1,-1,1,0,-1,0, 1,-1,1,0,-1,0,
-1,-1,-1,-1,0,0, -1,1,-1,-1,0,0, -1,1,1,-1,0,0, -1,-1,-1,-1,0,0, -1,1,1,-1,0,0, -1,-1,1,-1,0,0,
1,-1,-1,1,0,0, 1,-1,1,1,0,0, 1,1,1,1,0,0, 1,-1,-1,1,0,0, 1,1,1,1,0,0, 1,1,-1,1,0,0
]);
const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,cube,gl.STATIC_DRAW);
const aPos=gl.getAttribLocation(program,'aPosition'),aNorm=gl.getAttribLocation(program,'aNormal');
const uVP=gl.getUniformLocation(program,'uViewProj'),uModel=gl.getUniformLocation(program,'uModel'),uColor=gl.getUniformLocation(program,'uColor'),uLight=gl.getUniformLocation(program,'uLightDir'),uPulse=gl.getUniformLocation(program,'uPulse');

class Renderer {
  constructor(){ this.domElement=canvas; this.directionalLight=new DirectionalLight(); this.pointLight=new PointLight(); }
  resize(){ const d=Math.min(2,devicePixelRatio||1),w=Math.floor(innerWidth*d),h=Math.floor(innerHeight*d); if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;} gl.viewport(0,0,w,h); }
  begin(camera,t){ this.resize(); gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE); gl.clearColor(.008,.018,.045,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT); gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER,buffer); gl.enableVertexAttribArray(aPos);gl.enableVertexAttribArray(aNorm);gl.vertexAttribPointer(aPos,3,gl.FLOAT,false,24,0);gl.vertexAttribPointer(aNorm,3,gl.FLOAT,false,24,12); gl.uniformMatrix4fv(uVP,false,camera.viewProj); gl.uniform3fv(uLight,this.directionalLight.direction);gl.uniform1f(uPulse,t); }
  cube(x,y,z,sx,sy,sz,color){ gl.uniformMatrix4fv(uModel,false,matModel(x,y,z,sx,sy,sz));gl.uniform3fv(uColor,color);gl.drawArrays(gl.TRIANGLES,0,36); }
}

const scene=new Scene(), camera=new PerspectiveCamera(), renderer=new Renderer();
const keys=new Set();
const player={position:{x:0,y:.65,z:5},velocity:{x:0,z:0},hp:100,maxHp:100,fireCooldown:0,dodgeCooldown:0,invulnerable:0};
const state={score:0,wave:1,gameOver:false,tactic:'GUARD',decisionSource:'fallback',decisionCycles:0,behaviorChanges:0,shotsFired:0,dodgeCount:0,kills:0,wavesCleared:0,flags:{moved:false,fired:false,dodged:false,jevApplied:false,waveCleared:false}};
let enemies=[],shots=[],particles=[],last=performance.now(),aimAngle=Math.PI,flashTimer=0,audio=null,messageTimer=null;

function spawnWave(){
  enemies=[];
  const count=3+state.wave;
  for(let i=0;i<count;i++){ const a=(i/count)*Math.PI*2+random(-.3,.3),r=random(9,15); enemies.push({position:{x:Math.cos(a)*r,z:Math.sin(a)*r},hp:2+Math.floor(state.wave/2),cooldown:random(.3,1.3),phase:random(0,6.2),color:[.95,.18+.15*Math.random(),.42]}); }
  announce('WAVE '+state.wave);
}
function announce(text){ ui.message.textContent=text;ui.message.style.opacity='1';clearTimeout(messageTimer);messageTimer=setTimeout(()=>ui.message.style.opacity='0',900); }
function ensureAudio(){ if(audio)return; const C=window.AudioContext||window.webkitAudioContext; if(C)audio=new C(); }
function tone(freq=.2,duration=.08,type='sine',gain=.035){ if(!audio)return; const o=audio.createOscillator(),g=audio.createGain();o.type=type;o.frequency.value=freq;g.gain.setValueAtTime(gain,audio.currentTime);g.gain.exponentialRampToValueAtTime(.0001,audio.currentTime+duration);o.connect(g);g.connect(audio.destination);o.start();o.stop(audio.currentTime+duration); }

class JevDirector {
  constructor(){ this.mode='off';this.sessionKey='';this.busy=false;this.lastAt=0;this.model='jev-latest'; }
  setDirect(key){ this.sessionKey=String(key||'').trim();this.mode=this.sessionKey?'direct':'off';ui.key.value='';ui.source.textContent=this.mode==='direct'?'JEV direct session · key held in memory only':'Local fallback ready'; }
  setProxy(){ this.sessionKey='';this.mode='proxy';ui.key.value='';ui.source.textContent='JEV local proxy enabled'; }
  fallback(){
    const nearest=enemies.reduce((m,e)=>Math.min(m,Math.hypot(e.position.x-player.position.x,e.position.z-player.position.z)),99);
    if(player.hp<35)return 'ATTACK'; if(nearest<3.5)return 'RETREAT'; if(enemies.length>=6)return 'STRAFE'; if(state.wave%3===0)return 'GUARD'; return 'CHASE';
  }
  async decide(){
    if(this.busy||state.gameOver)return; this.busy=true;
    const fallback=this.fallback();
    try{
      if(this.mode==='off'){ this.apply(fallback,'fallback'); return; }
      const criteria=Object.fromEntries(TACTICS.map(id=>[id,{label:id,enemyCount:enemies.length,playerHp:player.hp,distance:enemies[0]?Math.hypot(enemies[0].position.x-player.position.x,enemies[0].position.z-player.position.z):12,wave:state.wave}]));
      const body={model:this.model,state:{playerHp:player.hp,score:state.score,wave:state.wave,enemyCount:enemies.length,currentTactic:state.tactic},questions:{decision:{type:'choice',criteria,instructions:{goal:'Choose the enemy tactic that creates readable pressure without stalling the game.',rules:['Choose exactly one supplied candidate ID.','Prefer active counter-play and avoid repetitive behavior.']}}}};
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),1800);
      const url=this.mode==='direct'?'https://api.typesafe.ai/v1/systemone':'/api/jev/decision';
      const headers={'content-type':'application/json'}; if(this.mode==='direct')headers.authorization='Bearer '+this.sessionKey;
      const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(body),signal:controller.signal}); clearTimeout(timer);
      if(!response.ok)throw new Error('JEV HTTP '+response.status);
      const json=await response.json(),answer=json?.answers?.decision,choice=answer?.choice;
      if(!TACTICS.includes(choice))throw new Error('JEV returned an unbounded choice');
      this.apply(choice,'jev',answer?.confidence);
    }catch(error){
      this.apply(fallback,'fallback');
      ui.source.textContent='Fallback · '+String(error.message||error).slice(0,55);
    }finally{ this.busy=false; }
  }
  apply(choice,source,confidence){
    state.decisionCycles++;
    if(choice!==state.tactic)state.behaviorChanges++;
    state.tactic=choice;state.decisionSource=source; if(source==='jev')state.flags.jevApplied=true;
    ui.tactic.textContent=choice;ui.source.textContent=source==='jev'?'JEV · confidence '+(Number(confidence)||0).toFixed(2):'Local fallback · resilient mode';
  }
}
const director=new JevDirector();

function fireShot(){
  if(state.gameOver||player.fireCooldown>0)return;
  ensureAudio(); player.fireCooldown=.16; state.shotsFired++;state.flags.fired=true;
  const dx=Math.sin(aimAngle),dz=Math.cos(aimAngle);
  shots.push({x:player.position.x+dx*.8,y:.7,z:player.position.z+dz*.8,vx:dx*17,vz:dz*17,life:1.4});
  burst(player.position.x,.7,player.position.z,[.25,.9,1],4);tone(420,.06,'sawtooth',.025);
}
function dodge(){
  if(state.gameOver||player.dodgeCooldown>0)return;
  ensureAudio();player.dodgeCooldown=1.2;player.invulnerable=.38;state.dodgeCount++;state.flags.dodged=true;
  const x=(keys.has('KeyD')?1:0)-(keys.has('KeyA')?1:0),z=(keys.has('KeyS')?1:0)-(keys.has('KeyW')?1:0),l=length2(x,z);
  player.position.x+=x/l*2.2;player.position.z+=z/l*2.2;burst(player.position.x,.6,player.position.z,[.55,.4,1],16);tone(180,.12,'triangle',.04);
}
function burst(x,y,z,color,count=10){ for(let i=0;i<count;i++)particles.push({x,y,z,vx:random(-3,3),vy:random(.5,3),vz:random(-3,3),life:random(.25,.7),color}); }

addEventListener('keydown',e=>{keys.add(e.code);ensureAudio();if(e.code==='Space'){e.preventDefault();fireShot();}if(e.code==='ShiftLeft'||e.code==='ShiftRight')dodge();if(state.gameOver&&e.code==='Enter')restart();});
addEventListener('keyup',e=>keys.delete(e.code));
canvas.addEventListener('pointermove',e=>{ const r=canvas.getBoundingClientRect(),nx=(e.clientX-r.left)/r.width*2-1;aimAngle=Math.PI+nx*.95; });
canvas.addEventListener('pointerdown',()=>{ensureAudio();fireShot();});
ui.direct.addEventListener('click',()=>{ensureAudio();director.setDirect(ui.key.value);director.decide();});
ui.proxy.addEventListener('click',()=>{ensureAudio();director.setProxy();director.decide();});
ui.restart.addEventListener('click',restart);

function hitPlayer(amount){
  if(player.invulnerable>0||state.gameOver)return;
  player.hp=clamp(player.hp-amount,0,player.maxHp);flashTimer=.15;burst(player.position.x,.7,player.position.z,[1,.18,.35],12);tone(95,.18,'square',.045);
  if(player.hp<=0){state.gameOver=true;ui.gameover.style.display='grid';ui.finalScore.textContent='Score '+state.score+' · Wave '+state.wave;announce('SIGNAL LOST');}
}
function restart(){
  player.position.x=0;player.position.z=5;player.hp=100;player.velocity.x=0;player.velocity.z=0;state.score=0;state.wave=1;state.gameOver=false;state.shotsFired=0;state.dodgeCount=0;state.kills=0;state.wavesCleared=0;state.tactic='GUARD';state.decisionSource='fallback';state.decisionCycles=0;state.behaviorChanges=0;state.flags={moved:false,fired:false,dodged:false,jevApplied:false,waveCleared:false};shots=[];particles=[];ui.gameover.style.display='none';spawnWave();director.apply(director.fallback(),'fallback');
}

function update(dt,t){
  if(state.gameOver)return;
  player.fireCooldown=Math.max(0,player.fireCooldown-dt);player.dodgeCooldown=Math.max(0,player.dodgeCooldown-dt);player.invulnerable=Math.max(0,player.invulnerable-dt);flashTimer=Math.max(0,flashTimer-dt);
  let ix=(keys.has('KeyD')?1:0)-(keys.has('KeyA')?1:0),iz=(keys.has('KeyS')?1:0)-(keys.has('KeyW')?1:0);
  const il=length2(ix,iz);if(ix||iz){ix/=il;iz/=il;state.flags.moved=true;}
  const speed=player.invulnerable>0?9.5:5.2,targetX=ix*speed,targetZ=iz*speed,blend=1-Math.exp(-dt*11);
  player.velocity.x+=(targetX-player.velocity.x)*blend;player.velocity.z+=(targetZ-player.velocity.z)*blend;
  player.position.x+=player.velocity.x*dt;player.position.z+=player.velocity.z*dt;
  player.position.x=clamp(player.position.x,-13,13);player.position.z=clamp(player.position.z,-13,13);

  for(const e of enemies){
    const dx=player.position.x-e.position.x,dz=player.position.z-e.position.z,d=length2(dx,dz),nx=dx/d,nz=dz/d;
    let vx=0,vz=0,speedE=1.25+state.wave*.08;
    if(state.tactic==='CHASE'){vx=nx;vz=nz;}
    else if(state.tactic==='STRAFE'){vx=-nz*.85+nx*.25;vz=nx*.85+nz*.25;}
    else if(state.tactic==='RETREAT'){vx=d<7?-nx:nx*.45;vz=d<7?-nz:nz*.45;}
    else if(state.tactic==='ATTACK'){vx=nx*1.35;vz=nz*1.35;speedE*=1.25;}
    else {const target=6,err=d-target;vx=nx*clamp(err,-1,1)-nz*.35;vz=nz*clamp(err,-1,1)+nx*.35;}
    e.position.x+=vx*speedE*dt;e.position.z+=vz*speedE*dt;e.cooldown-=dt;
    if(d<1.25&&e.cooldown<=0){hitPlayer(state.tactic==='ATTACK'?16:10);e.cooldown=.75;}
  }

  for(const s of shots){s.x+=s.vx*dt;s.z+=s.vz*dt;s.life-=dt;for(const e of enemies){if(e.hp<=0)continue;if(Math.hypot(s.x-e.position.x,s.z-e.position.z)<.85){e.hp--;s.life=0;burst(e.position.x,.7,e.position.z,[1,.34,.62],10);tone(250,.05,'square',.02);if(e.hp<=0){state.kills++;state.score+=100+state.wave*20;burst(e.position.x,.8,e.position.z,[1,.75,.2],22);tone(72,.25,'sawtooth',.05);}}}}
  shots=shots.filter(s=>s.life>0);enemies=enemies.filter(e=>e.hp>0);

  for(const p of particles){p.x+=p.vx*dt;p.y+=p.vy*dt;p.z+=p.vz*dt;p.vy-=5*dt;p.life-=dt;}particles=particles.filter(p=>p.life>0);
  if(enemies.length===0){state.wavesCleared++;state.flags.waveCleared=true;state.wave++;spawnWave();}

  camera.target.x+=(player.position.x-camera.target.x)*(1-Math.exp(-dt*5));camera.target.z+=(player.position.z-camera.target.z)*(1-Math.exp(-dt*5));
  camera.position.x=camera.target.x+8+Math.sin(t*.00018)*1.8;camera.position.y=10;camera.position.z=camera.target.z+13;
}
function render(t){
  camera.update(canvas.width/Math.max(1,canvas.height));renderer.pointLight.position.x=player.position.x;renderer.pointLight.position.z=player.position.z;renderer.begin(camera,t*.004);
  renderer.cube(0,-.65,0,15,.15,15,[.035,.09,.14]);
  for(let i=-12;i<=12;i+=4){renderer.cube(i,-.47,0,.025,.03,13,[.06,.25,.32]);renderer.cube(0,-.47,i,13,.03,.025,[.06,.25,.32]);}
  const playerColor=flashTimer>0?[1,.25,.35]:player.invulnerable>0?[.72,.45,1]:[.18,.8,1];
  renderer.cube(player.position.x,.55,player.position.z,.55,.55,.8,playerColor);
  renderer.cube(player.position.x,.58,player.position.z-.72,.22,.2,.65,[.4,.95,1]);
  for(const e of enemies){renderer.cube(e.position.x,.55,e.position.z,.58,.58,.58,e.color);renderer.cube(e.position.x,.8,e.position.z,.25,.2,.25,[1,.55,.75]);}
  for(const s of shots)renderer.cube(s.x,s.y,s.z,.12,.12,.35,[.35,1,1]);
  for(const p of particles)renderer.cube(p.x,p.y,p.z,.07,.07,.07,p.color);
}
function updateHud(){
  ui.hp.textContent=Math.ceil(player.hp);ui.hpfill.style.width=(player.hp/player.maxHp*100)+'%';ui.score.textContent=state.score;ui.wave.textContent=state.wave;ui.tactic.textContent=state.tactic;
}
function loop(now){
  const dt=Math.min(.033,(now-last)/1000||.016);last=now;update(dt,now);updateHud();render(now);requestAnimationFrame(loop);
}
setInterval(()=>director.decide(),2600);

function journeyProgress(){
  return clamp((state.flags.moved?.2:0)+(state.flags.fired?.2:0)+(state.flags.dodged?.1:0)+(state.decisionCycles>0?.2:0)+(state.score>0?.15:0)+(state.flags.waveCleared?.15:0),0,1);
}
window.__ROOTAGENT_PLAYTEST__={
  observe(){
    const controlMet=state.flags.moved&&state.flags.fired;
    const jevMet=state.decisionCycles>0&&state.behaviorChanges>0;
    const loopMet=state.flags.waveCleared&&state.wavesCleared>0;
    const allMet=controlMet&&jevMet&&loopMet;
    const progress=journeyProgress();
    return {
      player:{x:Number(player.position.x.toFixed(3)),z:Number(player.position.z.toFixed(3)),hp:player.hp},
      score:state.score,wave:state.wave,shotsFired:state.shotsFired,dodgeCount:state.dodgeCount,enemyCount:enemies.length,
      tactic:state.tactic,decisionSource:state.decisionSource,decisionCycles:state.decisionCycles,behaviorChanges:state.behaviorChanges,
      journey:{id:'arena-core-loop',status:state.gameOver?'failed':(allMet?'succeeded':'in_progress'),progress,milestone:loopMet?'wave-cleared':state.score>0?'first-kill':state.flags.fired?'first-shot':state.flags.moved?'first-move':'spawned'},
      outcome:{id:'rootagent-jev-3d-game',status:allMet?'satisfied':(state.gameOver?'failed':'pending'),criteria:[
        {id:OUTCOME_CONTROL,met:controlMet,evidence:'movement='+state.flags.moved+', fired='+state.flags.fired},
        {id:OUTCOME_JEV,met:jevMet,evidence:'decisionCycles='+state.decisionCycles+', behaviorChanges='+state.behaviorChanges+', source='+state.decisionSource},
        {id:OUTCOME_LOOP,met:loopMet,evidence:'wavesCleared='+state.wavesCleared+', score='+state.score}
      ]}
    };
  }
};

spawnWave();director.apply(director.fallback(),'fallback');requestAnimationFrame(loop);
