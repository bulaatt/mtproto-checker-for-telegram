const ANSI = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    cyan: '\x1b[36m',
    blue: '\x1b[94m',
    green: '\x1b[92m',
    yellow: '\x1b[93m',
    red: '\x1b[91m',
    white: '\x1b[97m'
};

const BOX_BREAK = Symbol('BOX_BREAK');
const ANSI_OR_CHAR_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]|[\s\S]/gu;
const terminalSession = require('./terminal_session');

function supportsColor() {
    return Boolean(process.stdout && process.stdout.isTTY);
}

function colorize(text, tone = 'white') {
    if (!supportsColor()) return text;

    const map = {
        accent: ANSI.cyan,
        info: ANSI.blue,
        success: ANSI.green,
        warning: ANSI.yellow,
        danger: ANSI.red,
        dim: ANSI.dim,
        strong: ANSI.bold,
        white: ANSI.white
    };

    const prefix = map[tone] || '';
    if (!prefix) return text;
    return `${prefix}${text}${ANSI.reset}`;
}

function stripAnsi(text) {
    return String(text || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function visibleLength(text) {
    return stripAnsi(text).length;
}

function truncateText(text, width) {
    const raw = String(text || '');
    if (visibleLength(raw) <= width) return raw;
    if (width <= 1) return '…';

    const tokens = tokenizeAnsi(raw);
    const result = [];
    let visible = 0;
    for (const token of tokens) {
        if (isAnsiToken(token)) {
            result.push(token);
            continue;
        }

        if (visible >= width - 1) break;
        result.push(token);
        visible += 1;
    }

    if (supportsColor()) {
        result.push(ANSI.reset);
    }
    result.push('…');
    return result.join('');
}

function truncateMiddleText(text, width) {
    const raw = String(text || '');
    if (visibleLength(raw) <= width) return raw;
    if (width <= 1) return '…';
    if (width === 2) return '…';

    const tokens = tokenizeAnsi(raw);
    const contentTokens = tokens.filter(token => !isAnsiToken(token));
    const prefixVisible = Math.max(1, Math.ceil((width - 1) / 2));
    const suffixVisible = Math.max(1, width - 1 - prefixVisible);

    const prefix = takeVisibleTokens(contentTokens, prefixVisible);
    const suffix = takeTrailingVisibleTokens(contentTokens, suffixVisible);
    const ansiPrefix = supportsColor() ? collectLeadingAnsiTokens(tokens) : [];
    const result = [...ansiPrefix, ...prefix, '…', ...suffix];

    if (supportsColor()) {
        result.push(ANSI.reset);
    }

    return result.join('');
}

function padText(text, width) {
    const truncated = truncateText(text, width);
    const missing = Math.max(0, width - visibleLength(truncated));
    return `${truncated}${' '.repeat(missing)}`;
}

function wrapText(text, width) {
    const raw = String(text || '');
    if (visibleLength(raw) <= width) return [raw];
    if (width <= 1) return Array.from(stripAnsi(raw));

    const tokens = tokenizeAnsi(raw);
    const lines = [];
    let currentTokens = [];
    let visible = 0;
    let lastBreakIndex = -1;

    const pushLine = (tokensToPush, trimTrailing = true) => {
        const joined = joinTokens(trimTrailing ? trimTrailingSpaces(tokensToPush) : tokensToPush);
        lines.push(joined);
    };

    const refreshBreakIndex = () => {
        lastBreakIndex = -1;
        for (let index = 0; index < currentTokens.length; index += 1) {
            if (isWrapBreakToken(currentTokens[index])) {
                lastBreakIndex = index + 1;
            }
        }
    };

    let index = 0;
    while (index < tokens.length) {
        const token = tokens[index];

        if (token === '\n') {
            pushLine(currentTokens);
            currentTokens = [];
            visible = 0;
            lastBreakIndex = -1;
            index += 1;
            continue;
        }

        if (isAnsiToken(token)) {
            currentTokens.push(token);
            index += 1;
            continue;
        }

        if (visible + 1 > width) {
            if (lastBreakIndex > 0) {
                const breakToken = currentTokens[lastBreakIndex - 1];
                const breakIsWhitespace = !isAnsiToken(breakToken) && /\s/u.test(breakToken);
                pushLine(currentTokens.slice(0, lastBreakIndex), !breakIsWhitespace);
                currentTokens = trimLeadingSpaces(currentTokens.slice(lastBreakIndex));
                visible = visibleLength(joinTokens(currentTokens));
                refreshBreakIndex();
                continue;
            }

            pushLine(currentTokens, false);
            currentTokens = [];
            visible = 0;
            lastBreakIndex = -1;
            continue;
        }

        currentTokens.push(token);
        visible += 1;
        if (isWrapBreakToken(token)) {
            lastBreakIndex = currentTokens.length;
        }
        index += 1;
    }

    if (currentTokens.length > 0) {
        pushLine(currentTokens);
    }

    const balancedLines = rebalanceTrailingWidow(lines, width);
    return balancedLines.length > 0 ? balancedLines : [''];
}

function rebalanceTrailingWidow(lines, width) {
    if (!Array.isArray(lines) || lines.length < 2) {
        return lines;
    }

    const output = lines.slice();
    for (let index = output.length - 1; index > 0; index -= 1) {
        const current = output[index];
        const previous = output[index - 1];
        if (containsAnsi(current) || containsAnsi(previous)) {
            continue;
        }

        const currentTrimmed = String(current).trim();
        if (!currentTrimmed || /\s/u.test(currentTrimmed)) {
            continue;
        }

        const currentLength = visibleLength(currentTrimmed);
        const widowThreshold = Math.max(4, Math.floor(width * 0.2));
        if (currentLength > widowThreshold) {
            continue;
        }

        const previousTrimmed = String(previous).replace(/\s+$/u, '');
        const match = previousTrimmed.match(/^(.*\S)\s+(\S+)$/u);
        if (!match) {
            continue;
        }

        const [, leftPart, movedWord] = match;
        const rebalancedLine = `${movedWord} ${currentTrimmed}`;
        if (visibleLength(rebalancedLine) > width) {
            continue;
        }

        output[index - 1] = leftPart;
        output[index] = rebalancedLine;
    }

    return output;
}

function getTerminalWidth(minWidth = 64, maxWidth = 74) {
    const hasMeasuredWidth = Boolean(process.stdout && Number.isFinite(process.stdout.columns));
    if (!hasMeasuredWidth) {
        return Math.max(5, Math.min(maxWidth, Math.max(minWidth, maxWidth)));
    }

    const availableWidth = Math.max(5, process.stdout.columns - 2);
    return Math.min(maxWidth, availableWidth);
}

function boxLine(text, innerWidth) {
    return `│ ${padText(text, innerWidth)} │`;
}

function renderBox({ title, subtitle, lines = [], width = getTerminalWidth(), tone = 'accent' }) {
    const innerWidth = Math.max(1, width - 4);
    const output = [];
    const normalizedLines = flattenLines(lines);

    output.push(`┌${'─'.repeat(innerWidth + 2)}┐`);
    if (title) {
        for (const segment of wrapText(colorize(title, tone), innerWidth)) {
            output.push(boxLine(segment, innerWidth));
        }
    }
    if (subtitle) {
        for (const segment of wrapText(colorize(subtitle, 'dim'), innerWidth)) {
            output.push(boxLine(segment, innerWidth));
        }
    }
    if (title || subtitle) {
        output.push(`├${'─'.repeat(innerWidth + 2)}┤`);
    }

    for (const line of normalizedLines) {
        if (line === BOX_BREAK) {
            output.push(`├${'─'.repeat(innerWidth + 2)}┤`);
            continue;
        }

        if (line == null) {
            output.push(boxLine('', innerWidth));
            continue;
        }

        const wrapped = wrapText(String(line), innerWidth);
        for (const segment of wrapped) {
            output.push(boxLine(segment, innerWidth));
        }
    }

    output.push(`└${'─'.repeat(innerWidth + 2)}┘`);
    return output.join('\n');
}

function renderColumns(columns, options = {}) {
    const normalized = Array.isArray(columns) ? columns : [];
    const requestedGap = Math.max(0, Number(options.gap ?? 2));
    const targetWidth = Number.isFinite(options.width) ? Math.max(1, Math.floor(options.width)) : null;
    const gap = resolveGap(normalized.length, requestedGap, targetWidth);
    const columnWidths = fitColumnWidths(normalized, { gap, targetWidth });
    const wrappedColumns = normalized.map((column, index) =>
        column.wrap === false
            ? [truncateMiddleText(column.text == null ? '' : String(column.text), columnWidths[index])]
            : wrapText(column.text == null ? '' : String(column.text), columnWidths[index])
    );
    const rowCount = wrappedColumns.reduce((max, segments) => Math.max(max, segments.length), 0);
    const output = [];

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const parts = wrappedColumns.map((segments, columnIndex) => {
            const segment = segments[rowIndex] || '';
            const align = normalized[columnIndex].align === 'right' ? 'right' : 'left';
            return align === 'right'
                ? `${' '.repeat(Math.max(0, columnWidths[columnIndex] - visibleLength(segment)))}${segment}`
                : padText(segment, columnWidths[columnIndex]);
        });

        output.push(parts.join(' '.repeat(gap)).replace(/\s+$/u, ''));
    }

    return output;
}

function fitColumnWidths(columns, { gap, targetWidth }) {
    const preferredWidths = columns.map(column => Math.max(1, Number(column.width || 1)));
    if (!targetWidth || columns.length === 0) {
        return preferredWidths;
    }

    const availableWidth = Math.max(columns.length, targetWidth - gap * Math.max(0, columns.length - 1));
    const softMinimums = columns.map((column, index) => {
        const minWidth = Number(column.minWidth ?? 1);
        return Math.max(1, Math.min(preferredWidths[index], Number.isFinite(minWidth) ? Math.floor(minWidth) : 1));
    });
    const widths = preferredWidths.slice();

    shrinkWidths(widths, softMinimums, availableWidth);
    if (sumWidths(widths) > availableWidth) {
        shrinkWidths(widths, new Array(widths.length).fill(1), availableWidth);
    }

    return widths;
}

function shrinkWidths(widths, minimums, targetWidth) {
    while (sumWidths(widths) > targetWidth) {
        let candidateIndex = -1;
        let candidateWidth = -1;

        for (let index = 0; index < widths.length; index += 1) {
            if (widths[index] <= minimums[index]) continue;
            if (widths[index] > candidateWidth) {
                candidateIndex = index;
                candidateWidth = widths[index];
            }
        }

        if (candidateIndex === -1) {
            return;
        }

        widths[candidateIndex] -= 1;
    }
}

function sumWidths(widths) {
    return widths.reduce((total, width) => total + width, 0);
}

function resolveGap(columnCount, requestedGap, targetWidth) {
    if (!targetWidth || columnCount <= 1) {
        return requestedGap;
    }

    const maxGap = Math.floor((targetWidth - columnCount) / Math.max(1, columnCount - 1));
    return Math.max(0, Math.min(requestedGap, maxGap));
}

function flattenLines(lines) {
    const output = [];
    for (const line of lines) {
        if (Array.isArray(line)) {
            output.push(...flattenLines(line));
            continue;
        }
        output.push(line);
    }
    return output;
}

function tokenizeAnsi(text) {
    return String(text || '').match(ANSI_OR_CHAR_PATTERN) || [];
}

function isAnsiToken(token) {
    return /^\x1B\[[0-?]*[ -/]*[@-~]$/u.test(token);
}

function containsAnsi(text) {
    return /\x1B\[[0-?]*[ -/]*[@-~]/u.test(String(text || ''));
}

function collectLeadingAnsiTokens(tokens) {
    const result = [];
    for (const token of tokens) {
        if (!isAnsiToken(token)) break;
        result.push(token);
    }
    return result;
}

function takeVisibleTokens(tokens, visibleCount) {
    const result = [];
    let visible = 0;
    for (const token of tokens) {
        if (visible >= visibleCount) break;
        result.push(token);
        visible += 1;
    }
    return result;
}

function takeTrailingVisibleTokens(tokens, visibleCount) {
    const result = [];
    let visible = 0;
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
        if (visible >= visibleCount) break;
        result.unshift(tokens[index]);
        visible += 1;
    }
    return result;
}

function isWrapBreakToken(token) {
    return /\s|[\/\\_.:|-]/u.test(token);
}

function joinTokens(tokens) {
    return tokens.join('');
}

function trimLeadingSpaces(tokens) {
    let index = 0;
    while (index < tokens.length && !isAnsiToken(tokens[index]) && /\s/u.test(tokens[index])) {
        index += 1;
    }
    return tokens.slice(index);
}

function trimTrailingSpaces(tokens) {
    let end = tokens.length;
    while (end > 0 && !isAnsiToken(tokens[end - 1]) && /\s/u.test(tokens[end - 1])) {
        end -= 1;
    }
    return tokens.slice(0, end);
}

function clearScreen() {
    terminalSession.clearViewport();
}

function rewriteLiveRegion(lines, previousLineCount = 0, options = {}) {
    void previousLineCount;
    return terminalSession.renderLive(lines, options);
}

function hideCursor() {
    terminalSession.hideCursor();
}

function showCursor() {
    terminalSession.showCursor();
}

module.exports = {
    ANSI,
    BOX_BREAK,
    clearScreen,
    colorize,
    getTerminalWidth,
    hideCursor,
    padText,
    rewriteLiveRegion,
    renderColumns,
    renderBox,
    showCursor,
    stripAnsi,
    truncateMiddleText,
    truncateText,
    wrapText,
    visibleLength
};
