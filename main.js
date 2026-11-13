#!/usr/bin/env node
/**
 * KRPH v2.3 — hostile single-file Lua/Luau obfuscator
 * Inspired by techniques seen in Luraph-style protectors (CF flatten, stream crypt, anti-tamper)
 * - Full Lua 5.1 + Luau syntax support (types stripped, compound ops kept, continue kept)
 * - Per-byte xorshift stream, multi-chunk pools, noise decoys
 * - Multi-layer CF state machine + dead handlers + opaque preds (float compares)
 * - Anti-tamper: string.char, load/loadstring, env, optional debug/getfenv probes
 * - Jailbreak mode: triple VM + heavier anti
 * - Wipe mode: original source traces erased
 * - Header: "This file was protected by KRPH"
 */
const http = require("http");
const { URL } = require("url");
const crypto = require("crypto");
const PORT = process.env.PORT || 3000;
const VERSION = "2.3.0";

const RESERVED = new Set([
  "and","break","do","else","elseif","end","false","for","function","goto","if","in",
  "local","nil","not","or","repeat","return","then","true","until","while","self",
  "game","workspace","script","Instance","task","typeof","require","shared","plugin",
  "string","table","math","bit32","utf8","coroutine","os","debug","buffer","vector",
  "pairs","ipairs","next","pcall","xpcall","error","assert","type","tostring","tonumber",
  "select","unpack","getfenv","setfenv","getmetatable","setmetatable","rawget","rawset",
  "loadstring","load","print","warn","tick","time","wait","spawn","delay","newproxy",
  "continue","export"
]);

function rnd(n = 8) {
  const A = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const B = A + "0123456789";
  let s = "_" + A[(Math.random() * A.length) | 0];
  for (let i = 0; i < n; i++) s += B[(Math.random() * B.length) | 0];
  return s;
}

function streamCrypt(bytes, seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  const out = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17; s >>>= 0;
    s ^= s << 5; s >>>= 0;
    const k = (s + Math.imul(i + 1, 0x85ebca6b)) >>> 0;
    out[i] = bytes[i] ^ ((k >>> ((i % 4) * 8)) & 0xff);
  }
  return out;
}

function strToBytes(str) {
  const o = [];
  for (let i = 0; i < str.length; i++) o.push(str.charCodeAt(i) & 0xff);
  return o;
}

function stripComments(code) {
  let out = "", i = 0;
  while (i < code.length) {
    if (code[i] === "-" && code[i + 1] === "-" && code[i + 2] === "[") {
      let eq = 0, p = i + 3;
      while (code[p] === "=") { eq++; p++; }
      if (code[p] === "[") {
        const close = "]" + "=".repeat(eq) + "]";
        const end = code.indexOf(close, p + 1);
        if (end !== -1) { i = end + close.length; continue; }
      }
    }
    if (code[i] === "-" && code[i + 1] === "-") {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (code[i] === '"' || code[i] === "'") {
      const q = code[i];
      out += code[i++];
      while (i < code.length) {
        if (code[i] === "\\") { out += code[i] + (code[i + 1] || ""); i += 2; continue; }
        out += code[i];
        if (code[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (code[i] === "[" && (code[i + 1] === "[" || code[i + 1] === "=")) {
      let eq = 0, p = i + 1;
      while (code[p] === "=") { eq++; p++; }
      if (code[p] === "[") {
        const close = "]" + "=".repeat(eq) + "]";
        const end = code.indexOf(close, p + 1);
        if (end !== -1) {
          out += code.slice(i, end + close.length);
          i = end + close.length;
          continue;
        }
      }
    }
    out += code[i++];
  }
  return out;
}

function preprocessLuau(code) {
  code = code.replace(/^--!\w+.*$/gm, "");
  code = code.replace(/(\b[A-Za-z_][A-Za-z0-9_]*)\s*:\s*[A-Za-z_][A-Za-z0-9_<>|?.,\s]*(?=[,)=\]\n])/g, "$1");
  code = code.replace(/\)\s*:\s*[A-Za-z_][A-Za-z0-9_<>|?.,\s]*(?=\s*(?:end|local|function|if|for|while|repeat|do|\n|$))/g, ")");
  code = code.replace(/^\s*(?:export\s+)?type\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*.+$/gm, "");
  code = code.replace(/function\s+([A-Za-z_][A-Za-z0-9_]*)\s*<[^>]+>/g, "function $1");
  return code;
}

function wipeOriginalTraces(code) {
  code = stripComments(code);
  code = preprocessLuau(code);
  code = code.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  code = code.replace(/\b(TODO|FIXME|NOTE|DEBUG)\b/gi, "");
  return code;
}

function extractStrings(code) {
  const strings = [];
  let out = "", i = 0;
  while (i < code.length) {
    if (code[i] === "[" && (code[i + 1] === "[" || code[i + 1] === "=")) {
      let eq = 0, p = i + 1;
      while (code[p] === "=") { eq++; p++; }
      if (code[p] === "[") {
        const close = "]" + "=".repeat(eq) + "]";
        const start = p + 1;
        const end = code.indexOf(close, start);
        if (end !== -1) {
          strings.push(code.slice(start, end));
          out += `__S${strings.length - 1}__`;
          i = end + close.length;
          continue;
        }
      }
    }
    if (code[i] === '"' || code[i] === "'") {
      const q = code[i];
      let j = i + 1, buf = "";
      while (j < code.length) {
        if (code[j] === "\\") { buf += code[j] + (code[j + 1] || ""); j += 2; continue; }
        if (code[j] === q) break;
        buf += code[j++];
      }
      const un = buf
        .replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r")
        .replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) => {
          try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; }
        });
      strings.push(un);
      out += `__S${strings.length - 1}__`;
      i = j + 1;
      continue;
    }
    out += code[i++];
  }
  return { template: out, strings };
}

function renameAll(code) {
  const map = new Map();
  const take = (n) => {
    if (RESERVED.has(n) || n.startsWith("__S")) return n;
    if (!map.has(n)) map.set(n, rnd(10 + ((Math.random() * 5) | 0)));
    return map.get(n);
  };
  code = code.replace(
    /\blocal\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)/g,
    (_, list) => "local " + list.split(",").map((s) => take(s.trim())).join(",")
  );
  code = code.replace(/\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g, (full, name) => {
    const n = take(name);
    return n === name ? full : `function ${n}(`;
  });
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  for (const k of keys) code = code.replace(new RegExp(`\\b${k}\\b`, "g"), map.get(k));
  return { code, count: map.size };
}

const BITPOLY = `if not bit32 then bit32={} function bit32.band(a,b)local r,v=0,1;a=a%4294967296;b=b%4294967296;for i=1,32 do local x=a%2;local y=b%2;if x==1 and y==1 then r=r+v end;a=(a-x)/2;b=(b-y)/2;v=v*2 end;return r end function bit32.bxor(a,b)local r,v=0,1;a=a%4294967296;b=b%4294967296;for i=1,32 do local x=a%2;local y=b%2;if x~=y then r=r+v end;a=(a-x)/2;b=(b-y)/2;v=v*2 end;return r end function bit32.lshift(a,n)return (a*2^n)%4294967296 end function bit32.rshift(a,n)return math.floor((a%4294967296)/2^n) end function bit32.bor(a,b)return bit32.bxor(a,b)+bit32.band(a,b) end end `;

function emitHardVm(payloadSrc, opts) {
  const jail = !!opts.jailbreak;
  const seed = (crypto.randomBytes(4).readUInt32BE(0) ^ 0xa5a5a5a5) >>> 0;
  const cipher = streamCrypt(strToBytes(payloadSrc), seed);
  const chunks = [];
  let off = 0;
  while (off < cipher.length) {
    const n = 18 + ((Math.random() * 90) | 0);
    chunks.push(cipher.slice(off, off + n));
    off += n;
  }

  const die = rnd(6), probe = rnd(6), run = rnd(6), handlers = rnd(7);
  const opT = rnd(6), opF = rnd(6), chk = rnd(5), env = rnd(5), antiH = rnd(5);
  const labels = ["boot","probe","mix","boot2","call","halt","d1","d2","d3","d4","d5","d6","gate","verify","lock"];
  const S = {}, used = new Set();
  for (const lab of labels) {
    let id = 15000 + ((Math.random() * 80000) | 0);
    while (used.has(id)) id++;
    used.add(id);
    S[lab] = id;
  }

  const poolParts = [];
  for (let i = 0; i < chunks.length; i++) {
    poolParts.push(`{${chunks[i].join(",")}}`);
    if (Math.random() > 0.4) {
      const noise = Array.from({ length: 5 + ((Math.random() * 22) | 0) }, () => (Math.random() * 255) | 0);
      poolParts.push(`{${noise.join(",")}}`);
    }
  }
  const poolLit = poolParts.join(",");
  const realCount = chunks.length;

  const antiParts = [
    `local function ${die}(m)return error(m or "KRPH",0)end`,
    `local function ${probe}()`,
    `local s=string;`,
    `if type(s)~="table" and type(s)~="string" then ${die}("H1") end;`,
    `if type(s.char)~="function" then ${die}("H2") end;`,
    `if s.char(65)~="A" or s.char(90)~="Z" then ${die}("H3") end;`,
    `if type(loadstring)~="function" and type(load)~="function" then ${die}("H4") end;`,
    `return true end`,
    `local function ${env}()`,
    `local ok=pcall(function()return type(_G)=="table" end);`,
    `if not ok then ${die}("E1") end;`,
    `return true end`,
    `local function ${chk}(x)`,
    `x=x or 0;local a=x*x-x+7;`,
    `if a<0 then ${die}("C1") end;`,
    `return a>0 end`
  ];

  if (jail) {
    antiParts.push(
      `local function ${antiH}()`,
      `local d=debug;`,
      `if type(d)=="table" and type(d.getinfo)=="function" then pcall(d.getinfo,1); end;`,
      `if type(getfenv)=="function" then local ok,e=pcall(getfenv,0); if ok and type(e)~="table" then ${die}("F1") end; end;`,
      `return true end`
    );
  }

  const anti = antiParts.join(" ");

  const rebuild = [
    `local function ${run}()`,
    `${probe}();${env}();`,
    jail ? `${antiH}();` : "",
    `local seed=${seed};local out={};local pos=0;`,
    `local pools={${poolLit}};`,
    `local real=${realCount};local pi=0;`,
    `for _=1,#pools do`,
    `pi=pi+1;if pi>real then break end;`,
    `local chunk=pools[pi];`,
    `for i=1,#chunk do`,
    `pos=pos+1;`,
    `local s=seed;`,
    `s=bit32.bxor(s,bit32.lshift(s,13));`,
    `s=bit32.bxor(s,bit32.rshift(s,17));`,
    `s=bit32.bxor(s,bit32.lshift(s,5));`,
    `seed=s;`,
    `local k=bit32.band(bit32.rshift(s+bit32.band(pos*0x85ebca6b,0xffffffff),(pos%4)*8),0xff);`,
    `out[#out+1]=bit32.bxor(chunk[i],k);`,
    `end;end;`,
    `local parts,buf={},{};`,
    `for i=1,#out do`,
    `buf[#buf+1]=string.char(out[i]);`,
    `if #buf>=32 then parts[#parts+1]=table.concat(buf);buf={} end`,
    `end;`,
    `if #buf>0 then parts[#parts+1]=table.concat(buf) end;`,
    `local src=table.concat(parts);`,
    `local loader=loadstring or load;`,
    `local fn,err=loader(src,"\\0");`,
    `if not fn then ${die}(tostring(err)) end;`,
    `return fn end`
  ].join(" ");

  const opaque = [
    `local function ${opT}(x)`,
    `x=x or 9;local y=x*x-x;`,
    `return (y==72)or(x+x>0.0)or(x*2~=x-1)`,
    `end`,
    `local function ${opF}(x)`,
    `x=x or 4;`,
    `return (x*x+x)==99.0 and false or (x==x+1)`,
    `end`
  ].join(" ");

  const h = [
    `local ${handlers}={`,
    `[${S.boot}]=function(st)if ${opT}(9)then return ${S.probe} else return ${S.d1} end end,`,
    `[${S.probe}]=function(st)${probe}();if ${opF}()then return ${S.d2} end;return ${S.gate} end,`,
    `[${S.gate}]=function(st)if ${chk}(3)then return ${S.verify} else return ${S.d5} end end,`,
    `[${S.verify}]=function(st)${env}();if ${opT}(5)then return ${S.lock} else return ${S.d3} end end,`,
    `[${S.lock}]=function(st)${jail ? antiH + "();" : ""}return ${S.mix} end,`,
    `[${S.mix}]=function(st,reg)reg.fn=${run}();return ${S.boot2} end,`,
    `[${S.boot2}]=function(st,reg)if type(reg.fn)~="function" then ${die}("NF") end;return ${S.call} end,`,
    `[${S.call}]=function(st,reg)local r=reg.fn(...);return ${S.halt},r end,`,
    `[${S.halt}]=function(st)return ${S.halt} end,`,
    `[${S.d1}]=function(st)if ${opF}(1)then return ${S.d3} end;return ${S.boot} end,`,
    `[${S.d2}]=function(st)local _=0;for i=1,5 do _=_+i end;return ${S.d4} end,`,
    `[${S.d3}]=function(st)return ${S.d1} end,`,
    `[${S.d4}]=function(st)return ${S.probe} end,`,
    `[${S.d5}]=function(st)if ${opF}(7)then return ${S.d6} end;return ${S.gate} end,`,
    `[${S.d6}]=function(st)local t=0;for i=1,4 do t=t+i*i end;return ${S.d2} end`,
    `}`
  ].join("");

  const driver = [
    `return(function(...)`,
    `local st,reg=${S.boot},{}`,
    `local ret;`,
    `local guard=0;`,
    `while st~=${S.halt} do`,
    `guard=guard+1;if guard>${jail ? 100 : 180} then ${die}("LOOP") end;`,
    `local h=${handlers}[st];`,
    `if not h then ${die}("BAD") end;`,
    `local nst,r=h(st,reg);`,
    `if r~=nil then ret=r end;`,
    `if nst==nil then break end;`,
    `st=nst;`,
    `if ${opF}(2)then st=${S.d2} end;`,
    `if not ${chk}(guard%7) then st=${S.d5} end;`,
    `end;`,
    `if type(ret)=="function" then return ret(...) end;`,
    `return ret`,
    `end)(...)`
  ].join(" ");

  const bannerTag = jail ? "CF+anti+jail | stream-pool" : "CF+anti | stream-pool";
  let body = [
    `--[[ This file was protected by KRPH v${VERSION} | ${bannerTag} ]]`,
    BITPOLY, opaque, anti, rebuild, h, driver
  ].join(" ");

  if (opts.minify !== false) body = body.replace(/ +/g, " ").replace(/\n+/g, "\n").trim();
  return body;
}

function injectJunk(code, amount = 5) {
  let out = code;
  for (let i = 0; i < amount; i++) {
    const a = rnd(6), b = rnd(5), v = (Math.random() * 1e7) | 0;
    const style = (Math.random() * 5) | 0;
    if (style === 0) out = `local ${a}=${v};if ${a}<0 then local ${b}=${a}*2 end ` + out;
    else if (style === 1) out = `local ${a}={${v},${(v ^ 0x55) >>> 0}};if #${a}<0 then end ` + out;
    else if (style === 2) out = `local function ${a}()return ${v} end;if ${a}()<0 then end ` + out;
    else if (style === 3) out = `do local ${a}=${v};if ${a}~=${a} then end end ` + out;
    else out = `local ${a}=function()return ${v}+0 end;pcall(${a});` + out;
  }
  return out;
}

function obfuscateLua(input, options = {}) {
  const opts = {
    strings: options.strings !== false,
    rename: options.rename !== false,
    minify: options.minify !== false,
    stripComments: options.stripComments !== false,
    vm: options.vm !== false,
    double: options.double !== false,
    junk: options.junk !== false,
    jailbreak: !!options.jailbreak,
    wipe: options.wipe !== false
  };

  let code = String(input || "");
  const stats = {
    originalBytes: Buffer.byteLength(code, "utf8"),
    stringsEncoded: 0, localsRenamed: 0, vm: false,
    jailbreak: opts.jailbreak, wiped: false, mode: "none"
  };

  if (opts.wipe) {
    code = wipeOriginalTraces(code);
    stats.wiped = true;
  } else {
    if (opts.stripComments) code = stripComments(code);
    code = preprocessLuau(code);
  }

  let strings = [];
  if (opts.strings) {
    const ex = extractStrings(code);
    code = ex.template;
    strings = ex.strings;
    stats.stringsEncoded = strings.length;
  }

  if (opts.rename) {
    const r = renameAll(code);
    code = r.code;
    stats.localsRenamed = r.count;
  }

  if (opts.strings && strings.length > 0) {
    const seed = (crypto.randomBytes(4).readUInt32BE(0)) >>> 0;
    const builders = [];
    for (let i = 0; i < strings.length; i++) {
      const sd = (seed ^ (i * 0x9e3779b9)) >>> 0;
      const enc = streamCrypt(strToBytes(strings[i]), sd);
      const pool = rnd(8), fn = rnd(8);
      const sub = [];
      let o = 0;
      while (o < enc.length) {
        const n = Math.min(enc.length - o, 8 + ((Math.random() * 32) | 0));
        sub.push(enc.slice(o, o + n));
        o += n;
      }
      const subLit = sub.map((c) => `{${c.join(",")}}`).join(",");
      builders.push(
        `local ${pool}={${subLit}};local function ${fn}()local s=${sd};local o={};local pos=0;for pi=1,#${pool} do local chunk=${pool}[pi];for i=1,#chunk do pos=pos+1;s=bit32.bxor(s,bit32.lshift(s,13));s=bit32.bxor(s,bit32.rshift(s,17));s=bit32.bxor(s,bit32.lshift(s,5));local k=bit32.band(bit32.rshift(s+bit32.band(pos*0x85ebca6b,0xffffffff),((pos-1)%4)*8),0xff);o[pos]=string.char(bit32.bxor(chunk[i],k));end;end;return table.concat(o) end`
      );
      code = code.split(`__S${i}__`).join(`${fn}()`);
    }
    code = BITPOLY + builders.join(" ") + " " + code;
  }

  if (opts.junk) {
    const amount = opts.jailbreak ? 8 + ((Math.random() * 4) | 0) : 4 + ((Math.random() * 3) | 0);
    code = injectJunk(code, amount);
  }

  if (opts.vm) {
    const vmOpts = { minify: opts.minify, jailbreak: opts.jailbreak };
    code = emitHardVm(code, vmOpts);
    if (opts.jailbreak || opts.double) {
      code = emitHardVm(code, vmOpts);
      if (opts.jailbreak) {
        code = emitHardVm(code, { minify: opts.minify, jailbreak: false });
        stats.mode = "vm-cf-anti-jail-x3";
      } else stats.mode = "vm-cf-anti-x2";
    } else stats.mode = "vm-cf-anti";
    stats.vm = true;
  } else {
    code = `--[[ This file was protected by KRPH v${VERSION} ]]\n` + code;
    stats.mode = opts.jailbreak ? "flat-jail" : "flat";
  }

  if (opts.minify) code = code.replace(/ +/g, " ").replace(/\n{2,}/g, "\n").trim();

  if (!code.startsWith("--[[ This file was protected by KRPH")) {
    const tag = opts.jailbreak ? "jailbreak | do not reverse" : "do not reverse";
    code = `--[[ This file was protected by KRPH v${VERSION} | ${tag} ]]\n` + code;
  }

  stats.outputBytes = Buffer.byteLength(code, "utf8");
  return { code, stats };
}

const HTML = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>KRPH v${VERSION}</title>
<style>:root{--bg:#05070c;--p:#0c1018;--bd:#1a2230;--t:#e8edf7;--m:#8b97ad;--a:#7aa2ff;--a2:#c084fc;--ok:#34d399;--er:#f87171}*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:var(--bg);color:var(--t);min-height:100vh}.bg{position:fixed;inset:0;z-index:-1;background:radial-gradient(800px 400px at 15% -5%,rgba(122,162,255,.15),transparent 55%),var(--bg)}header{display:flex;justify-content:space-between;align-items:center;padding:1rem 1.5rem;border-bottom:1px solid var(--bd)}.logo{font-weight:800;letter-spacing:.12em;background:linear-gradient(90deg,var(--a),var(--a2));-webkit-background-clip:text;background-clip:text;color:transparent}main{max-width:1180px;margin:0 auto;padding:1.25rem}h1{text-align:center;letter-spacing:.14em;font-size:clamp(2rem,5vw,3rem);background:linear-gradient(90deg,var(--a),var(--a2));-webkit-background-clip:text;background-clip:text;color:transparent}.lead{text-align:center;color:var(--m)}.panel{background:var(--p);border:1px solid var(--bd);border-radius:14px;padding:1rem}.tb{display:flex;flex-wrap:wrap;gap:.6rem;justify-content:space-between;margin-bottom:.75rem}label{color:var(--m);font-size:.85rem;margin-right:.6rem;cursor:pointer}button{border:1px solid var(--bd);background:#141a26;color:var(--t);border-radius:8px;padding:.45rem .85rem;cursor:pointer}button.pri{background:linear-gradient(90deg,#3b82f6,#7c3aed);border:0;font-weight:600}.filebtn{display:inline-block;border:1px solid var(--bd);background:#141a26;color:var(--t);border-radius:8px;padding:.45rem .85rem;cursor:pointer;font-size:.85rem}.filebtn input{display:none}.ed{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}@media(max-width:860px){.ed{grid-template-columns:1fr}}.col{border:1px solid var(--bd);border-radius:10px;background:#080b12;display:flex;flex-direction:column}textarea{flex:1;min-height:400px;border:0;resize:vertical;padding:.8rem;background:transparent;color:var(--t);font-family:ui-monospace,monospace;font-size:.8rem}.st{margin-top:.7rem;padding:.55rem .75rem;border-radius:8px;background:rgba(52,211,153,.08);border:1px solid rgba(52,211,153,.25);color:var(--ok);font-family:monospace;font-size:.82rem}.er{margin-top:.7rem;padding:.55rem .75rem;border-radius:8px;background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.3);color:var(--er)}</style></head><body><div class="bg"></div><header><div class="logo">KRPH</div><div style="color:var(--m)">v${VERSION} · Lua/Luau</div></header><main><h1>KRPH</h1><p class="lead">Lua + Luau · stream-pool · CF VM · anti-tamper · jailbreak · source wipe</p><section class="panel"><div class="tb"><div>
<label><input type="checkbox" id="vm" checked/> VM+CF+anti</label>
<label><input type="checkbox" id="strings" checked/> string pool</label>
<label><input type="checkbox" id="rename" checked/> rename</label>
<label><input type="checkbox" id="minify" checked/> minify</label>
<label><input type="checkbox" id="wipe" checked/> wipe source</label>
<label><input type="checkbox" id="jailbreak"/> jailbreak</label>
</div><div>
<button class="pri" id="go">Obfuscate</button>
<button id="copy">Copy</button>
<label class="filebtn">Upload .lua/.luau<input type="file" id="up" accept=".lua,.luau,.txt,text/plain"/></label>
<button id="dl">Download .lua</button>
</div></div><div class="ed"><div class="col"><textarea id="in">--!strict
local Players = game:GetService("Players")
local count: number = 0
count += 1
print(Players.LocalPlayer)
local msg = "hello KRPH"
print(msg)</textarea></div><div class="col"><textarea id="out" readonly></textarea></div></div><div class="st" id="stats" hidden></div><div class="er" id="err" hidden></div></section>
<p style="text-align:center;margin-top:1rem"><a href="/download/krph.js" style="color:#7aa2ff">Download KRPH tool (krph.js)</a></p>
</main>
<script>
const $=id=>document.getElementById(id);
async function run(){
  $("err").hidden=true;$("stats").hidden=true;$("go").disabled=true;
  try{
    const res=await fetch("/api/obfuscate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:$("in").value,options:{vm:$("vm").checked,strings:$("strings").checked,rename:$("rename").checked,minify:$("minify").checked,wipe:$("wipe").checked,jailbreak:$("jailbreak").checked}})});
    const d=await res.json();
    if(!res.ok||!d.ok)throw new Error(d.error||"fail");
    $("out").value=d.code;
    $("stats").hidden=false;
    $("stats").textContent="in "+d.stats.originalBytes+"B -> "+d.stats.outputBytes+"B | "+d.stats.mode+(d.stats.jailbreak?" | jail":"")+(d.stats.wiped?" | wiped":"");
  }catch(e){$("err").hidden=false;$("err").textContent=e.message}
  finally{$("go").disabled=false}
}
$("go").onclick=run;
$("copy").onclick=async()=>{if($("out").value)await navigator.clipboard.writeText($("out").value)};
$("up").onchange=async(e)=>{const f=e.target.files&&e.target.files[0];if(!f)return;if(f.size>1500000){alert("max 1.5MB");return;}$("in").value=await f.text();};
$("dl").onclick=()=>{const t=$("out").value;if(!t){alert("먼저 Obfuscate 하세요");return;}const blob=new Blob([t],{type:"text/plain;charset=utf-8"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="krph_protected.lua";document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},200);};
</script></body></html>`;

function send(res, status, body, type = "text/plain; charset=utf-8") {
  const buf = Buffer.from(body);
  res.writeHead(status, { "Content-Type": type, "Content-Length": buf.length });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    return send(res, 200, HTML, "text/html; charset=utf-8");
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, JSON.stringify({ ok: true, name: "KRPH", version: VERSION }), "application/json");
  }
  if (req.method === "GET" && url.pathname === "/download/krph.js") {
    const fs = require("fs");
    const self = fs.readFileSync(__filename);
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Content-Disposition": `attachment; filename="krph-v${VERSION}.js"`,
      "Content-Length": self.length
    });
    return res.end(self);
  }
  if (req.method === "POST" && url.pathname === "/api/obfuscate") {
    let raw = "";
    for await (const c of req) {
      raw += c;
      if (raw.length > 2000000) return send(res, 413, JSON.stringify({ error: "too large" }), "application/json");
    }
    try {
      const body = JSON.parse(raw || "{}");
      if (typeof body.code !== "string" || !body.code.trim()) {
        return send(res, 400, JSON.stringify({ error: "code required" }), "application/json");
      }
      const result = obfuscateLua(body.code, body.options || {});
      return send(res, 200, JSON.stringify({ ok: true, code: result.code, stats: result.stats }), "application/json");
    } catch (e) {
      return send(res, 500, JSON.stringify({ error: e.message || "fail" }), "application/json");
    }
  }
  send(res, 404, "not found");
});

if (require.main === module) {
  server.listen(PORT, () => console.log("KRPH", VERSION, ":" + PORT));
}

module.exports = { obfuscateLua, server };
