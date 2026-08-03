'use strict';

// A small error boundary for the main process.  Adapters and queue operations
// can retain their native Error as `cause`, but only the deliberately bounded
// facts returned by toFacts()/serializeError() may cross IPC or reach UI copy.

const CATEGORIES = Object.freeze([
  'protocol',
  'validation',
  'cancellation',
  'authentication',
  'permission',
  'transport',
  'unknown',
]);

const DECISIONS = Object.freeze(['retry', 'skip', 'abort']);

const CATEGORY_DEFAULTS = Object.freeze({
  protocol: {
    code: 'PROTOCOL_ERROR',
    message: 'The server returned a protocol error.',
    retryable: false,
    decisions: ['retry', 'skip', 'abort'],
  },
  validation: {
    code: 'INVALID_INPUT',
    message: 'The operation was rejected because its input is invalid.',
    retryable: false,
    decisions: ['abort'],
  },
  cancellation: {
    code: 'OPERATION_CANCELLED',
    message: 'The operation was cancelled.',
    retryable: false,
    decisions: ['abort'],
  },
  authentication: {
    code: 'AUTHENTICATION_FAILED',
    message: 'Authentication failed.',
    retryable: false,
    decisions: ['retry', 'abort'],
  },
  permission: {
    code: 'PERMISSION_DENIED',
    message: 'Permission was denied.',
    retryable: false,
    decisions: ['skip', 'abort'],
  },
  transport: {
    code: 'TRANSPORT_ERROR',
    message: 'The connection failed.',
    retryable: true,
    decisions: ['retry', 'skip', 'abort'],
  },
  unknown: {
    code: 'UNEXPECTED_ERROR',
    message: 'The operation failed unexpectedly.',
    retryable: false,
    decisions: ['retry', 'abort'],
  },
});

const SENSITIVE_KEY = /password|passphrase|private[ _-]*key|secret|token|credential|authorization|cookie|api[ _-]*key|ppk|pem/i;
const PEM_PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi;
const URL_CREDENTIAL = /(\b[a-z][a-z\d+.-]*:\/\/[^\s/@:]+)(:)[^\s/@]+@/gi;
const ASSIGNMENT_SECRET = /(\b(?:password|passphrase|private[ _-]*key|secret|token|credential|authorization|cookie)\b\s*[:=]\s*)(["']?)([^\s,"'};&]+)(\2)/gi;
const SENSITIVE_LABEL = /\b(?:password|passphrase|private[ _-]*key|secret|token|credential|authorization|cookie)\b/gi;
const MAX_TEXT_LENGTH = 512;
const MAX_DETAILS_DEPTH = 3;
const MAX_DETAIL_ITEMS = 32;

function isCategory(value) {
  return typeof value === 'string' && CATEGORIES.includes(value);
}

function isDecision(value) {
  return typeof value === 'string' && DECISIONS.includes(value);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactText(value, secrets = []) {
  let text = String(value === undefined || value === null ? '' : value);
  for (const secret of secrets) {
    if (secret === undefined || secret === null || String(secret) === '') continue;
    text = text.replace(new RegExp(escapeRegExp(secret), 'g'), '[redacted]');
  }
  text = text
    .replace(PEM_PRIVATE_KEY, '[redacted]')
    .replace(URL_CREDENTIAL, '$1$2[redacted]@')
    .replace(ASSIGNMENT_SECRET, '[redacted]')
    // Keep secret labels out of nested response/detail text too.  A fact such
    // as "private key should not be displayed" is still an implementation
    // detail and can encourage callers to copy unsafe text into the UI.
    .replace(SENSITIVE_LABEL, '[redacted]');
  if (text.length > MAX_TEXT_LENGTH) text = text.slice(0, MAX_TEXT_LENGTH - 1) + '\u2026';
  return text;
}

function sanitizeDetails(value, secrets = [], depth = 0) {
  if (value === null || value === undefined || typeof value === 'boolean' ||
      typeof value === 'number') return value;
  if (typeof value === 'string') return redactText(value, secrets);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return '[redacted binary]';
  if (depth >= MAX_DETAILS_DEPTH) return '[details omitted]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_DETAIL_ITEMS)
      .map((item) => sanitizeDetails(item, secrets, depth + 1));
  }
  if (typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).slice(0, MAX_DETAIL_ITEMS)) {
      if (SENSITIVE_KEY.test(key)) continue;
      output[key] = sanitizeDetails(value[key], secrets, depth + 1);
    }
    return output;
  }
  return redactText(value, secrets);
}

function safeCode(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const code = value.trim().toUpperCase();
  return /^[A-Z][A-Z0-9_:-]{0,63}$/.test(code) ? code : fallback;
}

function safeOptionalText(value, secrets) {
  if (value === undefined || value === null || value === '') return undefined;
  return redactText(value, secrets);
}

function statusOf(error) {
  const candidates = [error && error.statusCode, error && error.status,
    error && error.response && error.response.status];
  for (const candidate of candidates) {
    const status = Number(candidate);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  return undefined;
}

function errorText(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string') return error.message;
  return '';
}

function errorCode(error) {
  if (!error || typeof error.code !== 'string') return '';
  return error.code.toUpperCase();
}

function matches(error, codes, names, pattern) {
  const code = errorCode(error);
  const name = String(error && error.name || '').toLowerCase();
  const message = errorText(error);
  return codes.has(code) || names.has(name) || pattern.test(`${code} ${name} ${message}`);
}

/** Return the stable category for a native Error without exposing its text. */
function classifyCategory(error, context = {}) {
  if (isCategory(context.category)) return context.category;
  const source = error || {};
  if (matches(source,
    new Set(['ABORT_ERR', 'ECANCELED', 'ERR_CANCELED', 'EABORT', 'CANCELLED', 'CANCELED']),
    new Set(['aborterror', 'cancellationerror', 'cancelederror']),
    /\b(cancel(?:led|ed)?|abort(?:ed)?)\b/i)) return 'cancellation';
  if (matches(source,
    new Set(['EINVAL', 'ERR_INVALID_ARG', 'ERR_INVALID_ARG_TYPE', 'VALIDATION_ERROR', 'INVALID_INPUT']),
    new Set(['validationerror', 'inputerror']),
    /\b(invalid input|validation failed|must be .*|is required)\b/i)) return 'validation';
  if (matches(source,
    new Set(['EAUTH', 'ELOGIN', 'AUTH_FAILED', 'AUTHENTICATION_FAILED', 'ERR_AUTHENTICATION']),
    new Set(['autherror', 'authenticationerror', 'loginerror']),
    /\b(auth(?:entication)?|login|log[ -]?in|password)\b.*\b(fail|den|reject|refus|invalid|incorrect)/i) ||
      [401, 407].includes(statusOf(source))) return 'authentication';
  if (matches(source,
    new Set(['EACCES', 'EPERM', 'PERMISSION_DENIED', 'ACCESS_DENIED', 'ERR_PERMISSION']),
    new Set(['permissionerror', 'accessdeniederror']),
    /\b(permission|access)\b.*\b(denied|refus|forbidden|reject)/i) || statusOf(source) === 403) {
    return 'permission';
  }
  if (matches(source,
    new Set(['EPROTO', 'ERR_PROTOCOL', 'PROTOCOL_ERROR', 'SSH_PROTOCOL_ERROR', 'SFTP_PROTOCOL_ERROR']),
    new Set(['protocolerror']),
    /\b(protocol|handshake|packet|reply)\b.*\b(error|invalid|unexpected|unsupported)/i)) return 'protocol';
  if (matches(source,
    new Set(['ECONNRESET', 'ECONNABORTED', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT',
      'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ENOTCONN', 'ESOCKETTIMEDOUT',
      'ENOTFOUND', 'ERR_SOCKET', 'ERR_TLS_CERT_ALTNAME_INVALID']),
    new Set(['timeouterror', 'networkerror', 'connectionerror', 'transporterror']),
    /\b(connection|network|socket|tim(?:e|ed)[ -]?out|unreachable|dns|tls)\b.*\b(fail|reset|refus|closed|lost|error|unavailable|unreachable|timeout)/i) ||
      [408, 425, 502, 503, 504].includes(statusOf(source))) return 'transport';
  return 'unknown';
}

function defaultDetails(error) {
  const status = statusOf(error);
  return status === undefined ? {} : { status };
}

function normalizedDecisions(category, decisions) {
  const allowed = CATEGORY_DEFAULTS[category].decisions;
  if (!Array.isArray(decisions)) return allowed.slice();
  const selected = decisions.filter((decision, index) =>
    isDecision(decision) && allowed.includes(decision) && decisions.indexOf(decision) === index);
  return selected.length ? selected : allowed.slice();
}

class ContractError extends Error {
  constructor(category, message, options = {}) {
    const kind = isCategory(category) ? category : 'unknown';
    const defaults = CATEGORY_DEFAULTS[kind];
    const secrets = Array.isArray(options.secrets) ? options.secrets : [];
    const text = kind === 'unknown' && options.useMessage !== true
      ? defaults.message
      : redactText(message || defaults.message, secrets);
    super(text);
    this.name = 'ContractError';
    this.category = kind;
    this.code = safeCode(options.code, defaults.code);
    this.retryable = options.retryable === undefined
      ? defaults.retryable : options.retryable === true;
    this.decisions = normalizedDecisions(kind, options.decisions);
    this.operation = safeOptionalText(options.operation, secrets);
    this.protocol = safeOptionalText(options.protocol, secrets);
    this.details = sanitizeDetails(options.details || {}, secrets);
    if (options.cause !== undefined) {
      // Non-enumerable on purpose: diagnostics can inspect the native cause,
      // while JSON.stringify and the IPC facts cannot carry its stack or data.
      Object.defineProperty(this, 'cause', {
        configurable: true,
        enumerable: false,
        value: options.cause,
        writable: false,
      });
    }
  }

  toFacts() {
    const facts = {
      category: this.category,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      decisions: this.decisions.slice(),
      hasCause: this.cause !== undefined,
    };
    if (this.operation !== undefined) facts.operation = this.operation;
    if (this.protocol !== undefined) facts.protocol = this.protocol;
    if (Object.keys(this.details).length) facts.details = sanitizeDetails(this.details);
    return facts;
  }

  toJSON() { return this.toFacts(); }
}

function createError(category, message, options = {}) {
  return new ContractError(category, message, options);
}

function normalizeError(error, context = {}) {
  if (error instanceof ContractError) return error;
  // Adapters commonly reject with a plain `{ code, statusCode, message }`
  // object. Keep that evidence for classification instead of stringifying it
  // into "[object Object]" before the boundary sees it.
  const source = error && (typeof error === 'object' || typeof error === 'function')
    ? error : new Error(String(error || ''));
  const category = classifyCategory(source, context);
  const defaults = CATEGORY_DEFAULTS[category];
  const message = category === 'unknown' ? defaults.message : (errorText(source) || defaults.message);
  return new ContractError(category, message, {
    ...context,
    code: context.code || errorCode(source) || defaults.code,
    cause: source,
    details: context.details || defaultDetails(source),
    // The native message is intentionally ignored for unknown errors.  It can
    // contain a password, a private key, or implementation details.
    useMessage: category !== 'unknown',
  });
}

function classifyError(error, context = {}) {
  return normalizeError(error, context);
}

function errorFacts(error, context = {}) {
  return normalizeError(error, context).toFacts();
}

function serializeError(error, context = {}) {
  return errorFacts(error, context);
}

function canChoose(error, decision, context = {}) {
  return normalizedDecisions(classifyError(error, context).category)
    .includes(decision);
}

module.exports = {
  CATEGORIES,
  DECISIONS,
  CATEGORY_DEFAULTS,
  ContractError,
  canChoose,
  classifyCategory,
  classifyError,
  createError,
  errorFacts,
  normalizeError,
  redactText,
  sanitizeDetails,
  serializeError,
};
