import Logger from '../utils/logger.js';
import {
  createDefaultStatistics,
  incrementDailyHistory,
  normalizeStatistics
} from './statisticsHistory.js';

export class StatisticsManager {
  static logger = new Logger('StatisticsManager');
  static defaultStats = createDefaultStatistics();

  static async getStatistics() {
    try {
      const result = await browser.storage.local.get(['statistics']);
      if (!result.statistics) {
        const stats = createDefaultStatistics();
        await browser.storage.local.set({ statistics: stats });
        return stats;
      }

      const normalized = normalizeStatistics(result.statistics);
      if (JSON.stringify(normalized) !== JSON.stringify(result.statistics)) {
        await browser.storage.local.set({ statistics: normalized });
      }
      return normalized;
    } catch (error) {
      this.logger.error('Error getting statistics:', error);
      return createDefaultStatistics();
    }
  }

  static async _updateStats(updateFn) {
    try {
      const now = new Date();
      let stats = normalizeStatistics(await this.getStatistics(), now);
      stats = updateFn(stats, now);
      await browser.storage.local.set({ statistics: stats });
    } catch (error) {
      this.logger.error('Error updating statistics:', error);
    }
  }

  static async recordBlock(url) {
    await this._updateStats((stats, now) => {
      stats = incrementDailyHistory(stats, 'blocked', now);
      stats.totalBlocked += 1;
      stats.blockedToday += 1;
      this.logger.log(`Block recorded for ${url}. Today: ${stats.blockedToday}, Total: ${stats.totalBlocked}`);
      return stats;
    });
  }

  static async recordRedirect(from, to) {
    await this._updateStats((stats, now) => {
      stats = incrementDailyHistory(stats, 'redirected', now);
      stats.totalRedirects += 1;
      stats.redirectsToday += 1;
      this.logger.log(`Redirect recorded from ${from} to ${to}. Today: ${stats.redirectsToday}, Total: ${stats.totalRedirects}`);
      return stats;
    });
  }

  static async recordFocusSession() {
    await this._updateStats((stats, now) => {
      stats.successfulFocusSessions += 1;
      stats = incrementDailyHistory(stats, 'focusSessions', now);
      this.logger.log(`Successful focus session recorded. Total: ${stats.successfulFocusSessions}`);
      return stats;
    });
  }

  static async reset() {
    try {
      const stats = await this.getStatistics();
      const newStats = createDefaultStatistics();
      newStats.creationDate = stats.creationDate;
      await browser.storage.local.set({ statistics: newStats });
      this.logger.log('Statistics reset.');
    } catch (error) {
      this.logger.error('Error resetting statistics:', error);
    }
  }
}
