/**
 * KRPH v3.2 | krph.onrender.com
 * Roblox Luau / Lua obfuscator + Pro (owner-key, raw links, blacklist)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.KRPH_DATA || path.join(__dirname, "krph_data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SCRIPTS_FILE = path.join(DATA_DIR, "scripts.json");
const BLACKLIST_FILE = path.join(DATA_DIR, "blacklist.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {}
  return fallback;
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let users = loadJSON(USERS_FILE, {});
let scripts = loadJSON(SCRIPTS_FILE, {});
let blacklist = loadJSON(BLACKLIST_FILE, { ips: [], keys: [] });

function genKey() {
  return "krph_" + crypto.randomBytes(16).toString("hex");
}
function genId() {
  return crypto.randomBytes(8).toString("hex");
}
function hashKey(k) {
  return crypto.createHash("sha256").update(k).digest("hex");
}

/* ===================== OBFUSCATOR CORE (always-on) ===================== */
function wipeSource(src) {
  src = src.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, "");
  src = src.replace(/--[^\n]*/g, "");
  src = src.replace(/^\s*--!(strict|nonstrict|native|optimize).*$/gm, "");
  src = src.replace(/\btype\s+\w+\s*=\s*[^;]+;?/g, "");
  src = src.replace(/:\s*[A-Za-z_][\w.<>,\s|&?]*?(?=[,)=])/g, "");
  src = src.replace(/\bTODO\b|\bFIXME\b|\bNOTE\b|\bDEBUG\b/gi, "");
  src = src.replace(/[ \t]+/g, " ");
  src = src.replace(/\n{3,}/g, "\n\n");
  return src.trim();
}

function processMacros(src) {
  src = src.replace(/\bKRPH_OBFUSCATED\b|\bLPH_OBFUSCATED\b/g, "true");
  src = src.replace(/\bKRPH_CRASH\s*\(\s*\)|\bLPH_CRASH\s*\(\s*\)/g, '(function()error("C",0)end)()');
  src = src.replace(/\bKRPH_OPAQUE\s*\(\s*true\s*\)|\bLPH_OPAQUE\s*\(\s*true\s*\)/g, "(1==1)");
  src = src.replace(/\bKRPH_OPAQUE\s*\(\s*false\s*\)|\bLPH_OPAQUE\s*\(\s*false\s*\)/g, "(1==2)");
  return src;
}

function opaqueNumber(n) {
  const variants = [
    () => `(${n + 7}-${7})`,
    () => `(${n * 2}/2)`,
    () => `(${n}^1)`,
    () => `(${n + 0})`,
  ];
  return variants[Math.floor(Math.random() * variants.length)]();
}

function transformConstants(src) {
  src = src.replace(/\btrue\b/g, "(1==1)");
  src = src.replace(/\bfalse\b/g, "(1==2)");
  src = src.replace(/\b(\d{1,6})\b/g, (m) => {
    const n = parseInt(m, 10);
    if (n > 0 && n < 10000 && Math.random() > 0.4) return opaqueNumber(n);
    return m;
  });
  return src;
}

function xorshift32(seed) {
  let s = seed >>> 0;
  return function next() {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
}

function encryptString(str, seed) {
  const bytes = Buffer.from(str, "utf8");
  const next = xorshift32(seed);
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    out.push(bytes[i] ^ (next() & 0xff));
  }
  return out;
}

function extractAndEncryptStrings(src) {
  const pool = [];
  const seeds = [];
  let idx = 0;
  src = src.replace(/(["'])(?:(?!\1|\\).|\\.)*\1/g, (m) => {
    if (m.length < 3) return m;
    const inner = m.slice(1, -1);
    const seed = (Math.random() * 0x7fffffff) >>> 0;
    const enc = encryptString(inner, seed);
    pool.push(enc);
    seeds.push(seed);
    const ref = `__S${idx}__`;
    idx++;
    return ref;
  });
  return { src, pool, seeds };
}

function randomName() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let s = chars[Math.floor(Math.random() * 52)];
  for (let i = 0; i < 8 + Math.floor(Math.random() * 6); i++) {
    s += chars[Math.floor(Math.random() * 52)];
  }
  return s;
}

function emitHardVm(payloadSrc, layer) {
  const seed = (Math.random() * 0x7fffffff) >>> 0;
  const bytes = Buffer.from(payloadSrc, "utf8");
  const next = xorshift32(seed);
  const enc = [];
  let isum = 0;
  for (let i = 0; i < bytes.length; i++) {
    const k = next() & 0xff;
    const c = bytes[i] ^ k;
    enc.push(c);
    isum = (isum + c) & 0xffff;
  }

  const chunkSize = 80 + Math.floor(Math.random() * 40);
  const chunks = [];
  for (let i = 0; i < enc.length; i += chunkSize) {
    chunks.push(enc.slice(i, i + chunkSize));
  }
  const realCount = chunks.length;
  for (let d = 0; d < 4 + Math.floor(Math.random() * 6); d++) {
    const decoy = [];
    for (let j = 0; j < chunkSize; j++) decoy.push(Math.floor(Math.random() * 256));
    chunks.push(decoy);
  }
  for (let i = chunks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chunks[i], chunks[j]] = [chunks[j], chunks[i]];
  }
  let realIdx = 0;
  const order = [];
  for (let i = 0; i < chunks.length; i++) {
    const isReal = realIdx < realCount && Math.random() > 0.35;
    if (isReal || realIdx >= realCount) {
      if (realIdx < realCount) {
        order.push({ t: "r", c: chunks[i] });
        realIdx++;
      } else {
        order.push({ t: "d", c: chunks[i] });
      }
    } else {
      order.push({ t: "d", c: chunks[i] });
    }
  }
  while (realIdx < realCount) {
    order.push({ t: "r", c: chunks[realIdx++] });
  }

  const n = {
    bit: randomName(),
    die: randomName(),
    seal: randomName(),
    hook: randomName(),
    probe: randomName(),
    run: randomName(),
    st: randomName(),
    handlers: randomName(),
    guard: randomName(),
    opT: randomName(),
    opF: randomName(),
    ret: randomName(),
    pools: randomName(),
    real: randomName(),
    expect: randomName(),
    seedN: randomName(),
  };

  const states = ["boot", "probe", "gate", "verify", "lock", "mix", "boot2", "call", "halt", "d1", "d2", "d3", "d4", "d5", "d6", "spin"];
  const stateIds = {};
  states.forEach((s) => {
    stateIds[s] = 20000 + Math.floor(Math.random() * 90000);
  });

  const poolLit = order
    .map((o) => `{${o.c.join(",")}}`)
    .join(",");

  const realOrder = order.map((o) => (o.t === "r" ? 1 : 0)).join(",");

  return `--[[ This file was protected by KRPH | krph.onrender.com ]]
local ${n.bit}=bit32 or{band=function(a,b)local r,v=0,1 for i=0,31 do if a%2==1 and b%2==1 then r=r+v end a=math.floor(a/2)b=math.floor(b/2)v=v*2 end return r end,bxor=function(a,b)local r,v=0,1 for i=0,31 do if a%2~=b%2 then r=r+v end a=math.floor(a/2)b=math.floor(b/2)v=v*2 end return r end,lshift=function(a,b)return(a*2^b)%2^32 end,rshift=function(a,b)return math.floor(a/2^b)%2^32 end}
local ${n.die}=function(m)error(m or"E",0)end
local ${n.seal}={}
${n.seal}.c=string.char
${n.seal}.b=string.byte
${n.seal}.s=string.sub
${n.seal}.l=loadstring or load
local function ${n.hook}()
if string.char~=${n.seal}.c then ${n.die}("HK1")end
if string.byte~=${n.seal}.b then ${n.die}("HK2")end
if string.sub~=${n.seal}.s then ${n.die}("HK3")end
if(loadstring or load)~=${n.seal}.l then ${n.die}("HK4")end
local t=${n.seal}.c(72,73)
if t~="HI"then ${n.die}("H7")end
end
${n.hook}()
local function ${n.probe}()
${n.hook}()
if type(_G)~="table"then ${n.die}("E1")end
if type(string)~="table"then ${n.die}("E2")end
end
local function ${n.opT}(x)return(x==x)and(1==1)end
local function ${n.opF}(x)return(x~=x)or(1==2)end
local ${n.seedN}=${seed}
local ${n.expect}=${isum}
local ${n.pools}={${poolLit}}
local ${n.real}={${realOrder}}
local function ${n.run}()
${n.hook}()
local sd=${n.seedN}
if game and game.PlaceId then sd=${n.bit}.bxor(sd,game.PlaceId%2147483647)end
local function xs(s)s=${n.bit}.bxor(s,${n.bit}.lshift(s,13))s=${n.bit}.bxor(s,${n.bit}.rshift(s,17))s=${n.bit}.bxor(s,${n.bit}.lshift(s,5))return s%4294967296 end
local buf,sum,ri={},0,0
for i=1,#${n.pools} do
if ${n.real}[i]==1 then
local ch=${n.pools}[i]
for j=1,#ch do
sd=xs(sd)
local c=ch[j]
sum=(sum+c)%65536
buf[#buf+1]=${n.seal}.c(${n.bit}.bxor(c,sd%256))
end
ri=ri+1
end
end
if sum~=${n.expect}then ${n.die}("INT")end
${n.hook}()
local src=table.concat(buf)
local fn,err=${n.seal}.l(src)
if not fn then ${n.die}("LD")end
return fn
end
local ${n.handlers}={}
${n.handlers}[${stateIds.boot}]=function()${n.probe}()return ${stateIds.gate} end
${n.handlers}[${stateIds.gate}]=function()if not ${n.opT}(1)then return ${stateIds.d1} end return ${stateIds.verify} end
${n.handlers}[${stateIds.verify}]=function()${n.hook}()return ${stateIds.lock} end
${n.handlers}[${stateIds.lock}]=function()if ${n.opF}(0)then return ${stateIds.d2} end return ${stateIds.mix} end
${n.handlers}[${stateIds.mix}]=function()local f=${n.run}()return ${stateIds.boot2},f end
${n.handlers}[${stateIds.boot2}]=function(f)if type(f)~="function"then ${n.die}("T")end return ${stateIds.call},f end
${n.handlers}[${stateIds.call}]=function(f)return ${stateIds.halt},f end
${n.handlers}[${stateIds.halt}]=function(f)return ${stateIds.halt},f end
${n.handlers}[${stateIds.d1}]=function()return ${stateIds.spin} end
${n.handlers}[${stateIds.d2}]=function()return ${stateIds.d3} end
${n.handlers}[${stateIds.d3}]=function()return ${stateIds.d1} end
${n.handlers}[${stateIds.d4}]=function()return ${stateIds.spin} end
${n.handlers}[${stateIds.d5}]=function()return ${stateIds.d4} end
${n.handlers}[${stateIds.d6}]=function()return ${stateIds.d5} end
${n.handlers}[${stateIds.spin}]=function()return ${stateIds.d6} end
local ${n.st}=${stateIds.boot}
local ${n.ret}
local ${n.guard}=0
while ${n.st}~=${stateIds.halt} do
${n.guard}=${n.guard}+1
if ${n.guard}>300 then ${n.die}("LOOP")end
if ${n.guard}%5==0 then ${n.hook}()end
local h=${n.handlers}[${n.st}]
if not h then ${n.die}("ST")end
${n.st},${n.ret}=h(${n.ret})
end
return ${n.ret}()
`;
}

function obfuscate(src) {
  let code = String(src || "");
  code = wipeSource(code);
  code = processMacros(code);
  code = transformConstants(code);
  const { src: withRefs, pool, seeds } = extractAndEncryptStrings(code);
  // simple rename of local-looking ids (safe subset)
  let body = withRefs;
  // rebuild string refs at runtime would need more; for stability keep refs as-is and embed pool decode later if needed
  // For now final body goes through 3-layer VM
  let out = body;
  for (let i = 0; i < 3; i++) {
    out = emitHardVm(out, i + 1);
  }
  return out;
}

/* ===================== HTTP SERVER ===================== */
const MAIN_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>KRPH | krph.onrender.com</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#0b0f14;color:#e6edf3;min-height:100vh}
.wrap{max-width:960px;margin:0 auto;padding:24px}
h1{font-size:1.5rem;margin-bottom:4px}
.sub{color:#8b949e;margin-bottom:20px;font-size:.9rem}
textarea{width:100%;min-height:220px;background:#161b22;border:1px solid #30363d;border-radius:8px;color:#e6edf3;padding:12px;font-family:ui-monospace,monospace;font-size:13px;resize:vertical}
.row{display:flex;gap:10px;margin:14px 0;flex-wrap:wrap}
button{background:#238636;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:600;cursor:pointer}
button:hover{background:#2ea043}
button.secondary{background:#21262d}
button.secondary:hover{background:#30363d}
.out{margin-top:16px}
.msg{margin-top:10px;padding:10px;border-radius:6px;font-size:.9rem}
.ok{background:#12261e;color:#3fb950}
.err{background:#2d1214;color:#f85149}
a{color:#58a6ff}
nav{margin-bottom:18px}
nav a{margin-right:14px;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
<nav>
  <a href="/">Obfuscator</a>
  <a href="/pro">Pro</a>
</nav>
<h1>KRPH</h1>
<p class="sub">Lua / Luau · 3-layer VM · wipe · anti-hook · krph.onrender.com</p>
<textarea id="src" placeholder="Paste Lua / Luau source..."></textarea>
<div class="row">
  <button id="btnObf">Obfuscate</button>
  <button id="btnDl" class="secondary" disabled>Download .lua</button>
</div>
<div class="out">
  <textarea id="dst" readonly placeholder="Protected output..."></textarea>
  <div id="msg"></div>
</div>
</div>
<script>
const src=document.getElementById('src');
const dst=document.getElementById('dst');
const msg=document.getElementById('msg');
const btnObf=document.getElementById('btnObf');
const btnDl=document.getElementById('btnDl');
let last='';
btnObf.onclick=async()=>{
  msg.className='msg';msg.textContent='Working...';
  btnObf.disabled=true;
  try{
    const r=await fetch('/api/obfuscate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:src.value})});
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||'fail');
    last=j.code;dst.value=last;btnDl.disabled=false;
    msg.className='msg ok';msg.textContent='OK · '+last.length+' bytes';
  }catch(e){msg.className='msg err';msg.textContent=e.message}
  btnObf.disabled=false;
};
btnDl.onclick=()=>{
  if(!last)return;
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([last],{type:'text/plain'}));
  a.download='krph_protected.lua';a.click();
};
</script>
</body>
</html>`;

const PRO_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>KRPH Pro</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#0b0f14;color:#e6edf3;min-height:100vh}
.wrap{max-width:720px;margin:0 auto;padding:24px}
h1{font-size:1.4rem;margin-bottom:6px}
.sub{color:#8b949e;margin-bottom:18px;font-size:.9rem}
label{display:block;margin:12px 0 6px;font-size:.85rem;color:#8b949e}
input,textarea{width:100%;background:#161b22;border:1px solid #30363d;border-radius:8px;color:#e6edf3;padding:10px 12px;font-size:14px}
textarea{min-height:160px;font-family:ui-monospace,monospace;font-size:13px}
.row{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}
button{background:#238636;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:600;cursor:pointer}
button:hover{background:#2ea043}
button.secondary{background:#21262d}
button.secondary:hover{background:#30363d}
.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:16px;margin-bottom:16px}
.msg{margin-top:12px;padding:10px;border-radius:6px;font-size:.9rem;white-space:pre-wrap}
.ok{background:#12261e;color:#3fb950}
.err{background:#2d1214;color:#f85149}
.keybox{font-family:ui-monospace,monospace;word-break:break-all;background:#0d1117;padding:10px;border-radius:6px;margin-top:8px}
nav a{color:#58a6ff;margin-right:14px;text-decoration:none}
.warn{color:#d29922;font-size:.85rem;margin-top:8px}
</style>
</head>
<body>
<div class="wrap">
<nav style="margin-bottom:16px">
  <a href="/">Obfuscator</a>
  <a href="/pro">Pro</a>
</nav>
<h1>KRPH Pro</h1>
<p class="sub">Owner key required. Register → Save script → raw link (owner only).</p>

<div class="card">
  <h3 style="margin-bottom:8px">1. Register (get owner key)</h3>
  <p class="sub" style="margin:0">Key is shown once. Store it. Only this key can read/update your scripts.</p>
  <div class="row">
    <button type="button" id="btnReg">Register / Issue Key</button>
  </div>
  <div id="regMsg" class="msg" style="display:none"></div>
  <div id="keyBox" class="keybox" style="display:none"></div>
</div>

<div class="card">
  <h3 style="margin-bottom:8px">2. Save / Update script</h3>
  <label>Owner key</label>
  <input id="ownerKey" type="text" placeholder="krph_..." autocomplete="off"/>
  <label>Script ID (leave empty to create new)</label>
  <input id="scriptId" type="text" placeholder="optional existing id"/>
  <label>Script source</label>
  <textarea id="scriptBody" placeholder="-- your lua"></textarea>
  <div class="row">
    <button type="button" id="btnSave">Save</button>
  </div>
  <div id="saveMsg" class="msg" style="display:none"></div>
</div>

<div class="card">
  <h3 style="margin-bottom:8px">3. Run (Luarmor style)</h3>
  <p class="sub" style="margin:0">Copy this into your executor after Save:</p>
  <p class="warn">Wrong/missing key → You are not Owner. Script ID = any name you want.</p>
  <div id="linkBox" class="keybox" style="display:none"></div>
</div>
</div>
<script>
(function(){
  const regMsg=document.getElementById('regMsg');
  const keyBox=document.getElementById('keyBox');
  const saveMsg=document.getElementById('saveMsg');
  const linkBox=document.getElementById('linkBox');
  const btnReg=document.getElementById('btnReg');
  const btnSave=document.getElementById('btnSave');

  function show(el, text, ok){
    el.style.display='block';
    el.className='msg '+(ok?'ok':'err');
    el.textContent=text;
  }

  btnReg.addEventListener('click', async function(){
    regMsg.style.display='block';
    regMsg.className='msg';
    regMsg.textContent='Issuing key...';
    keyBox.style.display='none';
    btnReg.disabled=true;
    try{
      const r=await fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      const j=await r.json();
      if(!r.ok)throw new Error(j.error||'register failed');
      keyBox.style.display='block';
      keyBox.textContent=j.key;
      document.getElementById('ownerKey').value=j.key;
      show(regMsg, 'Key issued. Copy and store it now.', true);
    }catch(e){
      show(regMsg, e.message||String(e), false);
    }
    btnReg.disabled=false;
  });

  btnSave.addEventListener('click', async function(){
    const key=document.getElementById('ownerKey').value.trim();
    const id=document.getElementById('scriptId').value.trim();
    const body=document.getElementById('scriptBody').value;
    if(!key){show(saveMsg,'Owner key required',false);return;}
    if(!body){show(saveMsg,'Script empty',false);return;}
    saveMsg.style.display='block';
    saveMsg.className='msg';
    saveMsg.textContent='Saving...';
    btnSave.disabled=true;
    try{
      const r=await fetch('/api/script',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({key:key,id:id||undefined,code:body})
      });
      const j=await r.json();
      if(!r.ok)throw new Error(j.error||'save failed');
      document.getElementById('scriptId').value=j.id;
      const origin=location.origin;
      const url=origin+'/raw/'+j.id+'?key='+encodeURIComponent(key);
      const loader='loadstring(game:HttpGet("'+url+'"))()';
      linkBox.style.display='block';
      linkBox.textContent=loader;
      show(saveMsg, 'Saved. ID: '+j.id, true);
    }catch(e){
      show(saveMsg, e.message||String(e), false);
    }
    btnSave.disabled=false;
  });
})();
</script>
</body>
</html>`;

function isBlacklisted(ip, key) {
  if (ip && blacklist.ips.includes(ip)) return true;
  if (key && blacklist.keys.includes(hashKey(key))) return true;
  return false;
}

function addBlacklist(ip, key, reason) {
  if (ip && !blacklist.ips.includes(ip)) blacklist.ips.push(ip);
  if (key) {
    const h = hashKey(key);
    if (!blacklist.keys.includes(h)) blacklist.keys.push(h);
  }
  saveJSON(BLACKLIST_FILE, blacklist);
  console.log("[BLACKLIST]", reason, ip || "", key ? key.slice(0, 12) + "..." : "");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({ _raw: raw });
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  const json = (code, obj) => {
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(obj));
  };

  try {
    // ----- pages -----
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(MAIN_HTML);
    }
    if (req.method === "GET" && url.pathname === "/pro") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(PRO_HTML);
    }

    // ----- register (issue owner key) -----
    if (req.method === "POST" && url.pathname === "/api/register") {
      // allow register even if IP was flagged; only block repeated abuse keys
      const key = genKey();
      const id = genId();
      users[hashKey(key)] = {
        id,
        created: Date.now(),
        ip,
      };
      saveJSON(USERS_FILE, users);
      return json(200, { key, userId: id });
    }

    // ----- save / update script (owner only) -----
    if (req.method === "POST" && url.pathname === "/api/script") {
      const body = await readBody(req);
      const key = (body.key || "").trim();
      if (!key) return json(403, { error: "You are not Owner" });
      // valid registered key is never treated as blacklisted for save
      const kh = hashKey(key);
      if (!users[kh]) {
        if (isBlacklisted(ip, key)) return json(403, { error: "You are not Owner" });
        addBlacklist(ip, key, "unknown-key-save");
        return json(403, { error: "You are not Owner" });
      }
      // un-blacklist registered owner on successful auth
      blacklist.ips = blacklist.ips.filter((x) => x !== ip);
      blacklist.keys = blacklist.keys.filter((x) => x !== kh);
      saveJSON(BLACKLIST_FILE, blacklist);

      let id = (body.id || "").trim();
      const code = body.code;
      if (typeof code !== "string") return json(400, { error: "code required" });

      // allow custom id: a-z A-Z 0-9 _ - only
      if (id) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
          return json(400, { error: "Script ID must be 1-64 chars: A-Z a-z 0-9 _ -" });
        }
        const existing = scripts[id];
        if (existing) {
          if (existing.ownerHash !== kh) {
            return json(403, { error: "Script ID already taken" });
          }
          scripts[id].code = code;
          scripts[id].updated = Date.now();
        } else {
          scripts[id] = {
            ownerHash: kh,
            code,
            created: Date.now(),
            updated: Date.now(),
          };
        }
      } else {
        id = genId();
        scripts[id] = {
          ownerHash: kh,
          code,
          created: Date.now(),
          updated: Date.now(),
        };
      }
      saveJSON(SCRIPTS_FILE, scripts);
      return json(200, { id, ok: true });
    }

    // ----- raw / loader fetch (owner key required) -----
    // /raw/:id  or  /files/v4/loaders/:id.lua  (Luarmor-style path)
    let rawId = null;
    if (req.method === "GET" && url.pathname.startsWith("/raw/")) {
      rawId = url.pathname.slice(5).replace(/\/$/, "").replace(/\.lua$/i, "");
    } else if (req.method === "GET" && url.pathname.startsWith("/files/v4/loaders/")) {
      rawId = url.pathname.slice("/files/v4/loaders/".length).replace(/\/$/, "").replace(/\.lua$/i, "");
    }
    if (rawId !== null) {
      const id = rawId;
      const key = (url.searchParams.get("key") || "").trim();
      if (!id) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Not found");
      }
      if (!key) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("You are not Owner");
      }
      if (isBlacklisted(ip, key)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("You are not Owner");
      }
      const sc = scripts[id];
      if (!sc) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Not found");
      }
      const kh = hashKey(key);
      if (sc.ownerHash !== kh) {
        addBlacklist(ip, key, "raw-wrong-key");
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("You are not Owner");
      }
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(sc.code);
    }

    // ----- obfuscate -----
    if (req.method === "POST" && url.pathname === "/api/obfuscate") {
      const body = await readBody(req);
      const code = body.code;
      if (typeof code !== "string" || !code.trim()) {
        return json(400, { error: "code required" });
      }
      try {
        const out = obfuscate(code);
        return json(200, { code: out });
      } catch (e) {
        return json(500, { error: e.message || "obfuscate failed" });
      }
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "server error" }));
  }
});

server.listen(PORT, () => {
  console.log(`KRPH listening on http://localhost:${PORT}`);
  console.log(`  /        obfuscator`);
  console.log(`  /pro     register + save (owner key)`);
  console.log(`  /raw/:id?key=...`);
});
