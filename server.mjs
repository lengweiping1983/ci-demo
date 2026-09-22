import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const allowedTactics = new Set(['CHASE','STRAFE','RETREAT','ATTACK','GUARD']);
const mime = {'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};

function apiKey() {
  const raw = process.env.TYPESAFE_API_KEY || process.env.ROOTAGENT_JEV_API_KEYS || '';
  return String(raw).split(/[\s,;]+/).map(x=>x.trim()).find(Boolean) || '';
}

function send(res,status,body,type='application/json; charset=utf-8'){
  res.writeHead(status,{'content-type':type,'cache-control':'no-store'});
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const server = http.createServer(async (req,res)=>{
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/api/jev') {
    const key = apiKey();
    if (!key) return send(res,503,{error:'JEV_NOT_CONFIGURED'});
    let body='';
    req.setEncoding('utf8');
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 200_000) return send(res,413,{error:'BODY_TOO_LARGE'});
    }
    let parsed;
    try { parsed=JSON.parse(body || '{}'); } catch { return send(res,400,{error:'INVALID_JSON'}); }
    const ids = Object.keys(parsed?.questions?.decision?.criteria || {});
    if (ids.length !== 5 || !ids.every(id=>allowedTactics.has(id))) return send(res,400,{error:'UNBOUNDED_TACTICS'});
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(),1600);
    try {
      const upstream = await fetch(TYPESAFE_ENDPOINT,{
        method:'POST',
        headers:{authorization:'Bearer '+key,'content-type':'application/json'},
        body:JSON.stringify(parsed),
        signal:controller.signal,
      });
      const text = await upstream.text();
      res.writeHead(upstream.status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      res.end(text);
    } catch (error) {
      send(res,502,{error:'JEV_UPSTREAM_FAILED',message:String(error?.name || 'error')});
    } finally { clearTimeout(timer); }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(302, { location: '/index.html?jev_proxy=1' });
    res.end();
    return;
  }

  let rel = decodeURIComponent(url.pathname);
  const file = path.resolve(root, '.'+rel);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res,404,'Not found','text/plain; charset=utf-8');
  const ext=path.extname(file).toLowerCase();
  res.writeHead(200,{'content-type':mime[ext] || 'application/octet-stream','cache-control': ext==='.html' ? 'no-cache' : 'public,max-age=300'});
  fs.createReadStream(file).pipe(res);
});
server.listen(port,'127.0.0.1',()=>console.log('AEGIS DRIFT http://127.0.0.1:'+port));
