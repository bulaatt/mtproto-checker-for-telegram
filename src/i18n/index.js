const fs = require('fs');

const ui = require('../terminal/ui');
const terminalPrompt = require('../terminal/terminal_prompt');
const terminalSession = require('../terminal/terminal_session');
const projectPaths = require('../config/project_paths');
const en = require('./en');
const ru = require('./ru');

const DEFAULT_UI_LANGUAGE = 'en';
const SUPPORTED_UI_LANGUAGES = ['en', 'ru'];
const LANGUAGE_CHOICES = [
    { code: 'en', label: 'English', descriptionKey: 'prompts.languageDescriptionEnglish' },
    { code: 'ru', label: 'Русский', descriptionKey: 'prompts.languageDescriptionRussian' }
];

const catalogs = { en, ru };
let activeUiLanguage = DEFAULT_UI_LANGUAGE;

function normalizeUiLanguage(value) {
    return SUPPORTED_UI_LANGUAGES.includes(value) ? value : null;
}

function getActiveUiLanguage() {
    return activeUiLanguage;
}

function setActiveUiLanguage(language) {
    activeUiLanguage = normalizeUiLanguage(language) || DEFAULT_UI_LANGUAGE;
    return activeUiLanguage;
}

function getCatalog(language = getActiveUiLanguage()) {
    return catalogs[normalizeUiLanguage(language) || DEFAULT_UI_LANGUAGE] || en;
}

function resolveMessage(language, key) {
    const segments = String(key || '').split('.');
    let current = getCatalog(language);

    for (const segment of segments) {
        if (!current || typeof current !== 'object' || !(segment in current)) {
            current = null;
            break;
        }
        current = current[segment];
    }

    if (current != null) {
        return current;
    }

    current = en;
    for (const segment of segments) {
        if (!current || typeof current !== 'object' || !(segment in current)) {
            return key;
        }
        current = current[segment];
    }

    return current == null ? key : current;
}

function formatTemplate(template, params = {}) {
    return String(template).replace(/\{(\w+)\}/g, (_match, token) => {
        if (!Object.prototype.hasOwnProperty.call(params, token)) {
            return '';
        }
        return String(params[token]);
    });
}

function createPluralHelper(language) {
    return (count, forms) => {
        const normalizedCount = Math.abs(Number(count || 0));
        if (!Array.isArray(forms) || forms.length === 0) return '';

        if (language === 'ru') {
            const one = forms[0] || '';
            const few = forms[1] || one;
            const many = forms[2] || few;
            const mod10 = normalizedCount % 10;
            const mod100 = normalizedCount % 100;

            if (mod10 === 1 && mod100 !== 11) return one;
            if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return few;
            return many;
        }

        return normalizedCount === 1 ? forms[0] : (forms[1] || forms[0]);
    };
}

function t(key, params = {}, language = getActiveUiLanguage()) {
    const resolved = resolveMessage(language, key);
    if (typeof resolved === 'function') {
        return resolved({
            ...params,
            plural: createPluralHelper(language),
            t: (nestedKey, nestedParams = {}) => t(nestedKey, nestedParams, language)
        });
    }
    if (typeof resolved === 'string') {
        return formatTemplate(resolved, params);
    }
    return String(resolved);
}

function readPersistedConfig() {
    try {
        const raw = fs.readFileSync(projectPaths.getConfigPath(), 'utf8');
        return JSON.parse(raw);
    } catch (_) {
        return {};
    }
}

function writePersistedConfig(config) {
    projectPaths.ensureDataDirectories();
    fs.writeFileSync(projectPaths.getConfigPath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function loadStoredUiLanguage() {
    const config = readPersistedConfig();
    return normalizeUiLanguage(config.uiLanguage);
}

function isInteractiveTerminal() {
    return Boolean(process.stdin && process.stdin.isTTY && process.stdout && process.stdout.isTTY);
}

function promptLanguageSelection() {
    const lines = LANGUAGE_CHOICES.map((choice, index) => `${index + 1}. ${choice.label}  ${t(choice.descriptionKey, {}, 'en')}`);
    terminalSession.renderScreen(ui.renderBox({
        title: t('prompts.languageTitle', {}, 'en'),
        subtitle: `${t('prompts.languageSubtitle', {}, 'en')}\n${t('prompts.languageSubtitle', {}, 'ru')}`,
        lines,
        width: ui.getTerminalWidth(60, 76),
        tone: 'accent'
    }));

    while (true) {
        const answer = terminalPrompt.question(
            `${t('prompts.languagePrompt', {}, 'en')} / ${t('prompts.languagePrompt', {}, 'ru')} [1-2]: `
        ).trim();
        const parsed = Number.parseInt(answer, 10);
        if (Number.isFinite(parsed) && parsed >= 1 && parsed <= LANGUAGE_CHOICES.length) {
            return LANGUAGE_CHOICES[parsed - 1].code;
        }
    }
}

function ensureUiLanguageSelected(options = {}) {
    const interactive = Object.prototype.hasOwnProperty.call(options, 'interactive')
        ? options.interactive === true
        : isInteractiveTerminal();
    const config = {
        ...readPersistedConfig()
    };
    const existingLanguage = normalizeUiLanguage(config.uiLanguage);

    if (existingLanguage) {
        setActiveUiLanguage(existingLanguage);
        return {
            language: existingLanguage,
            prompted: false,
            persisted: false,
            config
        };
    }

    if (!interactive) {
        const fallbackLanguage = DEFAULT_UI_LANGUAGE;
        setActiveUiLanguage(fallbackLanguage);
        return {
            language: fallbackLanguage,
            prompted: false,
            persisted: false,
            config
        };
    }

    const selectedLanguage = promptLanguageSelection();
    const nextConfig = {
        ...config,
        uiLanguage: selectedLanguage
    };
    writePersistedConfig(nextConfig);
    setActiveUiLanguage(selectedLanguage);

    return {
        language: selectedLanguage,
        prompted: true,
        persisted: true,
        config: nextConfig
    };
}

module.exports = {
    DEFAULT_UI_LANGUAGE,
    SUPPORTED_UI_LANGUAGES,
    LANGUAGE_CHOICES,
    ensureUiLanguageSelected,
    getActiveUiLanguage,
    isInteractiveTerminal,
    loadStoredUiLanguage,
    normalizeUiLanguage,
    readPersistedConfig,
    setActiveUiLanguage,
    t,
    writePersistedConfig
};
