const test = require('node:test');
const assert = require('node:assert/strict');

const {
    addCancelListener,
    bindCancelToSigint,
    createCancelState,
    createCancelledError,
    isSafeCancelEnabled,
    isUserCancelledError,
    requestCancel,
    throwIfCancelled
} = require('../src/shared/cancel');

test('requestCancel is idempotent and notifies listeners once', () => {
    const cancelState = createCancelState();
    let calls = 0;

    addCancelListener(cancelState, () => {
        calls += 1;
    });

    requestCancel(cancelState);
    requestCancel(cancelState);

    assert.equal(cancelState.cancelled, true);
    assert.equal(calls, 1);
});

test('addCancelListener invokes listener immediately when already cancelled', () => {
    const cancelState = createCancelState();
    requestCancel(cancelState);

    let calls = 0;
    addCancelListener(cancelState, () => {
        calls += 1;
    });

    assert.equal(calls, 1);
});

test('throwIfCancelled throws the shared cancelled error shape', () => {
    const cancelState = createCancelState();
    requestCancel(cancelState);

    assert.throws(
        () => throwIfCancelled(cancelState),
        error => error.message === 'CANCELLED' && error.isUserCancelled === true
    );
});

test('isUserCancelledError recognizes both shared and legacy cancelled errors', () => {
    const sharedError = createCancelledError();
    const legacyError = new Error('CANCELLED');
    legacyError.isUserCancelled = true;

    assert.equal(isUserCancelledError(sharedError), true);
    assert.equal(isUserCancelledError(legacyError), true);
    assert.equal(isUserCancelledError(new Error('other')), false);
    assert.equal(isUserCancelledError(null), false);
});

test('interactive cancellation is disabled on every platform', () => {
    assert.equal(isSafeCancelEnabled({ platform: 'win32' }), false);
    assert.equal(isSafeCancelEnabled({ platform: 'darwin' }), false);
    assert.equal(isSafeCancelEnabled({ platform: 'linux' }), false);
});

test('bindCancelToSigint does not install a listener on any platform', () => {
    const cancelState = createCancelState();
    const calls = [];
    const processRef = {
        on(signal, listener) {
            calls.push(['on', signal, listener]);
        },
        off(signal, listener) {
            calls.push(['off', signal, listener]);
        }
    };

    const release = bindCancelToSigint(cancelState, {
        platform: 'linux',
        processRef
    });
    release();

    assert.deepEqual(calls, []);
    assert.equal(cancelState.cancelled, false);
});
