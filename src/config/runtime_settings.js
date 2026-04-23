const SETTING_LIMITS = Object.freeze({
    concurrency: Object.freeze({
        min: 1,
        max: 128,
        defaultValue: 32,
        recommendedMin: 1,
        recommendedMax: 64
    }),
    timeout: Object.freeze({
        min: 3,
        max: 10,
        defaultValue: 4
    }),
    attempts: Object.freeze({
        min: 1,
        max: 5,
        defaultValue: 2
    }),
    batchSize: Object.freeze({
        min: 0,
        max: 5000,
        defaultValue: 0
    })
});

function toRoundedInteger(value, fallback) {
    const numeric = typeof value === 'string' && value.trim() === ''
        ? Number.NaN
        : Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.round(numeric);
}

function clampInteger(value, limits, fallback = limits.defaultValue) {
    const normalized = toRoundedInteger(value, fallback);
    return Math.min(limits.max, Math.max(limits.min, normalized));
}

function sanitizeTimeoutSeconds(value, fallback = SETTING_LIMITS.timeout.defaultValue) {
    return clampInteger(value, SETTING_LIMITS.timeout, fallback);
}

function sanitizeConcurrency(value, fallback = SETTING_LIMITS.concurrency.defaultValue) {
    return clampInteger(value, SETTING_LIMITS.concurrency, fallback);
}

function sanitizeAttempts(value, fallback = SETTING_LIMITS.attempts.defaultValue) {
    return clampInteger(value, SETTING_LIMITS.attempts, fallback);
}

function sanitizeBatchSize(value, fallback = SETTING_LIMITS.batchSize.defaultValue) {
    return clampInteger(value, SETTING_LIMITS.batchSize, fallback);
}

function sanitizeBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}

function sanitizeNonEmptyString(value, fallback) {
    const normalized = String(value || '').trim();
    return normalized || fallback;
}

function sanitizeNullableString(value) {
    const normalized = String(value || '').trim();
    return normalized || null;
}

function sanitizeMenuConfig(config = {}, defaults = {}) {
    return {
        inputFile: sanitizeNonEmptyString(config.inputFile, defaults.inputFile || 'proxies.txt'),
        selectedSourceId: sanitizeNonEmptyString(config.selectedSourceId, defaults.selectedSourceId || 'all_sources'),
        lastFailedSourceId: sanitizeNullableString(config.lastFailedSourceId),
        uiLanguage: sanitizeNullableString(config.uiLanguage),
        concurrency: sanitizeConcurrency(config.concurrency, defaults.concurrency ?? SETTING_LIMITS.concurrency.defaultValue),
        timeout: sanitizeTimeoutSeconds(config.timeout, defaults.timeout ?? SETTING_LIMITS.timeout.defaultValue),
        attempts: sanitizeAttempts(config.attempts, defaults.attempts ?? SETTING_LIMITS.attempts.defaultValue),
        batchSize: sanitizeBatchSize(config.batchSize, defaults.batchSize ?? SETTING_LIMITS.batchSize.defaultValue),
        verbose: sanitizeBoolean(config.verbose, defaults.verbose ?? false)
    };
}

module.exports = {
    SETTING_LIMITS,
    sanitizeAttempts,
    sanitizeBatchSize,
    sanitizeBoolean,
    sanitizeConcurrency,
    sanitizeMenuConfig,
    sanitizeNonEmptyString,
    sanitizeNullableString,
    sanitizeTimeoutSeconds
};
