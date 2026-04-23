const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

const {
    isUserCancelledError
} = require('../shared/cancel');
const terminalSession = require('../terminal/terminal_session');
const ui = require('../terminal/ui');
const terminalPrompt = require('../terminal/terminal_prompt');
const {
    LANGUAGE_CHOICES,
    ensureUiLanguageSelected,
    setActiveUiLanguage,
    t
} = require('../i18n');
const projectPaths = require('../config/project_paths');
const {
    CONFIG_PATH,
    DEFAULT_CONFIG,
    UNIVERSAL_CONCURRENCY,
    UNIVERSAL_INIT_TIMEOUT_SECONDS,
    listTxtFiles,
    loadConfig,
    saveConfig,
    validateProxyListFile
} = require('./menu_file_helpers');
const {
    GITHUB_SOURCE_SELECTIONS,
    GITHUB_PROXY_SOURCES,
    SOURCE_ID_ALL,
    getSourceNote,
    refreshGitHubSources
} = require('../sources/github_source_updater');
const {
    main: runChecker,
    parseProxyUrl
} = require('../checker');
const {
    parseSavedResultsText
} = require('../checker/output_persistence');
const {
    SETTING_LIMITS,
    sanitizeMenuConfig
} = require('../config/runtime_settings');

const SINGLE_BYTE_DECODER_CACHE = new Map();

function getWorkingResultsFilePath() {
    return projectPaths.getWorkingResultsPath();
}

function formatBatchSize(value) {
    return value > 0 ? String(value) : t('common.all');
}

function resolveLanguageDisplayName(configLanguage, uiLanguage = configLanguage) {
    const safeConfigLanguage = String(configLanguage || 'en').trim().toLowerCase() === 'ru' ? 'ru' : 'en';
    const safeUiLanguage = String(uiLanguage || 'en').trim().toLowerCase() === 'ru' ? 'ru' : 'en';

    if (safeUiLanguage === 'ru') {
        return safeConfigLanguage === 'ru' ? 'Русский' : 'English';
    }

    return safeConfigLanguage === 'ru' ? 'Russian' : 'English';
}

function formatDurationMinutesSeconds(value) {
    const raw = String(value || '').trim();
    const matchedSeconds = raw.match(/^(\d+(?:\.\d+)?)s$/i);
    if (!matchedSeconds) return raw;

    const totalSeconds = Number.parseFloat(matchedSeconds[1]);
    if (!Number.isFinite(totalSeconds)) return raw;

    const roundedSeconds = Math.round(totalSeconds);
    const minutes = Math.floor(roundedSeconds / 60);
    const seconds = roundedSeconds % 60;
    return t('common.minutesSeconds', { minutes, seconds });
}

function formatGitHubSourceCountLabel(count) {
    return t('common.sourceCount', { count });
}

function formatCompactRepoLine(source) {
    return ui.truncateMiddleText(source.repoUrl, getScreenInnerWidth());
}

function getScreenInnerWidth() {
    return Math.max(1, ui.getTerminalWidth(66, 78) - 4);
}

function getFileMenuWidth() {
    return ui.getTerminalWidth(74, 90);
}

function getFileMenuInnerWidth() {
    return Math.max(1, getFileMenuWidth() - 4);
}

function menuLine(index, label, description) {
    const innerWidth = getScreenInnerWidth();
    const indexWidth = 3;
    const gap = 1;
    const labelWidth = Math.min(29, Math.max(12, Math.ceil(innerWidth * 0.4)));
    const descriptionWidth = Math.max(10, innerWidth - indexWidth - gap * 2 - labelWidth);

    return ui.renderColumns([
        { text: `${index}.`, width: indexWidth, minWidth: indexWidth, wrap: false, align: 'right' },
        { text: label, width: labelWidth, minWidth: 8, wrap: false },
        { text: description, width: descriptionWidth, minWidth: 8, wrap: false }
    ], { width: innerWidth, gap });
}

function fileMenuLine(index, label, description) {
    const innerWidth = getFileMenuInnerWidth();
    const indexWidth = 3;
    const gap = 1;
    const labelWidth = Math.min(48, Math.max(18, Math.ceil(innerWidth * 0.6)));
    const descriptionWidth = Math.max(10, innerWidth - indexWidth - gap * 2 - labelWidth);

    return ui.renderColumns([
        { text: `${index}.`, width: indexWidth, minWidth: indexWidth, wrap: false, align: 'right' },
        { text: label, width: labelWidth, minWidth: 10, wrap: false },
        { text: description, width: descriptionWidth, minWidth: 8, wrap: false }
    ], { width: innerWidth, gap });
}

function normalizeMenuFilePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function isHiddenManagedProxyFile(filePath) {
    const basename = path.basename(normalizeMenuFilePath(filePath));
    return /^working_proxies\.pre_/i.test(basename)
        || /^github_source_.*post_change/i.test(basename)
        || /^github_source_.*excluding_working/i.test(basename);
}

function humanizeProxyFileName(filePath) {
    const basename = path.basename(String(filePath || ''), '.txt');
    const normalized = basename.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return path.basename(String(filePath || ''));
    }

    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function describeProxyFileChoice(filePath) {
    const normalizedPath = normalizeMenuFilePath(filePath);
    const basename = path.basename(normalizedPath);
    const isManual = normalizedPath.startsWith(`data/${projectPaths.MANUAL_DIRNAME}/`);

    if (isHiddenManagedProxyFile(normalizedPath)) {
        return {
            id: filePath,
            title: basename,
            detail: normalizedPath,
            group: 'hidden',
            priority: 999
        };
    }

    if (basename === projectPaths.ALL_SOURCES_FILENAME) {
        return {
            id: filePath,
            title: t('proxyList.allGithubSources'),
            detail: normalizedPath,
            group: 'recommended',
            priority: 0
        };
    }

    if (basename === projectPaths.GITHUB_SOURCE_FILENAME) {
        return {
            id: filePath,
            title: t('proxyList.primaryGithubSource'),
            detail: normalizedPath,
            group: 'recommended',
            priority: 1
        };
    }

    if (basename === projectPaths.WORKING_RESULTS_FILENAME) {
        return {
            id: filePath,
            title: t('proxyList.latestWorkingList'),
            detail: normalizedPath,
            group: 'recommended',
            priority: 2
        };
    }

    return {
        id: filePath,
        title: humanizeProxyFileName(filePath),
        detail: normalizedPath,
        group: isManual ? 'user' : 'user',
        priority: 100
    };
}

function sortProxyFileEntries(entries) {
    return entries.slice().sort((left, right) => {
        if (left.priority !== right.priority) {
            return left.priority - right.priority;
        }
        return String(left.id).localeCompare(String(right.id));
    });
}

function resolveMenuSelectionIdentity(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return '';

    const selection = GITHUB_SOURCE_SELECTIONS.find(item => item.id === normalized);
    if (selection) {
        return projectPaths.toProjectRelative(projectPaths.getRuntimeFilePath(selection.outputFilename));
    }

    return projectPaths.toProjectRelative(projectPaths.resolveProjectFilePath(normalized));
}

function isSameMenuSelection(left, right) {
    if (String(left || '').trim() === String(right || '').trim()) {
        return true;
    }

    const leftIdentity = resolveMenuSelectionIdentity(left);
    const rightIdentity = resolveMenuSelectionIdentity(right);
    return Boolean(leftIdentity && rightIdentity && leftIdentity === rightIdentity);
}

function buildProxyListChoiceModel(files, currentValue) {
    const described = (files || []).map(describeProxyFileChoice);
    const visible = described.filter(entry => entry.group !== 'hidden');
    const current = currentValue ? describeProxyFileChoice(currentValue) : null;
    const currentExists = currentValue
        ? fs.existsSync(projectPaths.resolveProjectFilePath(currentValue))
        : false;

    return {
        current,
        currentExists,
        hiddenCount: described.length - visible.length,
        sections: [
            {
                kind: 'system',
                title: t('proxyList.recommendedGroup'),
                entries: sortProxyFileEntries(visible.filter(entry => entry.group === 'recommended'))
            },
            {
                kind: 'user',
                title: t('proxyList.yourFilesGroup'),
                entries: sortProxyFileEntries(visible.filter(entry => entry.group === 'user'))
            }
        ].filter(section => section.entries.length > 0)
    };
}

function renderFileChoiceEntry(index, entry, status) {
    return [
        fileMenuLine(index, entry.title, status || ''),
        ui.colorize(`    ${ui.truncateMiddleText(entry.detail, Math.max(10, getFileMenuInnerWidth() - 4))}`, 'dim')
    ];
}

function buildProxyListChoiceLines(model, numberedEntries, currentValue) {
    const lines = [];
    if (model.current) {
        lines.push(
            model.currentExists
                ? t('proxyList.currentSelection', { value: model.current.title })
                : t('proxyList.currentSelectionMissing')
        );
        lines.push(t('common.file', { value: model.current.detail || model.current.id }));
    }

    for (const section of model.sections) {
        if (lines.length > 0) {
            lines.push(ui.BOX_BREAK);
        }
        if (section.kind !== 'system') {
            lines.push(ui.colorize(section.title, 'strong'));
        }
        for (const entry of section.entries) {
            numberedEntries.push({
                id: entry.id,
                type: 'file'
            });
            lines.push(renderFileChoiceEntry(
                numberedEntries.length,
                entry,
                isSameMenuSelection(entry.id, currentValue)
                    ? ui.colorize(t('common.selected'), 'success')
                    : t('common.available')
            ));
        }
    }

    return lines;
}

function settingsLine(index, label, value, description, innerWidth = getScreenInnerWidth()) {
    const indexWidth = 3;
    const gap = 1;
    const labelWidth = Math.min(20, Math.max(10, Math.ceil(innerWidth * 0.28)));
    const valueWidth = Math.min(10, Math.max(5, Math.ceil(innerWidth * 0.12)));
    const descriptionWidth = Math.max(10, innerWidth - indexWidth - labelWidth - valueWidth - gap * 3);

    return ui.renderColumns([
        { text: `${index}.`, width: indexWidth, minWidth: indexWidth, wrap: false, align: 'right' },
        { text: label, width: labelWidth, minWidth: 8, wrap: false },
        { text: String(value), width: valueWidth, minWidth: 3, wrap: false },
        { text: description, width: descriptionWidth, minWidth: 8, wrap: false }
    ], { width: innerWidth, gap });
}

function settingsActionLine(index, label, description, innerWidth = getScreenInnerWidth()) {
    return settingsLine(index, label, '', description, innerWidth);
}

function promptUiLanguage(currentLanguage) {
    const entries = LANGUAGE_CHOICES.map(choice => ({
        code: choice.code,
        label: choice.label,
        description: choice.code === currentLanguage
            ? ui.colorize(t('common.selected'), 'success')
            : t(choice.descriptionKey)
    }));

    renderScreen(
        t('prompts.languageTitle'),
        t('prompts.languageSubtitle'),
        entries.map((entry, index) => menuLine(index + 1, entry.label, entry.description))
    );

    const choice = promptChoice(entries.length, t('common.chooseOption'), { leadingBlankLine: true });
    return entries[choice - 1].code;
}

function renderScreen(title, subtitle, lines, options = {}) {
    const tone = options.tone || 'accent';
    const width = options.width || ui.getTerminalWidth(66, 78);
    const content = [
        ui.renderBox({ title, subtitle, lines, width, tone }),
        options.footer
            ? `${options.footerTopGap !== false ? '\n' : ''}${ui.colorize(options.footer, 'dim')}`
            : null
    ].filter(value => value != null).join('');
    terminalSession.renderScreen(content);
    if (options.footer) {
        return;
    }
}

function normalizeMenuAnswer(answer) {
    return String(answer || '')
        .trim()
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/gu, '');
}

function getSingleByteReverseMap(encoding) {
    if (SINGLE_BYTE_DECODER_CACHE.has(encoding)) {
        return SINGLE_BYTE_DECODER_CACHE.get(encoding);
    }

    const reverseMap = new Map();
    try {
        const decoder = new TextDecoder(encoding);
        for (let byte = 0; byte <= 255; byte += 1) {
            const decoded = decoder.decode(Buffer.from([byte]));
            if (decoded && decoded !== '\uFFFD' && !reverseMap.has(decoded)) {
                reverseMap.set(decoded, byte);
            }
        }
    } catch {
        // Older Node builds may not expose every Windows codepage.
    }

    SINGLE_BYTE_DECODER_CACHE.set(encoding, reverseMap);
    return reverseMap;
}

function decodeSingleByteMojibake(value, encoding) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    const reverseMap = getSingleByteReverseMap(encoding);
    if (reverseMap.size === 0) return '';

    const bytes = [];
    for (const char of raw) {
        if (reverseMap.has(char)) {
            bytes.push(reverseMap.get(char));
            continue;
        }
        if (char.charCodeAt(0) <= 0x7f) {
            bytes.push(char.charCodeAt(0));
            continue;
        }
        return '';
    }

    return Buffer.from(bytes).toString('utf8');
}

function getMenuAnswerCandidates(answer) {
    const raw = String(answer || '').trim();
    const candidates = new Set([normalizeMenuAnswer(raw)]);

    for (const encoding of ['windows-1251', 'cp866', 'latin1']) {
        const decoded = decodeSingleByteMojibake(raw, encoding);
        if (decoded) {
            candidates.add(normalizeMenuAnswer(decoded));
        }
    }

    return candidates;
}

function matchesMenuAnswer(answer, aliases) {
    const candidates = getMenuAnswerCandidates(answer);
    return aliases.some(alias => candidates.has(normalizeMenuAnswer(alias)));
}

function isMojibakeCyrillicAnswer(answer) {
    return /^\uFFFD{2,}$/u.test(String(answer || '').trim());
}

function isBackAnswer(answer) {
    return matchesMenuAnswer(answer, ['b', 'back', 'нз', 'назад'])
        || isMojibakeCyrillicAnswer(answer);
}

function isYesAnswer(answer) {
    return matchesMenuAnswer(answer, ['y']);
}

function isNoAnswer(answer) {
    return matchesMenuAnswer(answer, ['n']);
}

function promptChoice(maxChoice, promptText, options = {}) {
    const allowBack = options.allowBack === true;
    const leadingBlankLine = options.leadingBlankLine === true;
    while (true) {
        const suffix = allowBack
            ? ` [1-${maxChoice}, ${t('prompts.backSuffix')}]`
            : ` [1-${maxChoice}]`;
        const prefix = leadingBlankLine ? '\n' : '';
        const answer = terminalPrompt.question(`${prefix}${promptText}${suffix}: `).trim().toLowerCase();
        if (allowBack && isBackAnswer(answer)) return null;

        const parsed = Number.parseInt(answer, 10);
        if (Number.isFinite(parsed) && parsed >= 1 && parsed <= maxChoice) {
            return parsed;
        }
    }
}

function promptPause(message = t('common.pressEnterToReturn')) {
    terminalPrompt.question(`\n${message}`);
}

function promptIntegerInRange(label, currentValue, minValue, maxValue) {
    while (true) {
        const answer = terminalPrompt.question(`${label} [${currentValue}]: `).trim();
        if (!answer) return currentValue;

        if (!/^-?\d+$/.test(answer)) {
            console.log(t('common.enterWholeNumberBetween', { minValue, maxValue }));
            continue;
        }

        const parsed = Number.parseInt(answer, 10);
        if (!Number.isFinite(parsed) || parsed < minValue || parsed > maxValue) {
            console.log(t('common.enterWholeNumberBetween', { minValue, maxValue }));
            continue;
        }

        return parsed;
    }
}

function promptConcurrency(currentValue) {
    const minValue = SETTING_LIMITS.concurrency.min;
    const maxValue = SETTING_LIMITS.concurrency.max;

    while (true) {
        const answer = terminalPrompt.question(
            `${t('prompts.multithreadingNormal', { minValue, maxValue })} [${currentValue}]: `
        ).trim();
        if (!answer) return currentValue;

        if (!/^-?\d+$/.test(answer)) {
            console.log(t('common.enterWholeNumberBetween', { minValue, maxValue }));
            continue;
        }

        const parsed = Number.parseInt(answer, 10);
        if (!Number.isFinite(parsed) || parsed < minValue || parsed > maxValue) {
            console.log(t('common.enterWholeNumberBetween', { minValue, maxValue }));
            continue;
        }

        return parsed;
    }
}

function promptBoolean(label, currentValue) {
    const yes = t('prompts.confirmSuffixYes');
    const no = t('prompts.confirmSuffixNo');
    const answer = terminalPrompt.question(`${label} [${yes}/${no}]: `).trim();
    if (!answer) return currentValue;
    if (isYesAnswer(answer)) return true;
    if (isNoAnswer(answer)) return false;
    return currentValue;
}

function promptConfirm(label) {
    const answer = terminalPrompt.question(`${label} [${t('prompts.confirmSuffixYes')}/${t('prompts.confirmSuffixNo')}]: `).trim();
    if (!answer) return false;
    if (isYesAnswer(answer)) return true;
    if (isNoAnswer(answer)) return false;
    return promptConfirm(label);
}

function chooseInputFile(currentValue) {
    while (true) {
        const files = listTxtFiles();
        const model = buildProxyListChoiceModel(files, currentValue);
        const entries = [];
        const lines = buildProxyListChoiceLines(model, entries, currentValue);
        entries.push({
            id: 'custom',
            type: 'custom',
            label: t('proxyList.enterCustomPath'),
            description: t('proxyList.enterCustomPathDescription')
        });
        entries.push({
            id: 'back',
            type: 'back',
            label: t('common.back'),
            description: t('proxyList.backDescriptionNoChanges')
        });
        lines.push(ui.BOX_BREAK);
        lines.push(renderFileChoiceEntry(entries.length - 1, {
            title: t('proxyList.enterCustomPath'),
            detail: t('proxyList.enterCustomPathDescription')
        }, ''));
        lines.push(renderFileChoiceEntry(entries.length, {
            title: t('common.back'),
            detail: t('proxyList.backDescriptionNoChanges')
        }, ''));

        renderScreen(
            t('proxyList.chooseTitle'),
            t('proxyList.chooseSubtitle'),
            lines,
            { width: getFileMenuWidth() }
        );
        const choice = promptChoice(entries.length, t('common.chooseOption'), { leadingBlankLine: true });
        const selected = entries[choice - 1];

        if (selected.type === 'back') {
            return null;
        }

        if (selected.type === 'custom') {
            const answer = terminalPrompt.question(t('common.customPathPrompt', { currentValue })).trim();
            if (!answer || isBackAnswer(answer)) {
                continue;
            }
            return answer;
        }

        return selected.id;
    }
}

function renderHomeScreen(config) {
    const safeConfig = sanitizeMenuConfig(config, DEFAULT_CONFIG);
    const lines = [
        t('common.currentList', { value: safeConfig.inputFile }),
        `${t('common.timeout', { value: safeConfig.timeout })} | ${t('common.attempts', { value: safeConfig.attempts })} | ${t('common.batch', { value: formatBatchSize(safeConfig.batchSize) })}`,
        `${t('common.multithreading')}: ${safeConfig.concurrency} | ${t('common.languageName', { value: resolveLanguageDisplayName(safeConfig.uiLanguage, safeConfig.uiLanguage) })}`,
        ui.BOX_BREAK,
        menuLine(1, t('menu.startCheck'), t('menu.startCheckDescription')),
        menuLine(2, t('menu.refreshSources'), t('menu.refreshSourcesDescription')),
        menuLine(3, t('menu.chooseProxyList'), t('menu.chooseProxyListDescription')),
        menuLine(4, t('menu.viewLastResults'), t('menu.viewLastResultsDescription')),
        menuLine(5, t('menu.sourcesInfo'), t('menu.sourcesInfoDescription')),
        menuLine(6, t('menu.settings'), t('menu.settingsDescription')),
        menuLine(7, t('menu.exit'), t('menu.exitDescription'))
    ];

    renderScreen(
        t('menu.homeTitle'),
        t('menu.homeSubtitle'),
        lines
    );
}

function renderProxyListValidation(validation) {
    renderScreen(
        t('proxyList.checkTitle'),
        t('proxyList.readySubtitle'),
        [
            t('common.file', { value: validation.relativePath }),
            t('common.status', { value: ui.colorize(t('proxyList.readyToUse'), 'success') }),
            ui.BOX_BREAK,
            t('common.numberOfTextLines', { count: validation.stats.totalLines }),
            t('common.mtprotoLinksFound', { count: validation.stats.supported }),
            t('common.duplicatesRemoved', { count: validation.stats.duplicatesRemoved }),
            t('common.otherLinesIgnored', { count: validation.stats.invalid }),
            t('common.uniqueProxiesToCheck', { count: validation.stats.uniqueSupported })
        ]
    );
}

function chooseProxyList(config) {
    while (true) {
        const selected = chooseInputFile(config.inputFile);
        if (!selected) {
            return config;
        }

        const validation = validateProxyListFile(selected);
        if (!validation.ok) {
            renderScreen(
                t('proxyList.checkTitle'),
                t('proxyList.invalidSubtitle'),
                [
                    ui.colorize(validation.error, 'danger'),
                    '',
                    t('proxyList.chooseAnotherOrGoBack')
                ],
                { tone: 'danger' }
            );
            if (!promptConfirm(t('prompts.tryAnotherFile'))) {
                return config;
            }
            continue;
        }

        renderProxyListValidation(validation);
        if (!promptConfirm(t('prompts.useThisProxyList'))) {
            continue;
        }

        config.inputFile = validation.relativePath;
        saveConfig(config);
        renderScreen(
            t('proxyList.updatedTitle'),
            t('proxyList.updatedSubtitle'),
            [
                t('common.currentList', { value: config.inputFile }),
                t('common.uniqueProxiesAvailable', { count: validation.stats.uniqueSupported })
            ],
            { tone: 'success' }
        );
        promptPause();
        return config;
    }
}

function renderSettingsScreen(config) {
    const safeConfig = sanitizeMenuConfig(config, DEFAULT_CONFIG);
    const isRussian = safeConfig.uiLanguage === 'ru';
    const width = isRussian ? ui.getTerminalWidth(74, 90) : ui.getTerminalWidth(66, 78);
    const innerWidth = Math.max(1, width - 4);
    const timeoutValue = `${safeConfig.timeout}${isRussian ? 'с' : 's'}`;
    const concurrencyDescription = t('settings.multithreadingDescription', {
        recommendedMin: SETTING_LIMITS.concurrency.recommendedMin,
        recommendedMax: SETTING_LIMITS.concurrency.recommendedMax
    });
    const settingsLabels = {
        waitTime: isRussian ? 'Время ожидания' : t('common.waitTime'),
        recheckCount: isRussian ? 'Повторные попытки' : t('common.recheckCount'),
        batchSize: isRussian ? 'Количество прокси' : t('common.batchSize'),
        multithreading: t('common.multithreading'),
        language: isRussian ? 'Язык' : t('common.language')
    };
    const settingsValues = {
        batchSize: safeConfig.batchSize <= 0
            ? (isRussian ? 'Все' : 'All')
            : formatBatchSize(safeConfig.batchSize),
        multithreading: safeConfig.concurrency,
        language: resolveLanguageDisplayName(safeConfig.uiLanguage, safeConfig.uiLanguage)
    };
    renderScreen(
        t('settings.title'),
        t('settings.subtitle'),
        [
            settingsLine(1, settingsLabels.waitTime, timeoutValue, t('settings.waitTimeDescription'), innerWidth),
            settingsLine(2, settingsLabels.recheckCount, safeConfig.attempts, t('settings.recheckDescription'), innerWidth),
            settingsLine(3, settingsLabels.batchSize, settingsValues.batchSize, t('settings.batchSizeDescription'), innerWidth),
            settingsLine(4, settingsLabels.multithreading, settingsValues.multithreading, concurrencyDescription, innerWidth),
            settingsLine(5, settingsLabels.language, settingsValues.language, t('settings.languageDescription'), innerWidth),
            settingsActionLine(6, t('common.saveAndBack'), t('settings.returnHomeDescription'), innerWidth)
        ],
        { width }
    );
}

function configureParameters(config) {
    while (true) {
        Object.assign(config, sanitizeMenuConfig(config, DEFAULT_CONFIG));
        renderSettingsScreen(config);
        const choice = promptChoice(6, t('common.chooseOption'), { leadingBlankLine: true });

        if (choice === 6) {
            saveConfig(config);
            return config;
        }

        if (choice === 1) {
            config.timeout = promptIntegerInRange(
                t('prompts.waitTimePerCheck', {
                    minValue: SETTING_LIMITS.timeout.min,
                    maxValue: SETTING_LIMITS.timeout.max
                }),
                config.timeout,
                SETTING_LIMITS.timeout.min,
                SETTING_LIMITS.timeout.max
            );
        }
        if (choice === 2) {
            config.attempts = promptIntegerInRange(
                t('prompts.recheckCount', {
                    minValue: SETTING_LIMITS.attempts.min,
                    maxValue: SETTING_LIMITS.attempts.max
                }),
                config.attempts,
                SETTING_LIMITS.attempts.min,
                SETTING_LIMITS.attempts.max
            );
        }
        if (choice === 3) {
            config.batchSize = promptIntegerInRange(
                t('prompts.batchSize', {
                    maxValue: SETTING_LIMITS.batchSize.max
                }),
                config.batchSize,
                SETTING_LIMITS.batchSize.min,
                SETTING_LIMITS.batchSize.max
            );
        }
        if (choice === 4) {
            config.concurrency = promptConcurrency(config.concurrency);
        }
        if (choice === 5) {
            config.uiLanguage = promptUiLanguage(config.uiLanguage || 'en');
            setActiveUiLanguage(config.uiLanguage);
        }
    }
}

function buildArgv(config) {
    const safeConfig = sanitizeMenuConfig(config, DEFAULT_CONFIG);
    const argv = [
        'node',
        'telegram_proxy_pinger.js',
        '--file',
        safeConfig.inputFile,
        '--concurrency',
        String(safeConfig.concurrency || UNIVERSAL_CONCURRENCY),
        '--timeout',
        String(safeConfig.timeout),
        '--attempts',
        String(safeConfig.attempts),
        '--bootstrap-timeout',
        String(UNIVERSAL_INIT_TIMEOUT_SECONDS)
    ];

    if (safeConfig.batchSize > 0) {
        argv.push('--batch-size', String(safeConfig.batchSize));
    }

    return argv;
}

function parseResultProxy(url) {
    const parsed = parseProxyUrl(url);
    if (parsed.ok) {
        return `${parsed.value.server}:${parsed.value.port}`;
    }
    return url;
}

function readLastResults() {
    const workingResultsFile = getWorkingResultsFilePath();

    if (!fs.existsSync(workingResultsFile)) {
        return {
            ok: false,
            filePath: workingResultsFile,
            proxies: [],
            workingProxies: [],
            mayWorkProxies: [],
            error: t('results.noResultFileYet')
        };
    }

    const raw = fs.readFileSync(workingResultsFile, 'utf8');
    const { workingProxies, mayWorkProxies, totalTime } = parseSavedResultsText(raw);

    const proxies = [...workingProxies, ...mayWorkProxies];

    return {
        ok: true,
        filePath: workingResultsFile,
        proxies,
        workingProxies,
        mayWorkProxies,
        totalTime
    };
}

function renderResultsScreen(result, options = {}) {
    const title = options.title || t('results.lastResultsTitle');
    if (!result.ok) {
        renderScreen(
            title,
            t('results.nothingToShowYet'),
            [
                ui.colorize(result.error, 'warning'),
                '',
                t('results.expectedFile', { value: path.basename(result.filePath) })
            ],
            { tone: 'warning' }
        );
        return;
    }

    const workingPreview = (result.workingProxies || []).slice(0, 5).map((proxy, index) =>
        `${index + 1}. ${parseResultProxy(proxy)}`
    );
    const mayWorkPreview = (result.mayWorkProxies || []).slice(0, 5).map((proxy, index) =>
        `${index + 1}. ${parseResultProxy(proxy)}`
    );

    const lines = [
        t('results.workingFound', { count: (result.workingProxies || []).length }),
        t('results.mayWorkFound', { count: (result.mayWorkProxies || []).length }),
        ...(result.proxies.length > 0 ? [ui.colorize(t('common.savedTo', { value: path.basename(result.filePath) }), 'success')] : []),
        ...(result.totalTime ? [t('common.totalCheckTime', { value: formatDurationMinutesSeconds(result.totalTime) })] : [])
    ];

    lines.push(ui.BOX_BREAK);
    if (workingPreview.length > 0) {
        lines.push(t('results.workingHeader'));
        lines.push(...workingPreview);
        if ((result.workingProxies || []).length > workingPreview.length) {
            lines.push(t('results.moreWorking', { count: (result.workingProxies || []).length - workingPreview.length }));
        }
    } else {
        lines.push(t('results.noWorkingSaved'));
    }

    lines.push(ui.BOX_BREAK);
    if (mayWorkPreview.length > 0) {
        lines.push(t('results.mayWorkHeader'));
        lines.push(...mayWorkPreview);
        if ((result.mayWorkProxies || []).length > mayWorkPreview.length) {
            lines.push(t('results.moreMayWork', { count: (result.mayWorkProxies || []).length - mayWorkPreview.length }));
        }
    } else {
        lines.push(t('results.noMayWorkSaved'));
    }

    lines.push(ui.BOX_BREAK);
    lines.push(ui.colorize(t('common.note'), 'warning'));
    lines.push(t('results.noteAvailability'));

    renderScreen(
        title,
        t('results.summarySubtitle'),
        lines,
        { tone: 'success' }
    );
}

function buildSourceInfoLines() {
    const lines = [
        t('sourceInfo.intro'),
        ui.BOX_BREAK
    ];

    for (const source of GITHUB_PROXY_SOURCES) {
        lines.push(source.name);
        lines.push(t('sourceInfo.repoLabel'));
        lines.push(source.repoUrl);
        lines.push(t('sourceInfo.file', { value: source.rawPathLabel }));
        lines.push(t('sourceInfo.urlLabel'));
        lines.push(source.rawUrl);
        lines.push(t('sourceInfo.notes', { value: getSourceNote(source) }));
        lines.push(ui.BOX_BREAK);
    }

    lines.pop();
    return lines;
}

function renderSourceInfoScreen() {
    renderScreen(
        t('sourceInfo.title'),
        t('sourceInfo.subtitle'),
        buildSourceInfoLines(),
        { tone: 'info', width: ui.getTerminalWidth(84, 92) }
    );
}

function buildRefreshResultLines(result, config) {
    const lines = [];
    const crossSourceDuplicatesRemoved = Number.isFinite(result.crossSourceDuplicatesRemoved)
        ? result.crossSourceDuplicatesRemoved
        : Math.max(
            0,
            result.sources
                .filter(source => source.ok)
                .reduce((sum, source) => sum + (source.stats ? Number(source.stats.uniqueSupported || 0) : 0), 0)
                - Number(result.stats ? result.stats.uniqueSupported || 0 : 0)
        );

    if (result.ok) {
        lines.push(t('common.outputFile', { value: result.relativeOutputPath }));
        lines.push(t('common.sourceSelection', { value: result.sourceName || t('common.allSources') }));
        lines.push(t('common.uniqueProxies', { count: result.stats.uniqueSupported }));
        lines.push(t('bootstrap.currentListSetTo', { value: config.inputFile }));
    } else {
        lines.push(ui.colorize(result.error, 'danger'));
    }

    lines.push(ui.BOX_BREAK);
    lines.push(t('refresh.fetchStatus'));
    for (const source of result.sources) {
        if (source.ok) {
            lines.push(t('refresh.sourceOk', {
                name: source.name,
                uniqueSupported: source.stats.uniqueSupported,
                duplicatesRemoved: source.stats.duplicatesRemoved
            }));
        } else {
            lines.push(t('refresh.sourceFailed', { name: source.name, error: source.error }));
        }
    }
    if (result.ok) {
        lines.push(t('refresh.crossSourceDuplicatesRemoved', {
            count: crossSourceDuplicatesRemoved
        }));
    }

    lines.push(ui.BOX_BREAK);
    lines.push(t('refresh.sourceRepos'));
    for (const source of GITHUB_PROXY_SOURCES) {
        lines.push(formatCompactRepoLine(source));
    }

    return lines;
}

async function handleRefreshGitHubSources(config, options = {}) {
    const renderFn = typeof options.renderFn === 'function' ? options.renderFn : renderScreen;
    const refreshRunner = typeof options.refreshRunner === 'function' ? options.refreshRunner : refreshGitHubSources;
    const pauseFn = typeof options.pauseFn === 'function' ? options.pauseFn : promptPause;

    renderFn(
        t('refresh.title'),
        t('refresh.subtitle'),
        [
            t('common.outputFile', { value: projectPaths.toProjectRelative(projectPaths.getAllSourcesPath()) }),
            formatGitHubSourceCountLabel(GITHUB_PROXY_SOURCES.length),
            '',
            ...GITHUB_PROXY_SOURCES.map(source => `${source.name} -> ${source.rawPathLabel}`)
        ],
        { tone: 'info' }
    );

    try {
        const result = await refreshRunner();
        if (result.ok) {
            config.inputFile = result.relativeOutputPath;
            config.selectedSourceId = result.sourceId || SOURCE_ID_ALL;
            config.lastFailedSourceId = null;
            saveConfig(config);
        }

        renderFn(
            result.ok
                ? (result.partial ? t('refresh.refreshCompletePartial') : t('refresh.refreshComplete'))
                : t('refresh.refreshFailed'),
            result.ok
                ? (result.partial
                    ? t('refresh.partialSubtitle')
                    : t('refresh.successSubtitle'))
                : t('refresh.failedSubtitle'),
            buildRefreshResultLines(result, config),
            { tone: result.ok ? (result.partial ? 'warning' : 'success') : 'danger' }
        );
    } catch (error) {
        renderFn(
            t('refresh.refreshFailed'),
            t('refresh.couldNotBeRefreshedSubtitle'),
            [
                ui.colorize(error.message || String(error), 'danger'),
                '',
                ...GITHUB_PROXY_SOURCES.map(source => formatCompactRepoLine(source))
            ],
            { tone: 'danger' }
        );
    }

    pauseFn();
}

async function runFindProxies(config, options = {}) {
    const validateFn = typeof options.validateFn === 'function' ? options.validateFn : validateProxyListFile;
    const renderFn = typeof options.renderFn === 'function' ? options.renderFn : renderScreen;
    const pauseFn = typeof options.pauseFn === 'function' ? options.pauseFn : promptPause;
    const clearFn = typeof options.clearFn === 'function' ? options.clearFn : ui.clearScreen;
    const checkerRunner = typeof options.checkerRunner === 'function' ? options.checkerRunner : runChecker;
    const readLastResultsFn = typeof options.readLastResultsFn === 'function' ? options.readLastResultsFn : readLastResults;
    const renderResultsFn = typeof options.renderResultsFn === 'function' ? options.renderResultsFn : renderResultsScreen;
    const validation = validateFn(config.inputFile);
    if (!validation.ok) {
        renderFn(
            t('run.cannotStartTitle'),
            t('run.cannotStartSubtitle'),
            [
                ui.colorize(validation.error, 'danger'),
                '',
                t('run.chooseValidListBeforeStart')
            ],
            { tone: 'danger' }
        );
        pauseFn();
        return;
    }

    try {
        renderFn(
            t('run.vpnWarningTitle'),
            t('run.vpnWarningSubtitle'),
            [
                t('run.vpnWarningLine')
            ],
            { tone: 'warning' }
        );
        pauseFn(t('run.pressEnterToStart'));

        clearFn();
        await checkerRunner(buildArgv(config));
        renderResultsFn(readLastResultsFn(), { title: t('run.checkCompleteTitle') });
    } catch (error) {
        if (isUserCancelledError(error)) {
            renderFn(
                t('common.checkCancelled'),
                t('common.scanStopped'),
                [
                    t('common.currentWorkStopped')
                ],
                { tone: 'warning' }
            );
            pauseFn();
            return;
        }

        if (error && error.userTitle) {
            renderFn(
                error.userTitle,
                error.userSubtitle || t('common.checkerCouldNotFinish'),
                error.userLines || [],
                { tone: 'danger' }
            );
            pauseFn();
            return;
        }

        renderFn(
            t('run.runFailedTitle'),
            t('common.checkerCouldNotFinish'),
            [
                ui.colorize(error.message || String(error), 'danger')
            ],
            { tone: 'danger' }
        );
    }

    pauseFn();
}

function viewLastResults() {
    renderResultsScreen(readLastResults());
    promptPause();
}

async function mainMenu() {
    let config = loadConfig();
    const selectedLanguage = ensureUiLanguageSelected().language;
    config = loadConfig();
    config.uiLanguage = selectedLanguage;
    saveConfig(config);

    while (true) {
        renderHomeScreen(config);
        const choice = promptChoice(7, t('common.chooseOption'), { leadingBlankLine: true });

        if (choice === 1) {
            await runFindProxies(config);
            config = loadConfig();
            continue;
        }

        if (choice === 2) {
            await handleRefreshGitHubSources(config);
            config = loadConfig();
            continue;
        }

        if (choice === 3) {
            config = chooseProxyList(config);
            continue;
        }

        if (choice === 4) {
            viewLastResults();
            continue;
        }

        if (choice === 5) {
            renderSourceInfoScreen();
            promptPause();
            continue;
        }

        if (choice === 6) {
            config = configureParameters(config);
            continue;
        }

        terminalSession.clearLive();
        ui.clearScreen();
        return;
    }
}

module.exports = {
    CONFIG_PATH,
    DEFAULT_CONFIG,
    buildArgv,
    buildProxyListChoiceModel,
    chooseInputFile,
    formatDurationMinutesSeconds,
    handleRefreshGitHubSources,
    loadConfig,
    menuLine,
    promptConcurrency,
    promptBoolean,
    promptConfirm,
    readLastResults,
    runFindProxies,
    renderSourceInfoScreen,
    saveConfig,
    settingsLine,
    validateProxyListFile,
    mainMenu,
    runCli
};

function runCli() {
    terminalSession.installProcessCleanupHandlers();
    return mainMenu().catch(error => {
        terminalSession.dispose();
        console.error(t('common.fatalMenuError', { error: error.message || error }));
        process.exit(1);
    });
}

if (require.main === module) {
    runCli();
}
