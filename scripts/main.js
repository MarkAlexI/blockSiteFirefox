import { storageUpdateHandler } from './storageUpdateHandler.js';

browser.storage.sync.onChanged.addListener(storageUpdateHandler);