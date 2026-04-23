const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');

const {
    createTerminalSession
} = require('../src/terminal/terminal_session');

test('terminal session clears live output before rendering a static screen and preparing a prompt', () => {
    const writes = [];
    const session = createTerminalSession({
        isTTY: true,
        supportsRawAnsi: true,
        write(chunk) {
            writes.push(String(chunk));
            return true;
        }
    });

    session.renderLive(['first line', 'second line'], { clearViewportOnFirstRender: true });
    session.renderScreen('STATIC SCREEN');
    session.preparePrompt();

    const output = writes.join('');
    assert.match(output, /\x1b\[\?25l/);
    assert.match(output, /\x1b\[2J\x1b\[H/);
    assert.match(output, /\x1b\[2F\x1b\[J\x1b\[\?25h/);
    assert.match(output, /STATIC SCREEN\n/);
    assert.match(output, /\x1b\[1G$/);
});

test('terminal session cleanup is idempotent once live output is already cleared', () => {
    const writes = [];
    const session = createTerminalSession({
        isTTY: true,
        supportsRawAnsi: true,
        write(chunk) {
            writes.push(String(chunk));
            return true;
        }
    });

    session.renderLive(['only line'], { clearViewportOnFirstRender: true });
    const writeCountBeforeClear = writes.length;
    session.clearLive();
    const writeCountAfterFirstClear = writes.length;
    session.clearLive();

    assert.ok(writeCountAfterFirstClear > writeCountBeforeClear);
    assert.equal(writes.length, writeCountAfterFirstClear);
});

test('terminal session prefers tty cursor APIs over raw ANSI when available', () => {
    const calls = [];
    const stream = {
        isTTY: true,
        write(chunk) {
            calls.push(['write', String(chunk)]);
            return true;
        },
        cursorTo(x, y) {
            calls.push(['cursorTo', x, y]);
            return true;
        },
        moveCursor(dx, dy) {
            calls.push(['moveCursor', dx, dy]);
            return true;
        },
        clearLine(dir) {
            calls.push(['clearLine', dir]);
            return true;
        },
        clearScreenDown() {
            calls.push(['clearScreenDown']);
            return true;
        }
    };
    const session = createTerminalSession({
        stream,
        supportsRawAnsi: false
    });

    session.renderLive(['first line', 'second line'], { clearViewportOnFirstRender: true });
    session.renderLive(['short']);
    session.clearLive();

    assert.deepEqual(calls.slice(0, 2), [
        ['cursorTo', 0, 0],
        ['clearScreenDown']
    ]);
    assert.ok(calls.some(call => call[0] === 'moveCursor' && call[1] === 0 && call[2] === -2));
    assert.ok(calls.some(call => call[0] === 'clearLine' && call[1] === 0));
    assert.ok(calls.some(call => call[0] === 'write' && call[1] === 'short'));
    assert.equal(calls.filter(call => call[0] === 'write').some(call => /\x1b\[/u.test(call[1])), false);
});

test('terminal session skips unchanged live lines to reduce redraw flicker', () => {
    const calls = [];
    const stream = {
        isTTY: true,
        write(chunk) {
            calls.push(['write', String(chunk)]);
            return true;
        },
        cursorTo(x, y) {
            calls.push(['cursorTo', x, y]);
            return true;
        },
        moveCursor(dx, dy) {
            calls.push(['moveCursor', dx, dy]);
            return true;
        },
        clearLine(dir) {
            calls.push(['clearLine', dir]);
            return true;
        },
        clearScreenDown() {
            calls.push(['clearScreenDown']);
            return true;
        }
    };
    const session = createTerminalSession({
        stream,
        supportsRawAnsi: false
    });

    session.renderLive(['TOP BORDER', 'spinner 1']);
    calls.length = 0;
    session.renderLive(['TOP BORDER', 'spinner 2']);

    const topBorderWrites = calls.filter(call => call[0] === 'write' && call[1] === 'TOP BORDER');
    assert.equal(topBorderWrites.length, 0);
    assert.ok(calls.some(call => call[0] === 'moveCursor' && call[1] === 0 && call[2] === 1));
    assert.equal(calls.some(call => call[0] === 'clearLine'), false);
    assert.ok(calls.some(call => call[0] === 'write' && call[1] === 'spinner 2'));
});

test('terminal session pads shortened changed live lines without clearing', () => {
    const calls = [];
    const stream = {
        isTTY: true,
        write(chunk) {
            calls.push(['write', String(chunk)]);
            return true;
        },
        cursorTo(x, y) {
            calls.push(['cursorTo', x, y]);
            return true;
        },
        moveCursor(dx, dy) {
            calls.push(['moveCursor', dx, dy]);
            return true;
        },
        clearLine(dir) {
            calls.push(['clearLine', dir]);
            return true;
        },
        clearScreenDown() {
            calls.push(['clearScreenDown']);
            return true;
        }
    };
    const session = createTerminalSession({
        stream,
        supportsRawAnsi: false
    });

    session.renderLive(['spinner long']);
    calls.length = 0;
    session.renderLive(['short']);

    assert.equal(calls.some(call => call[0] === 'clearLine'), false);
    assert.ok(calls.some(call => call[0] === 'write' && call[1] === 'short'));
    assert.ok(calls.some(call => call[0] === 'write' && call[1] === ' '.repeat('spinner long'.length - 'short'.length)));
});

test('terminal session does not emit raw ANSI on Windows TTY without VT support', () => {
    const writes = [];
    const session = createTerminalSession({
        isTTY: true,
        platform: 'win32',
        env: {},
        write(chunk) {
            writes.push(String(chunk));
            return true;
        }
    });

    session.renderLive(['first', 'second'], { clearViewportOnFirstRender: true });
    session.renderScreen('next');
    session.dispose();

    assert.equal(/\x1b\[/u.test(writes.join('')), false);
    assert.match(writes.join(''), /first\nsecond\nnext\n/);
});

test('terminal session process cleanup restores live region and cursor on exit', () => {
    const writes = [];
    const processRef = new EventEmitter();
    processRef.exit = code => {
        processRef.exitCode = code;
    };
    const session = createTerminalSession({
        isTTY: true,
        supportsRawAnsi: true,
        write(chunk) {
            writes.push(String(chunk));
            return true;
        }
    });

    const uninstall = session.installProcessCleanupHandlers(processRef);
    session.renderLive(['working'], { clearViewportOnFirstRender: true });
    processRef.emit('exit');
    uninstall();

    const output = writes.join('');
    assert.match(output, /\x1b\[1F\x1b\[J/);
    assert.match(output, /\x1b\[\?25h/);
    assert.match(output, /\x1b\[0m$/);
});
