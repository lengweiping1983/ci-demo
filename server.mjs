import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.PORT||4173);
const JEV_ENDPOINT='https://api.typesafe.ai/v1/systemone';
const ALLOWED=new Set(['CHASE','STRAFE','RETREAT','ATTACK','GUARD']);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.css':'text/css; charset=utf-8'};

function send(res,status,body,type='application/json; charset=utf-8'){res.writeHead(status,{'content-type':type,'cache-control':'no-store'});res.end(body);}
function readBody(req){return new Promise((resolve,reject)=>{let s='';req.on('data',d=>{s+=d;if(s.length>100000)reject(new Error('body too large'));});req.on('end',()=>resolve(s));req.on('error',reject);});}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(req.method==='POST'&&url.pathname==='/api/jev/decision'){
    try{
      const key=process.env.JEV_API_KEY||process.env.TYPESAFE_API_KEY;
      if(!key)return send(res,503,JSON.stringify({error:'JEV_API_KEY is not configured'}));
      const body=JSON.parse(await readBody(req));
      const ids=Object.keys(body?.questions?.decision?.criteria||{});
      if(ids.length!==ALLOWED.size||ids.some(id=>!ALLOWED.has(id)))return send(res,400,JSON.stringify({error:'unbounded tactic candidates'}));
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),2500);
      const upstream=await fetch(JEV_ENDPOINT,{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
      clearTimeout(timer);const text=await upstream.text();
      return send(res,upstream.status,text,upstream.headers.get('content-type')||'application/json; charset=utf-8');
    }catch(error){return send(res,502,JSON.stringify({error:'JEV proxy failed',detail:String(error.message||error).slice(0,120)}));}
  }
  if(req.method!=='GET'&&req.method!=='HEAD')return send(res,405,'method not allowed','text/plain; charset=utf-8');
  let rel=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname).replace(/^\/+/, '');
  if(rel.includes('..'))return send(res,400,'bad path','text/plain; charset=utf-8');
  const file=path.join(root,rel);
  if(!file.startsWith(root)||!fs.existsSync(file)||!fs.statSync(file).isFile())return send(res,404,'not found','text/plain; charset=utf-8');
  res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream','cache-control':'no-cache'});
  if(req.method==='HEAD')return res.end();fs.createReadStream(file).pipe(res);
});
server.listen(port,()=>console.log('NEON TACTICS server http://localhost:'+port+' (JEV key loaded from environment only)'));
