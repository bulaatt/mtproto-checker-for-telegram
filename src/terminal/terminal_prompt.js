const readlineSync = require('readline-sync');
const terminalSession = require('./terminal_session');

function question(promptText) {
    const prompt = String(promptText || '');
    terminalSession.preparePrompt();
    if (prompt) {
        process.stdout.write(prompt);
    }

    return readlineSync.question('');
}

module.exports = {
    question
};
