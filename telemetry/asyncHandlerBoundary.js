export const ASYNC_HANDLER_OPERATIONS = Object.freeze({
  CONTEXT_MENU_ADD: 'add',
  TAB_UPDATED: 'tab_updated',
  TAB_CREATED: 'tab_created',
  STARTUP: 'startup',
  INSTALL: 'install',
  UPDATE: 'update',
  CHROME_UPDATE: 'chrome_update',
  BROWSER_UPDATE: 'browser_update',
  SHARED_MODULE_UPDATE: 'shared_module_update',
  PERMISSION_REMOVED: 'permission_removed',
  PERMISSION_ADDED: 'permission_added',
  SCHEDULED_ALARM: 'scheduled_alarm',
  DAILY_LIMIT_ALARM: 'daily_limit_alarm',
  DNR_RELOAD_MESSAGE: 'dnr_reload_message',
  PRO_STATUS_TRANSITION: 'pro_status_transition',
  WINDOW_FOCUS_CHANGED: 'window_focus_changed',
  SERVICE_WORKER: 'service_worker'
});

const ALLOWED_OPERATIONS = new Set(Object.values(ASYNC_HANDLER_OPERATIONS));

export function createAsyncHandlerBoundary({ recordError, logger = console } = {}) {
  if (typeof recordError !== 'function') {
    throw new TypeError('Async handler boundary requires an error recorder');
  }

  return async function runAsyncHandler(operation, handler) {
    if (!ALLOWED_OPERATIONS.has(operation)) {
      throw new TypeError(`Unsupported async handler operation: ${operation}`);
    }
    if (typeof handler !== 'function') {
      throw new TypeError('Async handler boundary requires a function');
    }

    try {
      return await handler();
    } catch (error) {
      logger.error(`Async handler failed (${operation}):`, error);
      try {
        await recordError({
          source: 'worker',
          code: 'async_handler_failed',
          operation,
          errorName: error?.name || 'Error'
        });
      } catch (reportingError) {
        logger.info(`Async handler failure could not be recorded (${operation}):`, reportingError);
      }
      return undefined;
    }
  };
}
