const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_HOME_ENV = 'TGPROXY_HOME';
const APP_DIRNAME = 'tgproxy';
const LEGACY_APP_DIRNAME = '.tgproxy';
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

function hasAppHomeOverride() {
    return Boolean(String(process.env[APP_HOME_ENV] || '').trim());
}

function getDefaultAppRoot() {
    return path.join(os.homedir(), APP_DIRNAME);
}

function getAppRoot() {
    const override = String(process.env[APP_HOME_ENV] || '').trim();
    if (override) {
        return path.resolve(override);
    }

    return getDefaultAppRoot();
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

function getLegacyAppRoots() {
    if (hasAppHomeOverride()) {
        return [];
    }

    if (process.platform === 'win32') {
        const roots = [];
        const appData = String(process.env.APPDATA || '').trim();
        if (appData) {
            roots.push(path.join(appData, APP_DIRNAME));
        }
        roots.push(path.join(os.homedir(), 'AppData', 'Roaming', APP_DIRNAME));
        return uniquePaths(roots).filter(root => root !== getAppRoot());
    }

    return [path.join(os.homedir(), LEGACY_APP_DIRNAME)];
}

function isDirectoryEmpty(dirPath) {
    try {
        return fs.readdirSync(dirPath).length === 0;
    } catch (error) {
        if (error && error.code === 'ENOENT') return true;
        throw error;
    }
}

function copyMissingEntries(sourceDir, targetDir) {
    if (!fs.existsSync(sourceDir)) return;

    fs.mkdirSync(targetDir, { recursive: true });
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const sourcePath = path.join(sourceDir, entry.name);
        const targetPath = path.join(targetDir, entry.name);
        if (fs.existsSync(targetPath)) continue;

        if (entry.isDirectory()) {
            copyMissingEntries(sourcePath, targetPath);
            continue;
        }

        if (entry.isFile()) {
            fs.copyFileSync(sourcePath, targetPath);
        }
    }
}

function migrateLegacyAppRoot() {
    const appRoot = getAppRoot();
    if (!isDirectoryEmpty(appRoot)) return;

    const legacyRoot = getLegacyAppRoots().find(candidate => fs.existsSync(candidate));
    if (!legacyRoot) return;

    copyMissingEntries(legacyRoot, appRoot);
}

function ensureDataDirectories() {
    migrateLegacyAppRoot();
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

function normalizeRelativePathSeparators(filePath) {
    return String(filePath || '').replace(/[\\/]+/g, path.sep);
}

function isManagedRelativePath(filePath) {
    const normalized = String(filePath || '').replace(/\\/g, '/');
    return normalized.startsWith(`${DATA_DIRNAME}/${RUNTIME_DIRNAME}/`)
        || normalized.startsWith(`${DATA_DIRNAME}/${MANUAL_DIRNAME}/`);
}

function buildManagedPathCandidates(filePath) {
    const raw = String(filePath || '').trim();
    if (!raw) return [];

    const unquoted = raw.replace(/^(['"])(.*)\1$/, '$2').trim();
    if (!unquoted) return [];

    if (path.isAbsolute(unquoted)) {
        return [unquoted];
    }

    const normalizedRelative = normalizeRelativePathSeparators(unquoted);
    const basename = path.basename(normalizedRelative);
    const appRelativePath = path.join(getAppRoot(), normalizedRelative);
    const projectRelativePath = path.resolve(getProjectRoot(), normalizedRelative);
    const managedCandidates = [
        appRelativePath,
        projectRelativePath
    ];
    const projectCandidates = [
        projectRelativePath,
        appRelativePath
    ];

    return uniquePaths([
        ...(isManagedRelativePath(unquoted) ? managedCandidates : projectCandidates),
        path.join(getRuntimeDataDir(), normalizedRelative),
        path.join(getManualDataDir(), normalizedRelative),
        basename === normalizedRelative ? path.join(getRuntimeDataDir(), basename) : null,
        basename === normalizedRelative ? path.join(getManualDataDir(), basename) : null
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
