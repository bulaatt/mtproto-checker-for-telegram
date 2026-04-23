const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const { t } = require('../i18n');
const projectPaths = require('../config/project_paths');
const {
    addCancelListener,
    createCancelledError,
    isUserCancelledError,
    throwIfCancelled
} = require('../shared/cancel');
const {
    dedupeSupported,
    parseProxyUrl,
    summarizeInput
} = require('../proxy/input');

const SOURCE_ID_ARGH94 = 'argh94_proxy_list';
const SOURCE_ID_SOLISPIRIT = 'solispirit_mtproto';
const SOURCE_ID_SCRAPER = 'argh94_scraper';
const SOURCE_ID_ALL = 'all_sources';

const GITHUB_SOURCES_MERGED_FILENAME = projectPaths.ALL_SOURCES_FILENAME;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_REQUEST_RETRY_COUNT = 1;
const DEFAULT_REQUEST_RETRY_DELAY_MS = 1_000;
const MAX_REDIRECTS = 5;

const GITHUB_PROXY_SOURCES = [
    {
        id: SOURCE_ID_ARGH94,
        name: 'Argh94/Proxy-List',
        repoUrl: 'https://github.com/Argh94/Proxy-List',
        rawUrl: 'https://raw.githubusercontent.com/Argh94/Proxy-List/master/MTProto.txt',
        outputFilename: projectPaths.GITHUB_SOURCE_FILENAME,
        rawPathLabel: 'MTProto.txt',
        noteKey: 'sourceInfo.noteArgh94'
    },
    {
        id: SOURCE_ID_SOLISPIRIT,
        name: 'SoliSpirit/mtproto',
        repoUrl: 'https://github.com/SoliSpirit/mtproto',
        rawUrl: 'https://raw.githubusercontent.com/SoliSpirit/mtproto/master/all_proxies.txt',
        outputFilename: projectPaths.SOLISPIRIT_SOURCE_FILENAME,
        rawPathLabel: 'all_proxies.txt',
        noteKey: 'sourceInfo.noteSoliSpirit'
    },
    {
        id: SOURCE_ID_SCRAPER,
        name: 'Argh94/telegram-proxy-scraper',
        repoUrl: 'https://github.com/Argh94/telegram-proxy-scraper',
        rawUrl: 'https://raw.githubusercontent.com/Argh94/telegram-proxy-scraper/main/proxy.txt',
        outputFilename: projectPaths.SCRAPER_SOURCE_FILENAME,
        rawPathLabel: 'proxy.txt',
        noteKey: 'sourceInfo.noteArgh94Scraper'
    }
];

const GITHUB_SOURCE_SELECTIONS = [
    {
        id: SOURCE_ID_ARGH94,
        name: 'Argh94/Proxy-List',
        outputFilename: projectPaths.GITHUB_SOURCE_FILENAME,
        sourceIds: [SOURCE_ID_ARGH94]
    },
    {
        id: SOURCE_ID_SOLISPIRIT,
        name: 'SoliSpirit/mtproto',
        outputFilename: projectPaths.SOLISPIRIT_SOURCE_FILENAME,
        sourceIds: [SOURCE_ID_SOLISPIRIT]
    },
    {
        id: SOURCE_ID_SCRAPER,
        name: 'Argh94/telegram-proxy-scraper',
        outputFilename: projectPaths.SCRAPER_SOURCE_FILENAME,
        sourceIds: [SOURCE_ID_SCRAPER]
    },
    {
        id: SOURCE_ID_ALL,
        name: 'All Sources',
        outputFilename: GITHUB_SOURCES_MERGED_FILENAME,
        sourceIds: [SOURCE_ID_ARGH94, SOURCE_ID_SOLISPIRIT, SOURCE_ID_SCRAPER]
    }
];

function getSourceSelectionName(selection) {
    if (!selection) return '';
    if (selection.id === SOURCE_ID_ALL) {
        return t('common.allSources');
    }
    return selection.name;
}

function delay(ms, options = {}) {
    const cancelState = options.cancelState || null;
    throwIfCancelled(cancelState);
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            offCancel();
            resolve();
        }, ms);
        const offCancel = addCancelListener(cancelState, () => {
            clearTimeout(timeout);
            reject(createCancelledError());
        });
    });
}

function parseSourceEntries(content) {
    const entries = [];

    for (const [index, line] of String(content || '').split(/\r?\n/).entries()) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const parsed = parseProxyUrl(trimmed);
        entries.push({
            lineNumber: index + 1,
            raw: trimmed,
            ...parsed
        });
    }

    return entries;
}

function buildSourceSummary(source, entries, deduped, extra = {}) {
    const stats = summarizeInput(entries, deduped);
    return {
        ...source,
        ok: stats.uniqueSupported > 0,
        entries,
        deduped,
        stats,
        ...extra
    };
}

function renderMergedProxyList(uniqueProxies) {
    return `${uniqueProxies.map(proxy => proxy.canonicalUrl || proxy.originalUrl).join('\n')}\n`;
}

function writeFileAtomically(targetPath, content) {
    const directory = path.dirname(targetPath);
    const tempPath = path.join(
        directory,
        `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`
    );

    try {
        fs.writeFileSync(tempPath, content, 'utf8');
        fs.renameSync(tempPath, targetPath);
    } catch (error) {
        try {
            if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
            }
        } catch (_) {}
        throw error;
    }
}

function fetchTextFromUrl(url, options = {}) {
    const timeoutMs = Number(options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS);
    const redirectCount = Number(options.redirectCount || 0);
    const cancelState = options.cancelState || null;
    throwIfCancelled(cancelState);

    return new Promise((resolve, reject) => {
        let settled = false;
        let offCancel = () => {};
        const finish = callback => value => {
            if (settled) return;
            settled = true;
            offCancel();
            callback(value);
        };
        const client = url.startsWith('http://') ? http : https;
        const request = client.get(url, {
            headers: {
                'user-agent': 'telegram-proxy-checker/1.0',
                accept: 'text/plain, text/*;q=0.9, */*;q=0.1'
            }
        }, response => {
            const { statusCode = 0, headers } = response;

            if (statusCode >= 300 && statusCode < 400 && headers.location) {
                response.resume();
                if (redirectCount >= MAX_REDIRECTS) {
                    finish(reject)(new Error('Too many redirects'));
                    return;
                }

                const redirectedUrl = new URL(headers.location, url).toString();
                fetchTextFromUrl(redirectedUrl, {
                    timeoutMs,
                    redirectCount: redirectCount + 1,
                    cancelState
                }).then(finish(resolve), finish(reject));
                return;
            }

            if (statusCode < 200 || statusCode >= 300) {
                response.resume();
                finish(reject)(new Error(`HTTP ${statusCode}`));
                return;
            }

            response.setEncoding('utf8');
            let body = '';
            response.on('data', chunk => {
                body += chunk;
            });
            response.on('end', () => {
                finish(resolve)({
                    statusCode,
                    body
                });
            });
        });
        offCancel = addCancelListener(cancelState, () => {
            request.destroy(createCancelledError());
        });

        request.setTimeout(timeoutMs, () => {
            request.destroy(new Error('Request timeout'));
        });

        request.on('error', finish(reject));
    });
}

async function fetchSourceWithRetry(source, options = {}) {
    const fetchText = typeof options.fetchText === 'function'
        ? options.fetchText
        : fetchTextFromUrl;
    const retryCount = Number(options.retryCount ?? DEFAULT_REQUEST_RETRY_COUNT);
    const retryDelayMs = Number(options.retryDelayMs ?? DEFAULT_REQUEST_RETRY_DELAY_MS);
    const timeoutMs = Number(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    const cancelState = options.cancelState || null;

    let lastError = null;
    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
        throwIfCancelled(cancelState);
        try {
            const response = await fetchText(source.rawUrl, { timeoutMs, source, attempt, cancelState });
            const body = typeof response === 'string' ? response : response.body;
            const statusCode = typeof response === 'string' ? 200 : response.statusCode || 200;
            return { ok: true, statusCode, body, attemptsUsed: attempt + 1 };
        } catch (error) {
            if (isUserCancelledError(error)) {
                throw error;
            }
            lastError = error;
            if (attempt < retryCount) {
                await delay(retryDelayMs, { cancelState });
            }
        }
    }

    return {
        ok: false,
        error: lastError ? (lastError.message || String(lastError)) : 'Unknown fetch error',
        attemptsUsed: retryCount + 1
    };
}

async function refreshGitHubSources(options = {}) {
    const cancelState = options.cancelState || null;
    throwIfCancelled(cancelState);
    const selectionId = options.sourceId || SOURCE_ID_ALL;
    const selection = GITHUB_SOURCE_SELECTIONS.find(candidate => candidate.id === selectionId);
    if (!selection) {
        throw new Error(`Unknown GitHub source selection: ${selectionId}`);
    }

    const selectedSources = GITHUB_PROXY_SOURCES.filter(source => selection.sourceIds.includes(source.id));
    const outputPath = options.outputFile
        ? path.resolve(process.cwd(), options.outputFile)
        : projectPaths.getRuntimeFilePath(selection.outputFilename);
    const sourceResults = [];

    for (const source of selectedSources) {
        throwIfCancelled(cancelState);
        const fetched = await fetchSourceWithRetry(source, options);
        if (!fetched.ok) {
            sourceResults.push({
                ...source,
                ok: false,
                error: fetched.error,
                attemptsUsed: fetched.attemptsUsed,
                stats: {
                    totalLines: 0,
                    supported: 0,
                    invalid: 0,
                    duplicatesRemoved: 0,
                    uniqueSupported: 0
                }
            });
            continue;
        }

        const entries = parseSourceEntries(fetched.body);
        const deduped = dedupeSupported(entries);
        const summary = buildSourceSummary(source, entries, deduped, {
            ok: deduped.unique.length > 0,
            statusCode: fetched.statusCode,
            attemptsUsed: fetched.attemptsUsed
        });

        if (!summary.ok) {
            sourceResults.push({
                ...summary,
                error: t('validationErrors.noValidMtproto')
            });
            continue;
        }

        sourceResults.push(summary);
    }

    const successfulSources = sourceResults.filter(source => source.ok);
    const mergedEntries = successfulSources.flatMap(source => source.entries);
    const mergedDeduped = dedupeSupported(mergedEntries);
    const mergedStats = summarizeInput(mergedEntries, mergedDeduped);
    const crossSourceDuplicatesRemoved = Math.max(
        0,
        successfulSources.reduce((sum, source) => sum + source.stats.uniqueSupported, 0) - mergedStats.uniqueSupported
    );
    throwIfCancelled(cancelState);

    if (successfulSources.length === 0 || mergedDeduped.unique.length === 0) {
        return {
            ok: false,
            partial: false,
            sourceId: selection.id,
            sourceName: getSourceSelectionName(selection),
            outputPath,
            relativeOutputPath: projectPaths.toProjectRelative(outputPath),
            sources: sourceResults,
            stats: mergedStats,
            crossSourceDuplicatesRemoved,
            error: successfulSources.length === 0
                ? t('bootstrap.noUsableGithubSourceRefreshed')
                : t('validationErrors.noValidMtproto')
        };
    }

    projectPaths.ensureDataDirectories();
    throwIfCancelled(cancelState);
    writeFileAtomically(outputPath, renderMergedProxyList(mergedDeduped.unique));

    return {
        ok: true,
        partial: successfulSources.length !== sourceResults.length,
        sourceId: selection.id,
        sourceName: getSourceSelectionName(selection),
        outputPath,
        relativeOutputPath: projectPaths.toProjectRelative(outputPath),
        sources: sourceResults,
        stats: mergedStats,
        crossSourceDuplicatesRemoved
    };
}

function getSourceNote(source) {
    return source && source.noteKey ? t(source.noteKey) : '';
}

module.exports = {
    DEFAULT_REQUEST_RETRY_COUNT,
    DEFAULT_REQUEST_RETRY_DELAY_MS,
    DEFAULT_REQUEST_TIMEOUT_MS,
    GITHUB_SOURCE_SELECTIONS,
    GITHUB_PROXY_SOURCES,
    GITHUB_SOURCES_MERGED_FILENAME,
    SOURCE_ID_ALL,
    SOURCE_ID_ARGH94,
    SOURCE_ID_SCRAPER,
    SOURCE_ID_SOLISPIRIT,
    fetchSourceWithRetry,
    getSourceSelectionName,
    getSourceNote,
    parseSourceEntries,
    refreshGitHubSources,
    renderMergedProxyList,
    writeFileAtomically
};
