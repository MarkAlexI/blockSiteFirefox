export class StatisticsManager {
  static defaultStats = {
    totalBlocked: 0,
    blockedToday: 0,
    totalRedirects: 0,
    redirectsToday: 0,
    lastResetDate: new Date().toDateString(),
    createdDate: new Date().toISOString()
  };
  
  static async getStatistics() {
    try {
      const result = await browser.storage.local.get(['statistics']);
      
      if (!result.statistics) {
        await browser.storage.local.set({ statistics: this.defaultStats });
        return this.defaultStats;
      }
      
      const stats = { ...this.defaultStats, ...result.statistics };
      
      const today = new Date().toDateString();
      if (stats.lastResetDate !== today) {
        stats.blockedToday = 0;
        stats.redirectsToday = 0;
        stats.lastResetDate = today;
        await browser.storage.local.set({ statistics: stats });
      }
      
      return stats;
    } catch (error) {
      console.error('Error getting statistics:', error);
      return this.defaultStats;
    }
  }
  
  static async recordBlock(url = '') {
    try {
      const stats = await this.getStatistics();
      
      stats.totalBlocked = (stats.totalBlocked || 0) + 1;
      stats.blockedToday = (stats.blockedToday || 0) + 1;
      
      await browser.storage.local.set({ statistics: stats });
      
      console.log(`Block recorded: ${url}. Total: ${stats.totalBlocked}, Today: ${stats.blockedToday}`);
      return stats;
    } catch (error) {
      console.error('Error recording block:', error);
      return await this.getStatistics();
    }
  }
  
  static async recordRedirect(fromUrl = '', toUrl = '') {
    try {
      const stats = await this.getStatistics();
      
      stats.totalRedirects = (stats.totalRedirects || 0) + 1;
      stats.redirectsToday = (stats.redirectsToday || 0) + 1;
      
      await browser.storage.local.set({ statistics: stats });
      
      console.log(`Redirect recorded: ${fromUrl} -> ${toUrl}. Total: ${stats.totalRedirects}, Today: ${stats.redirectsToday}`);
      return stats;
    } catch (error) {
      console.error('Error recording redirect:', error);
      return await this.getStatistics();
    }
  }
  
  static async getUIData() {
    try {
      const stats = await this.getStatistics();
      const rulesResult = await browser.storage.sync.get(['rules']);
      const totalRules = rulesResult.rules?.length || 0;
      
      return {
        totalRules,
        totalBlocked: stats.totalBlocked,
        blockedToday: stats.blockedToday,
        totalRedirects: stats.totalRedirects,
        redirectsToday: stats.redirectsToday
      };
    } catch (error) {
      console.error('Error getting UI data:', error);
      return {
        totalRules: 0,
        totalBlocked: 0,
        blockedToday: 0,
        totalRedirects: 0,
        redirectsToday: 0
      };
    }
  }
  
  static async reset() {
    try {
      const newStats = {
        ...this.defaultStats,
        createdDate: new Date().toISOString()
      };
      await browser.storage.local.set({ statistics: newStats });
      return newStats;
    } catch (error) {
      console.error('Error resetting statistics:', error);
      throw error;
    }
  }
}