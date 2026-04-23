const fs = require('fs');
const os = require('os');
const path = require('path');

const projectPaths = require('../config/project_paths');
const {
    DEFAULT_UI_LANGUAGE,
    normalizeUiLanguage,
    setActiveUiLanguage,
    t
} = require('../i18n');
const {
    dedupeSupported,
    loadInputEntries
} = require('../proxy/input');
const {
    sanitizeMenuConfig
} = require('../config/runtime_settings');

const CONFIG_PATH = projectPaths.getConfigPath();
const UNIVERSAL_INIT_TIMEOUT_SECONDS = 12;
const UNIVERSAL_CONCURRENCY = 32;
const DEFAULT_SELECTED_SOURCE_ID = 'all_sources';

const DEFAULT_CONFIG = {
    inputFile: 'proxies.txt',
    selectedSourceId: DEFAULT_SELECTED_SOURCE_ID,
    lastFailedSourceId: null,
    uiLanguage: null,
    concurrency: UNIVERSAL_CONCURRENCY,
    timeout: 4,
    attempts: 2,
    batchSize: 0,
    verbose: false
};

function inferSelectedSourceId(config = {}) {
    const inputFile = String(config.inputFile || '').trim();
    const normalized = inputFile.replace(/\\/g, '/');

    if (normalized.endsWith(projectPaths.ALL_SOURCES_FILENAME)) {
        return 'all_sources';
    }
    if (normalized.endsWith(projectPaths.SCRAPER_SOURCE_FILENAME)) {
        return 'argh94_scraper';
    }
    if (normalized.endsWith(projectPaths.SOLISPIRIT_SOURCE_FILENAME)) {
        return 'solispirit_mtproto';
    }
    return DEFAULT_SELECTED_SOURCE_ID;
}

function normalizeUserFilePath(filePath) {
    const raw = String(filePath || '').trim();
    if (!raw) {
        return {
            ok: false,
            error: t('validationErrors.emptyPath')
        };
    }

    const unquoted = raw.replace(/^(['"])(.*)\1$/, '$2').trim();
    const expanded = unquoted === '~'
        ? os.homedir()
        : (unquoted.startsWith('~/') || unquoted.startsWith('~\\'))
            ? path.join(os.homedir(), unquoted.slice(2))
            : unquoted;
    const resolvedPath = projectPaths.resolveProjectFilePath(expanded);
    const storedPath = projectPaths.toProjectRelative(resolvedPath);

    return {
        ok: true,
        raw,
        normalizedInput: expanded,
        resolvedPath,
        storedPath
    };
}

function validateProxyListFile(filePath) {
    const normalized = normalizeUserFilePath(filePath);
    if (!normalized.ok) {
        return { ok: false, error: normalized.error };
    }

    if (!normalized.normalizedInput.toLowerCase().endsWith('.txt')) {
        return { ok: false, error: t('validationErrors.txtOnly') };
    }

    const resolvedPath = normalized.resolvedPath;
    if (!fs.existsSync(resolvedPath)) {
        return { ok: false, error: t('validationErrors.fileNotFound', { value: normalized.normalizedInput }) };
    }

    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
        return { ok: false, error: t('validationErrors.pathMustBeFile') };
    }

    let entries;
    try {
        entries = loadInputEntries(resolvedPath);
    } catch (error) {
        return { ok: false, error: t('validationErrors.failedToReadFile', { value: error.message || error }) };
    }

    const deduped = dedupeSupported(entries);
    const supported = entries.filter(entry => entry.ok).length;
    const invalid = entries.filter(entry => !entry.ok).length;

    if (entries.length === 0) {
        return { ok: false, error: t('validationErrors.fileEmpty') };
    }

    if (supported === 0 || deduped.unique.length === 0) {
        return { ok: false, error: t('validationErrors.noValidMtproto') };
    }

    return {
        ok: true,
        resolvedPath,
        relativePath: normalized.storedPath,
        stats: {
            totalLines: entries.length,
            supported,
            invalid,
            duplicatesRemoved: deduped.removed,
            uniqueSupported: deduped.unique.length
        }
    };
}

function resolveConfigPath() {
    return projectPaths.getConfigPath();
}

function loadConfig() {
    try {
        const raw = fs.readFileSync(resolveConfigPath(), 'utf8');
        const parsed = JSON.parse(raw);
        const merged = sanitizeMenuConfig({
            ...DEFAULT_CONFIG,
            ...parsed
        }, DEFAULT_CONFIG);
        merged.uiLanguage = normalizeUiLanguage(merged.uiLanguage);
        if (!merged.selectedSourceId) {
            merged.selectedSourceId = inferSelectedSourceId(merged);
        }
        if (merged.uiLanguage) {
            setActiveUiLanguage(merged.uiLanguage);
        } else {
            setActiveUiLanguage(DEFAULT_UI_LANGUAGE);
        }
        return merged;
    } catch (_) {
        setActiveUiLanguage(DEFAULT_UI_LANGUAGE);
        return { ...DEFAULT_CONFIG };
    }
}

function saveConfig(config) {
    const sanitized = sanitizeMenuConfig(config, DEFAULT_CONFIG);
    const persisted = {
        ...sanitized,
        uiLanguage: normalizeUiLanguage(sanitized.uiLanguage)
    };
    projectPaths.ensureDataDirectories();
    fs.writeFileSync(projectPaths.getConfigPath(), `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
    if (persisted.uiLanguage) {
        setActiveUiLanguage(persisted.uiLanguage);
    }
}

function listTxtFiles() {
    return projectPaths.listManagedTxtFiles();
}

module.exports = {
    CONFIG_PATH,
    DEFAULT_CONFIG,
    DEFAULT_SELECTED_SOURCE_ID,
    UNIVERSAL_CONCURRENCY,
    UNIVERSAL_INIT_TIMEOUT_SECONDS,
    inferSelectedSourceId,
    listTxtFiles,
    loadConfig,
    normalizeUserFilePath,
    saveConfig,
    validateProxyListFile
};
