const { DEFAULT_UI_LANGUAGE, getActiveUiLanguage } = require('../i18n');
const ui = require('../terminal/ui');
const PROGRESS_HINTS = [
    {
        id: 'source',
        en: 'May the source be with this proxy list',
        ru: 'Да пребудет с этим списком сила хороших прокси'
    },
    {
        id: 'background',
        en: 'You can let this run while you do something else',
        ru: 'Пусть проверка идёт, а вы пока займитесь чем-нибудь ещё'
    },
    {
        id: 'tea',
        en: 'I guess it is time for a tea break',
        ru: 'Небольшой чайный перерыв сейчас будет очень кстати'
    },
    {
        id: 'matrix',
        en: 'Somewhere in the Matrix, packets are choosing their fate',
        ru: 'Где-то в Матрице пакеты решают свою судьбу'
    },
    {
        id: 'jedi',
        en: 'Not every proxy chooses the Jedi path',
        ru: 'Не каждый прокси выбирает путь джедая'
    },
    {
        id: 'hyperspace',
        en: 'Packets jumped to hyperspace and should be back soon',
        ru: 'Пакеты ушли в гиперпространство и скоро вернутся'
    },
    {
        id: 'dice',
        en: 'The network gods are rolling dice for this list',
        ru: 'Сетевые боги кидают кубики за этот список'
    },
    {
        id: 'suspicious-route',
        en: 'This route looks suspicious… which means it might actually work',
        ru: 'Этот маршрут выглядит подозрительно… значит, возможно, рабочий'
    },
    {
        id: 'contemplating',
        en: 'The proxy is contemplating eternity and a few packets',
        ru: 'Прокси сейчас думает о вечном и немного о пакетах'
    },
    {
        id: 'fine-tuning',
        en: 'Fine-tuning the delicate space between almost and working',
        ru: 'Идёт тонкая настройка между “почти” и “работает”'
    },
    {
        id: 'shortcut',
        en: 'Looks like this proxy knows a shortcut',
        ru: 'Похоже, этот прокси знает короткую дорогу'
    },
    {
        id: 'legend',
        en: 'This proxy will either work or become legend in the logs',
        ru: 'Прокси либо сработает, либо войдёт в легенды логов'
    },
    {
        id: 'admin',
        en: 'Some admin once said this should probably work',
        ru: 'Где-то админ сказал “ну вроде должно работать”'
    },
    {
        id: 'confidently',
        en: 'The check proceeds confidently, almost as if by design',
        ru: 'Проверка идёт уверенно, почти как будто по плану'
    },
    {
        id: 'do-not-touch',
        en: 'This has strong do not touch it, it works energy',
        ru: 'Тут есть энергия “не трогай, оно работает”'
    }
];

function resolveProgressHintLanguage() {
    return getActiveUiLanguage() || DEFAULT_UI_LANGUAGE;
}

function normalizeProgressHintText(text) {
    return String(text || '').trim().replace(/\.+$/u, '');
}

function resolveProgressHintText(hint, language = resolveProgressHintLanguage()) {
    if (!hint || typeof hint !== 'object') return '';

    if (language === 'ru' && typeof hint.ru === 'string' && hint.ru.trim()) {
        return normalizeProgressHintText(hint.ru);
    }
    if (typeof hint.en === 'string' && hint.en.trim()) {
        return normalizeProgressHintText(hint.en);
    }
    if (typeof hint.ru === 'string' && hint.ru.trim()) {
        return normalizeProgressHintText(hint.ru);
    }

    return '';
}

function createProgressHint(randomFn = Math.random, language = resolveProgressHintLanguage()) {
    if (!PROGRESS_HINTS.length) {
        return { id: 'fallback', text: '' };
    }

    const pickRandom = typeof randomFn === 'function' ? randomFn : Math.random;
    const raw = Number(pickRandom());
    const normalized = Number.isFinite(raw) && raw >= 0 ? raw : 0;
    const index = Math.min(PROGRESS_HINTS.length - 1, Math.floor(normalized * PROGRESS_HINTS.length));
    const hint = PROGRESS_HINTS[index];

    return {
        id: hint.id,
        text: resolveProgressHintText(hint, language)
    };
}

function takeRandomHint(remainingHints, randomFn, lastHintId = null) {
    if (!Array.isArray(remainingHints) || remainingHints.length === 0) {
        return null;
    }

    const pickRandom = typeof randomFn === 'function' ? randomFn : Math.random;
    const raw = Number(pickRandom());
    const normalized = Number.isFinite(raw) && raw >= 0 ? raw : 0;
    let index = Math.min(remainingHints.length - 1, Math.floor(normalized * remainingHints.length));

    if (
        lastHintId &&
        remainingHints.length > 1 &&
        remainingHints[index] &&
        remainingHints[index].id === lastHintId
    ) {
        index = (index + 1) % remainingHints.length;
    }

    const [selected] = remainingHints.splice(index, 1);
    return selected || null;
}

function createProgressHintRotator(
    randomFn = Math.random,
    language = resolveProgressHintLanguage(),
    options = {}
) {
    const rotationIntervalMs = Math.max(1, Number(options.rotationIntervalMs) || 30_000);
    const ellipsisFrames = Array.isArray(options.ellipsisFrames) && options.ellipsisFrames.length > 0
        ? options.ellipsisFrames.map(frame => String(frame ?? ''))
        : ['', '.', '..', '...'];
    const ellipsisHoldFrames = Math.max(1, Number(options.ellipsisHoldFrames) || 2);

    let remainingHints = [];
    let currentHint = null;
    let nextRotateAtMs = null;
    let ellipsisIndex = 0;
    let ellipsisTick = 0;

    const refillHints = () => {
        remainingHints = PROGRESS_HINTS.map(hint => ({
            id: hint.id,
            text: resolveProgressHintText(hint, language)
        })).filter(hint => hint.text);
    };

    const selectNextHint = () => {
        if (remainingHints.length === 0) {
            refillHints();
        }
        const selected = takeRandomHint(remainingHints, randomFn, currentHint ? currentHint.id : null);
        currentHint = selected || { id: 'fallback', text: '' };
        ellipsisIndex = 0;
        ellipsisTick = 0;
        return currentHint;
    };

    return {
        next(nowMs = Date.now()) {
            const currentNow = Number.isFinite(nowMs) ? nowMs : Date.now();

            if (!currentHint) {
                selectNextHint();
                nextRotateAtMs = currentNow + rotationIntervalMs;
            } else if (currentNow >= nextRotateAtMs) {
                while (currentNow >= nextRotateAtMs) {
                    selectNextHint();
                    nextRotateAtMs += rotationIntervalMs;
                }
            }

            const suffix = ellipsisFrames[ellipsisIndex % ellipsisFrames.length] || '';
            ellipsisTick += 1;
            if (ellipsisTick >= ellipsisHoldFrames) {
                ellipsisTick = 0;
                ellipsisIndex = (ellipsisIndex + 1) % ellipsisFrames.length;
            }

            return {
                id: currentHint.id,
                baseText: currentHint.text,
                suffix,
                text: `${currentHint.text}${suffix}`,
                suffixWidth: ellipsisFrames.reduce((max, frame) => Math.max(max, ui.visibleLength(frame)), 0)
            };
        }
    };
}

function formatProgressHintLines(frame, innerWidth) {
    if (!frame || typeof frame !== 'object') return [];

    const fallbackText = typeof frame.text === 'string' ? frame.text : '';
    const baseText = String(frame.baseText || fallbackText || '').trim();
    const suffix = String(frame.suffix || '');
    const reserveWidth = Math.max(0, Math.min(
        Math.max(0, Number(frame.suffixWidth) || 0),
        Math.max(0, Number(innerWidth) || 0)
    ));

    if (!baseText && !suffix) {
        return [''];
    }

    let lines = ui.wrapText(baseText, Math.max(1, innerWidth));
    const lastLine = lines[lines.length - 1] || '';
    if (reserveWidth > 0 && ui.visibleLength(lastLine) + reserveWidth > innerWidth) {
        lines = ui.wrapText(baseText, Math.max(1, innerWidth - reserveWidth));
    }

    const targetIndex = Math.max(0, lines.length - 1);
    lines[targetIndex] = `${lines[targetIndex] || ''}${suffix}`;
    return lines;
}

module.exports = {
    DEFAULT_UI_LANGUAGE,
    PROGRESS_HINTS,
    createProgressHint,
    createProgressHintRotator,
    formatProgressHintLines,
    normalizeProgressHintText,
    resolveProgressHintLanguage,
    resolveProgressHintText
};
