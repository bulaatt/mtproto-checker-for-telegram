const checker = require('./src/checker');
const menu = require('./src/cli/terminal_menu');

module.exports = checker;

if (require.main === module) {
    menu.runCli();
}
