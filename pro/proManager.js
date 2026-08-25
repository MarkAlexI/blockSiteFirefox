import Logger from '../utils/logger.js';

export class ProManager {
  static RESTRICTION_START_DATE = '2026-01-01T00:00:00Z';
  
  static logger = new Logger('ProManager');
  
  static defaultCredentials = {
    isPro: false,
    subscriptionEmail: null,
    subscriptionDate: null,
    expiryDate: null,
    licenseKey: null,
    isLegacyUser: false,
    installationDate: null
  };
  
  static get hasDOM() {
    return typeof document !== 'undefined' && document !== null;
  }

  static resolveLegacyAccess(credentials) {
    if (credentials.installationDate) {
      return new Date(credentials.installationDate) < new Date(this.RESTRICTION_START_DATE);
    }
    return true;
  }

  static async getAccess() {
    const credentials = await this.getCredentials({ throwOnError: true });
    return {
      credentials,
      isPro: credentials.isPro === true,
      isLegacyUser: this.resolveLegacyAccess(credentials)
    };
  }

  static async hasPaidAccess() {
    try {
      const access = await this.getAccess();
      return access.isPro || access.isLegacyUser;
    } catch (error) {
      this.logger.info('Error checking paid feature access:', error);
      return false;
    }
  }
  
  static async isPro() {
    try {
      return (await this.getAccess()).isPro;
    } catch (error) {
      this.logger.error('Error checking Pro status:', error);
      return false;
    }
  }
  
  static async isLegacyUser() {
    try {
      return (await this.getAccess()).isLegacyUser;
    } catch (error) {
      this.logger.info('Error checking legacy status:', error);
      return false;
    }
  }
  
  static async getCredentials({ throwOnError = false } = {}) {
    try {
      const result = await browser.storage.sync.get(['credentials']);
      
      if (!result.credentials) {
        const newCredentials = { ...this.defaultCredentials, installationDate: new Date().toISOString() };
        newCredentials.isLegacyUser = new Date() < new Date(this.RESTRICTION_START_DATE);
        await browser.storage.sync.set({ credentials: newCredentials });
        return newCredentials;
      }
      
      return { ...this.defaultCredentials, ...result.credentials };
    } catch (error) {
      this.logger.error('Error getting credentials:', error);
      if (throwOnError) throw error;
      return this.defaultCredentials;
    }
  }
  
  static async updateProStatus(isPro, subscriptionData = {}) {
    try {
      if (typeof isPro !== 'boolean') {
        throw new TypeError('Pro status must be an explicit boolean');
      }

      const currentCredentials = await this.getCredentials({ throwOnError: true });
      
      const updatedCredentials = {
        ...currentCredentials,
        isPro: isPro,
        subscriptionEmail: isPro ? (subscriptionData.subscriptionEmail || currentCredentials.subscriptionEmail) : null,
        subscriptionDate: isPro ? (subscriptionData.subscriptionDate || currentCredentials.subscriptionDate) : null,
        expiryDate: isPro ? (subscriptionData.expiryDate || currentCredentials.expiryDate) : null,
        licenseKey: isPro ? (subscriptionData.licenseKey || currentCredentials.licenseKey) : null,
        
        isLegacyUser: currentCredentials.isLegacyUser,
        installationDate: currentCredentials.installationDate
      };
      
      await browser.storage.sync.set({ credentials: updatedCredentials });
      
      if (this.hasDOM) {
        this.updateProFeaturesVisibility(isPro || this.resolveLegacyAccess(updatedCredentials));
      }
      
      this.notifyProStatusChange(isPro);
      
      return updatedCredentials;
    } catch (error) {
      this.logger.error('Error updating Pro status:', error);
      throw error;
    }
  }
  
  static updateProFeaturesVisibility(isPro) {
    if (!this.hasDOM) {
      this.logger.log(`Pro status updated to: ${isPro} (no DOM available)`);
      return;
    }
    
    try {
      const proFeatures = document.querySelectorAll('.pro-feature');
      
      proFeatures.forEach(element => {
        if (isPro) {
          element.classList.remove('hidden');
        } else {
          element.classList.add('hidden');
        }
      });
      
      this.logger.log(`Pro features ${isPro ? 'enabled' : 'disabled'}`);
    } catch (error) {
      this.logger.error('Error updating Pro features visibility:', error);
    }
  }
  
  static async notifyProStatusChange(isPro) {
    try {
      browser.runtime.sendMessage({
        type: 'pro_status_changed',
        isPro: isPro
      }).catch(() => {
        
      });
      
    } catch (error) {
      this.logger.error('Error notifying Pro status change:', error);
    }
  }
  
  static async initializeProFeatures() {
    try {
      const hasPaidAccess = await this.hasPaidAccess();
      if (this.hasDOM) {
        this.updateProFeaturesVisibility(hasPaidAccess);
      }
      return hasPaidAccess;
    } catch (error) {
      this.logger.error('Error initializing Pro features:', error);
      return false;
    }
  }
  
  static async setProStatusFromWorker(isPro, subscriptionData = {}) {
    try {
      this.logger.log(`Service worker updating Pro status to: ${isPro}`);
      return await this.updateProStatus(isPro, subscriptionData);
    } catch (error) {
      this.logger.error('Error updating Pro status from service worker:', error);
      throw error;
    }
  }
}
