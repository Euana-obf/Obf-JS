/**
 * KRPH v3.3 | krph.onrender.com
 * Lua/Luau obfuscator + Pro (owner-key, raw loaders)
 * Storage: Postgres (DATABASE_URL) or local JSON fallback
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || "";
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

function genKey() {
  return "krph_" + crypto.randomBytes(16).toString("hex");
}
function genId() {
  return crypto.randomBytes(8).toString("hex");
}
function hashKey(k) {
  return crypto.createHash("sha256").update(String(k)).digest("hex");
}

/* ===================== DATABASE LAYER ===================== */
let pool = null;
let useDb = false;

// file fallback memory
let fileUsers = loadJSON(USERS_FILE, {});
let fileScripts = loadJSON(SCRIPTS_FILE, {});
let fileBlacklist = loadJSON(BLACKLIST_FILE, { ips: [], keys: [] });

async function initDb() {
  if (!DATABASE_URL) {
    console.log("[KRPH] No DATABASE_URL — using local JSON files (ephemeral on Render)");
    return;
  }
  try {
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS krph_users (
        key_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created BIGINT NOT NULL,
        ip TEXT
      );
      CREATE TABLE IF NOT EXISTS krph_scripts (
        id TEXT PRIMARY KEY,
        owner_hash TEXT NOT NULL,
        code TEXT NOT NULL,
        created BIGINT NOT NULL,
        updated BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS krph_blacklist (
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (kind, value)
      );
    `);
    useDb = true;
    console.log("[KRPH] Postgres connected");
  } catch (e) {
    console.error("[KRPH] DB init failed, falling back to files:", e.message);
    useDb = false;
    pool = null;
  }
}

async function dbRegisterUser(keyHash, userId, ip) {
  if (useDb) {
    await pool.query(
      `INSERT INTO krph_users (key_hash, user_id, created, ip) VALUES ($1,$2,$3,$4)
       ON CONFLICT (key_hash) DO NOTHING`,
      [keyHash, userId, Date.now(), ip || ""]
    );
    return;
  }
  fileUsers[keyHash] = { id: userId, created: Date.now(), ip: ip || "" };
  saveJSON(USERS_FILE, fileUsers);
}

async function dbUserExists(keyHash) {
  if (useDb) {
    const r = await pool.query(`SELECT 1 FROM krph_users WHERE key_hash=$1`, [keyHash]);
    return r.rowCount > 0;
  }
  fileUsers = loadJSON(USERS_FILE, fileUsers);
  return !!fileUsers[keyHash];
}

async function dbGetScript(id) {
  if (useDb) {
    const r = await pool.query(
      `SELECT id, owner_hash AS "ownerHash", code, created, updated FROM krph_scripts WHERE id=$1`,
      [id]
    );
    return r.rows[0] || null;
  }
  fileScripts = loadJSON(SCRIPTS_FILE, fileScripts);
  return fileScripts[id] || null;
}

async function dbListScripts(ownerHash) {
  if (useDb) {
    const r = await pool.query(
      `SELECT id, created, updated, length(code) AS size
       FROM krph_scripts WHERE owner_hash=$1 ORDER BY updated DESC`,
      [ownerHash]
    );
    return r.rows;
  }
  fileScripts = loadJSON(SCRIPTS_FILE, fileScripts);
  return Object.keys(fileScripts)
    .filter((id) => fileScripts[id].ownerHash === ownerHash)
    .map((id) => ({
      id,
      created: fileScripts[id].created,
      updated: fileScripts[id].updated,
      size: (fileScripts[id].code || "").length,
    }))
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

async function dbSaveScript(id, ownerHash, code) {
  const now = Date.now();
  if (useDb) {
    await pool.query(
      `INSERT INTO krph_scripts (id, owner_hash, code, created, updated)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET code=EXCLUDED.code, updated=EXCLUDED.updated
       WHERE krph_scripts.owner_hash=EXCLUDED.owner_hash`,
      [id, ownerHash, code, now, now]
    );
    return;
  }
  fileScripts = loadJSON(SCRIPTS_FILE, fileScripts);
  if (fileScripts[id]) {
    fileScripts[id].code = code;
    fileScripts[id].updated = now;
  } else {
    fileScripts[id] = { ownerHash, code, created: now, updated: now };
  }
  saveJSON(SCRIPTS_FILE, fileScripts);
}

async function dbIsBlacklisted(ip, key) {
  if (useDb) {
    if (ip) {
      const r = await pool.query(
        `SELECT 1 FROM krph_blacklist WHERE kind='ip' AND value=$1`,
        [ip]
      );
      if (r.rowCount) return true;
    }
    if (key) {
      const r = await pool.query(
        `SELECT 1 FROM krph_blacklist WHERE kind='key' AND value=$1`,
        [hashKey(key)]
      );
      if (r.rowCount) return true;
    }
    return false;
  }
  fileBlacklist = loadJSON(BLACKLIST_FILE, fileBlacklist);
  if (ip && fileBlacklist.ips.includes(ip)) return true;
  if (key && fileBlacklist.keys.includes(hashKey(key))) return true;
  return false;
}

async function dbAddBlacklist(ip, key, reason) {
  console.log("[BLACKLIST]", reason, ip || "", key ? String(key).slice(0, 12) + "..." : "");
  if (useDb) {
    if (ip) {
      await pool.query(
        `INSERT INTO krph_blacklist (kind, value) VALUES ('ip',$1) ON CONFLICT DO NOTHING`,
        [ip]
      );
    }
    if (key) {
      await pool.query(
        `INSERT INTO krph_blacklist (kind, value) VALUES ('key',$1) ON CONFLICT DO NOTHING`,
        [hashKey(key)]
      );
    }
    return;
  }
  fileBlacklist = loadJSON(BLACKLIST_FILE, fileBlacklist);
  if (ip && !fileBlacklist.ips.includes(ip)) fileBlacklist.ips.push(ip);
  if (key) {
    const h = hashKey(key);
    if (!fileBlacklist.keys.includes(h)) fileBlacklist.keys.push(h);
  }
  saveJSON(BLACKLIST_FILE, fileBlacklist);
}

async function dbClearIpBlacklist(ip) {
  if (!ip) return;
  if (useDb) {
    await pool.query(`DELETE FROM krph_blacklist WHERE kind='ip' AND value=$1`, [ip]);
    return;
  }
  fileBlacklist = loadJSON(BLACKLIST_FILE, fileBlacklist);
  fileBlacklist.ips = fileBlacklist.ips.filter((x) => x !== ip);
  saveJSON(BLACKLIST_FILE, fileBlacklist);
}

/* ===================== OBFUSCATOR CORE ===================== */
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

function randomName() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let s = chars[Math.floor(Math.random() * 52)];
  for (let i = 0; i < 8 + Math.floor(Math.random() * 6); i++) {
    s += chars[Math.floor(Math.random() * 52)];
  }
  return s;
}

function emitHardVm(payloadSrc) {
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

  const order = [];
  let realIdx = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (realIdx < realCount && (i % 2 === 0 || realIdx + (chunks.length - i) <= realCount)) {
      order.push({ t: "r", c: chunks[i] });
      realIdx++;
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

  const poolLit = order.map((o) => `{${o.c.join(",")}}`).join(",");
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
local buf,sum={},0
for i=1,#${n.pools} do
if ${n.real}[i]==1 then
local ch=${n.pools}[i]
for j=1,#ch do
sd=xs(sd)
local c=ch[j]
sum=(sum+c)%65536
buf[#buf+1]=${n.seal}.c(${n.bit}.bxor(c,sd%256))
end
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
  let out = code;
  for (let i = 0; i < 3; i++) out = emitHardVm(out);
  return out;
}

/* ===================== HTML ===================== */
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
.msg{margin-top:10px;padding:10px;border-radius:6px;font-size:.9rem}
.ok{background:#12261e;color:#3fb950}
.err{background:#2d1214;color:#f85149}
nav a{margin-right:14px;text-decoration:none;color:#58a6ff}
</style>
</head>
<body>
<div class="wrap">
<nav><a href="/">Obfuscator</a><a href="/pro">Pro</a></nav>
<h1>KRPH</h1>
<p class="sub">Lua / Luau · 3-layer VM · wipe · anti-hook · krph.onrender.com</p>
<textarea id="src" placeholder="Paste Lua / Luau source..."></textarea>
<div class="row">
  <button id="btnObf">Obfuscate</button>
  <button id="btnDl" class="secondary" disabled>Download .lua</button>
</div>
<textarea id="dst" readonly placeholder="Protected output..."></textarea>
<div id="msg"></div>
</div>
<script>
const src=document.getElementById('src'),dst=document.getElementById('dst'),msg=document.getElementById('msg');
const btnObf=document.getElementById('btnObf'),btnDl=document.getElementById('btnDl');
let last='';
btnObf.onclick=async()=>{
  msg.className='msg';msg.textContent='Working...';btnObf.disabled=true;
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
<nav style="margin-bottom:16px"><a href="/">Obfuscator</a><a href="/pro">Pro</a></nav>
<h1>KRPH Pro</h1>
<p class="sub">Register → Save → loadstring. DB keeps keys after restart when DATABASE_URL is set.</p>

<div class="card">
  <h3 style="margin-bottom:8px">1. Register (owner key)</h3>
  <div class="row"><button type="button" id="btnReg">Register / Issue Key</button></div>
  <div id="regMsg" class="msg" style="display:none"></div>
  <div id="keyBox" class="keybox" style="display:none"></div>
</div>

<div class="card">
  <h3 style="margin-bottom:8px">2. My scripts (panel only)</h3>
  <p class="sub" style="margin:0">Source is only visible here with your owner key. Direct URL without key → You are not Owner.</p>
  <label>Owner key</label>
  <input id="ownerKey" type="text" placeholder="krph_..." autocomplete="off"/>
  <div class="row">
    <button type="button" id="btnList">Load my scripts</button>
  </div>
  <div id="listBox" class="keybox" style="display:none"></div>
  <label>Script ID (any name, or empty = auto)</label>
  <input id="scriptId" type="text" placeholder="e.g. why"/>
  <label>Script source (view / edit)</label>
  <textarea id="scriptBody" placeholder='print("a")'></textarea>
  <div class="row"><button type="button" id="btnSave">Save / Update</button></div>
  <div id="saveMsg" class="msg" style="display:none"></div>
</div>

<div class="card">
  <h3 style="margin-bottom:8px">3. Run (Luarmor style)</h3>
  <p class="warn">Browser /raw/ID without key → You are not Owner. Executor needs full loadstring with key.</p>
  <div id="linkBox" class="keybox" style="display:none"></div>
</div>
</div>
<script>
(function(){
  const regMsg=document.getElementById('regMsg');
  const keyBox=document.getElementById('keyBox');
  const saveMsg=document.getElementById('saveMsg');
  const linkBox=document.getElementById('linkBox');
  const listBox=document.getElementById('listBox');
  function show(el,text,ok){el.style.display='block';el.className='msg '+(ok?'ok':'err');el.textContent=text;}
  function key(){return document.getElementById('ownerKey').value.trim();}

  document.getElementById('btnReg').onclick=async function(){
    const btn=this;btn.disabled=true;
    regMsg.style.display='block';regMsg.className='msg';regMsg.textContent='Issuing key...';
    keyBox.style.display='none';
    try{
      const r=await fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      const j=await r.json();
      if(!r.ok)throw new Error(j.error||'register failed');
      keyBox.style.display='block';keyBox.textContent=j.key;
      document.getElementById('ownerKey').value=j.key;
      show(regMsg,'Key issued. Keep it.',true);
    }catch(e){show(regMsg,e.message||String(e),false);}
    btn.disabled=false;
  };

  async function loadList(){
    const k=key();
    if(!k){listBox.style.display='block';listBox.textContent='Owner key required';return;}
    const r=await fetch('/api/myscripts?key='+encodeURIComponent(k));
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||'list failed');
    if(!j.scripts||!j.scripts.length){
      listBox.style.display='block';
      listBox.textContent='(no scripts yet)';
      return;
    }
    listBox.style.display='block';
    listBox.innerHTML=j.scripts.map(function(s){
      return '<div style="margin:6px 0;cursor:pointer;color:#58a6ff" data-id="'+s.id+'">'+s.id+' · '+s.size+' bytes</div>';
    }).join('');
    listBox.querySelectorAll('[data-id]').forEach(function(el){
      el.onclick=async function(){
        const id=el.getAttribute('data-id');
        const r2=await fetch('/api/myscript?id='+encodeURIComponent(id)+'&key='+encodeURIComponent(k));
        const j2=await r2.json();
        if(!r2.ok){show(saveMsg,j2.error||'load failed',false);return;}
        document.getElementById('scriptId').value=j2.id;
        document.getElementById('scriptBody').value=j2.code;
        const url=location.origin+'/raw/'+j2.id+'?key='+encodeURIComponent(k);
        linkBox.style.display='block';
        linkBox.textContent='loadstring(game:HttpGet("'+url+'"))()';
        show(saveMsg,'Loaded '+j2.id+' (panel only)',true);
      };
    });
  }

  document.getElementById('btnList').onclick=async function(){
    try{await loadList();}catch(e){listBox.style.display='block';listBox.textContent=e.message||String(e);}
  };

  document.getElementById('btnSave').onclick=async function(){
    const k=key();
    const id=document.getElementById('scriptId').value.trim();
    const body=document.getElementById('scriptBody').value;
    if(!k){show(saveMsg,'Owner key required',false);return;}
    if(!body){show(saveMsg,'Script empty',false);return;}
    const btn=this;btn.disabled=true;
    saveMsg.style.display='block';saveMsg.className='msg';saveMsg.textContent='Saving...';
    try{
      const r=await fetch('/api/script',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({key:k,id:id||undefined,code:body})});
      const j=await r.json();
      if(!r.ok)throw new Error(j.error||'save failed');
      document.getElementById('scriptId').value=j.id;
      const url=location.origin+'/raw/'+j.id+'?key='+encodeURIComponent(k);
      linkBox.style.display='block';
      linkBox.textContent='loadstring(game:HttpGet("'+url+'"))()';
      show(saveMsg,'Saved. ID: '+j.id,true);
      try{await loadList();}catch(_){}
    }catch(e){show(saveMsg,e.message||String(e),false);}
    btn.disabled=false;
  };
})();
</script>
</body>
</html>`;

/* ===================== HTTP ===================== */
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
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(MAIN_HTML);
    }
    if (req.method === "GET" && url.pathname === "/pro") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(PRO_HTML);
    }

    if (req.method === "POST" && url.pathname === "/api/register") {
      await dbClearIpBlacklist(ip);
      const key = genKey();
      const id = genId();
      await dbRegisterUser(hashKey(key), id, ip);
      return json(200, { key, userId: id, db: useDb });
    }

    // panel: list my scripts (owner key required)
    if (req.method === "GET" && url.pathname === "/api/myscripts") {
      const key = (url.searchParams.get("key") || "").trim();
      if (!key) return json(403, { error: "You are not Owner" });
      const kh = hashKey(key);
      if (!(await dbUserExists(kh))) return json(403, { error: "You are not Owner" });
      const scripts = await dbListScripts(kh);
      return json(200, { scripts });
    }

    // panel: get one script source (owner key required)
    if (req.method === "GET" && url.pathname === "/api/myscript") {
      const key = (url.searchParams.get("key") || "").trim();
      const id = (url.searchParams.get("id") || "").trim();
      if (!key || !id) return json(403, { error: "You are not Owner" });
      const kh = hashKey(key);
      if (!(await dbUserExists(kh))) return json(403, { error: "You are not Owner" });
      const sc = await dbGetScript(id);
      if (!sc || sc.ownerHash !== kh) return json(403, { error: "You are not Owner" });
      return json(200, { id: sc.id || id, code: sc.code });
    }

    if (req.method === "POST" && url.pathname === "/api/script") {
      const body = await readBody(req);
      const key = (body.key || "").trim();
      if (!key) return json(403, { error: "You are not Owner" });
      const kh = hashKey(key);
      if (!(await dbUserExists(kh))) {
        return json(403, {
          error: "Invalid key. Click Register again.",
        });
      }
      await dbClearIpBlacklist(ip);

      let id = (body.id || "").trim();
      const code = body.code;
      if (typeof code !== "string") return json(400, { error: "code required" });

      if (id) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
          return json(400, { error: "Script ID must be 1-64 chars: A-Z a-z 0-9 _ -" });
        }
        const existing = await dbGetScript(id);
        if (existing && existing.ownerHash !== kh) {
          return json(403, { error: "Script ID already taken" });
        }
        await dbSaveScript(id, kh, code);
      } else {
        id = genId();
        await dbSaveScript(id, kh, code);
      }
      return json(200, { id, ok: true });
    }

    // /raw/:id or /files/v4/loaders/:id.lua
    let rawId = null;
    if (req.method === "GET" && url.pathname.startsWith("/raw/")) {
      rawId = url.pathname.slice(5).replace(/\/$/, "").replace(/\.lua$/i, "");
    } else if (req.method === "GET" && url.pathname.startsWith("/files/v4/loaders/")) {
      rawId = url.pathname
        .slice("/files/v4/loaders/".length)
        .replace(/\/$/, "")
        .replace(/\.lua$/i, "");
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
      if (await dbIsBlacklisted(ip, key)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("You are not Owner");
      }
      const sc = await dbGetScript(id);
      if (!sc) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Not found");
      }
      if (sc.ownerHash !== hashKey(key)) {
        await dbAddBlacklist(ip, key, "raw-wrong-key");
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

    if (req.method === "POST" && url.pathname === "/api/obfuscate") {
      const body = await readBody(req);
      if (typeof body.code !== "string" || !body.code.trim()) {
        return json(400, { error: "code required" });
      }
      try {
        return json(200, { code: obfuscate(body.code) });
      } catch (e) {
        return json(500, { error: e.message || "obfuscate failed" });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(200, { ok: true, db: useDb });
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "server error" }));
  }
});

initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`KRPH listening on http://localhost:${PORT}`);
    console.log(`  storage: ${useDb ? "Postgres" : "JSON files"}`);
    console.log(`  /pro  /raw/:id?key=  /files/v4/loaders/:id.lua?key=`);
  });
});
