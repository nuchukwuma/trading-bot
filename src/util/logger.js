'use strict';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function createLogger(scope, level) {
  const threshold = LEVELS[level || process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;

  const emit = (lvl, args) => {
    if (LEVELS[lvl] > threshold) return;
    const line = `${new Date().toISOString()} [${lvl.toUpperCase()}] [${scope}]`;
    const fn = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log;
    fn(line, ...args);
  };

  return {
    error: (...a) => emit('error', a),
    warn: (...a) => emit('warn', a),
    info: (...a) => emit('info', a),
    debug: (...a) => emit('debug', a),
    child: (sub) => createLogger(`${scope}:${sub}`, level),
  };
}

module.exports = { createLogger, LEVELS };
