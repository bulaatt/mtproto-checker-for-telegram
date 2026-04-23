function createCancelledError() {
    const error = new Error('CANCELLED');
    error.isUserCancelled = true;
    return error;
}

function createCancelState() {
    return {
        cancelled: false,
        listeners: new Set()
    };
}

function isUserCancelledError(error) {
    return Boolean(
        error &&
        (error.isUserCancelled === true || error.message === 'CANCELLED')
    );
}

function throwIfCancelled(cancelState) {
    if (cancelState && cancelState.cancelled) {
        throw createCancelledError();
    }
}

function addCancelListener(cancelState, listener) {
    if (!cancelState) return () => {};
    if (!cancelState.listeners) {
        cancelState.listeners = new Set();
    }
    if (cancelState.cancelled) {
        try {
            listener();
        } catch (_) {}
        return () => {};
    }

    cancelState.listeners.add(listener);
    return () => {
        if (cancelState.listeners) {
            cancelState.listeners.delete(listener);
        }
    };
}

function requestCancel(cancelState) {
    if (!cancelState || cancelState.cancelled) return false;
    cancelState.cancelled = true;
    const listeners = cancelState.listeners ? [...cancelState.listeners] : [];
    for (const listener of listeners) {
        try {
            listener();
        } catch (_) {}
    }
    return true;
}

function isSafeCancelEnabled(options = {}) {
    void options;
    return false;
}

function bindCancelToSigint(cancelState, options = {}) {
    void cancelState;
    void options;
    return () => {};
}

module.exports = {
    addCancelListener,
    bindCancelToSigint,
    createCancelledError,
    createCancelState,
    isSafeCancelEnabled,
    isUserCancelledError,
    requestCancel,
    throwIfCancelled
};
