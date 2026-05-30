// In-memory ring buffer for siste 500 logghendelser.
// Intercepterer console.log/warn/error så vi kan vise dem i dashbordet.
const BUFFER_SIZE = 500;
const buffer = [];

function record(level, args) {
  try {
    const msg = args.map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack || a.message;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(" ");
    buffer.push({
      ts: new Date().toISOString(),
      level,
      message: msg.slice(0, 5000),
    });
    if (buffer.length > BUFFER_SIZE) buffer.shift();
  } catch { /* ignore logger errors */ }
}

const origLog = console.log.bind(console);
const origInfo = console.info.bind(console);
const origWarn = console.warn.bind(console);
const origError = console.error.bind(console);

console.log = (...args) => { record("info", args); origLog(...args); };
console.info = (...args) => { record("info", args); origInfo(...args); };
console.warn = (...args) => { record("warn", args); origWarn(...args); };
console.error = (...args) => { record("error", args); origError(...args); };

export function getLogs(opts = {}) {
  let logs = buffer.slice();
  if (opts.level) logs = logs.filter((l) => l.level === opts.level);
  if (opts.search) {
    const q = String(opts.search).toLowerCase();
    logs = logs.filter((l) => l.message.toLowerCase().includes(q));
  }
  if (opts.limit) logs = logs.slice(-opts.limit);
  return logs.slice().reverse(); // nyeste først
}

export function clearLogs() { buffer.length = 0; }

export function logCount(level) {
  if (!level) return buffer.length;
  return buffer.filter((l) => l.level === level).length;
}
