// extract-forms.js — parse WinSCP's .dfm form definitions into a control tree.
//
// The 144,000 lines of .dfm are the exact specification of every dialog: which
// controls exist, what they are called, what they say, how they nest, which tab
// sheet they live on, and which are checkboxes rather than radio buttons.
// Porting 50 dialogs from memory guarantees quiet omissions, so the port works
// from this inventory instead.
//
// Run: node tools/extract-forms.js            (write design/renderer/forms.json)
//      node tools/extract-forms.js --report   (also print a per-dialog summary)
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FORMS_DIR = path.join(ROOT, 'vendor', 'winscp', 'source', 'forms');
const OUT_JSON = path.join(ROOT, 'design', 'renderer', 'forms.json');
const OUT_MD = path.join(ROOT, 'docs', 'dialog-inventory.md');

/** Controls that carry user-visible behaviour, as opposed to layout scaffolding. */
const INTERACTIVE = new Set([
  'TButton', 'TBitBtn', 'TCheckBox', 'TRadioButton', 'TEdit', 'TMemo', 'TComboBox',
  'TListBox', 'TCheckListBox', 'TListView', 'TTreeView', 'TSpinEdit', 'TUpDown',
  'TTrackBar', 'TDateTimePicker', 'TMaskEdit', 'TRichEdit', 'TColorBox',
  'TPageControl', 'TTabSheet', 'TRadioGroup', 'TGroupBox', 'TPanel',
  'TFilterComboBox', 'TDirectoryListBox', 'TDriveComboBox', 'TFileListBox',
  'TLabel', 'TStaticText', 'TLinkLabel', 'TImage', 'TProgressBar', 'TSpeedButton',
  'TToolBar', 'TStatusBar', 'TSplitter', 'TScrollBox', 'TShape', 'TBevel',
  'TPasswordEdit', 'TFilenameEdit', 'TComboEdit', 'TButtonedEdit',
]);

/** Purely decorative or structural — counted, but not a feature to implement. */
const DECORATIVE = new Set(['TBevel', 'TShape', 'TImage', 'TSplitter']);

/**
 * Read a Delphi property value starting at `i`. Handles quoted strings with
 * '' escapes, #nn character codes, +-continuations across lines, bracketed
 * sets, parenthesised lists and binary blobs, returning the value and the
 * index just past it.
 */
function readValue(text, i) {
  const start = i;
  // Skip leading whitespace on the value side.
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;

  const ch = text[i];

  if (ch === '{') {              // binary blob: { ...hex... }
    const end = text.indexOf('}', i);
    return { value: '<binary>', next: end < 0 ? text.length : end + 1 };
  }

  if (ch === '(') {              // parenthesised list, possibly multi-line
    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') { depth--; if (!depth) { j++; break; } }
    }
    const raw = text.slice(i, j);
    const items = [];
    const re = /'((?:[^']|'')*)'/g;
    let m;
    while ((m = re.exec(raw))) items.push(m[1].replace(/''/g, "'"));
    return { value: items, next: j };
  }

  if (ch === '[') {              // set literal: [foo, bar]
    const end = text.indexOf(']', i);
    const raw = text.slice(i + 1, end < 0 ? text.length : end);
    return {
      value: raw.split(',').map((s) => s.trim()).filter(Boolean),
      next: end < 0 ? text.length : end + 1,
    };
  }

  if (ch === "'" || ch === '#') {  // string, possibly continued with '+'
    let out = '';
    let j = i;
    for (;;) {
      while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
      if (text[j] === "'") {
        j++;
        let buf = '';
        while (j < text.length) {
          if (text[j] === "'") {
            if (text[j + 1] === "'") { buf += "'"; j += 2; continue; }
            j++; break;
          }
          buf += text[j++];
        }
        out += buf;
      } else if (text[j] === '#') {
        j++;
        let num = '';
        while (j < text.length && /\d/.test(text[j])) num += text[j++];
        out += String.fromCharCode(Number(num));
      } else break;
      // A '+' at the end of the line continues the literal.
      let k = j;
      while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
      if (text[k] === '+') {
        k++;
        while (k < text.length && text[k] !== '\n') k++;
        j = k + 1;
        continue;
      }
      break;
    }
    return { value: out, next: j };
  }

  // Bare token: number, identifier, True/False.
  let j = i;
  while (j < text.length && text[j] !== '\n' && text[j] !== '\r') j++;
  const raw = text.slice(i, j).trim();
  let value = raw;
  if (raw === 'True') value = true;
  else if (raw === 'False') value = false;
  else if (/^-?\d+$/.test(raw)) value = Number(raw);
  return { value, next: j === start ? start + 1 : j };
}

/**
 * Parse a whole .dfm into nested {name,type,props,children} trees.
 *
 * A .dfm routinely holds SEVERAL top-level objects: the form itself plus the
 * popup menus, image lists and TApplicationEvents that belong to it. Returning
 * only one of them silently drops most of a dialog — Preferences.dfm looked
 * like two controls that way — so every root is collected and the caller picks
 * the form out of them.
 */
function parseDfm(text) {
  const stack = [];
  const roots = [];
  let i = 0;

  while (i < text.length) {
    // Find the start of the next logical line.
    let lineEnd = text.indexOf('\n', i);
    if (lineEnd < 0) lineEnd = text.length;
    const line = text.slice(i, lineEnd);
    const trimmed = line.trim();

    if (!trimmed) { i = lineEnd + 1; continue; }

    const objMatch = /^(?:object|inherited|inline)\s+(?:(\w+)\s*:\s*)?([\w.]+)/.exec(trimmed);
    if (objMatch) {
      const node = {
        name: objMatch[1] || '',
        type: objMatch[2],
        props: {},
        children: [],
      };
      if (stack.length) stack[stack.length - 1].children.push(node);
      else roots.push(node);
      stack.push(node);
      i = lineEnd + 1;
      continue;
    }

    if (/^end$/.test(trimmed)) {
      stack.pop();
      i = lineEnd + 1;
      continue;
    }

    const propMatch = /^(\w+(?:\.\w+)*)\s*=\s*/.exec(trimmed);
    if (propMatch && stack.length) {
      const key = propMatch[1];
      const valueStart = i + line.indexOf('=') + 1;
      const { value, next } = readValue(text, valueStart);
      stack[stack.length - 1].props[key] = value;
      i = Math.max(next, lineEnd + 1);
      // Re-sync to a line boundary.
      if (i < text.length && text[i - 1] !== '\n') {
        const nl = text.indexOf('\n', i);
        i = nl < 0 ? text.length : nl + 1;
      }
      continue;
    }

    i = lineEnd + 1;
  }

  return roots;
}

/**
 * Of the top-level objects in a .dfm, the form is the one that actually is a
 * window. The rest (popup menus, image lists, event sinks) hang off it.
 */
function pickForm(roots) {
  if (!roots.length) return null;
  const isForm = (r) => /(?:Dialog|Form|Frame)$/i.test(r.type) || r.children.length > 3;
  return roots.find(isForm) || roots[0];
}

/** Flatten a tree into a control list with the tab sheet each control sits on. */
function flatten(node, out = [], sheet = '', depth = 0) {
  if (!node) return out;
  for (const c of node.children) {
    const isSheet = c.type === 'TTabSheet';
    const mySheet = isSheet ? (c.props.Caption || c.name) : sheet;
    out.push({
      name: c.name,
      type: c.type,
      caption: typeof c.props.Caption === 'string' ? c.props.Caption : '',
      hint: typeof c.props.Hint === 'string' ? c.props.Hint : '',
      action: typeof c.props.Action === 'string' ? c.props.Action : '',
      sheet: isSheet ? '' : sheet,
      depth,
      interactive: INTERACTIVE.has(c.type) && !DECORATIVE.has(c.type),
      decorative: DECORATIVE.has(c.type),
      items: Array.isArray(c.props.Items) ? c.props.Items
        : (c.props['Items.Strings'] || c.props['Lines.Strings'] || null),
      enabled: c.props.Enabled !== false,
      checked: c.props.Checked === true,
    });
    flatten(c, out, mySheet, depth + 1);
  }
  return out;
}

function main() {
  const report = process.argv.includes('--report');
  if (!fs.existsSync(FORMS_DIR)) {
    console.error('WinSCP source not found. Run: git submodule update --init');
    process.exit(1);
  }

  const files = fs.readdirSync(FORMS_DIR).filter((f) => f.toLowerCase().endsWith('.dfm')).sort();
  const dialogs = [];
  let totalControls = 0, totalInteractive = 0;

  for (const f of files) {
    const text = fs.readFileSync(path.join(FORMS_DIR, f), 'utf8');
    let roots;
    try { roots = parseDfm(text); } catch (e) {
      console.error(`  ! ${f}: ${e.message}`);
      continue;
    }
    if (!roots.length) continue;
    const tree = pickForm(roots);
    if (!tree) continue;
    // The form's own controls, plus the popup menus and toolbars defined
    // alongside it — a context menu entry is a feature to port just as much as
    // a button is.
    const controls = flatten(tree);
    for (const aux of roots) {
      if (aux === tree) continue;
      for (const c of flatten(aux)) controls.push({ ...c, sheet: aux.name || aux.type });
    }
    const sheets = [...new Set(controls.filter((c) => c.type === 'TTabSheet').map((c) => c.caption || c.name))];
    const interactive = controls.filter((c) => c.interactive).length;
    totalControls += controls.length;
    totalInteractive += interactive;
    dialogs.push({
      file: f,
      form: tree.name,
      type: tree.type,
      caption: typeof tree.props.Caption === 'string' ? tree.props.Caption : '',
      sourceLines: text.split('\n').length,
      sheets,
      controlCount: controls.length,
      interactiveCount: interactive,
      controls,
    });
  }

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify({
    generatedFrom: 'vendor/winscp/source/forms/*.dfm',
    dialogCount: dialogs.length,
    totalControls,
    totalInteractive,
    dialogs,
  }, null, 1), 'utf8');

  // A human-readable inventory, so the dialog work can be checked off.
  const md = [];
  md.push('# Dialog inventory');
  md.push('');
  md.push('Generated by `node tools/extract-forms.js` — do not edit by hand.');
  md.push('');
  md.push('Every dialog WinSCP defines, with its tab sheets and its control counts.');
  md.push('"Interactive" excludes labels, bevels, shapes and images: it is the number of');
  md.push('controls that must actually *do* something for the dialog to count as ported.');
  md.push('');
  md.push(`**${dialogs.length} dialogs · ${totalControls.toLocaleString()} controls · ${totalInteractive.toLocaleString()} interactive.**`);
  md.push('');
  md.push('| Dialog | Caption | Sheets | Controls | Interactive | .dfm lines |');
  md.push('|---|---|---:|---:|---:|---:|');
  for (const d of [...dialogs].sort((a, b) => b.interactiveCount - a.interactiveCount)) {
    const esc = (s) => String(s || '').replace(/\|/g, '\\|').replace(/&/g, '');
    md.push(`| \`${d.file.replace('.dfm', '')}\` | ${esc(d.caption)} | ${d.sheets.length} | ${d.controlCount} | ${d.interactiveCount} | ${d.sourceLines} |`);
  }
  md.push('');
  md.push('## Tab sheets per dialog');
  md.push('');
  for (const d of dialogs.filter((x) => x.sheets.length)) {
    md.push(`- **${d.file.replace('.dfm', '')}** — ` + d.sheets.map((s) => '`' + String(s).replace(/&/g, '') + '`').join(', '));
  }
  md.push('');
  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  fs.writeFileSync(OUT_MD, md.join('\n'), 'utf8');

  console.log(`Wrote ${path.relative(ROOT, OUT_JSON)} and ${path.relative(ROOT, OUT_MD)}`);
  console.log(`  dialogs:     ${dialogs.length}`);
  console.log(`  controls:    ${totalControls.toLocaleString()}`);
  console.log(`  interactive: ${totalInteractive.toLocaleString()}`);

  if (report) {
    for (const d of [...dialogs].sort((a, b) => b.interactiveCount - a.interactiveCount).slice(0, 25)) {
      console.log(`  ${String(d.interactiveCount).padStart(4)} interactive  ${d.file.replace('.dfm', '').padEnd(24)} ${d.sheets.length} sheets`);
    }
  }
}

if (require.main === module) main();
module.exports = { parseDfm, pickForm, flatten, readValue };
