// options.js — WinSCP's command-line model.
//
// Ports core/Option.cpp (TOptions) and the entry-point semantics of
// windows/ProgParams.cpp (TProgramParams). This is the layer that decides what
// is a switch and what is a bare parameter, how a switch carries a value, how
// many following parameters a switch consumes, and how a quoted command line is
// split into tokens (core/Common.cpp's CutToken).
//
// It is deliberately separate from sessiondata.js: TSessionData::ParseUrl takes
// a TOptions and reads `-username`, `-password`, `-rawsettings` and friends out
// of it, so the two modules meet at this interface rather than at a string.
//
// Indexing note: the C++ is 1-based (UnicodeString) throughout. Every offset
// here is 0-based, and the translation is the only liberty taken with it.
'use strict';

/** WinSCP masks every password it echoes with this, never the real value. */
const PASSWORD_MASK = '***';

/** TOptionType. */
const OPTION_PARAM = 'param';
const OPTION_SWITCH = 'switch';

/** TOptions::TOptions defaults. '[' is ArrayValueDelimiter, ']' closes it. */
const DEFAULT_SWITCH_MARKS = '/-';
const ARRAY_VALUE_DELIMITER = '[';
const ARRAY_VALUE_END = ']';
const DEFAULT_SWITCH_VALUE_DELIMITERS = '=:' + ARRAY_VALUE_DELIMITER;

function isLetter(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

/**
 * TryStrToInt: Delphi accepts optional sign and decimal digits only, and
 * rejects anything with trailing rubbish. `parseInt` would accept "2x".
 */
function tryStrToInt(s) {
  if (typeof s !== 'string' || !/^[+-]?\d+$/.test(s.trim())) return null;
  const n = Number(s.trim());
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * DoCutToken from core/Common.cpp — the tokenizer PuTTY's sftp_getcmd inspired.
 *
 * Leading spaces/tabs are skipped, a token ends at the first unquoted space or
 * tab, `""` is an escaped quote and a lone `"` toggles quoting. With
 * `escapeQuotesInQuotesOnly` (CutTokenEx) the `""` escape applies only inside
 * quotes, so a bare `""` argument means the empty string rather than a quote —
 * that difference is why WinSCP has both functions.
 *
 * Returns null at end of input (the C++ returns false and clears Str).
 */
function cutToken(str, escapeQuotesInQuotesOnly = false) {
  let index = 0;
  while (index < str.length && (str[index] === ' ' || str[index] === '\t')) index++;

  if (index >= str.length) return null;

  const start = index;
  let token = '';
  let quoting = false;

  while (index < str.length) {
    const c = str[index];
    if (!quoting && (c === ' ' || c === '\t')) break;
    if (c === '"' && index + 1 < str.length && str[index + 1] === '"' &&
        (!escapeQuotesInQuotesOnly || quoting)) {
      index += 2;
      token += '"';
    } else if (c === '"') {
      index++;
      quoting = !quoting;
    } else {
      token += c;
      index++;
    }
  }

  const raw = str.slice(start, index);
  let separator = '';
  if (index < str.length) {
    separator = str[index];
    index++;
  }

  return { token, raw, separator, rest: str.slice(index) };
}

/** Split a whole command line into tokens (TOptions::Parse). */
function tokenizeCommandLine(cmdLine, escapeQuotesInQuotesOnly = false) {
  const out = [];
  let rest = String(cmdLine == null ? '' : cmdLine);
  for (;;) {
    const cut = cutToken(rest, escapeQuotesInQuotesOnly);
    if (cut === null) break;
    out.push(cut.token);
    rest = cut.rest;
  }
  return out;
}

/** EscapeParam: a quote is doubled so the token survives a re-parse. */
function escapeParam(param) {
  return String(param).replace(/"/g, '""');
}

/** ShellQuoteStr: always quoted, inner quotes doubled. */
function shellQuoteStr(str) {
  return '"' + escapeParam(str) + '"';
}

/** AddQuotes: quote only when the value contains a space. */
function addQuotes(str) {
  return String(str).includes(' ') ? '"' + str + '"' : String(str);
}

/**
 * StringsToParams — how a Name=Value list becomes ` Name="Value"` arguments.
 * An all-numeric value is left unquoted, which is what makes `-rawsettings`
 * output round-trip through the parser above without gaining quotes.
 */
function stringsToParams(lines) {
  let result = '';
  for (const line of lines) {
    const p = line.indexOf('=');
    const name = p < 0 ? line : line.slice(0, p);
    let value = p < 0 ? '' : line.slice(p + 1);
    const asInt = tryStrToInt(value);
    if (asInt === null || String(asInt) !== value) {
      value = '"' + escapeParam(value) + '"';
    }
    result += ` ${name}=${value}`;
  }
  return result;
}

/** TOptions. */
class Options {
  constructor(source) {
    if (source instanceof Options) {
      this.switchMarks = source.switchMarks;
      this.switchValueDelimiters = source.switchValueDelimiters;
      this._options = source._options.map((o) => ({ ...o }));
      this._originalOptions = source._originalOptions.map((o) => ({ ...o }));
      this._noMoreSwitches = source._noMoreSwitches;
      this.paramCount = source.paramCount;
      return;
    }
    this.switchMarks = DEFAULT_SWITCH_MARKS;
    this.switchValueDelimiters = DEFAULT_SWITCH_VALUE_DELIMITERS;
    this._options = [];
    this._originalOptions = [];
    this._noMoreSwitches = false;
    this.paramCount = 0;
  }

  /** Build from an already-split argument vector. */
  static fromArgs(args) {
    const o = new Options();
    for (const a of args) o.add(a);
    return o;
  }

  /** Build from a raw command line, tokenizing it first (TOptions::Parse). */
  static fromCommandLine(cmdLine) {
    const o = new Options();
    o.parse(cmdLine);
    return o;
  }

  get empty() { return this._options.length === 0; }

  parse(cmdLine) {
    for (const token of tokenizeCommandLine(cmdLine)) this.add(token);
  }

  /**
   * TOptions::Add. Two rules do the real work here:
   *
   *  - a bare doubled switch mark (`//` or `--`) is not stored at all; it turns
   *    off switch recognition for everything after it, which is how a file
   *    literally named `-x` reaches the program.
   *  - a token that starts with a switch mark is only a switch while every
   *    character up to the value delimiter is a letter or `?`. That is what
   *    keeps `/home/martin` a parameter instead of a `/home` switch, and the
   *    extra `-` clause is what allows `--puttygen-switches`.
   */
  add(value) {
    value = String(value);

    if (!this._noMoreSwitches && value.length === 2 && value[0] === value[1] &&
        this.switchMarks.includes(value[0])) {
      this._noMoreSwitches = true;
      this._originalOptions = this._options.map((o) => ({ ...o }));
      return;
    }

    let isSwitch = false;
    let index = 0;              // 0-based; the C++ starts at 2 (1-based)
    let switchMark = '';
    let valueDelimiter = '';

    if (!this._noMoreSwitches && value.length >= 2 &&
        this.switchMarks.includes(value[0])) {
      index = 1;
      isSwitch = true;
      switchMark = value[0];
      while (isSwitch && index < value.length) {
        const c = value[index];
        if (this.switchValueDelimiters.includes(c)) {
          valueDelimiter = c;
          break;
        } else if (c === '?' || isLetter(c) ||
                   (c === '-' && switchMark === '-' && value[1] === '-')) {
          // still a switch name
        } else {
          isSwitch = false;
          break;
        }
        index++;
      }
    }

    const option = { type: OPTION_PARAM, name: '', value: '', valueSet: false, used: false, switchMark };

    if (isSwitch) {
      option.type = OPTION_SWITCH;
      option.name = value.slice(1, index);
      option.value = value.slice(index + 1);
      if (valueDelimiter === ARRAY_VALUE_DELIMITER && option.value.endsWith(ARRAY_VALUE_END)) {
        option.value = option.value.slice(0, -1);
      }
      option.valueSet = index < value.length;
    } else {
      option.type = OPTION_PARAM;
      option.value = value;
      option.valueSet = false;
      this.paramCount++;
    }

    this._options.push(option);
    this._originalOptions = this._options.map((o) => ({ ...o }));
  }

  /** Param[Index], 1-based, and marks the parameter used. */
  param(index) {
    let remaining = index;
    for (let i = 0; i < this._options.length && remaining > 0; i++) {
      if (this._options[i].type === OPTION_PARAM) {
        remaining--;
        if (remaining === 0) {
          this._options[i].used = true;
          return this._options[i].value;
        }
      }
    }
    return '';
  }

  /** All remaining parameters, in order (a convenience the C++ gets from Param[]). */
  params() {
    return this._options.filter((o) => o.type === OPTION_PARAM).map((o) => o.value);
  }

  /** ConsumeParam: read the first parameter and remove it from the list. */
  consumeParam() {
    const result = this.param(1);
    this._paramsProcessed(1, 1);
    return result;
  }

  /**
   * The core FindSwitch. Returns the switch's value, whether a value was
   * explicitly set, and the 1-based position/count of the parameters that
   * immediately follow it — the latter is what `-rawsettings Key=Value ...`
   * relies on.
   */
  _findSwitch(name, caseSensitive) {
    let paramsStart = 0;
    let valueSet = false;
    let value = '';
    let index = 0;
    let found = false;

    while (index < this._options.length && !found) {
      const o = this._options[index];
      if (o.type === OPTION_PARAM) {
        paramsStart++;
      } else if (o.type === OPTION_SWITCH) {
        const match = caseSensitive
          ? o.name === name
          : o.name.toLowerCase() === String(name).toLowerCase();
        if (match) {
          found = true;
          value = o.value;
          valueSet = o.valueSet;
          o.used = true;
        }
      }
      index++;
    }

    let paramsCount = 0;
    if (found) {
      paramsStart++;
      while (index + paramsCount < this._options.length &&
             this._options[index + paramsCount].type === OPTION_PARAM) {
        paramsCount++;
      }
    } else {
      paramsStart = 0;
    }

    return { found, value, valueSet, paramsStart, paramsCount };
  }

  /** FindSwitch(Switch) — presence only. Marks it used. */
  findSwitch(name) {
    return this._findSwitch(name, false).found;
  }

  /** FindSwitch(Switch, Value, ValueSet). */
  findSwitchValue(name) {
    const r = this._findSwitch(name, false);
    return { found: r.found, value: r.value, valueSet: r.valueSet };
  }

  findSwitchCaseSensitive(name) {
    return this._findSwitch(name, true).found;
  }

  /**
   * DoFindSwitch — the parameter-consuming form. The switch's own value, when
   * it is a number, caps how many following parameters belong to it
   * (`-rawsettings=2 a=1 b=2 file.txt`); `paramsMax` caps it again. Consumed
   * parameters are removed, so later Param[] indexes shift exactly as in the
   * C++.
   */
  findSwitchParams(name, paramsMax = -1, caseSensitive = false) {
    const r = this._findSwitch(name, caseSensitive);
    const params = [];
    if (r.found) {
      let count = r.paramsCount;
      const asInt = tryStrToInt(r.value);
      if (asInt !== null && asInt < count) count = asInt;
      if (paramsMax >= 0 && count > paramsMax) count = paramsMax;

      for (let i = 0; i < count; i++) params.push(this.param(r.paramsStart + i));
      this._paramsProcessed(r.paramsStart, count);
    }
    return { found: r.found, params };
  }

  findSwitchParamsCaseSensitive(name, paramsMax = -1) {
    return this.findSwitchParams(name, paramsMax, true);
  }

  /** SwitchValue(Switch, Default) — an empty value falls back to the default. */
  switchValue(name, defaultValue = '') {
    const r = this._findSwitch(name, false);
    return r.value === '' ? defaultValue : r.value;
  }

  /**
   * SwitchValue(Switch, Default, DefaultOnNonExistence). `on`/`off` and any
   * integer are accepted; anything else is the error WinSCP reports verbatim.
   */
  switchValueBool(name, defaultValue, defaultOnNonExistence = defaultValue) {
    const r = this._findSwitch(name, false);
    if (!r.found) return defaultOnNonExistence;
    if (r.value === '') return defaultValue;
    if (r.value.toLowerCase() === 'on') return true;
    if (r.value.toLowerCase() === 'off') return false;
    const asInt = tryStrToInt(r.value);
    if (asInt !== null) return asInt !== 0;
    throw new Error(`Invalid switch value '${r.value}'. Valid values are 'on' and 'off'.`);
  }

  /** UnusedSwitch — the first switch nothing has looked at, or null. */
  unusedSwitch() {
    for (const o of this._options) {
      if (o.type === OPTION_SWITCH && !o.used) return o.name;
    }
    return null;
  }

  /** WasSwitchAdded — the last token, when it was a switch. */
  wasSwitchAdded() {
    const last = this._options[this._options.length - 1];
    if (!last || last.type !== OPTION_SWITCH) return null;
    return { name: last.name, value: last.value, switchMark: last.switchMark };
  }

  /** ParamsProcessed: drop `count` parameters starting at the 1-based start. */
  _paramsProcessed(paramsStart, paramsCount) {
    if (paramsCount <= 0) return;
    let start = paramsStart;
    let index = 0;
    while (index < this._options.length && start > 0) {
      if (this._options[index].type === OPTION_PARAM) {
        start--;
        if (start === 0) {
          let left = paramsCount;
          while (left > 0 && index < this._options.length &&
                 this._options[index].type === OPTION_PARAM) {
            this._options.splice(index, 1);
            this.paramCount--;
            left--;
          }
        }
      }
      index++;
    }
  }

  /**
   * LogOptions. Logs the options as they were *added*, not as they stand after
   * parameters have been consumed — a log that changed with consumption would
   * not describe the command line the user typed.
   */
  logOptions() {
    return this._originalOptions.map((o) => {
      if (o.type === OPTION_PARAM) return `Parameter: ${o.value}`;
      const delimiter = o.value === '' ? '' : this.switchValueDelimiters[0];
      return `Switch:    ${this.switchMarks[0]}${o.name}${delimiter}${o.value}`;
    });
  }
}

/**
 * TProgramParams. The Win32 command line includes the executable as its first
 * token, so Init cuts exactly one token before parsing the rest. Constructing
 * from an argv array (Electron's process.argv) skips that instead.
 */
class ProgramParams extends Options {
  static fromCommandLine(cmdLine) {
    const p = new ProgramParams();
    const cut = cutToken(String(cmdLine == null ? '' : cmdLine));
    p.parse(cut === null ? '' : cut.rest);
    return p;
  }

  /** process.argv without argv[0] (and without the script path under Node). */
  static fromArgv(argv) {
    const p = new ProgramParams();
    for (const a of argv) p.add(a);
    return p;
  }

  /** FormatSwitch — the canonical `/switch` spelling used in messages. */
  static formatSwitch(name) { return `/${name}`; }
}

module.exports = {
  PASSWORD_MASK,
  OPTION_PARAM,
  OPTION_SWITCH,
  Options,
  ProgramParams,
  cutToken,
  tokenizeCommandLine,
  escapeParam,
  shellQuoteStr,
  addQuotes,
  stringsToParams,
  tryStrToInt,
};
