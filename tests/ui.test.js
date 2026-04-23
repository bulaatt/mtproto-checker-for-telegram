const test = require('node:test');
const assert = require('node:assert/strict');

const ui = require('../src/terminal/ui');

function withTerminalColumns(columns, fn) {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    Object.defineProperty(process.stdout, 'columns', {
        configurable: true,
        enumerable: descriptor ? descriptor.enumerable : true,
        writable: true,
        value: columns
    });

    try {
        return fn();
    } finally {
        if (descriptor) {
            Object.defineProperty(process.stdout, 'columns', descriptor);
        } else {
            delete process.stdout.columns;
        }
    }
}

test('wrapText preserves full long paths without dropping characters', () => {
    const input = '/Users/bulat/Documents/MTProto Checker for Telegram/very-long-folder-name/another-long-folder/working_proxies_with_a_really_long_name.txt';
    const wrapped = ui.wrapText(input, 24);
    const reconstructed = wrapped.join('');

    assert.equal(reconstructed, input);
    assert.ok(wrapped.length > 1);
    for (const line of wrapped) {
        assert.ok(ui.visibleLength(line) <= 24);
    }
});

test('renderColumns keeps wrapped column rows within target width', () => {
    const lines = ui.renderColumns([
        { text: '8.', width: 3 },
        { text: 'manual_check_8_proxies_with_a_very_long_name.txt', width: 24 },
        { text: 'Use this proxy list from a long custom location', width: 18 }
    ], { width: 49 });

    assert.ok(lines.length > 1);
    for (const line of lines) {
        assert.ok(ui.visibleLength(line) <= 49);
    }
});

test('renderColumns shrinks gaps and widths to fit very narrow layouts', () => {
    const lines = ui.renderColumns([
        { text: '12.', width: 3, minWidth: 3 },
        { text: 'manual_check_8_proxies_with_a_very_long_name.txt', width: 20, minWidth: 8 },
        { text: 'Suggested proxy list from a deeply nested folder', width: 18, minWidth: 8 }
    ], { width: 24, gap: 2 });

    assert.ok(lines.length > 2);
    for (const line of lines) {
        assert.ok(ui.visibleLength(line) <= 24);
    }
});

test('renderColumns can force single-line truncated columns', () => {
    const lines = ui.renderColumns([
        { text: '7.', width: 3, minWidth: 3, wrap: false },
        { text: 'Refresh proxy list', width: 20, minWidth: 8, wrap: false },
        { text: 'Fetch fresh MTProto source data', width: 24, minWidth: 8, wrap: false }
    ], { width: 40, gap: 1 });

    assert.equal(lines.length, 1);
    assert.ok(ui.visibleLength(lines[0]) <= 40);
    assert.match(lines[0], /…/);
});

test('truncateMiddleText keeps the start and end of long strings', () => {
    const truncated = ui.truncateMiddleText('focus_known_unavailable.txt', 18);

    assert.equal(ui.visibleLength(truncated), 18);
    assert.match(truncated, /^focus_kno….*\.txt$/);
});

test('wrapText avoids a trailing one-word widow when it fits with the previous word', () => {
    const wrapped = ui.wrapText('Fetch fresh MTProto source data safely', 36);

    assert.deepEqual(wrapped, [
        'Fetch fresh MTProto source',
        'data safely'
    ]);
});

test('renderBox flattens nested line groups and keeps borders aligned', () => {
    const panel = ui.renderBox({
        title: 'Choose Proxy List',
        subtitle: 'Pick a validated .txt file with MTProto proxy links',
        width: 50,
        lines: [
            ['1. short', '   wrapped description line that should stay inside'],
            ui.BOX_BREAK,
            `Saved to: /Users/bulat/Documents/MTProto Checker for Telegram/very/long/path/working_proxies_with_a_really_long_name.txt`
        ]
    });

    const rows = panel.split('\n');
    const visibleWidths = rows.map(row => ui.visibleLength(row));
    const uniqueWidths = new Set(visibleWidths);

    assert.equal(uniqueWidths.size, 1);
});

test('getTerminalWidth never exceeds measured terminal width', () => {
    withTerminalColumns(52, () => {
        assert.equal(ui.getTerminalWidth(66, 78), 50);
    });
});

test('renderBox keeps borders aligned on narrow terminals with long content', () => {
    const panel = withTerminalColumns(42, () => ui.renderBox({
        title: 'Choose Proxy List',
        subtitle: 'Pick a validated MTProto source list',
        width: ui.getTerminalWidth(66, 78),
        lines: [
            'Current file: manual_check_8_proxies_with_a_very_long_name.txt',
            'Current proxy entries:',
            '  this-is-a-very-long-proxy-hostname.example.com:443'
        ]
    }));

    const rows = panel.split('\n');
    const visibleWidths = rows.map(row => ui.visibleLength(row));

    assert.ok(rows.length > 5);
    assert.deepEqual(new Set(visibleWidths), new Set([40]));
});

test('clearScreen clears viewport without full terminal reset', () => {
    const originalWrite = process.stdout.write;
    const originalCursorTo = process.stdout.cursorTo;
    const originalClearScreenDown = process.stdout.clearScreenDown;
    const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const writes = [];
    const calls = [];

    try {
        Object.defineProperty(process.stdout, 'isTTY', {
            configurable: true,
            value: true
        });
        process.stdout.write = chunk => {
            writes.push(String(chunk));
            return true;
        };
        process.stdout.cursorTo = (x, y) => {
            calls.push(['cursorTo', x, y]);
            return true;
        };
        process.stdout.clearScreenDown = () => {
            calls.push(['clearScreenDown']);
            return true;
        };

        ui.clearScreen();

        assert.deepEqual(calls, [
            ['cursorTo', 0, 0],
            ['clearScreenDown']
        ]);
        assert.equal(writes.join(''), '');
    } finally {
        process.stdout.write = originalWrite;
        process.stdout.cursorTo = originalCursorTo;
        process.stdout.clearScreenDown = originalClearScreenDown;
        if (isTTYDescriptor) {
            Object.defineProperty(process.stdout, 'isTTY', isTTYDescriptor);
        } else {
            delete process.stdout.isTTY;
        }
    }
});
