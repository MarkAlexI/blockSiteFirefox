import Logger from '../utils/logger.js';

export class StatisticsManager {
  static logger = new Logger('StatisticsManager');
  
  static defaultStats = {
    totalBlocked: 0,
    blockedToday: 0,
    totalRedirects: 0,
    redirectsToday: 0,
    successfulFocusSessions: 0,
    creationDate: new Date().toDateString(),
    lastResetDate: new Date().toDateString()
  };
  
  static async getStatistics() {
    try {
      const result = await browser.storage.local.get(['statistics']);
      if (!result.statistics) {
        await browser.storage.local.set({ statistics: this.defaultStats });
        return this.defaultStats;
      }
      return result.statistics;
    } catch (error) {
      this.logger.error('Error getting statistics:', error);
      return this.defaultStats;
    }
  }
  
  static async _updateStats(updateFn) {
    try {
      let stats = await this.getStatistics();
      const today = new Date().toDateString();
      
      if (stats.lastResetDate !== today) {
        stats.blockedToday = 0;
        stats.redirectsToday = 0;
        stats.lastResetDate = today;
      }
      
      stats = updateFn(stats);
      
      await browser.storage.local.set({ statistics: stats });
    } catch (error) {
      this.logger.error('Error updating statistics:', error);
    }
  }
  
  static async recordBlock(url) {
    await this._updateStats(stats => {
      stats.totalBlocked = (stats.totalBlocked || 0) + 1;
      stats.blockedToday = (stats.blockedToday || 0) + 1;
      this.logger.log(`Block recorded for ${url}. Today: ${stats.blockedToday}, Total: ${stats.totalBlocked}`);
      return stats;
    });
  }
  
  static async recordRedirect(from, to) {
    await this._updateStats(stats => {
      stats.totalRedirects = (stats.totalRedirects || 0) + 1;
      stats.redirectsToday = (stats.redirectsToday || 0) + 1;
      this.logger.log(`Redirect recorded from ${from} to ${to}. Today: ${stats.redirectsToday}, Total: ${stats.totalRedirects}`);
      return stats;
    });
  }
  
  static async recordFocusSession() {
    await this._updateStats(stats => {
      stats.successfulFocusSessions = (stats.successfulFocusSessions || 0) + 1;
      this.logger.log(`Successful focus session recorded. Total: ${stats.successfulFocusSessions}`);
      return stats;
    });
  }
  
  static async reset() {
    try {
      const stats = await this.getStatistics();
      const newStats = { ...this.defaultStats, creationDate: stats.creationDate, lastResetDate: new Date().toDateString() };
      await browser.storage.local.set({ statistics: newStats });
      this.logger.log('Statistics reset.');
    } catch (error) {
      this.logger.error('Error resetting statistics:', error);
    }
  }
}