#!/usr/bin/env node

const menu = require('./src/cli/terminal_menu');

module.exports = menu;

if (require.main === module) {
    menu.runCli();
}
