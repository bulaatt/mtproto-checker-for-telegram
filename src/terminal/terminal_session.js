function getDefaultStream() {
    return process.stdout || null;
}

function createDefaultWriter(stream = getDefaultStream()) {
    return chunk => {
        const target = stream || getDefaultStream();
        if (target && typeof target.write === 'function') {
            return target.write(chunk);
        }
        return true;
    };
}

function normalizeLines(lines) {
    if (Array.isArray(lines)) {
        return lines.map(line => String(line));
    }
    return String(lines || '').split('\n');
}

function stripAnsi(text) {
    return String(text || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function visibleLength(text) {
    return stripAnsi(text).length;
}

function detectRawAnsiSupport(stream, options = {}) {
    if (typeof options.supportsRawAnsi === 'boolean') {
        return options.supportsRawAnsi;
    }

    const isTTY = options.isTTY ?? Boolean(stream && stream.isTTY);
    if (!isTTY) return false;

    const env = options.env || process.env || {};
    const platform = options.platform || process.platform;

    if (platform !== 'win32') return true;

    return Boolean(
        env.WT_SESSION ||
        env.ANSICON ||
        env.ConEmuANSI === 'ON' ||
        env.TERM_PROGRAM ||
        /^(xterm|vt100|vt220|ansi|cygwin|msys)/i.test(String(env.TERM || ''))
    );
}

function createTerminalControl(options = {}) {
    const stream = options.stream || getDefaultStream();
    const write = typeof options.write === 'function'
        ? options.write
        : createDefaultWriter(stream);
    const hasExplicitIsTTY = Object.prototype.hasOwnProperty.call(options, 'isTTY');

    function isTty() {
        return hasExplicitIsTTY ? Boolean(options.isTTY) : Boolean(stream && stream.isTTY);
    }

    function hasRawAnsiSupport() {
        return detectRawAnsiSupport(stream, {
            ...options,
            isTTY: isTty()
        });
    }

    function writeChunk(chunk) {
        return write(String(chunk));
    }

    function canCall(methodName) {
        return Boolean(isTty() && stream && typeof stream[methodName] === 'function');
    }

    function writeAnsi(sequence) {
        if (!hasRawAnsiSupport()) return false;
        writeChunk(sequence);
        return true;
    }

    function cursorTo(x, y) {
        if (canCall('cursorTo')) {
            return y == null ? stream.cursorTo(x) : stream.cursorTo(x, y);
        }
        if (!hasRawAnsiSupport()) return false;
        if (y == null) {
            writeChunk(`\x1b[${Math.max(1, Number(x) + 1)}G`);
        } else {
            writeChunk(`\x1b[${Math.max(1, Number(y) + 1)};${Math.max(1, Number(x) + 1)}H`);
        }
        return true;
    }

    function moveCursor(dx, dy) {
        if (canCall('moveCursor')) {
            return stream.moveCursor(dx, dy);
        }
        if (!hasRawAnsiSupport()) return false;

        const output = [];
        if (dy < 0) output.push(`\x1b[${Math.abs(dy)}A`);
        if (dy > 0) output.push(`\x1b[${dy}B`);
        if (dx < 0) output.push(`\x1b[${Math.abs(dx)}D`);
        if (dx > 0) output.push(`\x1b[${dx}C`);
        if (output.length > 0) {
            writeChunk(output.join(''));
        }
        return true;
    }

    function moveToNextLine() {
        if (canCall('moveCursor') && canCall('cursorTo')) {
            stream.moveCursor(0, 1);
            stream.cursorTo(0);
            return true;
        }
        if (hasRawAnsiSupport()) {
            writeChunk('\x1b[1E');
            return true;
        }
        writeChunk('\n');
        return true;
    }

    function clearLine(dir = 0) {
        if (canCall('clearLine')) {
            return stream.clearLine(dir);
        }
        return writeAnsi(`\x1b[${dir === -1 ? 1 : dir === 1 ? 0 : 2}K`);
    }

    function clearScreenDown() {
        if (canCall('clearScreenDown')) {
            return stream.clearScreenDown();
        }
        return writeAnsi('\x1b[J');
    }

    function clearViewport() {
        if (canCall('cursorTo') && canCall('clearScreenDown')) {
            stream.cursorTo(0, 0);
            stream.clearScreenDown();
            return true;
        }
        return writeAnsi('\x1b[2J\x1b[H');
    }

    function clearCurrentLine() {
        cursorTo(0);
        clearLine(0);
    }

    function moveToLineStart(linesUp) {
        const count = Math.max(0, Number(linesUp) || 0);
        if (count > 0) {
            if (canCall('moveCursor') && canCall('cursorTo')) {
                stream.moveCursor(0, -count);
                stream.cursorTo(0);
                return true;
            }
            if (hasRawAnsiSupport()) {
                writeChunk(`\x1b[${count}F`);
                return true;
            }
            return false;
        }
        cursorTo(0);
        return true;
    }

    function hasControlSupport() {
        return Boolean(
            (isTty() && canCall('cursorTo') && canCall('clearLine') && canCall('clearScreenDown')) ||
            hasRawAnsiSupport()
        );
    }

    return {
        clearCurrentLine,
        clearLine,
        clearScreenDown,
        clearViewport,
        cursorTo,
        hasControlSupport,
        moveCursor,
        moveToNextLine,
        moveToLineStart,
        get supportsRawAnsi() {
            return hasRawAnsiSupport();
        },
        writeAnsi,
        writeChunk
    };
}

function createTerminalSession(options = {}) {
    const control = createTerminalControl(options);

    let liveLineCount = 0;
    let liveLines = [];
    let cursorHidden = false;
    let cleanupInstalled = false;
    let cleanupHandlers = null;

    function writeChunk(chunk) {
        return control.writeChunk(chunk);
    }

    function hideCursor() {
        if (cursorHidden) return;
        cursorHidden = true;
        control.writeAnsi('\x1b[?25l');
    }

    function showCursor() {
        if (!cursorHidden) return;
        cursorHidden = false;
        control.writeAnsi('\x1b[?25h');
    }

    function clearViewport() {
        control.clearViewport();
    }

    function rewriteLiveRegion(lines, options = {}) {
        const normalizedLines = normalizeLines(lines);
        const clearViewportOnFirstRender = options.clearViewportOnFirstRender === true;
        const hadLiveRegion = liveLineCount > 0;

        if (hadLiveRegion) {
            control.moveToLineStart(liveLineCount);
        } else if (clearViewportOnFirstRender) {
            control.clearViewport();
        }

        for (let index = 0; index < normalizedLines.length; index += 1) {
            const line = normalizedLines[index];
            const previousLine = liveLines[index];
            if (hadLiveRegion && previousLine === line) {
                control.moveToNextLine();
                continue;
            }

            if (!hadLiveRegion || previousLine == null) {
                control.clearCurrentLine();
            } else {
                control.cursorTo(0);
            }
            writeChunk(line);
            if (hadLiveRegion && previousLine != null) {
                const trailingSpaces = Math.max(0, visibleLength(previousLine) - visibleLength(line));
                if (trailingSpaces > 0) {
                    writeChunk(' '.repeat(trailingSpaces));
                }
            }
            writeChunk('\n');
        }

        if (liveLineCount > normalizedLines.length) {
            control.clearCurrentLine();
            control.clearScreenDown();
        }

        liveLineCount = normalizedLines.length;
        liveLines = normalizedLines.slice();
        return liveLineCount;
    }

    function renderLive(lines, options = {}) {
        hideCursor();
        return rewriteLiveRegion(lines, options);
    }

    function clearLive() {
        if (liveLineCount > 0) {
            control.moveToLineStart(liveLineCount);
            control.clearScreenDown();
            liveLineCount = 0;
            liveLines = [];
        }
        showCursor();
        return 0;
    }

    function renderScreen(content, options = {}) {
        const clearViewport = options.clearViewport !== false;
        clearLive();
        const output = [];
        if (clearViewport) {
            control.clearViewport();
        } else {
            control.cursorTo(0);
        }
        output.push(String(content || ''));
        if (!String(content || '').endsWith('\n')) {
            output.push('\n');
        }
        writeChunk(output.join(''));
        showCursor();
        return 0;
    }

    function preparePrompt() {
        clearLive();
        control.cursorTo(0);
        showCursor();
    }

    function dispose() {
        clearLive();
        showCursor();
        if (control.supportsRawAnsi) {
            writeChunk('\x1b[0m');
        }
    }

    function installProcessCleanupHandlers(processRef = process) {
        if (cleanupInstalled || !processRef || typeof processRef.on !== 'function') {
            return () => {};
        }

        const onExit = () => {
            dispose();
        };
        const onSigterm = () => {
            dispose();
            if (typeof processRef.exit === 'function') {
                processRef.exit(143);
            }
        };

        processRef.on('exit', onExit);
        processRef.on('SIGTERM', onSigterm);

        cleanupHandlers = { processRef, onExit, onSigterm };
        cleanupInstalled = true;

        return uninstallProcessCleanupHandlers;
    }

    function uninstallProcessCleanupHandlers() {
        if (!cleanupInstalled || !cleanupHandlers) return;
        const { processRef, onExit, onSigterm } = cleanupHandlers;
        if (typeof processRef.off === 'function') {
            processRef.off('exit', onExit);
            processRef.off('SIGTERM', onSigterm);
        } else if (typeof processRef.removeListener === 'function') {
            processRef.removeListener('exit', onExit);
            processRef.removeListener('SIGTERM', onSigterm);
        }
        cleanupHandlers = null;
        cleanupInstalled = false;
    }

    return {
        clearViewport,
        clearLive,
        dispose,
        hideCursor,
        installProcessCleanupHandlers,
        preparePrompt,
        renderLive,
        renderScreen,
        showCursor,
        uninstallProcessCleanupHandlers
    };
}

const sharedSession = createTerminalSession();

module.exports = {
    createTerminalControl,
    createTerminalSession,
    clearViewport: (...args) => sharedSession.clearViewport(...args),
    clearLive: (...args) => sharedSession.clearLive(...args),
    dispose: (...args) => sharedSession.dispose(...args),
    hideCursor: (...args) => sharedSession.hideCursor(...args),
    installProcessCleanupHandlers: (...args) => sharedSession.installProcessCleanupHandlers(...args),
    preparePrompt: (...args) => sharedSession.preparePrompt(...args),
    renderLive: (...args) => sharedSession.renderLive(...args),
    renderScreen: (...args) => sharedSession.renderScreen(...args),
    showCursor: (...args) => sharedSession.showCursor(...args),
    uninstallProcessCleanupHandlers: (...args) => sharedSession.uninstallProcessCleanupHandlers(...args)
};
