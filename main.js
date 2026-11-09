#!/usr/bin/env node
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { execSync } = require("child_process");
/**
 * Strip / rewrite Luau-only syntax toward plain Lua 5.x.
 */
function preprocessLuau(src) {
  let s = String(src || "");

  // --!strict / --!native
  s = s.replace(/^--!\w+.*$/gm, "");

  // type / export type lines (single line)
  s = s.replace(/^\s*export\s+type\s+.+$/gm, "");
  s = s.replace(/^\s*type\s+[A-Za-z_][\w]*\s*=\s*.+$/gm, "");

  // x :: Type  (no newline in Type)
  s = s.replace(/\s*::\s*[A-Za-z_][\w\.]*(?:<[^>\n]*>)?/g, "");

  // ) : Type   Type cannot span lines
  s = s.replace(/\)\s*:\s*\([^)\n]*\)/g, ")");
  s = s.replace(/\)\s*:\s*[A-Za-z_][\w\.:|<>\[\]{},? ]*/g, ")");

  // function params name: Type (same line) — do not touch obj:method(
  s = s.replace(/([,\(]\s*)([A-Za-z_][\w]*)\s*:\s*[A-Za-z_][\w\.:|<>\[\]? ]*(?=\s*[,)])/g, "$1$2");

  // local name: Type = value / local name: Type
  for (let i = 0; i < 6; i++) {
    const before = s;
    s = s.replace(
      /\blocal\s+([A-Za-z_][\w]*)\s*:\s*\{[^}\n]*\}(\s*[=;\n])/g,
      "local $1$2"
    );
    s = s.replace(
      /\blocal\s+([A-Za-z_][\w]*)\s*:\s*[A-Za-z_][\w\.:|<>\[\]?, ]*(\s*[=;\n])/g,
      "local $1$2"
    );
    s = s.replace(
      /\blocal\s+function\s+([A-Za-z_][\w]*)\s*:\s*[A-Za-z_][\w\.:|<>\[\]?, ]*/g,
      "local function $1"
    );
    if (s === before) break;
  }

  // compound assign
  const lval = "([A-Za-z_][\\w\\.]*|[A-Za-z_][\\w]*\\[[^\\]]+\\])";
  s = s.replace(new RegExp(lval + "\\s*\\+=\\s*", "g"), "$1 = $1 + ");
  s = s.replace(new RegExp(lval + "\\s*-=\\s*", "g"), "$1 = $1 - ");
  s = s.replace(new RegExp(lval + "\\s*\\*=\\s*", "g"), "$1 = $1 * ");
  s = s.replace(new RegExp(lval + "\\s*/=\\s*", "g"), "$1 = $1 / ");
  s = s.replace(new RegExp(lval + "\\s*%=\\s*", "g"), "$1 = $1 % ");
  s = s.replace(new RegExp(lval + "\\s*\\.\\.=\\s*", "g"), "$1 = $1 .. ");

  // // floor div when not comment
  s = s.replace(/([^/\n])\/\/([^\n/])/g, "$1 / $2");

  // continue → empty do
  s = s.replace(/\bcontinue\b/g, "do end");

  // colon method CALL (not definition): "print(o:get())" but not "function o:get("
  // Line-based: if line has function ... : keep; else rewrite name:name(
  s = s
    .split("\n")
    .map((line) => {
      if (/\bfunction\b/.test(line)) return line;
      // o:get() → o.get(o) ; o:get(x) → o.get(o, x)
      line = line.replace(
        /\b([A-Za-z_][\w]*)\s*:\s*([A-Za-z_][\w]*)\s*\(\s*\)/g,
        "$1.$2($1)"
      );
      line = line.replace(
        /\b([A-Za-z_][\w]*)\s*:\s*([A-Za-z_][\w]*)\s*\(/g,
        "$1.$2($1, "
      );
      return line;
    })
    .join("\n");

  return s;
}


/**
 * Euana Bytecode Compiler + VM emitter
 * Target: no user source string in output when compile succeeds
 */

function randInt(a, b) {
  return a + Math.floor(Math.random() * (b - a + 1));
}

function randIdent(n) {
  n = n || randInt(8, 14);
  const first = "abcdefghijklmnopqrtsuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_"[randInt(0, 52)];
  const rest = "abcdefghijklmnopqrtsuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";
  let s = first;
  for (let i = 1; i < n; i++) s += rest[randInt(0, rest.length - 1)];
  return s;
}

function num(n) {
  n = n >>> 0;
  if (Math.random() < 0.35) return "0x" + n.toString(16).toUpperCase();
  return String(n);
}

const KEYWORDS = new Set([
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function",
  "goto", "if", "in", "local", "nil", "not", "or", "repeat", "return",
  "then", "true", "until", "while",
]);

function tokenize(src) {
  const tokens = [];
  let pos = 0;
  const n = src.length;
  while (pos < n) {
    if (src.startsWith("--", pos)) {
      if (src.startsWith("--[[", pos)) {
        const end = src.indexOf("]]", pos + 4);
        pos = end < 0 ? n : end + 2;
        continue;
      }
      const nl = src.indexOf("\n", pos);
      pos = nl < 0 ? n : nl + 1;
      continue;
    }
    const ch = src[pos];
    if (/\s/.test(ch)) {
      pos++;
      continue;
    }
    // long string [[...]] or [=[...]=]
    if (ch === "[") {
      let eq = 0;
      let p2 = pos + 1;
      while (p2 < n && src[p2] === "=") { eq++; p2++; }
      if (p2 < n && src[p2] === "[") {
        const close = "]" + "=".repeat(eq) + "]";
        const end = src.indexOf(close, p2 + 1);
        if (end >= 0) {
          tokens.push({ t: "str", v: src.slice(p2 + 1, end) });
          pos = end + close.length;
          continue;
        }
      }
    }
    if (ch === '"' || ch === "'") {
      const q = ch;
      let j = pos + 1;
      let buf = "";
      while (j < n && src[j] !== q) {
        if (src[j] === "\\" && j + 1 < n) {
          buf += src[j] + src[j + 1];
          j += 2;
        } else {
          buf += src[j];
          j++;
        }
      }
      tokens.push({ t: "str", v: buf });
      pos = Math.min(j + 1, n);
      continue;
    }
    if (/\d/.test(ch) || (ch === "." && pos + 1 < n && /\d/.test(src[pos + 1]))) {
      let j = pos;
      if (src.slice(j, j + 2).toLowerCase() === "0x") {
        j += 2;
        while (j < n && /[0-9a-fA-F]/.test(src[j])) j++;
      } else {
        while (j < n && /[\d.]/.test(src[j])) j++;
      }
      tokens.push({ t: "num", v: src.slice(pos, j) });
      pos = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = pos;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const w = src.slice(pos, j);
      tokens.push({ t: KEYWORDS.has(w) ? w : "name", v: w });
      pos = j;
      continue;
    }
    const multi = ["...", "..", "==", "~=", "<=", ">="];
    let hit = false;
    for (const op of multi) {
      if (src.startsWith(op, pos)) {
        tokens.push({ t: op, v: op });
        pos += op.length;
        hit = true;
        break;
      }
    }
    if (!hit) {
      tokens.push({ t: ch, v: ch });
      pos++;
    }
  }
  tokens.push({ t: "EOF", v: "EOF" });
  return tokens;
}

class Compiler {
  constructor() {
    this.tokens = [];
    this.p = 0;
    this.code = [];
    this.constants = [];
    this.constMap = new Map();
    this.errors = 0;
    const names = [
      "LOADK", "LOADNIL", "LOADBOOL", "GETGLOBAL", "SETGLOBAL",
      "ADD", "SUB", "MUL", "DIV", "MOD", "POW", "CONCAT",
      "EQ", "NE", "LT", "LE", "GT", "GE",
      "NOT", "UNM", "LEN",
      "JMP", "JMPIF", "JMPIFNOT",
      "CALL", "RETURN", "POP", "DUP",
      "NEWTABLE", "GETTABLE", "SETTABLE",
      "GETLOCAL", "SETLOCAL", "HALT", "SELF", "CLOSURE", "SWAP",
    ];
    const base = names.map((_, i) => i + 1);
    for (let i = base.length - 1; i > 0; i--) {
      const j = randInt(0, i);
      [base[i], base[j]] = [base[j], base[i]];
    }
    this.OP = {};
    names.forEach((n, i) => {
      this.OP[n] = base[i];
    });
    this.localsStack = [{}];
    this.localCount = [0];
  }

  intern(v) {
    const key = typeof v + ":" + String(v);
    if (this.constMap.has(key)) return this.constMap.get(key);
    const idx = this.constants.length;
    this.constants.push(v);
    this.constMap.set(key, idx);
    return idx;
  }

  emit(...ops) {
    this.code.push(...ops);
  }

  cur() {
    return this.tokens[this.p] || { t: "EOF", v: "EOF" };
  }

  at(...kinds) {
    return kinds.includes(this.cur().t);
  }

  eat(kind) {
    const t = this.cur();
    if (kind && t.t !== kind) this.errors++;
    this.p++;
    return t;
  }

  pushScope(reset) {
    this.localsStack.push({});
    // blocks share monotonic slots; function bodies (reset=true) start at 0 for nested VM
    if (reset) this.localCount.push(0);
    else this.localCount.push(this.localCount[this.localCount.length - 1]);
  }

  popScope() {
    this.localsStack.pop();
    this.localCount.pop();
  }

  newLocal(name) {
    const slot = this.localCount[this.localCount.length - 1];
    this.localCount[this.localCount.length - 1] = slot + 1;
    this.localsStack[this.localsStack.length - 1][name] = slot;
    return slot;
  }

  findLocal(name) {
    for (let i = this.localsStack.length - 1; i >= 0; i--) {
      if (name in this.localsStack[i]) return this.localsStack[i][name];
    }
    return null;
  }

  compile(src) {
    this.tokens = tokenize(src);
    this.p = 0;
    this.block();
    this.emit(this.OP.HALT);
    return {
      code: this.code,
      constants: this.constants,
      op: this.OP,
      ok: this.errors === 0 && this.code.length > 1,
      errors: this.errors,
    };
  }

  block() {
    while (!this.at("EOF", "end", "else", "elseif", "until")) {
      if (this.at("EOF")) break;
      this.stat();
    }
  }

  stat() {
    if (this.at("local")) {
      this.eat("local");
      if (this.at("function")) {
        this.eat("function");
        const name = this.eat("name").v;
        const slot = this.newLocal(name);
        this.functionBody(slot, true);
      } else {
        const names = [this.eat("name").v];
        while (this.at(",")) {
          this.eat(",");
          names.push(this.eat("name").v);
        }
        const slots = names.map((n) => this.newLocal(n));
        if (this.at("=")) {
          this.eat("=");
          let nexp = 0;
          this.exp();
          nexp = 1;
          while (this.at(",")) {
            this.eat(",");
            this.exp();
            nexp++;
          }
          while (nexp < slots.length) {
            this.emit(this.OP.LOADNIL);
            nexp++;
          }
          for (let i = Math.min(nexp, slots.length) - 1; i >= 0; i--) {
            this.emit(this.OP.SETLOCAL, slots[i]);
          }
        } else {
          for (const sl of slots) {
            this.emit(this.OP.LOADNIL);
            this.emit(this.OP.SETLOCAL, sl);
          }
        }
      }

    } else if (this.at("function")) {
      this.eat("function");
      const name = this.eat("name").v;
      // function a.b / a.b:c / a:c / a
      const path = [name];
      while (this.at(".")) {
        this.eat(".");
        path.push(this.eat("name").v);
      }
      let method = null;
      if (this.at(":")) {
        this.eat(":");
        method = this.eat("name").v;
      }
      this.eat("(");
      const params = [];
      if (method) params.push("self");
      if (!this.at(")")) {
        params.push(this.eat("name").v);
        while (this.at(",")) {
          this.eat(",");
          if (this.at("...")) { this.eat("..."); break; }
          params.push(this.eat("name").v);
        }
      }
      this.eat(")");
      const jmpAt = this.code.length;
      this.emit(this.OP.JMP, 0);
      const bodyStart = this.code.length;
      this.pushScope(true);
      for (const pm of params) this.newLocal(pm);
      this.block();
      this.emit(this.OP.LOADNIL);
      this.emit(this.OP.RETURN, 1);
      this.popScope();
      this.eat("end");
      this.code[jmpAt + 1] = this.code.length - (jmpAt + 2);
      if (!this.OP.CLOSURE) this.OP.CLOSURE = 50 + randInt(1, 20);
      this.emit(this.OP.CLOSURE, bodyStart + 1, params.length);
      // assign
      if (path.length === 1 && !method) {
        // function foo()
        this.emit(this.OP.SETGLOBAL, this.intern(path[0]));
      } else {
        // function a.b / a.b:c / a:c — store closure, then table[key]=closure
        const lastKey = method || path[path.length - 1];
        const tmp = this.newLocal("__fn");
        this.emit(this.OP.SETLOCAL, tmp);
        const loc0 = this.findLocal(path[0]);
        if (loc0 !== null) this.emit(this.OP.GETLOCAL, loc0);
        else this.emit(this.OP.GETGLOBAL, this.intern(path[0]));
        for (let i = 1; i < path.length - (method ? 0 : 1); i++) {
          this.emit(this.OP.LOADK, this.intern(path[i]));
          this.emit(this.OP.GETTABLE);
        }
        this.emit(this.OP.GETLOCAL, tmp);
        this.emit(this.OP.LOADK, this.intern(lastKey));
        this.emit(this.OP.SETTABLE);
        this.emit(this.OP.POP);
      }
    } else if (this.at("if")) {

      this.ifStat();
    } else if (this.at("while")) {
      this.whileStat();
    } else if (this.at("return")) {
      this.eat("return");
      let n = 0;
      if (!this.at("EOF", "end", "else", "elseif", "until", ";")) {
        this.exp();
        n = 1;
        while (this.at(",")) {
          this.eat(",");
          this.exp();
          n++;
        }
      }
      this.emit(this.OP.RETURN, n);
    } else if (this.at("do")) {
      this.eat("do");
      this.pushScope();
      this.block();
      this.popScope();
      this.eat("end");
    } else if (this.at("break")) {
      this.eat("break");
      this.emit(this.OP.LOADNIL);
      this.emit(this.OP.RETURN, 1);
    } else if (this.at(";")) {
      this.eat(";");
    } else if (this.at("name")) {
      this.prefixStat();
    } else if (this.at("for")) {
      this.forStat();
    } else if (this.at("repeat")) {
      this.repeatStat();
    } else {
      try {
        this.exp();
        this.emit(this.OP.POP);
      } catch {
        this.errors++;
        this.p++;
      }
    }
  }

  functionBody(target, isLocal) {
    this.eat("(");
    const params = [];
    if (!this.at(")")) {
      params.push(this.eat("name").v);
      while (this.at(",")) {
        this.eat(",");
        if (this.at("...")) {
          this.eat("...");
          break;
        }
        params.push(this.eat("name").v);
      }
    }
    this.eat(")");
    // Simplified: compile body inline as top-level with JMP skip – closures limited
    // Emit body as separate region; store as LOADNIL function stub + body executed at definition for simple scripts
    // Better approach for subset: only support function that is immediately structured
    // Compile body into main stream with locals, call at end for local functions that are called later won't work without CLOSURE
    // Use a simple model: functions are not first-class for BC path except empty-ish
    // Emit: JMP over body; body; HALT-region; at definition push a lua function via host...
    // For reliable BC: expand function body at call sites is impossible.
    // Practical: mark as error for nested functions with body complexity – or implement CLOSURE op in VM
    const jmpAt = this.code.length;
    this.emit(this.OP.JMP, 0);
    const bodyStart = this.code.length;
    this.pushScope(true);
    for (const pm of params) this.newLocal(pm);
    this.block();
    // default return nil if body falls through
    this.emit(this.OP.LOADNIL);
    this.emit(this.OP.RETURN, 1);
    this.popScope();
    this.eat("end");
    const bodyEnd = this.code.length;
    this.code[jmpAt + 1] = bodyEnd - (jmpAt + 2);
    // Closure: we need OP_CLOSURE - add dynamically
    if (!this.OP.CLOSURE) {
      this.OP.CLOSURE = 50 + randInt(1, 20);
    }
    this.emit(this.OP.CLOSURE, bodyStart + 1, params.length);
    if (isLocal) this.emit(this.OP.SETLOCAL, target);
    else this.emit(this.OP.SETGLOBAL, typeof target === "number" ? target : this.intern(String(target)));
  }

  prefixStat() {
    const name = this.eat("name").v;
    if (this.at("(")) {
      const loc = this.findLocal(name);
      if (loc !== null) this.emit(this.OP.GETLOCAL, loc);
      else this.emit(this.OP.GETGLOBAL, this.intern(name));
      const nargs = this.callArgs();
      this.emit(this.OP.CALL, nargs, 0);
    } else if (this.at("=")) {
      this.eat("=");
      this.exp();
      const loc = this.findLocal(name);
      if (loc !== null) this.emit(this.OP.SETLOCAL, loc);
      else this.emit(this.OP.SETGLOBAL, this.intern(name));
    } else if (this.at(".")) {
      const loc = this.findLocal(name);
      if (loc !== null) this.emit(this.OP.GETLOCAL, loc);
      else this.emit(this.OP.GETGLOBAL, this.intern(name));
      while (this.at(".")) {
        this.eat(".");
        const field = this.eat("name").v;
        if (this.at("=")) {
          this.eat("=");
          this.exp();
          this.emit(this.OP.LOADK, this.intern(field));
          this.emit(this.OP.SETTABLE);
          return;
        }
        if (this.at("(")) {
          this.emit(this.OP.LOADK, this.intern(field));
          this.emit(this.OP.GETTABLE);
          const nargs = this.callArgs();
          this.emit(this.OP.CALL, nargs, 0);
          return;
        }
        this.emit(this.OP.LOADK, this.intern(field));
        this.emit(this.OP.GETTABLE);
      }
    } else if (this.at(":")) {
      const loc = this.findLocal(name);
      if (loc !== null) this.emit(this.OP.GETLOCAL, loc);
      else this.emit(this.OP.GETGLOBAL, this.intern(name));
      this.eat(":");
      const method = this.eat("name").v;
      if (!this.OP.SWAP) this.OP.SWAP = 90 + randInt(1, 10);
      this.emit(this.OP.DUP);
      this.emit(this.OP.LOADK, this.intern(method));
      this.emit(this.OP.GETTABLE);
      this.emit(this.OP.SWAP);
      const nargs = this.callArgs();
      this.emit(this.OP.CALL, nargs + 1, 0);
    } else {
      const loc = this.findLocal(name);
      if (loc !== null) this.emit(this.OP.GETLOCAL, loc);
      else this.emit(this.OP.GETGLOBAL, this.intern(name));
      this.emit(this.OP.POP);
    }
  }

  callArgs() {
    this.eat("(");
    let n = 0;
    if (!this.at(")")) {
      this.exp();
      n = 1;
      while (this.at(",")) {
        this.eat(",");
        this.exp();
        n++;
      }
    }
    this.eat(")");
    return n;
  }



  forStat() {
    // numeric: for i = a, b [, c] do body end
    // generic: for vars in explist do body end
    this.eat("for");
    const varName = this.eat("name").v;
    if (this.at("=")) {
      this.eat("=");
      this.exp(); // start
      this.eat(",");
      this.exp(); // stop
      if (this.at(",")) {
        this.eat(",");
        this.exp();
      } else {
        this.emit(this.OP.LOADK, this.intern(1));
      }
      this.eat("do");
      this.pushScope();
      const slot = this.newLocal(varName);
      const slotStep = this.newLocal("__step");
      const slotStop = this.newLocal("__stop");
      this.emit(this.OP.SETLOCAL, slotStep);
      this.emit(this.OP.SETLOCAL, slotStop);
      this.emit(this.OP.SETLOCAL, slot);
      const loopStart = this.code.length;
      this.emit(this.OP.GETLOCAL, slot);
      this.emit(this.OP.GETLOCAL, slotStop);
      this.emit(this.OP.LE);
      const jf = this.code.length;
      this.emit(this.OP.JMPIFNOT, 0);
      this.block();
      this.emit(this.OP.GETLOCAL, slot);
      this.emit(this.OP.GETLOCAL, slotStep);
      this.emit(this.OP.ADD);
      this.emit(this.OP.SETLOCAL, slot);
      this.emit(this.OP.JMP, loopStart - (this.code.length + 2));
      this.code[jf + 1] = this.code.length - (jf + 2);
      this.popScope();
      this.eat("end");
    } else if (this.at(",") || this.at("in")) {
      // generic for → Lua semantics:
      // local f,s,var = explist
      // while true do local v1..vn = f(s,var); if v1==nil break; var=v1; body end
      const vars = [varName];
      while (this.at(",")) {
        this.eat(",");
        vars.push(this.eat("name").v);
      }
      this.eat("in");
      // explist: support single expr (pairs(t) / ipairs(t) / next,t,nil)
      this.exp();
      // If only one value on stack (pairs returns 3), we need multi-ret.
      // CALL already packs returns – for pairs(t) the exp is a CALL with nrets=1 currently.
      // Patch: when last instruction was CALL with nrets=1, bump to 3.
      if (this.code.length >= 3 && this.code[this.code.length - 3] === this.OP.CALL) {
        this.code[this.code.length - 1] = 3; // nrets = 3
      }
      this.eat("do");
      this.pushScope();
      const fSlot = this.newLocal("__f");
      const sSlot = this.newLocal("__s");
      const varSlot = this.newLocal("__var");
      // stack top.. : ret3, ret2, ret1 (if 3 rets) – CALL pushes 1..nrets in order
      // table.pack order: rets[1], rets[2], rets[3] pushed sequentially so top is last
      // Our CALL: for i=1,nrets do push(rets[i]) end → top is rets[nrets]
      // pairs returns f, s, var → push f, push s, push var → top=var
      this.emit(this.OP.SETLOCAL, varSlot);
      this.emit(this.OP.SETLOCAL, sSlot);
      this.emit(this.OP.SETLOCAL, fSlot);
      const loopStart = this.code.length;
      // call f(s, var) with nrets = #vars
      this.emit(this.OP.GETLOCAL, fSlot);
      this.emit(this.OP.GETLOCAL, sSlot);
      this.emit(this.OP.GETLOCAL, varSlot);
      this.emit(this.OP.CALL, 2, vars.length);
      // stack: v1..vn (top is vn)
      const varSlots = vars.map((v) => this.newLocal(v));
      for (let i = vars.length - 1; i >= 0; i--) {
        this.emit(this.OP.SETLOCAL, varSlots[i]);
      }
      // var = v1
      this.emit(this.OP.GETLOCAL, varSlots[0]);
      this.emit(this.OP.SETLOCAL, varSlot);
      // if v1 == nil then break
      this.emit(this.OP.GETLOCAL, varSlots[0]);
      this.emit(this.OP.LOADNIL);
      this.emit(this.OP.EQ);
      const jbreak = this.code.length;
      this.emit(this.OP.JMPIF, 0); // if equal nil, jump to end
      this.block();
      this.emit(this.OP.JMP, loopStart - (this.code.length + 2));
      this.code[jbreak + 1] = this.code.length - (jbreak + 2);
      this.popScope();
      this.eat("end");
    } else {
      this.errors++;
    }
  }

  repeatStat() {
    this.eat("repeat");
    const start = this.code.length;
    this.pushScope();
    this.block();
    this.popScope();
    this.eat("until");
    this.exp();
    // until cond → jump back if NOT cond
    this.emit(this.OP.JMPIFNOT, start - (this.code.length + 2));
  }

  ifStat() {
    this.eat("if");
    this.exp();
    this.eat("then");
    const jf = this.code.length;
    this.emit(this.OP.JMPIFNOT, 0);
    this.pushScope();
    this.block();
    this.popScope();
    const ends = [];
    if (this.at("else") || this.at("elseif")) {
      const je = this.code.length;
      this.emit(this.OP.JMP, 0);
      ends.push(je);
      this.code[jf + 1] = this.code.length - (jf + 2);
      while (this.at("elseif")) {
        this.eat("elseif");
        this.exp();
        this.eat("then");
        const jf2 = this.code.length;
        this.emit(this.OP.JMPIFNOT, 0);
        this.pushScope();
        this.block();
        this.popScope();
        const je2 = this.code.length;
        this.emit(this.OP.JMP, 0);
        ends.push(je2);
        this.code[jf2 + 1] = this.code.length - (jf2 + 2);
      }
      if (this.at("else")) {
        this.eat("else");
        this.pushScope();
        this.block();
        this.popScope();
      }
    } else {
      this.code[jf + 1] = this.code.length - (jf + 2);
    }
    this.eat("end");
    for (const je of ends) {
      this.code[je + 1] = this.code.length - (je + 2);
    }
  }

  whileStat() {
    this.eat("while");
    const start = this.code.length;
    this.exp();
    this.eat("do");
    const jf = this.code.length;
    this.emit(this.OP.JMPIFNOT, 0);
    this.pushScope();
    this.block();
    this.popScope();
    this.eat("end");
    this.emit(this.OP.JMP, start - (this.code.length + 2));
    this.code[jf + 1] = this.code.length - (jf + 2);
  }

  exp() {
    this.expOr();
  }

  expOr() {
    this.expAnd();
    while (this.at("or")) {
      this.eat("or");
      this.emit(this.OP.DUP);
      const j = this.code.length;
      this.emit(this.OP.JMPIF, 0);
      this.emit(this.OP.POP);
      this.expAnd();
      this.code[j + 1] = this.code.length - (j + 2);
    }
  }

  expAnd() {
    this.expCmp();
    while (this.at("and")) {
      this.eat("and");
      this.emit(this.OP.DUP);
      const j = this.code.length;
      this.emit(this.OP.JMPIFNOT, 0);
      this.emit(this.OP.POP);
      this.expCmp();
      this.code[j + 1] = this.code.length - (j + 2);
    }
  }

  expCmp() {
    this.expConcat();
    while (this.at("==", "~=", "<", ">", "<=", ">=")) {
      const op = this.eat().t;
      this.expConcat();
      const map = { "==": "EQ", "~=": "NE", "<": "LT", ">": "GT", "<=": "LE", ">=": "GE" };
      this.emit(this.OP[map[op]]);
    }
  }

  expConcat() {
    this.expAdd();
    while (this.at("..")) {
      this.eat("..");
      this.expAdd();
      this.emit(this.OP.CONCAT);
    }
  }

  expAdd() {
    this.expMul();
    while (this.at("+", "-")) {
      const op = this.eat().t;
      this.expMul();
      this.emit(op === "+" ? this.OP.ADD : this.OP.SUB);
    }
  }

  expMul() {
    this.expUnary();
    while (this.at("*", "/", "%")) {
      const op = this.eat().t;
      this.expUnary();
      this.emit(op === "*" ? this.OP.MUL : op === "/" ? this.OP.DIV : this.OP.MOD);
    }
  }

  expUnary() {
    if (this.at("not", "-", "#")) {
      const op = this.eat().t;
      this.expUnary();
      this.emit(op === "not" ? this.OP.NOT : op === "-" ? this.OP.UNM : this.OP.LEN);
    } else {
      this.expPow();
    }
  }

  expPow() {
    this.expPrimary();
    if (this.at("^")) {
      this.eat("^");
      this.expUnary();
      this.emit(this.OP.POW);
    }
  }

  expPrimary() {
    if (this.at("function")) {
      // anonymous function expression
      this.eat("function");
      this.eat("(");
      const params = [];
      if (!this.at(")")) {
        params.push(this.eat("name").v);
        while (this.at(",")) {
          this.eat(",");
          if (this.at("...")) { this.eat("..."); break; }
          params.push(this.eat("name").v);
        }
      }
      this.eat(")");
      const jmpAt = this.code.length;
      this.emit(this.OP.JMP, 0);
      const bodyStart = this.code.length;
      this.pushScope(true);
      for (const pm of params) this.newLocal(pm);
      this.block();
      this.emit(this.OP.LOADNIL);
      this.emit(this.OP.RETURN, 1);
      this.popScope();
      this.eat("end");
      this.code[jmpAt + 1] = this.code.length - (jmpAt + 2);
      if (!this.OP.CLOSURE) this.OP.CLOSURE = 50 + randInt(1, 20);
      this.emit(this.OP.CLOSURE, bodyStart + 1, params.length);
      return;
    }
    if (this.at("num")) {
      const v = this.eat("num").v;
      let numv = 0;
      try {
        numv = v.toLowerCase().startsWith("0x") ? parseInt(v, 16) : parseFloat(v);
      } catch {
        numv = 0;
      }
      this.emit(this.OP.LOADK, this.intern(numv));
    } else if (this.at("str")) {
      let s = this.eat("str").v;
      s = s
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, "\\");
      // Split strings so full plaintext never exists as a single constant
      if (s.length >= 4) {
        const n = s.length <= 8 ? 2 : (s.length <= 24 ? 3 : 4);
        const step = Math.ceil(s.length / n);
        const parts = [];
        for (let i = 0; i < s.length; i += step) parts.push(s.slice(i, i + step));
        this.emit(this.OP.LOADK, this.intern(parts[0]));
        for (let i = 1; i < parts.length; i++) {
          this.emit(this.OP.LOADK, this.intern(parts[i]));
          this.emit(this.OP.CONCAT);
        }
      } else {
        this.emit(this.OP.LOADK, this.intern(s));
      }
    } else if (this.at("nil")) {
      this.eat("nil");
      this.emit(this.OP.LOADNIL);
    } else if (this.at("true")) {
      this.eat("true");
      this.emit(this.OP.LOADBOOL, 1);
    } else if (this.at("false")) {
      this.eat("false");
      this.emit(this.OP.LOADBOOL, 0);
    } else if (this.at("{")) {
      this.tableConstructor();
    } else if (this.at("(")) {
      this.eat("(");
      this.exp();
      this.eat(")");
    } else if (this.at("name")) {
      const name = this.eat("name").v;
      const loc = this.findLocal(name);
      if (loc !== null) this.emit(this.OP.GETLOCAL, loc);
      else this.emit(this.OP.GETGLOBAL, this.intern(name));
      while (true) {
        if (this.at(".")) {
          this.eat(".");
          const field = this.eat("name").v;
          this.emit(this.OP.LOADK, this.intern(field));
          this.emit(this.OP.GETTABLE);
        } else if (this.at("[")) {
          this.eat("[");
          this.exp();
          this.eat("]");
          this.emit(this.OP.GETTABLE);
        } else if (this.at("(")) {
          const nargs = this.callArgs();
          this.emit(this.OP.CALL, nargs, 1);
        } else if (this.at(":")) {
          this.eat(":");
          const method = this.eat("name").v;
          // stack: obj → obj, obj → obj, obj, key → obj, method → method, obj
          if (!this.OP.SWAP) this.OP.SWAP = 90 + randInt(1, 10);
          this.emit(this.OP.DUP);
          this.emit(this.OP.LOADK, this.intern(method));
          this.emit(this.OP.GETTABLE);
          this.emit(this.OP.SWAP);
          const nargs = this.callArgs();
          this.emit(this.OP.CALL, nargs + 1, 1);
        } else break;
      }
    } else {
      this.errors++;
      this.emit(this.OP.LOADNIL);
      if (!this.at("EOF")) this.p++;
    }
  }

  tableConstructor() {
    this.eat("{");
    this.emit(this.OP.NEWTABLE);
    let idx = 1;
    while (!this.at("}", "EOF")) {
      if (this.at("name") && this.tokens[this.p + 1] && this.tokens[this.p + 1].t === "=") {
        const k = this.eat("name").v;
        this.eat("=");
        this.exp();
        this.emit(this.OP.LOADK, this.intern(k));
        this.emit(this.OP.SETTABLE);
      } else if (this.at("[")) {
        this.eat("[");
        this.exp();
        this.eat("]");
        this.eat("=");
        this.exp();
        this.emit(this.OP.SETTABLE);
      } else {
        this.exp();
        this.emit(this.OP.LOADK, this.intern(idx));
        this.emit(this.OP.SETTABLE);
        idx++;
      }
      if (this.at(",", ";")) this.eat();
      else break;
    }
    if (this.at("}")) this.eat("}");
  }
}

function bx(a, b) {
  a &= 255;
  b &= 255;
  let r = 0;
  let p = 1;
  for (let i = 0; i < 8; i++) {
    r += (((a % 2) + (b % 2)) % 2) * p;
    a = Math.floor(a / 2);
    b = Math.floor(b / 2);
    p *= 2;
  }
  return r;
}

function encodeBc(data, key) {
  const out = Buffer.alloc(data.length);
  let state = (key[0] + key[1] * 256 + key[2] * 65536 + key[3] * 16777216) >>> 0;
  if (!state) state = 1;
  for (let i = 0; i < data.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] =
      data[i] ^
      key[i % key.length] ^
      ((state >>> 16) & 0xff) ^
      ((i * 131) & 0xff);
  }
  return out;
}

function packProgram(code, constants, key) {
  key = key || Buffer.alloc(16);
  const parts = [];
  const nconst = Buffer.alloc(4);
  nconst.writeUInt32LE(constants.length);
  const ncode = Buffer.alloc(4);
  ncode.writeUInt32LE(code.length);
  parts.push(nconst, ncode);
  for (let ci = 0; ci < constants.length; ci++) {
    const c = constants[ci];
    if (c === null || c === undefined) {
      parts.push(Buffer.from([0]));
    } else if (typeof c === "boolean") {
      parts.push(Buffer.from([1, c ? 1 : 0]));
    } else if (typeof c === "number") {
      let s = Buffer.from(String(c), "utf8");
      // per-constant XOR using key + index
      let st = (key[ci % key.length] + ci * 131) >>> 0;
      const sA = (key._saltA >>> 0) || 0;
      const sB = (key._saltB >>> 0) || 0;
      st = (st + sA + sB) >>> 0;
      for (let j = 0; j < s.length; j++) {
        st = (Math.imul(st, 1664525) + 1013904223) >>> 0;
        let k1 = (st >>> 16) & 0xff;
        st = (Math.imul(st, 1664525) + 1013904223) >>> 0;
        let k2 = (st >>> 16) & 0xff;
        s[j] ^= k1 ^ k2;
      }
      parts.push(Buffer.from([2, s.length & 0xff, (s.length >> 8) & 0xff]), s);
    } else {
      let s = Buffer.from(String(c), "utf8");
      let st = (key[ci % key.length] + ci * 131) >>> 0;
      const sA = (key._saltA >>> 0) || 0;
      const sB = (key._saltB >>> 0) || 0;
      st = (st + sA + sB) >>> 0;
      for (let j = 0; j < s.length; j++) {
        st = (Math.imul(st, 1664525) + 1013904223) >>> 0;
        let k1 = (st >>> 16) & 0xff;
        st = (Math.imul(st, 1664525) + 1013904223) >>> 0;
        let k2 = (st >>> 16) & 0xff;
        s[j] ^= k1 ^ k2;
      }
      parts.push(Buffer.from([3, s.length & 0xff, (s.length >> 8) & 0xff]), s);
    }
  }
  // Encrypt each code word; mixMul from VM profile
  const mixMul = (key._mixMul >>> 0) || 0x9e3779b9;
  for (let ci = 0; ci < code.length; ci++) {
    let v = code[ci] & 0xffff;
    let st = (key[ci % 16] ^ (Math.imul(ci, mixMul) >>> 0)) >>> 0;
    st = (Math.imul(st, 1664525) + 1013904223) >>> 0;
    const mask = (st >>> 16) & 0xffff;
    v = (v ^ mask) & 0xffff;
    parts.push(Buffer.from([v & 0xff, (v >> 8) & 0xff]));
  }
  parts.push(Buffer.alloc(4)); // reserved
  return Buffer.concat(parts);
}

function b85(data) {
  const chars = [
    ..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+./:;<=>?@[]^_{|}~",
  ];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  const alph = chars.join("");
  const base = alph.length;
  const pad = (4 - (data.length % 4)) % 4;
  const buf = Buffer.concat([data, Buffer.alloc(pad)]);
  let out = "";
  for (let i = 0; i < buf.length; i += 4) {
    let n = (buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24)) >>> 0;
    for (let k = 0; k < 5; k++) {
      out += alph[n % base];
      n = Math.floor(n / base);
    }
  }
  return { b85: out, alph, pad };
}

function emitBcVm(blob, alph, pad, keyMat, op) {
  const N = {};
  for (const k of ["bx", "dec", "st", "sp", "pc", "kn", "code", "locals", "vm", "env"]) {
    N[k] = randIdent();
  }
  const { seedStr, saltA, saltB } = keyMat;
  const mixMul = (keyMat.mixMul >>> 0) || 0x9e3779b9;
  const mixA = (keyMat.mixA >>> 0) || 1664525;
  const mixB = (keyMat.mixB >>> 0) || 1013904223;
  const shell = (keyMat.shell | 0) % 10;
  const variant = keyMat.variant | 0;
  const keyName = randIdent(12);
  const seedName = randIdent(10);
  const saltNameA = randIdent(8);
  const saltNameB = randIdent(8);
  // split seed hex into fragments; each byte XOR-masked so concat alone != seed
  const seedHex = Buffer.from(seedStr, "utf8").toString("hex"); // only 0-9a-f
  const nFrag = 4 + randInt(0, 2); // 4–6 fragments
  const fragSize = Math.ceil(seedHex.length / nFrag);
  const seedMask = randInt(1, 255);
  const seedFrags = [];
  for (let i = 0; i < seedHex.length; i += fragSize) {
    const raw = seedHex.slice(i, i + fragSize);
    let masked = "";
    const hexChars = "0123456789abcdef";
    for (let j = 0; j < raw.length; j++) {
      // global nibble index so Lua unmask (mx+i-1)%16 matches
      const gi = i + j;
      const v = parseInt(raw[j], 16) ^ ((seedMask + gi) & 15);
      masked += hexChars[v & 15];
    }
    seedFrags.push(masked);
  }
  const fragNames = seedFrags.map(() => randIdent(7));
  const maskName = randIdent(7);
  function escLuaStr(s) {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
  // opaque encoding of magic constants
  function opaqueConst(n) {
    n = n >>> 0;
    const a = randInt(1000, 9000);
    const b = (n - a) >>> 0;
    const forms = [
      `(${num(a)}+${num(b)})%4294967296`,
      `(${num(n ^ 0xffff)}~${num(0xffff)})%4294967296`,
      `(${num(Math.floor(n/3))}*3+${num(n%3)})%4294967296`,
    ];
    return forms[randInt(0, forms.length - 1)];
  }
  const cMul = opaqueConst(1664525);
  const cAdd = opaqueConst(1013904223);
  const cXor = opaqueConst(0xa5a5a5a5);

  let eq = "=";
  while (blob.includes("]" + eq + "]")) eq += "=";
  const payload = `[${eq}[${blob}]${eq}]`;
  const alphEsc = alph.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  // map real op names to random idents (no OP_LOADK leaks)
  const opId = {};
  for (const k of Object.keys(op)) opId[k] = randIdent(8);
  const opLocals = Object.entries(op)
    .map(([k, v]) => `local ${opId[k]}=${num(v)}`)
    .join("\n");
  const OP = (k) => opId[k]; // helper for template

  // Polymorphic anti (order shuffled; predicates must be safe)
  const antiParts = [
    `if type(string)~="table" or type(string.char)~="function" then while true do end end`,
    `if type(table)~="table" or type(table.concat)~="function" then while true do end end`,
    `if type(math)~="table" or type(math.floor)~="function" then while true do end end`,
    `if select("#",1,2)~=2 then while true do end end`,
    `if (1==1)==false then while true do end end`,
    `if type(type)~="function" then while true do end end`,
  ];
  for (let i = antiParts.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [antiParts[i], antiParts[j]] = [antiParts[j], antiParts[i]];
  }
  const anti = antiParts.slice(0, 3 + randInt(0, 2)).join("\n") + "\n";

  let body = `
return (function(...)
${anti}
local function ${N.bx}(a,b)
a=math.floor(a)%256 b=math.floor(b)%256
local r,p=0,1
for _=1,8 do local ba,bb=a%2,b%2 r=r+((ba+bb)%2)*p a=math.floor(a/2) b=math.floor(b/2) p=p*2 end
return r
end
local function ${randIdent(9)}(blob,alpha,key,pad)
-- decoy decoder (wrong LCG) — traps naive reimplementation
local base=#alpha local idx={}
for i=1,base do idx[alpha:sub(i,i)]=i-1 end
local out={}
for i=1,math.min(32,#blob) do out[i]=(blob:byte(i) or 0) end
return out
end
local function ${N.dec}(blob,alpha,key,pad)
local base=#alpha local idx={}
for i=1,base do idx[alpha:sub(i,i)]=i-1 end
local digits={}
for i=1,#blob do digits[#digits+1]=idx[blob:sub(i,i)] end
local bytes={} local di=1
while di+4<=#digits do
local n,p=0,1
for j=0,4 do n=n+(digits[di+j] or 0)*p p=p*base end
di=di+5
for j=0,3 do bytes[#bytes+1]=n%256 n=math.floor(n/256) end
end
if pad>0 then for i=1,pad do bytes[#bytes]=nil end end
local state=key[1]+key[2]*256+key[3]*65536+key[4]*16777216
if state==0 then state=1 end
local out={}
for i=1,#bytes do
state=(state*(${cMul})+(${cAdd}))%4294967296
local k=math.floor(state/65536)%256
out[i]=${N.bx}(${N.bx}(bytes[i],key[((i-1)%#key)+1]),${N.bx}(k,(i-1)*131%256))
end
return out
end
${opLocals}
local ${randIdent(8)}={${[...Array(16)].map(()=>num(randInt(0,255))).join(",")}}
local ${randIdent(8)}={${[...Array(16)].map(()=>num(randInt(0,255))).join(",")}}
local ${saltNameA}=${num(saltA)}
local ${saltNameB}=${num(saltB)}
local ${maskName}=${num(seedMask)}
${fragNames.map((fn,i)=>`local ${fn}="${escLuaStr(seedFrags[i])}"`).join("\n")}
local ${seedName}=${fragNames.join("..")}
do
local h=${seedName}
local mx=${maskName}
local hexc="0123456789abcdef"
local inv={}
for i=0,15 do inv[hexc:sub(i+1,i+1)]=i end
local plain={}
for i=1,#h do
local ch=h:sub(i,i)
local v=inv[ch] or 0
v=${N.bx}(v,(mx+i-1)%16)
plain[i]=hexc:sub(v+1,v+1)
end
h=table.concat(plain)
local t={}
for i=1,#h/2 do
local byte=tonumber(h:sub(i*2-1,i*2),16)
t[i]=string.char(byte)
end
${seedName}=table.concat(t)
end
local ${keyName}={}
do
local s=(${saltNameA}~${saltNameB}~(${cXor}))%4294967296
for i=1,16 do
local b=${seedName}:byte(((i-1)%#${seedName})+1)
s=((s~b)*(${cMul})+(${cAdd}))%4294967296
local sh=((i-1)%4)*8
${keyName}[i]=math.floor(s/(2^sh))%256
end
end
local bytes=${N.dec}(${payload},"${alphEsc}",${keyName},${num(pad)})
local function u16(i) return bytes[i]+bytes[i+1]*256 end
local off=1
local nconst=bytes[off]+bytes[off+1]*256+bytes[off+2]*65536+bytes[off+3]*16777216 off=off+4
local ncode=bytes[off]+bytes[off+1]*256+bytes[off+2]*65536+bytes[off+3]*16777216 off=off+4
local ${N.kn}={}
for ci=1,nconst do
local tag=bytes[off] off=off+1
if tag==0 then ${N.kn}[ci]={t=0}
elseif tag==1 then ${N.kn}[ci]={t=1,v=bytes[off]~=0} off=off+1
elseif tag==2 or tag==3 then
local ln=bytes[off]+bytes[off+1]*256 off=off+2
local enc={}
for j=0,ln-1 do enc[j+1]=bytes[off+j] end
off=off+ln
${N.kn}[ci]={t=tag,e=enc,i=ci}
end
end
local function ${N.kn}_get(idx)
local c=${N.kn}[idx]
if not c then return nil end
if c.t==0 then return nil end
if c.t==1 then return c.v end
if c.d~=nil then return c.d end
local enc=c.e
local st=(${keyName}[((c.i-1)%#${keyName})+1]+(c.i-1)*131)%4294967296
st=(st+${saltNameA}+${saltNameB})%4294967296
local chars={}
for j=1,#enc do
st=(st*1664525+1013904223)%4294967296
local k1=math.floor(st/65536)%256
st=(st*1664525+1013904223)%4294967296
local k2=math.floor(st/65536)%256
chars[j]=string.char(${N.bx}(${N.bx}(enc[j],k1),k2))
end
local s=table.concat(chars)
if #s~=#enc then return nil end
if c.t==2 then c.d=tonumber(s) else c.d=s end
return c.d
end
local ${N.code}={}
for ci=1,ncode do ${N.code}[ci]=u16(off) off=off+2 end
local _csumExp=bytes[off]+bytes[off+1]*256+bytes[off+2]*65536+bytes[off+3]*16777216 off=off+4
-- checksum retained in stream; soft check skipped for compat
do local _=_csumExp end
-- runtime integrity noise
do
local _z=0
for _i=1,math.min(8,nconst) do
local _c=${N.kn}[_i]
if _c and _c.e then _z=_z+#_c.e end
end
if _z<0 then while true do end end
end
local function ${N.code}_umul(a,b)
a=a%4294967296 b=b%4294967296
local a0,a1=a%65536,math.floor(a/65536)%65536
local b0,b1=b%65536,math.floor(b/65536)%65536
local p0=a0*b0
local p1=a0*b1+a1*b0
return (p0+(p1%65536)*65536)%4294967296
end
local function ${N.code}_at(i)
local v=${N.code}[i]
if not v then return 0 end
local kb=${keyName}[((i-1)%#${keyName})+1]
local mix=${N.code}_umul((i-1),${mixMul})
local st=(mix - mix%256 + ${N.bx}(kb,mix%256))%4294967296
local s0,s1=st%65536,math.floor(st/65536)%65536
local m0,m1=1664525%65536,math.floor(1664525/65536)%65536
local p0=s0*m0 local p1=s0*m1+s1*m0
st=(p0+(p1%65536)*65536+1013904223)%4294967296
local mask=math.floor(st/65536)%65536
local lo=${N.bx}(v%256,mask%256)
local hi=${N.bx}(math.floor(v/256)%256,math.floor(mask/256)%256)
return lo+hi*256
end
local ${N.env}=(type(_G)=="table" and _G) or {}
local function ${N.vm}(...)
local ${N.st}={} local ${N.sp}=0 local ${N.pc}=1
local ${N.locals}={}
local function push(v) ${N.sp}=${N.sp}+1 ${N.st}[${N.sp}]=v end
local function pop() local v=${N.st}[${N.sp}] ${N.st}[${N.sp}]=nil ${N.sp}=${N.sp}-1 return v end
while ${N.pc}<=ncode do
local op=${N.code}_at(${N.pc}) ${N.pc}=${N.pc}+1
if op==${OP("LOADK")} then
local idx=${N.code}_at(${N.pc}) ${N.pc}=${N.pc}+1
push(${N.kn}_get(idx+1))
elseif op==${OP("LOADNIL")} then push(nil)
elseif op==${OP("LOADBOOL")} then
local v=${N.code}_at(${N.pc}) ${N.pc}=${N.pc}+1
push(v~=0)
elseif op==${OP("GETGLOBAL")} then
local idx=${N.code}_at(${N.pc}) ${N.pc}=${N.pc}+1
local name=${N.kn}_get(idx+1)
local v=rawget(${N.env},name)
if v==nil then v=_G[name] end
push(v)
elseif op==${OP("SETGLOBAL")} then
local idx=${N.code}_at(${N.pc}) ${N.pc}=${N.pc}+1
local name=${N.kn}_get(idx+1)
local val=pop()
if type(${N.env})=="table" then rawset(${N.env},name,val) else _G[name]=val end
elseif op==${OP("GETLOCAL")} then
local slot=${N.code}_at(${N.pc}) ${N.pc}=${N.pc}+1
push(${N.locals}[slot])
elseif op==${OP("SETLOCAL")} then
local slot=${N.code}_at(${N.pc}) ${N.pc}=${N.pc}+1
${N.locals}[slot]=pop()
elseif op==${OP("ADD")} then local b,a=pop(),pop() push(a+b)
elseif op==${OP("SUB")} then local b,a=pop(),pop() push(a-b)
elseif op==${OP("MUL")} then local b,a=pop(),pop() push(a*b)
elseif op==${OP("DIV")} then local b,a=pop(),pop() push(a/b)
elseif op==${OP("MOD")} then local b,a=pop(),pop() push(a%b)
elseif op==${OP("POW")} then local b,a=pop(),pop() push(a^b)
elseif op==${OP("CONCAT")} then local b,a=pop(),pop() push(tostring(a)..tostring(b))
elseif op==${OP("EQ")} then local b,a=pop(),pop() push(a==b)
elseif op==${OP("NE")} then local b,a=pop(),pop() push(a~=b)
elseif op==${OP("LT")} then local b,a=pop(),pop() push(a<b)
elseif op==${OP("LE")} then local b,a=pop(),pop() push(a<=b)
elseif op==${OP("GT")} then local b,a=pop(),pop() push(a>b)
elseif op==${OP("GE")} then local b,a=pop(),pop() push(a>=b)
elseif op==${OP("NOT")} then push(not pop())
elseif op==${OP("UNM")} then push(-pop())
elseif op==${OP("LEN")} then push(#pop())
elseif op==${OP("JMP")} then
local off=${N.code}_at(${N.pc}) ${N.pc}=${N.pc}+1
if off>=0x8000 then off=off-0x10000 end
${N.pc}=${N.pc}+off
elseif op==${OP("JMPIF")} then
local off=${N.code}_at(${N.pc}) ${N.pc}=${N.pc}+1
if off>=0x8000 then off=off-0x10000 end
if pop() then ${N.pc}=${N.pc}+off end
elseif op==${OP("JMPIFNOT")} then
local off=${N.code}_at(${N.pc}) ${N.pc}=${N.pc}+1
if off>=0x8000 then off=off-0x10000 end
if not pop() then ${N.pc}=${N.pc}+off end
elseif op==${OP("CALL")} then
local nargs=${N.code}_at(${N.pc}) ${N.pc}=${N.pc}+1
local nrets=${N.code}_at(${N.pc}) ${N.pc}=${N.pc}+1
local args={}
for i=nargs,1,-1 do args[i]=pop() end
local fn=pop()
if type(fn)=="function" then
local rets=table.pack(fn(table.unpack(args,1,nargs)))
if nrets==1 then push(rets[1])
elseif nrets>1 then for i=1,nrets do push(rets[i]) end
elseif nrets==0 then
else for i=1,rets.n do push(rets[i]) end end
else push(nil) end
elseif op==${OP("RETURN")} then
local n=${N.code}_at(${N.pc}) ${N.pc}=${N.pc}+1
local rets={}
for i=n,1,-1 do rets[i]=pop() end
return table.unpack(rets,1,n)
elseif op==${OP("POP")} then pop()
elseif op==${OP("DUP")} then local v=pop() push(v) push(v)
elseif op==${OP("NEWTABLE")} then push({})
elseif op==${OP("GETTABLE")} then
local key=pop() local tbl=pop()
push(tbl[key])
elseif op==${OP("SETTABLE")} then
local key=pop() local val=pop() local tbl=pop()
tbl[key]=val push(tbl)
elseif op==${OP("SELF")} then
local key=pop() local obj=pop()
push(obj[key]) push(obj)
elseif op==${OP("SWAP")} then
local a=pop() local b=pop() push(a) push(b)
elseif op==${OP("HALT")} then break
elseif op==${OP("CLOSURE")} then
local entry=${N.code}_at(${N.pc}) ${N.pc}=${N.pc}+1
local nparams=${N.code}_at(${N.pc}) ${N.pc}=${N.pc}+1
local code_ref, kn_ref, env_ref = ${N.code}, ${N.kn}, ${N.env}
push(function(...)
local args=table.pack(...)
local st={} local sp=0 local pc=entry
local locals={}
for i=1,math.min(nparams,args.n) do locals[i-1]=args[i] end
local function push2(v) sp=sp+1 st[sp]=v end
local function pop2() local v=st[sp] st[sp]=nil sp=sp-1 return v end
while pc<=ncode do
local op2=${N.code}_at(pc) pc=pc+1
if op2==${OP("LOADK")} then local idx=${N.code}_at(pc) pc=pc+1 push2(${N.kn}_get(idx+1))
elseif op2==${OP("LOADNIL")} then push2(nil)
elseif op2==${OP("LOADBOOL")} then local v=${N.code}_at(pc) pc=pc+1 push2(v~=0)
elseif op2==${OP("GETGLOBAL")} then
local idx=${N.code}_at(pc) pc=pc+1
local name=${N.kn}_get(idx+1)
push2(rawget(env_ref,name) or _G[name])
elseif op2==${OP("GETLOCAL")} then local slot=${N.code}_at(pc) pc=pc+1 push2(locals[slot])
elseif op2==${OP("SETLOCAL")} then local slot=${N.code}_at(pc) pc=pc+1 locals[slot]=pop2()
elseif op2==${OP("ADD")} then local b,a=pop2(),pop2() push2(a+b)
elseif op2==${OP("SUB")} then local b,a=pop2(),pop2() push2(a-b)
elseif op2==${OP("MUL")} then local b,a=pop2(),pop2() push2(a*b)
elseif op2==${OP("DIV")} then local b,a=pop2(),pop2() push2(a/b)
elseif op2==${OP("CONCAT")} then local b,a=pop2(),pop2() push2(tostring(a)..tostring(b))
elseif op2==${OP("EQ")} then local b,a=pop2(),pop2() push2(a==b)
elseif op2==${OP("NE")} then local b,a=pop2(),pop2() push2(a~=b)
elseif op2==${OP("LT")} then local b,a=pop2(),pop2() push2(a<b)
elseif op2==${OP("CALL")} then
local na=${N.code}_at(pc) pc=pc+1 local nr=${N.code}_at(pc) pc=pc+1
local a2={} for i=na,1,-1 do a2[i]=pop2() end
local fn=pop2()
if type(fn)=="function" then
local rets=table.pack(fn(table.unpack(a2,1,na)))
if nr==1 then push2(rets[1])
elseif nr>1 then for i=1,nr do push2(rets[i]) end
else for i=1,rets.n do push2(rets[i]) end end
else push2(nil) end
elseif op2==${OP("RETURN")} then
local n=${N.code}_at(pc) pc=pc+1
local rets={} for i=n,1,-1 do rets[i]=pop2() end
return table.unpack(rets,1,n)
elseif op2==${OP("POP")} then pop2()
elseif op2==${OP("GETTABLE")} then local key=pop2() local tbl=pop2() push2(tbl[key])
elseif op2==${OP("SETTABLE")} then
local key=pop2() local val=pop2() local tbl=pop2()
tbl[key]=val push2(tbl)
elseif op2==${OP("SETGLOBAL")} then
local idx=${N.code}_at(pc) pc=pc+1
local name=${N.kn}_get(idx+1)
local val=pop2()
if type(env_ref)=="table" then rawset(env_ref,name,val) else _G[name]=val end
elseif op2==${OP("SELF")} then
local key=pop2() local obj=pop2()
push2(obj[key]) push2(obj)
elseif op2==${OP("SWAP")} then
local a=pop2() local b=pop2() push2(a) push2(b)
elseif op2==${OP("NEWTABLE")} then push2({})
elseif op2==${OP("NOT")} then push2(not pop2())
elseif op2==${OP("UNM")} then push2(-pop2())
elseif op2==${OP("LEN")} then push2(#pop2())
elseif op2==${OP("LE")} then local b,a=pop2(),pop2() push2(a<=b)
elseif op2==${OP("GE")} then local b,a=pop2(),pop2() push2(a>=b)
elseif op2==${OP("GT")} then local b,a=pop2(),pop2() push2(a>b)
elseif op2==${OP("MOD")} then local b,a=pop2(),pop2() push2(a%b)
elseif op2==${OP("POW")} then local b,a=pop2(),pop2() push2(a^b)
elseif op2==${OP("DUP")} then local v=pop2() push2(v) push2(v)
elseif op2==${OP("JMP")} then
local off=${N.code}_at(pc) pc=pc+1 if off>=0x8000 then off=off-0x10000 end pc=pc+off
elseif op2==${OP("JMPIF")} then
local off=${N.code}_at(pc) pc=pc+1 if off>=0x8000 then off=off-0x10000 end
if pop2() then pc=pc+off end
elseif op2==${OP("JMPIFNOT")} then
local off=${N.code}_at(pc) pc=pc+1 if off>=0x8000 then off=off-0x10000 end
if not pop2() then pc=pc+off end
elseif op2==${OP("HALT")} then break
else break end
end
end)
end
end
end
return ${N.vm}(...)
end)(...)
`;
  body = body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");



  // v4 skins: junk + decoy table + shell wrap (safe)
  const junk = [];
  for (let i = 0; i < 2 + (shell % 4); i++) {
    junk.push(`local ${randIdent(6)}=${num(randInt(0, 0xffffff))}`);
  }
  const decoy = randIdent(8);
  const decoyEntries = [];
  for (let i = 0; i < 3 + (shell % 5); i++) {
    decoyEntries.push(`[${num(randInt(1000, 60000))}]=function(...) end`);
  }
  junk.push(`local ${decoy}={${decoyEntries.join(",")}}`);
  const prefix = junk.join("\n");
  let wrapped = `${prefix}\n${body}`;
  if (shell % 3 === 0) wrapped = `${prefix}\ndo\n${body}\nend`;
  else if (shell % 3 === 1) wrapped = `local ${randIdent(5)}=${num(variant)}\n${prefix}\n${body}`;
  wrapped = `-- euana-vm/${variant}\n` + wrapped;
  return wrapped;
}




function compileToBytecode(src) {
  const c = new Compiler();
  return c.compile(src);
}

function emitBytecodeObfuscation(src, intensity) {
  src = preprocessLuau(src);
  const result = compileToBytecode(src);
  if (!result.ok) {
    return { ok: false, errors: result.errors };
  }
  let { code, constants, op } = result;

  // Heavy noise — real constants buried among many fakes
  const noise = { v1: 16, v2: 32, v3: 64 }[intensity] || 32;
  for (let i = 0; i < noise; i++) {
    constants.push(randInt(0x1000, 0xffffff));
    constants.push(randIdent(randInt(6, 14)));
    if (Math.random() < 0.4) constants.push(randIdent(randInt(4, 10)) + randIdent(4));
  }
  // Force minimum complexity for tiny scripts (e.g. print(1))
  while (constants.length < 24) {
    constants.push(randInt(100, 0xffffff));
    constants.push(randIdent(8));
  }
  // Shuffle constant table so index 0/1 are not always the real ones
  // (compiler already interned; we only append noise after, so real ones stay low —
  // extra: inject noise at front by rebuilding)
  const realConsts = constants.slice(0, result.constants.length);
  const noiseConsts = constants.slice(result.constants.length);
  for (let i = noiseConsts.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [noiseConsts[i], noiseConsts[j]] = [noiseConsts[j], noiseConsts[i]];
  }
  // Keep real constants but interleave noise so linear scan is noisier
  const mixed = [];
  let ri = 0, ni = 0;
  while (ri < realConsts.length || ni < noiseConsts.length) {
    if (ni < noiseConsts.length && (ri >= realConsts.length || Math.random() < 0.55)) {
      mixed.push(noiseConsts[ni++]);
    } else if (ri < realConsts.length) {
      mixed.push(realConsts[ri++]);
    }
  }
  // Remap code LOADK indices — skip for now (would need full remap). Keep original order + trailing noise.
  constants = result.constants.concat(noiseConsts);

  // Pick one of ~100 VM profiles
  const variant = randInt(0, 99);
  const MIX_MULS = [
    0x9e3779b9, 0x6c078965, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2d,
    0x165667b1, 0x94d049bb, 0x7f4a7c15, 0x5bd1e995, 0x1b873593
  ];
  const mixMul = MIX_MULS[variant % 10];
  const mixA = 1664525;
  const mixB = 1013904223;
  const shell = Math.floor(variant / 10) % 10;

  const seedStr = crypto.randomBytes(32).toString("base64");
  const saltA = randInt(1, 0x7fffffff);
  const saltB = randInt(1, 0x7fffffff);
  const key = Buffer.alloc(16);
  let ds = (saltA >>> 0) ^ (saltB >>> 0) ^ 0xa5a5a5a5;
  for (let i = 0; i < 16; i++) {
    ds = (Math.imul(ds ^ seedStr.charCodeAt(i % seedStr.length), 1664525) + 1013904223) >>> 0;
    key[i] = (ds >>> ((i % 4) * 8)) & 0xff;
  }
  key._mixMul = mixMul;
  key._saltA = saltA;
  key._saltB = saltB;
  const packed = packProgram(code, constants, key);
  const enc = encodeBc(packed, key);
  const { b85: blob, alph, pad } = b85(enc);
  const out = emitBcVm(blob, alph, pad, { seedStr, saltA, saltB, mixMul, mixA, mixB, shell, variant }, op);
  return { ok: true, code: out, mode: "bytecode", variant };
}


/**
 * Euana v2.1 – universal Lua/Luau obfuscator (Node)
 * Multi-chunk encrypted payload + CF state-machine VM
 * Encode/decode symmetric with emitted Lua VM
 */

const APP_NAME = "Euana";
const VERSION = "5.0.0";

function randInt(a, b) {
  return a + Math.floor(Math.random() * (b - a + 1));
}

function randIdent(n) {
  n = n || randInt(9, 16);
  // MUST start with letter or underscore – never digit (Lua parses 0x.. / 1o as number)
  const styles = [
    () => {
      const first = "abcdefghijklmnopqrstuvwxyz"[randInt(0, 25)];
      return first + [...Array(n - 1)].map(() => "abcdefghijklmnopqrstuvwxyz"[randInt(0, 25)]).join("");
    },
    () =>
      "_" +
      [...Array(n)].map(() => "abcdefghijklmnopqrstuvwxyz0123456789"[randInt(0, 35)]).join(""),
    () => {
      const first = "IlOlo"[randInt(0, 4)];
      return first + [...Array(n - 1)].map(() => "IlO0o1"[randInt(0, 5)]).join("");
    },
    () => {
      const first = "abcdefghijklmnopqrstuvwxyz"[randInt(0, 25)];
      return (
        first +
        [...Array(1)].map(() => "abcdefghijklmnopqrstuvwxyz"[randInt(0, 25)]).join("") +
        String(randInt(100000, 9999999)) +
        [...Array(3)].map(() => "abcdefghijklmnopqrstuvwxyz"[randInt(0, 25)]).join("")
      );
    },
  ];
  let name = styles[randInt(0, styles.length - 1)]();
  if (/^[0-9]/.test(name)) name = "n" + name;
  return name;
}

function num(n) {
  // Lua 5.x has no 0b literals. Never glue to next token: callers must keep spaces,
  // but we still avoid trailing letter ambiguity by preferring hex/decimal only.
  n = n >>> 0;
  const r = Math.random();
  if (n < 8 && r < 0.2) return String(n);
  if (r < 0.55) return "0x" + n.toString(16).toUpperCase();
  return String(n);
}

function opaqueTrue() {
  const a = randInt(3, 40);
  const b = randInt(3, 40);
  const forms = [
    `(function() local a=${num(a)} return a*a>=${num(0)} end)()`,
    `(function() local a=${num(a)} local b=${num(b)} return (a*b)==(b*a) end)()`,
    `(function() local a=${num(a)} return type(a)=="number" and a==a end)()`,
    `(function() local a=${num(a)} return #tostring(a)>${num(0)} end)()`,
  ];
  return forms[randInt(0, forms.length - 1)];
}

function opaqueFalse() {
  const a = randInt(2, 25);
  return [
    `(function() local a=${num(a)} return a*a<${num(0)} end)()`,
    `(function() local a=${num(a)} return a~=a end)()`,
    `(function() return false and ${num(a)} end)()`,
  ][randInt(0, 2)];
}

function bx(a, b) {
  a = a & 255;
  b = b & 255;
  let r = 0;
  let p = 1;
  for (let i = 0; i < 8; i++) {
    r += (((a % 2) + (b % 2)) % 2) * p;
    a = Math.floor(a / 2);
    b = Math.floor(b / 2);
    p *= 2;
  }
  return r;
}

function streamCrypt(data, key, salt) {
  const out = Buffer.alloc(data.length);
  let state =
    (key[0] + key[1] * 256 + key[2] * 65536 + key[3] * 16777216) >>> 0;
  if (state === 0) state = 0xa5a5a5a5;
  for (let j = 0; j < data.length; j++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const k = Math.floor(state / 65536) % 256;
    const kb = key[j % key.length];
    const mix = bx(k, (j * 131 + salt) % 256);
    out[j] = bx(data[j], bx(kb, mix));
  }
  return out;
}

function shuffleAlphabet() {
  const chars = [
    ..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+./:;<=>?@[]^_{|}~",
  ];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function b85encode(data, alphabet) {
  const base = alphabet.length;
  const pad = (4 - (data.length % 4)) % 4;
  const buf = Buffer.concat([data, Buffer.alloc(pad)]);
  let out = "";
  for (let i = 0; i < buf.length; i += 4) {
    let n = (buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24)) >>> 0;
    for (let k = 0; k < 5; k++) {
      out += alphabet[n % base];
      n = Math.floor(n / base);
    }
  }
  return { encoded: out, pad };
}

function longstr(s) {
  let eq = "=";
  while (s.includes("]" + eq + "]")) eq += "=";
  return `[${eq}[${s}]${eq}]`;
}

function antiBundle(intensity) {
  const ids = Array.from({ length: 6 }, () => randIdent());
  const nums = Array.from({ length: 6 }, () => randInt(0x1000, 0xffffff));
  const parts = [
    `local ${ids[0]}=${num(nums[0])}`,
    `local ${ids[1]}=${num(nums[1])}`,
    `local ${ids[2]}={[${num(1)}]=${ids[0]},[${num(2)}]=${ids[1]}}`,
    `local ${ids[3]}=${ids[2]}[${num(1)}]`,
    `if ${ids[3]}~=${ids[0]} and ${opaqueTrue()} then ${ids[0]}=${ids[3]} end`,
  ];
  const f1 = randIdent();
  const f2 = randIdent();
  parts.push(`local ${f1}=function() return ${num(randInt(1, 9))} end`);
  parts.push(`local ${f2}=function(...) return ${f1}() end`);
  parts.push(
    `if type(${f1})~="function" or type(${f2})~="function" then while true do end end`
  );
  if (intensity === "v2" || intensity === "v3") {
    parts.push(
      `if type(string)~="table" or type(string.char)~="function" then while true do end end`
    );
    parts.push(
      `if type(table)~="table" or type(table.concat)~="function" then while true do end end`
    );
    parts.push(
      `if type(math)~="table" or type(math.floor)~="function" then while true do end end`
    );
    parts.push(`if ${opaqueFalse()} then ${f2}(${num(0)}) while true do end end`);
  }
  if (intensity === "v3") {
    parts.push(
      `do local _t=type if _t(_t)~="function" then while true do end end end`
    );
    for (let i = 0; i < 4; i++) {
      parts.push(`do local ${randIdent()}=${num(randInt(10, 99999))} end`);
    }
    const sA = randIdent();
    parts.push(
      `do local ${sA}=string.char(${num(72)},${num(73)}) if #${sA}~=${num(2)} then while true do end end end`
    );
    parts.push(
      `if select("#", ${num(1)}, ${num(2)}) ~= ${num(2)} then while true do end end`
    );
  }
  return parts.join(" ");
}

function emitVm(src, intensity) {
  const raw = Buffer.from(src, "utf8");
  let nChunks = { v1: 3, v2: 5, v3: 8 }[intensity] || 5;
  if (raw.length > 200000) nChunks = Math.min(24, nChunks + 8);
  else if (raw.length > 50000) nChunks = Math.min(16, nChunks + 4);

  const size = Math.max(1, Math.ceil(raw.length / nChunks));
  const chunks = [];
  for (let i = 0; i < raw.length; i += size) {
    chunks.push(raw.subarray(i, Math.min(i + size, raw.length)));
  }
  if (chunks.length === 0) chunks.push(Buffer.alloc(0));

  const masterKey = crypto.randomBytes(16);
  const alphabet = shuffleAlphabet();
  const order = chunks.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const invOrder = Array(chunks.length);
  order.forEach((o, i) => {
    invOrder[o] = i;
  });

  const slotPayloads = Array(chunks.length);
  const slotSalts = Array(chunks.length);
  const slotPads = Array(chunks.length);
  const slotLens = Array(chunks.length);
  let checksum = 0;

  for (let i = 0; i < chunks.length; i++) {
    const salt = randInt(1, 0x7fffffff);
    const enc = streamCrypt(chunks[i], masterKey, salt);
    for (let b = 0; b < chunks[i].length; b++) checksum = (checksum + chunks[i][b]) & 0xffff;
    const { encoded, pad } = b85encode(enc, alphabet);
    const slot = order[i];
    slotPayloads[slot] = encoded;
    slotSalts[slot] = salt;
    slotPads[slot] = pad;
    slotLens[slot] = chunks[i].length;
  }

  // decoy slots (never referenced by order table)
  const decoyN = intensity === "v3" ? 3 : intensity === "v2" ? 2 : 1;
  for (let d = 0; d < decoyN; d++) {
    const fake = crypto.randomBytes(randInt(16, 64));
    const { encoded, pad } = b85encode(fake, alphabet);
    slotPayloads.push(encoded);
    slotSalts.push(randInt(1, 0x7fffffff));
    slotPads.push(pad);
    slotLens.push(fake.length);
  }

  const chunkLits = slotPayloads.map(longstr).join(", ");
  const saltTbl = "{" + slotSalts.map(num).join(",") + "}";
  const padTbl = "{" + slotPads.map(num).join(",") + "}";
  const lenTbl = "{" + slotLens.map(num).join(",") + "}";
  // assembly order: for i=0..n-1 emit slot where original chunk i lives
  const orderTbl = "{" + order.map((slot) => num(slot + 1)).join(",") + "}";
  const keyTbl = "{" + [...masterKey].map(num).join(",") + "}";
  const alphaEsc = alphabet.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  const N = {};
  for (const k of [
    "bx", "chunks", "salts", "pads", "lens", "ord", "key", "alpha",
    "out", "st", "i", "part", "fn", "sum",
  ]) {
    N[k] = randIdent();
  }

  const states = Array.from({ length: 16 }, (_, i) => 20 + i * 3 + randInt(0, 2));
  for (let i = states.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [states[i], states[j]] = [states[j], states[i]];
  }
  const S = {
    INIT: states[0], CHECK: states[1], PREP: states[2], LOOP: states[3],
    JOIN: states[4], LOAD: states[5], CALL: states[6], FAIL: states[7],
    SPIN: states[8], JUNK: states[9], ANTI: states[10], DEAD: states[11],
    CSUM: states[12],
  };

  const anti = antiBundle(intensity);
  const ot = opaqueTrue();
  const expectSum = num(checksum);

  let body = `
return (function(...)
${anti}
local function ${N.bx}(x,y)
x=math.floor(x)%256 y=math.floor(y)%256
local r,p=0,1
for _=1,8 do local bx,by=x%2,y%2 r=r+((bx+by)%2)*p x=math.floor(x/2) y=math.floor(y/2) p=p*2 end
return r
end
local ${N.chunks}={ ${chunkLits} }
local ${N.salts}=${saltTbl}
local ${N.pads}=${padTbl}
local ${N.lens}=${lenTbl}
local ${N.ord}=${orderTbl}
local ${N.key}=${keyTbl}
local ${N.alpha}="${alphaEsc}"
local ${N.out}={}
local ${N.st}=${num(S.INIT)}
local ${N.i}=0
local ${N.part}=nil
local ${N.fn}=nil
local ${N.sum}=0
while true do
if ${N.st}==${num(S.INIT)} then
if ${opaqueTrue()} then ${N.st}=${num(S.CHECK)} else ${N.st}=${num(S.DEAD)} end
elseif ${N.st}==${num(S.CHECK)} then
if type(${N.chunks})~="table" or #${N.chunks}<${num(1)} then ${N.st}=${num(S.FAIL)} else ${N.st}=${num(S.ANTI)} end
elseif ${N.st}==${num(S.ANTI)} then
local _t=type
if _t(_t)~="function" then ${N.st}=${num(S.SPIN)} else ${N.st}=${num(S.PREP)} end
elseif ${N.st}==${num(S.PREP)} then
${N.i}=1 ${N.sum}=0 ${N.st}=${num(S.LOOP)}
elseif ${N.st}==${num(S.LOOP)} then
if ${N.i}>#${N.ord} then ${N.st}=${num(S.CSUM)}
else
local slot=${N.ord}[${N.i}]
local part=${N.chunks}[slot]
local salt=${N.salts}[slot]
local pad=${N.pads}[slot]
local L=${N.lens}[slot]
local A=${N.alpha}
local base=#A
local idx={}
for j=1,base do idx[A:sub(j,j)]=j-1 end
local digits={}
for j=1,#part do digits[#digits+1]=idx[part:sub(j,j)] end
local bytes={}
local di=1
while di+4<=#digits do
local n,p=0,1
for k=0,4 do n=n+(digits[di+k] or 0)*p p=p*base end
di=di+5
for k=0,3 do bytes[#bytes+1]=n%256 n=math.floor(n/256) end
end
if pad>0 then for k=1,pad do bytes[#bytes]=nil end end
local state=(${N.key}[1]+${N.key}[2]*256+${N.key}[3]*65536+${N.key}[4]*16777216)
if state==0 then state=${num(0xa5a5a5a5)} end
local piece={}
for j=1,L do
state=(state*1664525+1013904223)%4294967296
local k=math.floor(state/65536)%256
local kb=${N.key}[((j-1)%#${N.key})+1]
local xb=${N.bx}(bytes[j] or 0,${N.bx}(kb,${N.bx}(k,((j-1)*131+salt)%256)))
piece[j]=string.char(xb)
${N.sum}=${N.sum}+xb
end
${N.out}[${N.i}]=table.concat(piece)
if ${opaqueFalse()} then ${N.st}=${num(S.DEAD)}
else ${N.i}=${N.i}+1 ${N.st}=${num(S.JUNK)} end
end
elseif ${N.st}==${num(S.JUNK)} then
local _z=${num(randInt(1, 999))} _z=_z+0
${N.st}=${num(S.LOOP)}
elseif ${N.st}==${num(S.CSUM)} then
if (${N.sum}%65536)~=${expectSum} then ${N.st}=${num(S.FAIL)}
else ${N.st}=${num(S.JOIN)} end
elseif ${N.st}==${num(S.JOIN)} then
${N.part}=table.concat(${N.out})
${N.st}=${num(S.LOAD)}
elseif ${N.st}==${num(S.LOAD)} then
local loader=load or loadstring
local fn,err=loader(${N.part})
if not fn then error(err or "load") end
if type(fn)~="function" then ${N.st}=${num(S.SPIN)} else ${N.fn}=fn ${N.st}=${num(S.CALL)} end
elseif ${N.st}==${num(S.CALL)} then
if ${ot} then return ${N.fn}(...) end
return ${N.fn}(...)
elseif ${N.st}==${num(S.DEAD)} then
if ${opaqueFalse()} then ${N.st}=${num(S.SPIN)} else ${N.st}=${num(S.FAIL)} end
elseif ${N.st}==${num(S.FAIL)} then
error("EUN")
elseif ${N.st}==${num(S.SPIN)} then
while ${opaqueTrue()} do end
else
${N.st}=${num(S.FAIL)}
end
end
end)(...)
`;
  body = body.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  // Soft compact: join only pure indent lines, keep structure to avoid token gluing
  body = body
    .split("\n")
    .map((ln) => ln.trim())
    .filter((ln) => ln.length)
    .join("\n");
  return body;
}

function stripComments(code) {
  return code
    .split("\n")
    .filter((line) => {
      const s = line.trim();
      return !(s.startsWith("--") && !s.startsWith("--[["));
    })
    .join("\n");
}

function selfTestCrypto() {
  const key = crypto.randomBytes(16);
  const salt = randInt(1, 0x7fffffff);
  const data = Buffer.from("print('euana-self-test')\nlocal x=1+2\n", "utf8");
  const enc = streamCrypt(data, key, salt);
  let state =
    (key[0] + key[1] * 256 + key[2] * 65536 + key[3] * 16777216) >>> 0;
  if (state === 0) state = 0xa5a5a5a5;
  const out = Buffer.alloc(data.length);
  for (let j = 0; j < data.length; j++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const k = Math.floor(state / 65536) % 256;
    const kb = key[j % key.length];
    const mix = bx(k, (j * 131 + salt) % 256);
    out[j] = bx(enc[j], bx(kb, mix));
  }
  if (!out.equals(data)) throw new Error("crypto self-test failed");
  return true;
}

/**
 * True if `output` still contains readable fragments of user source.
 * Used to guarantee original source is not left in plaintext.
 */
function leaksPlainSource(output, source) {
  if (!output || !source) return false;
  const out = String(output);
  const src = String(source);
  // Significant non-comment lines
  const lines = src.split(/\n/).map((l) => l.trim()).filter((l) => {
    if (l.length < 14) return false;
    if (l.startsWith("--")) return false;
    return true;
  });
  for (const line of lines) {
    if (out.includes(line)) return true;
  }
  // Sliding window over denser source
  if (src.length >= 20) {
    const step = 12;
    const win = 20;
    for (let i = 0; i + win <= src.length; i += step) {
      const chunk = src.slice(i, i + win);
      if (/^\s+$/.test(chunk)) continue;
      if (out.includes(chunk)) return true;
    }
  }
  return false;
}

function obfuscateCode(code, intensity = "v3") {
  code = (code || "").trim();
  if (!code) return "-- empty";
  if (!["v1", "v2", "v3"].includes(intensity)) intensity = "v3";

  if (!obfuscateCode._tested) {
    selfTestCrypto();
    obfuscateCode._tested = true;
  }

  let src = stripComments(code);
  if (!src.trim()) src = code;
  src = preprocessLuau(src);

  const date = new Date().toISOString().slice(0, 10);
  const header = (mode) =>
    `-- Protected by ${APP_NAME} ${VERSION}\n-- ${date} | ${intensity} | ${mode} | no-plain-source\n`;

  // 1) Bytecode VM — original source must not appear as plaintext
  try {
    const bc = emitBytecodeObfuscation(src, intensity);
    if (bc.ok) {
      const body = bc.code;
      if (!leaksPlainSource(body, src)) {
        return header("bytecode") + body + "\n";
      }
      // leaked → fall through to encrypted envelope
    }
  } catch (_) {
    /* fall through */
  }

  // 2) Encrypted envelope — source only inside ciphertext chunks
  let layers = { v1: 2, v2: 3, v3: 5 }[intensity] || 3;
  if (src.length > 500000) layers = Math.min(layers, 2);
  else if (src.length > 150000) layers = Math.min(layers, 3);
  else if (src.length > 50000) layers = Math.min(layers, 4);

  let current = src;
  for (let i = 0; i < layers; i++) {
    const li = intensity === "v3" ? "v3" : i === layers - 1 ? intensity : "v1";
    current = emitVm(current, li);
  }

  // Final guarantee: never ship if plaintext source still visible
  if (leaksPlainSource(current, src)) {
    // last resort: one more envelope layer
    current = emitVm(current, "v3");
  }
  if (leaksPlainSource(current, src)) {
    return header("blocked") + `-- error: refused to emit plaintext source\n`;
  }

  return header("envelope") + current + "\n";
}

function calcCost() {
  return 3;
}


function runTests() {
  const LUA = process.env.LUA || "/tmp/lua5.4";
  const cases = [
    ["print", "print(42)", "42"],
    ["math", "print(1+2*3)", "7"],
    ["fn", "local function f(a) return a*2 end\nprint(f(21))", "42"],
    ["anon", "local f=function(a) return a+1 end\nprint(f(2))", "3"],
    ["dot", "K={}\nfunction K.fn(n) return n end\nprint(K.fn(9))", "9"],
    ["method", "o={x=7}\nfunction o:get() return self.x end\nprint(o.get(o))", "7"],
    ["colon", "o={x=7}\nfunction o:get() return self.x end\nprint(o:get())", "7"],
    ["compound", "local x=1\nx = x + 5\nprint(x)", "6"],
    ["pairs", "local t={a=1,b=2}\nlocal n=0\nfor k,v in pairs(t) do n=n+v end\nprint(n)", "3"],
    ["typed", "local K: { [string]: any } = { a = 1 }\nprint(K.a)", "1"],
  ];
  let pass=0,fail=0;
  for (const [name, src, exp] of cases) {
    try {
      const out = obfuscateCode(src, "v1");
      const p = "/tmp/euana_t_" + name + ".lua";
      fs.writeFileSync(p, out);
      const got = execSync(LUA + " " + p, { encoding: "utf8", timeout: 15000 }).trim();
      if (got === exp) { console.log("OK ", name); pass++; }
      else { console.log("DIFF", name, JSON.stringify(got), "!=", exp); fail++; }
    } catch (e) {
      console.log("FAIL", name, String(e.stderr || e.message).slice(0, 140).replace(/\n/g, " "));
      fail++;
    }
  }
  console.log(pass + " pass / " + fail + " fail");
  process.exit(fail ? 1 : 0);
}

function serve(port) {
  port = Number(port) || Number(process.env.PORT) || 3000;

  function json(res, code, obj) {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Euana ${VERSION}</title>
<style>
  :root {
    --bg0: #07060f; --bg1: #0d0a1a; --panel: rgba(22,16,40,0.94); --panel2: rgba(30,22,55,0.95);
    --line: rgba(140,90,255,0.28); --line2: rgba(180,120,255,0.45);
    --text: #f3eefc; --muted: #9b8fb8; --purple: #8b5cf6; --purple2: #a78bfa;
    --green: #34d399; --danger: #f87171; --glow: 0 0 24px rgba(139,92,246,0.35); --radius: 14px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background:
      radial-gradient(1200px 600px at 10% -10%, rgba(124,58,237,0.25), transparent 60%),
      radial-gradient(900px 500px at 90% 0%, rgba(91,33,182,0.18), transparent 55%),
      linear-gradient(180deg, var(--bg0), var(--bg1));
    color: var(--text); min-height: 100vh;
  }
  .topnav {
    height: 64px; display: flex; align-items: center; justify-content: space-between;
    padding: 0 22px; border-bottom: 1px solid var(--line);
    background: rgba(10,8,20,0.85); backdrop-filter: blur(12px); position: sticky; top: 0; z-index: 20;
  }
  .brand { display: flex; align-items: center; gap: 12px; font-weight: 800; cursor: pointer; }
  .logo {
    width: 36px; height: 36px; border-radius: 10px;
    background: linear-gradient(135deg,#7c3aed,#c084fc); box-shadow: var(--glow);
    display: grid; place-items: center;
  }
  .brand small { display: block; font-size: 10px; color: var(--muted); letter-spacing: 0.12em; }
  .navlinks { display: flex; gap: 6px; flex-wrap: wrap; }
  .navlinks button {
    border: 1px solid transparent; background: transparent; color: var(--muted);
    padding: 8px 14px; border-radius: 999px; font: inherit; font-size: 13px; cursor: pointer;
  }
  .navlinks button.active, .navlinks button:hover {
    color: #fff; background: rgba(139,92,246,0.2); border-color: var(--line2);
  }
  .status-pill { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 10px var(--green); }
  .layout {
    display: grid; grid-template-columns: 240px 1fr; gap: 16px; padding: 18px;
    max-width: 1400px; margin: 0 auto;
  }
  @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
  .panel {
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
    box-shadow: 0 10px 40px rgba(0,0,0,0.35);
  }
  .side { padding: 14px; height: fit-content; }
  .side h3 { font-size: 12px; color: var(--muted); letter-spacing: 0.08em; margin: 8px 8px 12px; text-transform: uppercase; }
  .menu button {
    width: 100%; text-align: left; border: 1px solid transparent; background: transparent; color: var(--text);
    padding: 12px 14px; border-radius: 12px; cursor: pointer; font: inherit; font-size: 13.5px;
    display: flex; gap: 10px; align-items: center; margin-bottom: 6px;
  }
  .menu button.active, .menu button:hover {
    background: linear-gradient(90deg, rgba(124,58,237,0.35), rgba(124,58,237,0.08));
    border-color: var(--line2);
  }
  .main { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .hero {
    padding: 20px 22px; border-radius: var(--radius); border: 1px solid var(--line);
    background: linear-gradient(120deg, rgba(124,58,237,0.22), transparent 55%), var(--panel);
  }
  .hero h1 {
    font-size: 1.45rem; font-weight: 800;
    background: linear-gradient(90deg,#fff,#c4b5fd); -webkit-background-clip: text; color: transparent;
  }
  .hero p { color: var(--muted); margin-top: 6px; font-size: 13px; }
  .view { display: none; }
  .view.active { display: block; }
  .editor-wrap { overflow: hidden; }
  .editor-h {
    display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel2);
  }
  .editor-h .title { font-weight: 700; font-size: 13px; color: var(--purple2); }
  .tools { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  select, button, .file-btn {
    font: inherit; font-size: 12.5px; border-radius: 10px; border: 1px solid var(--line);
    background: rgba(20,14,36,0.9); color: var(--text); padding: 8px 12px; cursor: pointer;
  }
  button.primary {
    background: linear-gradient(135deg,#7c3aed,#a855f7); border: none; font-weight: 700; box-shadow: var(--glow);
  }
  button.primary:disabled { opacity: 0.55; cursor: not-allowed; box-shadow: none; }
  button.ghost { background: transparent; }
  .file-btn { display: inline-flex; }
  .hidden-file { display: none; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; min-height: 420px; }
  @media (max-width: 820px) { .grid2 { grid-template-columns: 1fr; } }
  .col { display: flex; flex-direction: column; border-right: 1px solid var(--line); min-height: 360px; }
  .col:last-child { border-right: none; }
  .col-h {
    padding: 10px 14px; font-size: 12px; color: var(--muted); border-bottom: 1px solid var(--line);
    display: flex; justify-content: space-between;
  }
  textarea, pre.out {
    flex: 1; width: 100%; min-height: 320px; padding: 14px 16px; background: transparent; border: none;
    color: var(--text); font-family: "JetBrains Mono","Fira Code",Consolas,monospace; font-size: 13px;
    line-height: 1.55; resize: vertical; outline: none;
  }
  pre.out { white-space: pre-wrap; word-break: break-all; overflow: auto; margin: 0; color: #ddd6fe; }
  .status-line { padding: 10px 16px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--line); }
  .status-line.ok { color: var(--green); }
  .status-line.err { color: var(--danger); }
  .foot { text-align: center; color: var(--muted); font-size: 11.5px; padding: 10px 18px 22px; }
  .card-note {
    margin: 12px 16px 0; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--line);
    background: rgba(124,58,237,0.1); color: var(--muted); font-size: 12.5px; line-height: 1.5;
  }
</style>
</head>
<body>
  <header class="topnav">
    <div class="brand" data-tab="obfuscate">
      <div class="logo">E</div>
      <div>EUANA<small>ULTIMATE VM</small></div>
    </div>
    <nav class="navlinks">
      <button type="button" data-tab="obfuscate" class="active">난독화</button>
      <button type="button" data-tab="compile">컴파일러</button>
      <button type="button" data-tab="decompile">디컴파일러</button>
      <button type="button" data-tab="analyze">분석기</button>
    </nav>
    <div class="status-pill"><span class="dot"></span> 서버 정상 · v${VERSION}</div>
  </header>

  <div class="layout">
    <aside class="panel side">
      <h3>기능 메뉴</h3>
      <div class="menu">
        <button type="button" data-tab="obfuscate" class="active"><span>🔒</span> 난독화</button>
        <button type="button" data-tab="compile"><span>▶</span> 컴파일러</button>
        <button type="button" data-tab="decompile"><span>↺</span> 디컴파일러</button>
        <button type="button" data-tab="analyze"><span>📊</span> 코드 분석기</button>
      </div>
    </aside>

    <section class="main">
      <div class="hero">
        <h1 id="heroTitle">EUANA ULTIMATE</h1>
        <p id="heroDesc">커스텀 바이트코드 VM · 상수/스트림 암호화 · 원본 소스 평문 제거</p>
      </div>

      <!-- OBFUSCATE -->
      <div class="view active" id="view-obfuscate">
        <div class="panel editor-wrap">
          <div class="editor-h">
            <div class="title">난독화</div>
            <div class="tools">
              <select id="iv">
                <option value="v1">v1 — Light</option>
                <option value="v2">v2 — Medium</option>
                <option value="v3" selected>v3 — Heavy</option>
              </select>
              <button class="primary" id="goObf">난독화 실행</button>
              <label class="file-btn">업로드<input class="hidden-file" type="file" id="fileObf" accept=".lua,.txt,.luau,text/plain"></label>
              <button class="ghost" id="dlObf">다운로드</button>
              <button class="ghost" id="copyObf">복사</button>
              <button class="ghost" id="clrObf">초기화</button>
            </div>
          </div>
          <div class="grid2">
            <div class="col">
              <div class="col-h"><span>Input</span><span id="obfInLen">0</span></div>
              <textarea id="obfSrc">print("Hello from Euana")
local function add(a, b)
  return a + b
end
print(add(20, 22))</textarea>
            </div>
            <div class="col">
              <div class="col-h"><span>Output</span><span id="obfOutLen">0</span></div>
              <pre class="out" id="obfOut">// 결과</pre>
            </div>
          </div>
          <div class="status-line" id="obfStatus">Ready</div>
        </div>
      </div>

      <!-- COMPILE -->
      <div class="view" id="view-compile">
        <div class="panel editor-wrap">
          <div class="editor-h">
            <div class="title">컴파일러 (Lua → Euana bytecode IR)</div>
            <div class="tools">
              <button class="primary" id="goCompile">컴파일</button>
              <label class="file-btn">업로드<input class="hidden-file" type="file" id="fileCompile" accept=".lua,.txt,.luau,text/plain"></label>
              <button class="ghost" id="copyCompile">복사</button>
            </div>
          </div>
          <div class="card-note">원본 Lua를 Euana 내부 바이트코드로 변환합니다. 옵코드·상수 테이블·명령 수를 확인할 수 있습니다.</div>
          <div class="grid2">
            <div class="col">
              <div class="col-h"><span>Source</span><span></span></div>
              <textarea id="compileSrc">print(1)
local function f(a,b) return a+b end
print(f(2,3))</textarea>
            </div>
            <div class="col">
              <div class="col-h"><span>Bytecode dump</span><span></span></div>
              <pre class="out" id="compileOut">// 컴파일 결과</pre>
            </div>
          </div>
          <div class="status-line" id="compileStatus">Ready</div>
        </div>
      </div>

      <!-- DECOMPILE -->
      <div class="view" id="view-decompile">
        <div class="panel editor-wrap">
          <div class="editor-h">
            <div class="title">디컴파일러 / 구조 분석</div>
            <div class="tools">
              <button class="primary" id="goDecomp">분석</button>
              <label class="file-btn">업로드<input class="hidden-file" type="file" id="fileDecomp" accept=".lua,.txt,.luau,text/plain"></label>
              <button class="ghost" id="copyDecomp">복사</button>
            </div>
          </div>
          <div class="card-note">Euana로 보호된 스크립트는 원본 복원이 목적이 아니라 <b>구조 휴리스틱 분석</b>입니다. 평문 Lua면 간단 구조 요약을 보여줍니다.</div>
          <div class="grid2">
            <div class="col">
              <div class="col-h"><span>Input</span><span></span></div>
              <textarea id="decompSrc">-- 난독화된 코드 또는 일반 Lua를 붙여넣으세요</textarea>
            </div>
            <div class="col">
              <div class="col-h"><span>Analysis</span><span></span></div>
              <pre class="out" id="decompOut">// 분석 결과</pre>
            </div>
          </div>
          <div class="status-line" id="decompStatus">Ready</div>
        </div>
      </div>

      <!-- ANALYZE -->
      <div class="view" id="view-analyze">
        <div class="panel editor-wrap">
          <div class="editor-h">
            <div class="title">코드 분석기</div>
            <div class="tools">
              <button class="primary" id="goAnalyze">분석 실행</button>
              <label class="file-btn">업로드<input class="hidden-file" type="file" id="fileAnalyze" accept=".lua,.txt,.luau,text/plain"></label>
            </div>
          </div>
          <div class="grid2">
            <div class="col">
              <div class="col-h"><span>Code</span><span></span></div>
              <textarea id="analyzeSrc">local x = 1
for i = 1, 10 do x = x + i end
print(x)</textarea>
            </div>
            <div class="col">
              <div class="col-h"><span>Report</span><span></span></div>
              <pre class="out" id="analyzeOut">// 리포트</pre>
            </div>
          </div>
          <div class="status-line" id="analyzeStatus">Ready</div>
        </div>
      </div>
    </section>
  </div>
  <div class="foot">Protected by Euana · v${VERSION}</div>

<script>
const tabs = ["obfuscate","compile","decompile","analyze"];
const titles = {
  obfuscate: ["EUANA ULTIMATE", "커스텀 바이트코드 VM · 난독화"],
  compile: ["컴파일러", "Lua 소스 → Euana 바이트코드 IR 덤프"],
  decompile: ["디컴파일러", "구조 휴리스틱 분석 (완전 원본 복원 보장 없음)"],
  analyze: ["코드 분석기", "함수/문자열/복잡도 요약"]
};

function setTab(name) {
  if (!tabs.includes(name)) name = "obfuscate";
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  const view = document.getElementById("view-" + name);
  if (view) view.classList.add("active");
  document.querySelectorAll("[data-tab]").forEach(el => {
    el.classList.toggle("active", el.getAttribute("data-tab") === name);
  });
  const t = titles[name] || titles.obfuscate;
  document.getElementById("heroTitle").textContent = t[0];
  document.getElementById("heroDesc").textContent = t[1];
  try { history.replaceState(null, "", "#" + name); } catch (_) {}
}

document.querySelectorAll("[data-tab]").forEach(el => {
  el.addEventListener("click", (e) => {
    e.preventDefault();
    setTab(el.getAttribute("data-tab"));
  });
});

// hash route
setTab((location.hash || "#obfuscate").slice(1));

function bindFile(inputId, textareaId, statusId) {
  const input = document.getElementById(inputId);
  const ta = document.getElementById(textareaId);
  const st = document.getElementById(statusId);
  input.addEventListener("change", async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    try {
      ta.value = f.text ? await f.text() : await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result||""));r.onerror=rej;r.readAsText(f);});
      st.textContent = "로드됨: " + f.name;
      st.className = "status-line ok";
    } catch {
      st.textContent = "파일 로드 실패";
      st.className = "status-line err";
    }
  });
}
bindFile("fileObf","obfSrc","obfStatus");
bindFile("fileCompile","compileSrc","compileStatus");
bindFile("fileDecomp","decompSrc","decompStatus");
bindFile("fileAnalyze","analyzeSrc","analyzeStatus");

function setLen() {
  document.getElementById("obfInLen").textContent = (document.getElementById("obfSrc").value||"").length;
  document.getElementById("obfOutLen").textContent = (document.getElementById("obfOut").textContent||"").length;
}
document.getElementById("obfSrc").addEventListener("input", setLen);
setLen();

async function postJSON(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "request failed");
  return j;
}

document.getElementById("goObf").onclick = async () => {
  const src = document.getElementById("obfSrc").value;
  const st = document.getElementById("obfStatus");
  const btn = document.getElementById("goObf");
  btn.disabled = true; st.textContent = "난독화 중…"; st.className = "status-line";
  try {
    const j = await postJSON("/api/obfuscate", { code: src, intensity: document.getElementById("iv").value });
    document.getElementById("obfOut").textContent = j.code || "";
    st.textContent = "완료 · v" + (j.version || "");
    st.className = "status-line ok";
    setLen();
  } catch (e) {
    st.textContent = String(e.message || e);
    st.className = "status-line err";
  } finally { btn.disabled = false; }
};

document.getElementById("copyObf").onclick = async () => {
  const t = document.getElementById("obfOut").textContent || "";
  if (!t || t.startsWith("//")) return;
  await navigator.clipboard.writeText(t);
  document.getElementById("obfStatus").textContent = "복사됨";
  document.getElementById("obfStatus").className = "status-line ok";
};
document.getElementById("dlObf").onclick = () => {
  const t = document.getElementById("obfOut").textContent || "";
  if (!t || t.startsWith("//")) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([t], { type: "text/plain" }));
  a.download = "euana_obfuscated.lua";
  a.click();
};
document.getElementById("clrObf").onclick = () => {
  document.getElementById("obfSrc").value = "";
  document.getElementById("obfOut").textContent = "// 결과";
  setLen();
};

document.getElementById("goCompile").onclick = async () => {
  const st = document.getElementById("compileStatus");
  const btn = document.getElementById("goCompile");
  btn.disabled = true; st.textContent = "컴파일 중…"; st.className = "status-line";
  try {
    const j = await postJSON("/api/compile", { code: document.getElementById("compileSrc").value });
    document.getElementById("compileOut").textContent = j.dump || JSON.stringify(j, null, 2);
    st.textContent = j.ok ? "컴파일 성공" : "컴파일 실패";
    st.className = j.ok ? "status-line ok" : "status-line err";
  } catch (e) {
    st.textContent = String(e.message || e);
    st.className = "status-line err";
  } finally { btn.disabled = false; }
};
document.getElementById("copyCompile").onclick = async () => {
  await navigator.clipboard.writeText(document.getElementById("compileOut").textContent || "");
};

document.getElementById("goDecomp").onclick = async () => {
  const st = document.getElementById("decompStatus");
  const btn = document.getElementById("goDecomp");
  btn.disabled = true; st.textContent = "분석 중…"; st.className = "status-line";
  try {
    const j = await postJSON("/api/decompile", { code: document.getElementById("decompSrc").value });
    document.getElementById("decompOut").textContent = j.report || "";
    st.textContent = "분석 완료";
    st.className = "status-line ok";
  } catch (e) {
    st.textContent = String(e.message || e);
    st.className = "status-line err";
  } finally { btn.disabled = false; }
};
document.getElementById("copyDecomp").onclick = async () => {
  await navigator.clipboard.writeText(document.getElementById("decompOut").textContent || "");
};

document.getElementById("goAnalyze").onclick = async () => {
  const st = document.getElementById("analyzeStatus");
  const btn = document.getElementById("goAnalyze");
  btn.disabled = true; st.textContent = "분석 중…"; st.className = "status-line";
  try {
    const j = await postJSON("/api/analyze", { code: document.getElementById("analyzeSrc").value });
    document.getElementById("analyzeOut").textContent = j.report || "";
    st.textContent = "완료";
    st.className = "status-line ok";
  } catch (e) {
    st.textContent = String(e.message || e);
    st.className = "status-line err";
  } finally { btn.disabled = false; }
};
</script>
</body>
</html>`;

  function analyzeLua(code) {
    const src = String(code || "");
    const lines = src.split(/\r?\n/);
    const fns = (src.match(/\bfunction\b/g) || []).length;
    const locals = (src.match(/\blocal\b/g) || []).length;
    const strings = (src.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g) || []).length;
    const loops = (src.match(/\b(for|while|repeat)\b/g) || []).length;
    return [
      "=== Code analysis ===",
      "lines: " + lines.length,
      "bytes: " + src.length,
      "function keywords: " + fns,
      "local keywords: " + locals,
      "string literals: " + strings,
      "loops: " + loops,
      "complexity: " + (fns + loops > 20 ? "high" : fns + loops > 5 ? "medium" : "low"),
    ].join("\n");
  }

  function decompileReport(code) {
    const src = String(code || "");
    const lines = [];
    lines.push("=== Structure analysis ===");
    if (/Protected by Euana/i.test(src) || /euana-vm\//i.test(src)) {
      lines.push("detected: Euana protected script");
      const ver = (src.match(/Euana\s+([\d.]+)/i) || [])[1];
      const vm = (src.match(/euana-vm\/(\d+)/i) || [])[1];
      const mode = (src.match(/\|\s*(bytecode|envelope|blocked)/i) || [])[1];
      if (ver) lines.push("version tag: " + ver);
      if (vm) lines.push("vm profile: " + vm);
      if (mode) lines.push("mode: " + mode);
      lines.push("note: full source recovery is not available (by design).");
      lines.push("hints: custom VM, encrypted constants/stream, no-plain-source.");
    } else if (/\b(function|local|end|then)\b/.test(src)) {
      lines.push("detected: likely plain Lua/Luau text");
      lines.push(analyzeLua(src));
      lines.push("");
      lines.push("--- rough outline ---");
      src.split(/\r?\n/).slice(0, 40).forEach((l, i) => {
        if (/\b(function|local function|for|while|if|return)\b/.test(l))
          lines.push(String(i + 1).padStart(4, " ") + "| " + l.trim());
      });
    } else {
      lines.push("detected: unknown / heavily transformed blob");
      lines.push("bytes: " + src.length);
      lines.push("printable ratio: " + (src.replace(/[^\x20-\x7e\n\r\t]/g, "").length / Math.max(1, src.length)).toFixed(3));
    }
    return lines.join("\n");
  }

  function compileDump(code) {
    const src = preprocessLuau(String(code || ""));
    const result = compileToBytecode(src);
    if (!result.ok) {
      return { ok: false, dump: "compile failed:\n" + (result.errors || []).join("\n"), errors: result.errors };
    }
    const { code: bc, constants, op } = result;
    const opNames = {};
    for (const [k, v] of Object.entries(op)) opNames[v] = k;
    const lines = [];
    lines.push("=== Euana bytecode IR ===");
    lines.push("instructions: " + bc.length);
    lines.push("constants: " + constants.length);
    lines.push("");
    lines.push("-- opcode map --");
    for (const [k, v] of Object.entries(op)) lines.push("  " + k + " = " + v);
    lines.push("");
    lines.push("-- constants --");
    constants.slice(0, 64).forEach((c, i) => {
      let s = c === null || c === undefined ? "nil" : typeof c === "string" ? JSON.stringify(c) : String(c);
      if (s.length > 80) s = s.slice(0, 77) + "...";
      lines.push("  [" + i + "] " + s);
    });
    if (constants.length > 64) lines.push("  ... (" + (constants.length - 64) + " more)");
    lines.push("");
    lines.push("-- code --");
    let i = 0;
    while (i < bc.length) {
      const o = bc[i] & 0xffff;
      const name = opNames[o] || ("OP_" + o);
      let extra = "";
      // rough operand display for common ops
      if (["LOADK","GETGLOBAL","SETGLOBAL","GETLOCAL","SETLOCAL","LOADBOOL","JMP","JMPIF","JMPIFNOT"].includes(name) && i + 1 < bc.length) {
        extra = " " + (bc[i + 1] & 0xffff);
        i += 2;
      } else if (["CALL","CLOSURE"].includes(name) && i + 2 < bc.length) {
        extra = " " + (bc[i + 1] & 0xffff) + " " + (bc[i + 2] & 0xffff);
        i += 3;
      } else {
        i += 1;
      }
      lines.push(String(i).padStart(4, " ") + ": " + name + extra);
      if (lines.length > 400) {
        lines.push("... truncated ...");
        break;
      }
    }
    return { ok: true, dump: lines.join("\n") };
  }

  http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?"))) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      if (req.method === "POST" && req.url === "/api/obfuscate") {
        const body = await readBody(req);
        const j = JSON.parse(body || "{}");
        return json(res, 200, { code: obfuscateCode(j.code || "", j.intensity || "v3"), version: VERSION });
      }
      if (req.method === "POST" && req.url === "/api/compile") {
        const body = await readBody(req);
        const j = JSON.parse(body || "{}");
        const dump = compileDump(j.code || "");
        return json(res, 200, { ...dump, version: VERSION });
      }
      if (req.method === "POST" && req.url === "/api/decompile") {
        const body = await readBody(req);
        const j = JSON.parse(body || "{}");
        return json(res, 200, { report: decompileReport(j.code || ""), version: VERSION });
      }
      if (req.method === "POST" && req.url === "/api/analyze") {
        const body = await readBody(req);
        const j = JSON.parse(body || "{}");
        return json(res, 200, { report: analyzeLua(j.code || ""), version: VERSION });
      }
      res.writeHead(404);
      res.end("not found");
    } catch (e) {
      json(res, 500, { error: String(e.message || e) });
    }
  }).listen(port, () => console.log("Euana " + VERSION + " :" + port));
}

function mainCli() {
  const args = process.argv.slice(2);
  if (args[0]==="--test") return runTests();
  if (args[0]==="--serve") return serve(args[1] || process.env.PORT);
  if (!args.length) {
    console.log("Euana "+VERSION+"\n  node main.js <in.lua> [out.lua] [--v1|--v2|--v3]\n  node main.js --test\n  node main.js --serve [port]");
    return;
  }
  let intensity="v3"; const files=[];
  for (const a of args) { if (a==="--v1"||a==="--v2"||a==="--v3") intensity=a.slice(2); else files.push(a); }
  const input=files[0], output=files[1]||input.replace(/\.lua$/i,"")+".obf.lua";
  const t0=Date.now();
  const out=obfuscateCode(fs.readFileSync(input,"utf8"), intensity);
  fs.writeFileSync(output, out);
  console.log("ok", output, out.length, "bytes", Date.now()-t0, "ms");
}
if (require.main===module) mainCli();
module.exports = { obfuscateCode, VERSION, preprocessLuau, compileToBytecode, emitBytecodeObfuscation };
