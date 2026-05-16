// ════════════════════════════════════════════════════════════════
//  Minimal structured logger for pipeline workers. Produces one
//  JSON line per event so downstream log collectors (loki, fluent,
//  plain `grep`) can parse it without heuristics.
// ════════════════════════════════════════════════════════════════

type Level = 'debug' | 'info' | 'warn' | 'error';

interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function threshold(): Level {
  const v = (process.env.PIPELINE_LOG_LEVEL ?? 'info').toLowerCase();
  if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v;
  return 'info';
}

function emit(level: Level, component: string, msg: string, fields?: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold()]) return;
  const line = {
    t:  new Date().toISOString(),
    l:  level,
    c:  component,
    m:  msg,
    ...(fields ?? {}),
  };
  const out = JSON.stringify(line);
  if (level === 'error')      console.error(out);
  else if (level === 'warn')  console.warn(out);
  else                        console.log(out);
}

export function createLogger(component: string): {
  debug: (msg: string, fields?: LogFields) => void;
  info:  (msg: string, fields?: LogFields) => void;
  warn:  (msg: string, fields?: LogFields) => void;
  error: (msg: string, fields?: LogFields) => void;
} {
  return {
    debug: (m, f) => emit('debug', component, m, f),
    info:  (m, f) => emit('info',  component, m, f),
    warn:  (m, f) => emit('warn',  component, m, f),
    error: (m, f) => emit('error', component, m, f),
  };
}
