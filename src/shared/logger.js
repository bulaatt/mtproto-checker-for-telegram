/**
 * Small structured logger for maintainer-facing diagnostics.
 * User-facing menu and checker panels should continue to render through UI helpers.
 */

const LEVELS = Object.freeze({
    silent: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4
});

/**
 * @param {string | undefined | null} value
 * @returns {'silent' | 'error' | 'warn' | 'info' | 'debug'}
 */
function normalizeLevel(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(LEVELS, normalized)) {
        return normalized;
    }
    return 'info';
}

/**
 * @param {{
 *   level?: string,
 *   stderr?: NodeJS.WriteStream
 * }} [options]
 */
function createLogger(options = {}) {
    const stderr = options.stderr || process.stderr;
    let activeLevel = normalizeLevel(options.level || process.env.MTPROTO_CHECKER_LOG_LEVEL);

    /**
     * @param {'error' | 'warn' | 'info' | 'debug'} level
     * @param {string} message
     */
    function write(level, message) {
        if (LEVELS[level] > LEVELS[activeLevel]) return;
        stderr.write(`[${level}] ${message}\n`);
    }

    return {
        getLevel() {
            return activeLevel;
        },
        setLevel(level) {
            activeLevel = normalizeLevel(level);
        },
        error(message) {
            write('error', message);
        },
        warn(message) {
            write('warn', message);
        },
        info(message) {
            write('info', message);
        },
        debug(message) {
            write('debug', message);
        }
    };
}

const logger = createLogger();

module.exports = {
    LEVELS,
    createLogger,
    logger
};
