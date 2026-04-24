const checker = require('./src/checker');

module.exports = checker;

if (require.main === module) {
    checker.runCli();
}
