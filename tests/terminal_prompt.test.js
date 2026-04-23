const test = require('node:test');
const assert = require('node:assert/strict');
const readlineSync = require('readline-sync');
const terminalSession = require('../src/terminal/terminal_session');

test('terminal prompt writes unicode prompt through stdout and reads with empty readline-sync display', () => {
    const prompt = require('../src/terminal/terminal_prompt');
    const originalQuestion = readlineSync.question;
    const originalWrite = process.stdout.write;
    const originalPreparePrompt = terminalSession.preparePrompt;
    const writes = [];
    const readlinePrompts = [];
    let prepareCalls = 0;

    try {
        readlineSync.question = display => {
            readlinePrompts.push(display);
            return '7';
        };
        process.stdout.write = chunk => {
            writes.push(String(chunk));
            return true;
        };
        terminalSession.preparePrompt = () => {
            prepareCalls += 1;
            process.stdout.write('\r');
        };

        const answer = prompt.question('Выберите действие [1-8]: ');

        assert.equal(answer, '7');
        assert.deepEqual(readlinePrompts, ['']);
        assert.equal(prepareCalls, 1);
        assert.equal(writes.join(''), '\rВыберите действие [1-8]: ');
    } finally {
        readlineSync.question = originalQuestion;
        process.stdout.write = originalWrite;
        terminalSession.preparePrompt = originalPreparePrompt;
    }
});
