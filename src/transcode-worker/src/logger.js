// Log có cấu trúc. Khi LOG_FORMAT=json (trên EKS), mỗi dòng log là một object JSON để
// CloudWatch Logs Insights và metric filter đọc được các trường (level, event, durationMs...).
// Fluent Bit của Container Insights đưa object này vào trường log_processed.
// Chạy local thì giữ log dạng chữ cho dễ đọc.

const JSON_LOGS = process.env.LOG_FORMAT === 'json';
const SERVICE = process.env.SERVICE_NAME || 'streamforge';
const original = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function serializeError(err) {
  return { name: err.name, message: err.message, stack: err.stack, ...(err.code ? { code: err.code } : {}) };
}

function write(level, msg, fields = {}) {
  if (!JSON_LOGS) {
    const extra = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
    (level === 'error' ? original.error : level === 'warn' ? original.warn : original.log)(`${msg}${extra}`);
    return;
  }
  const line = JSON.stringify({ time: new Date().toISOString(), level, service: SERVICE, msg, ...fields });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
}

export const logger = {
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
};

/**
 * Chuyển console.log/info/warn/error sang logger, để mọi dòng log cũ cũng thành JSON.
 * Chuỗi được nối thành msg; Error được tách thành trường err (có stack); object khác vào trường data.
 */
export function installConsoleBridge() {
  if (!JSON_LOGS) return;
  const bridge =
    (level) =>
    (...args) => {
      const parts = [];
      const fields = {};
      for (const arg of args) {
        if (arg instanceof Error) fields.err = serializeError(arg);
        else if (arg && typeof arg === 'object') fields.data = arg;
        else parts.push(String(arg));
      }
      write(level, parts.join(' ').trim(), fields);
    };
  console.log = bridge('info');
  console.info = bridge('info');
  console.warn = bridge('warn');
  console.error = bridge('error');
}
