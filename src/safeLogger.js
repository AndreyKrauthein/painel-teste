import dotenv from 'dotenv';
dotenv.config();

const SENSITIVE_KEYS = new Set([
  'cookie',
  'cookies',
  'set-cookie',
  'xsrf-token',
  'mundogf_session',
  'authorization',
  'api_secret',
  'secret',
  'senha',
  'password',
  'pass',
  'token',
  '_token'
]);

function maskValue(val) {
  if (typeof val !== 'string') return val;
  if (val.length === 0) return val;
  // If it's a bearer token
  if (/^bearer\s+/i.test(val)) {
    return 'Bearer [MASKED]';
  }
  // Otherwise, return a generic masked indicator
  return `[MASKED (${val.length} chars)]`;
}

function redactObject(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) {
    return obj.map(redactObject);
  }
  if (typeof obj === 'object') {
    const redacted = {};
    for (const [key, val] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_KEYS.has(lowerKey)) {
        redacted[key] = maskValue(val);
      } else if (typeof val === 'object') {
        redacted[key] = redactObject(val);
      } else if (typeof val === 'string') {
        // Double check if value contains sensitive patterns
        let cleanedVal = val;
        // Check if API_SECRET is in string
        const apiSecret = process.env.API_SECRET;
        if (apiSecret && apiSecret.length > 3 && cleanedVal.includes(apiSecret)) {
          cleanedVal = cleanedVal.replaceAll(apiSecret, '[API_SECRET MASKED]');
        }
        // Check if it's a cookie-like string or contains sensitive params
        cleanedVal = cleanString(cleanedVal);
        redacted[key] = cleanedVal;
      } else {
        redacted[key] = val;
      }
    }
    return redacted;
  }
  return obj;
}

function cleanString(str) {
  if (typeof str !== 'string') return str;
  let result = str;

  // Mask API_SECRET if configured and exists in string
  const apiSecret = process.env.API_SECRET;
  if (apiSecret && apiSecret.length > 3 && result.includes(apiSecret)) {
    result = result.replaceAll(apiSecret, '[API_SECRET MASKED]');
  }

  // Mask cookies in header style: cookie_name=value
  // e.g. mundogf_session=xyz
  result = result.replace(/(mundogf_session|XSRF-TOKEN)=[^;\s]+/gi, '$1=[MASKED]');

  // Mask bearer tokens
  result = result.replace(/bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi, 'Bearer [MASKED]');

  // Mask CSRF _token in query parameters or form fields
  result = result.replace(/_token=[a-zA-Z0-9]+/gi, '_token=[MASKED]');

  return result;
}

function formatArgs(args) {
  return args.map(arg => {
    if (arg instanceof Error) {
      // Mask stack trace and message if they contain secrets
      const errObj = {
        name: arg.name,
        message: cleanString(arg.message),
        stack: cleanString(arg.stack)
      };
      return errObj;
    }
    if (typeof arg === 'object') {
      return redactObject(arg);
    }
    if (typeof arg === 'string') {
      return cleanString(arg);
    }
    return arg;
  });
}

export const logger = {
  info(...args) {
    console.log(`[INFO] [${new Date().toISOString()}]`, ...formatArgs(args));
  },
  warn(...args) {
    console.warn(`[WARN] [${new Date().toISOString()}]`, ...formatArgs(args));
  },
  error(...args) {
    console.error(`[ERROR] [${new Date().toISOString()}]`, ...formatArgs(args));
  },
  debug(...args) {
    // Only log debug if env is set or default to info
    console.log(`[DEBUG] [${new Date().toISOString()}]`, ...formatArgs(args));
  }
};

export default logger;
