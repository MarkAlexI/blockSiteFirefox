function send(runtimeApi, payload) {
  try {
    const result = runtimeApi.sendMessage({ type: 'telemetry:recordError', payload });
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    // Error telemetry must never interfere with the extension page itself.
  }
}

export function installPageErrorReporter(source, {
  runtimeApi = globalThis.browser?.runtime,
  globalRef = globalThis
} = {}) {
  if (!runtimeApi?.sendMessage || !globalRef?.addEventListener) return () => {};

  const onError = event => {
    send(runtimeApi, {
      source,
      code: 'uncaught_error',
      operation: 'page_runtime',
      errorName: event?.error?.name || 'Error'
    });
  };

  const onUnhandledRejection = event => {
    const reason = event?.reason;
    send(runtimeApi, {
      source,
      code: 'unhandled_rejection',
      operation: 'page_runtime',
      errorName: reason?.name || 'Error'
    });
  };

  globalRef.addEventListener('error', onError);
  globalRef.addEventListener('unhandledrejection', onUnhandledRejection);

  return () => {
    globalRef.removeEventListener?.('error', onError);
    globalRef.removeEventListener?.('unhandledrejection', onUnhandledRejection);
  };
}
