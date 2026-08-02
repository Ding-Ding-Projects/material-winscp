// extract-actions.js — build the action registry from WinSCP's own definitions.
//
// WinSCP declares every command once, as a TAction in NonVisual.dfm, carrying
// its caption, hint, help keyword, icon index and keyboard shortcut. That file
// is the authoritative list of what the program can do, so the port generates
// its registry from it rather than transcribing 300 commands by hand and
// quietly losing a few.
//
// Run: node tools/extract-actions.js
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'vendor', 'winscp', 'source', 'forms', 'NonVisual.dfm');
const OUT = path.join(__dirname, '..', 'design', 'renderer', 'actions.js');

// Delphi TShortCut packs modifiers into the high bits of a virtual key code.
const SC_SHIFT = 0x2000, SC_CTRL = 0x4000, SC_ALT = 0x8000;

const VK = {
  8: 'Backspace', 9: 'Tab', 13: 'Enter', 19: 'Pause', 27: 'Esc', 32: 'Space',
  33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home',
  37: 'Left', 38: 'Up', 39: 'Right', 40: 'Down',
  45: 'Insert', 46: 'Delete',
  106: 'Num *', 107: 'Num +', 109: 'Num -', 111: 'Num /',
  186: ';', 187: '=', 188: ',', 189: '-', 190: '.', 191: '/', 192: '`',
  219: '[', 220: '\\', 221: ']', 222: "'",
};
for (let i = 112; i <= 123; i++) VK[i] = 'F' + (i - 111);

function shortcutToText(value) {
  if (!value) return '';
  const mods = [];
  if (value & SC_CTRL) mods.push('Ctrl');
  if (value & SC_SHIFT) mods.push('Shift');
  if (value & SC_ALT) mods.push('Alt');
  const key = value & 0xFF;
  let name = VK[key];
  if (!name) {
    if (key >= 48 && key <= 90) name = String.fromCharCode(key);
    else return '';
  }
  return [...mods, name].join('+');
}

/** Delphi captions mark the accelerator with '&'. Keep it, but separately. */
function splitAccel(caption) {
  const i = caption.indexOf('&');
  if (i < 0 || i === caption.length - 1) return { label: caption, accel: '' };
  return {
    label: caption.slice(0, i) + caption.slice(i + 1),
    accel: caption[i + 1].toUpperCase(),
  };
}

/** Delphi string literals can be continued across lines and use #nn escapes. */
function readDelphiString(raw) {
  let out = '';
  const re = /'([^']*)'|#(\d+)/g;
  let m;
  while ((m = re.exec(raw))) {
    if (m[1] !== undefined) out += m[1];
    else out += String.fromCharCode(Number(m[2]));
  }
  return out.replace(/''/g, "'");
}

function parse(text) {
  const actions = [];
  const lines = text.split(/\r?\n/);
  let cur = null;
  let pendingKey = null;
  let pendingRaw = '';

  const flushPending = () => {
    if (!cur || !pendingKey) return;
    const value = readDelphiString(pendingRaw);
    if (pendingKey === 'Caption') {
      const { label, accel } = splitAccel(value);
      cur.caption = label;
      cur.accelerator = accel;
      // A trailing '...' means the command opens a dialog rather than acting
      // immediately — the UI uses this to decide on a confirmation step.
      cur.opensDialog = /\.\.\.$/.test(label);
    } else if (pendingKey === 'Hint') {
      // 'Short|Long' — the short half is the toolbar hint, the long half the
      // status-bar description.
      const bar = value.indexOf('|');
      if (bar >= 0) { cur.hint = value.slice(0, bar); cur.description = value.slice(bar + 1); }
      else { cur.hint = value; cur.description = value; }
    } else if (pendingKey === 'Category') cur.category = value;
    else if (pendingKey === 'HelpKeyword') cur.helpKeyword = value;
    pendingKey = null;
    pendingRaw = '';
  };

  for (const line of lines) {
    const open = /^\s*object\s+(\w+):\s*T(\w*Action)\s*$/.exec(line);
    if (open) {
      flushPending();
      cur = {
        name: open[1], kind: open[2], caption: '', accelerator: '', hint: '',
        description: '', category: '', helpKeyword: '', imageIndex: -1,
        shortcut: '', tag: 0, opensDialog: false,
      };
      continue;
    }
    if (!cur) continue;

    if (/^\s*end\s*$/.test(line)) {
      flushPending();
      // TAction containers (TActionList) are not commands themselves.
      if (cur.kind !== 'ActionList') actions.push(cur);
      cur = null;
      continue;
    }

    const kv = /^\s*(\w+)\s*=\s*(.*)$/.exec(line);
    if (kv) {
      flushPending();
      const [, key, rest] = kv;
      if (key === 'Caption' || key === 'Hint' || key === 'Category' || key === 'HelpKeyword') {
        pendingKey = key;
        pendingRaw = rest;
        // A value ending in '+' continues on the next line.
        if (!/\+\s*$/.test(rest)) flushPending();
      } else if (key === 'ImageIndex') cur.imageIndex = Number(rest);
      else if (key === 'ShortCut') cur.shortcut = shortcutToText(Number(rest));
      else if (key === 'Tag') cur.tag = Number(rest);
      continue;
    }
    if (pendingKey) {
      pendingRaw += rest_of(line);
      if (!/\+\s*$/.test(line)) flushPending();
    }
  }
  flushPending();
  return actions;
}

function rest_of(line) { return line.trim(); }

/**
 * WinSCP names many actions in triplicate — Local*, Remote* and Current* —
 * because the same command applies to whichever panel has focus. Group them so
 * the UI can bind one command and resolve the side at invocation time.
 */
function classify(a) {
  const n = a.name;
  let side = 'both';
  if (/^Local/.test(n)) side = 'local';
  else if (/^Remote/.test(n)) side = 'remote';
  else if (/^Current/.test(n)) side = 'current';
  const focused = /Focused/.test(n);
  return { ...a, side, focused };
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('WinSCP source not found at ' + SRC + '\nRun: git submodule update --init');
    process.exit(1);
  }
  const actions = parse(fs.readFileSync(SRC, 'utf8')).map(classify);

  const categories = [...new Set(actions.map((a) => a.category).filter(Boolean))].sort();
  const withShortcut = actions.filter((a) => a.shortcut).length;

  const banner = `// GENERATED by tools/extract-actions.js from WinSCP's NonVisual.dfm.
// Do not edit by hand — re-run the extractor instead.
//
// ${actions.length} actions in ${categories.length} categories, ${withShortcut} with a default
// keyboard shortcut. This is the authoritative list of what the application can
// do; every entry must resolve to a real handler in the command registry.
`;

  const body = 'export const ACTIONS = ' + JSON.stringify(actions, null, 2) + ';\n\n'
    + 'export const ACTION_CATEGORIES = ' + JSON.stringify(categories, null, 2) + ';\n\n'
    + 'export const ACTIONS_BY_NAME = Object.fromEntries(ACTIONS.map((a) => [a.name, a]));\n\n'
    + 'export default ACTIONS;\n';

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, banner + '\n' + body, 'utf8');

  console.log(`Wrote ${OUT}`);
  console.log(`  actions:    ${actions.length}`);
  console.log(`  categories: ${categories.length}`);
  console.log(`  shortcuts:  ${withShortcut}`);
  console.log(`  captions:   ${actions.filter((a) => a.caption).length}`);
  console.log(`  hints:      ${actions.filter((a) => a.hint).length}`);
  const missing = actions.filter((a) => !a.caption);
  if (missing.length) console.log('  no caption: ' + missing.map((a) => a.name).join(', '));
}

if (require.main === module) main();
module.exports = { parse, classify, shortcutToText, splitAccel, readDelphiString };
