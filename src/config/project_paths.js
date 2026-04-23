const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_HOME_ENV = 'TGPROXY_HOME';
const APP_DIRNAME = '.tgproxy';
const DATA_DIRNAME = 'data';
const RUNTIME_DIRNAME = 'runtime';
const MANUAL_DIRNAME = 'manual';

const CHECKER_CONFIG_FILENAME = 'checker_config.json';
const WORKING_RESULTS_FILENAME = 'working_proxies.txt';
const GITHUB_SOURCE_FILENAME = 'github_source.txt';
const SOLISPIRIT_SOURCE_FILENAME = 'github_source_solispirit.txt';
const SCRAPER_SOURCE_FILENAME = 'github_source_scraper.txt';
const ALL_SOURCES_FILENAME = 'github_source_all.txt';

function getProjectRoot() {
    return process.cwd();
}

function getAppRoot() {
    const override = String(process.env[APP_HOME_ENV] || '').trim();
    if (override) {
        return path.resolve(override);
    }

    if (process.platform === 'win32') {
        const appData = String(process.env.APPDATA || '').trim();
        if (appData) {
            return path.join(appData, 'tgproxy');
        }
        return path.join(os.homedir(), 'AppData', 'Roaming', 'tgproxy');
    }

    return path.join(os.homedir(), APP_DIRNAME);
}

function getDataDir() {
    return path.join(getAppRoot(), DATA_DIRNAME);
}

function getRuntimeDataDir() {
    return path.join(getDataDir(), RUNTIME_DIRNAME);
}

function getManualDataDir() {
    return path.join(getDataDir(), MANUAL_DIRNAME);
}

function getRuntimeFilePath(filename) {
    return path.join(getRuntimeDataDir(), filename);
}

function getManualFilePath(filename) {
    return path.join(getManualDataDir(), filename);
}

function getConfigPath() {
    return getRuntimeFilePath(CHECKER_CONFIG_FILENAME);
}

function getWorkingResultsPath() {
    return getRuntimeFilePath(WORKING_RESULTS_FILENAME);
}

function getGithubSourcePath() {
    return getRuntimeFilePath(GITHUB_SOURCE_FILENAME);
}

function getSoliSpiritSourcePath() {
    return getRuntimeFilePath(SOLISPIRIT_SOURCE_FILENAME);
}

function getScraperSourcePath() {
    return getRuntimeFilePath(SCRAPER_SOURCE_FILENAME);
}

function getAllSourcesPath() {
    return getRuntimeFilePath(ALL_SOURCES_FILENAME);
}

function ensureDataDirectories() {
    fs.mkdirSync(getRuntimeDataDir(), { recursive: true });
    fs.mkdirSync(getManualDataDir(), { recursive: true });
}

function toProjectRelative(filePath) {
    const absolutePath = path.resolve(String(filePath || ''));
    const managedRelativePath = path.relative(getAppRoot(), absolutePath);
    if (managedRelativePath && !managedRelativePath.startsWith('..') && !path.isAbsolute(managedRelativePath)) {
        return managedRelativePath;
    }

    const projectRelativePath = path.relative(getProjectRoot(), absolutePath);
    if (!projectRelativePath || projectRelativePath.startsWith('..') || path.isAbsolute(projectRelativePath)) {
        return absolutePath;
    }
    return projectRelativePath;
}

function uniquePaths(candidates) {
    return [...new Set(candidates.filter(Boolean).map(candidate => path.normalize(candidate)))];
}

function buildManagedPathCandidates(filePath) {
    const raw = String(filePath || '').trim();
    if (!raw) return [];

    const unquoted = raw.replace(/^(['"])(.*)\1$/, '$2').trim();
    if (!unquoted) return [];

    if (path.isAbsolute(unquoted)) {
        return [unquoted];
    }

    const basename = path.basename(unquoted);
    return uniquePaths([
        path.resolve(getProjectRoot(), unquoted),
        path.join(getAppRoot(), unquoted),
        path.join(getRuntimeDataDir(), unquoted),
        path.join(getManualDataDir(), unquoted),
        basename === unquoted ? path.join(getRuntimeDataDir(), basename) : null,
        basename === unquoted ? path.join(getManualDataDir(), basename) : null
    ]);
}

function resolveProjectFilePath(filePath) {
    const candidates = buildManagedPathCandidates(filePath);
    if (candidates.length === 0) {
        return path.resolve(getProjectRoot(), String(filePath || '').trim());
    }

    const existing = candidates.find(candidate => fs.existsSync(candidate));
    return existing || candidates[0];
}

function listManagedTxtFiles() {
    const searchRoots = [
        getProjectRoot(),
        getRuntimeDataDir(),
        getManualDataDir()
    ];
    const files = new Set();

    for (const root of searchRoots) {
        if (!fs.existsSync(root)) continue;

        const entries = fs.readdirSync(root, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            if (!entry.name.toLowerCase().endsWith('.txt')) continue;

            files.add(toProjectRelative(path.join(root, entry.name)));
        }
    }

    return [...files].sort((left, right) => left.localeCompare(right));
}

module.exports = {
    DATA_DIRNAME,
    RUNTIME_DIRNAME,
    MANUAL_DIRNAME,
    APP_HOME_ENV,
    APP_DIRNAME,
    CHECKER_CONFIG_FILENAME,
    WORKING_RESULTS_FILENAME,
    GITHUB_SOURCE_FILENAME,
    SOLISPIRIT_SOURCE_FILENAME,
    SCRAPER_SOURCE_FILENAME,
    ALL_SOURCES_FILENAME,
    ensureDataDirectories,
    getAllSourcesPath,
    getAppRoot,
    getConfigPath,
    getDataDir,
    getGithubSourcePath,
    getManualDataDir,
    getManualFilePath,
    getProjectRoot,
    getRuntimeDataDir,
    getRuntimeFilePath,
    getScraperSourcePath,
    getSoliSpiritSourcePath,
    getWorkingResultsPath,
    listManagedTxtFiles,
    resolveProjectFilePath,
    toProjectRelative
};
