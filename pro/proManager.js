export class ProManager {
  static RESTRICTION_START_DATE = '2026-12-14T00:00:00Z';
  
  static defaultCredentials = {
    isPro: false,
    subscriptionEmail: null,
    subscriptionDate: null,
    expiryDate: null,
    licenseKey: null,
    isLegacyUser: true,
    installationDate: null
  };
  
  static get hasDOM() {
    return typeof document !== 'undefined' && document !== null;
  }
  
  static async isPro() {
    try {
      const result = await browser.storage.sync.get(['credentials']);
      
      if (!result.credentials) {
        await browser.storage.sync.set({ credentials: this.defaultCredentials });
        return false;
      }
      
      const credentials = { ...this.defaultCredentials, ...result.credentials };
      
      return credentials.isPro === true;
    } catch (error) {
      console.error('Error checking Pro status:', error);
      return false;
    }
  }
  
  static async isLegacyUser() {
    try {
      const credentials = await this.getCredentials();
      if (credentials.installationDate) {
        return new Date(credentials.installationDate) < new Date(this.RESTRICTION_START_DATE);
      }
      return true;
    } catch (error) {
      console.info('Error checking legacy status:', error);
      return true;
    }
  }
  
  static async getCredentials() {
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
      console.error('Error getting credentials:', error);
      return this.defaultCredentials;
    }
  }
  
  static async updateProStatus(isPro, subscriptionData = {}) {
    try {
      const currentCredentials = await this.getCredentials();
      
      const updatedCredentials = {
        ...currentCredentials,
        isPro: isPro,
        subscriptionEmail: isPro ? (subscriptionData.subscriptionEmail || currentCredentials.subscriptionEmail) : null,
        subscriptionDate: isPro ? (subscriptionData.subscriptionDate || currentCredentials.subscriptionDate) : null,
        expiryDate: isPro ? (subscriptionData.expiryDate || currentCredentials.expiryDate) : null,
        licenseKey: isPro ? (subscriptionData.licenseKey || currentCredentials.licenseKey) : null,
        
        isLegacyUser: subscriptionData.isLegacyUser !== undefined ? subscriptionData.isLegacyUser : currentCredentials.isLegacyUser,
        installationDate: subscriptionData.installationDate || currentCredentials.installationDate
      };
      
      await browser.storage.sync.set({ credentials: updatedCredentials });
      
      if (this.hasDOM) {
        this.updateProFeaturesVisibility(isPro);
      }
      
      this.notifyProStatusChange(isPro);
      
      return updatedCredentials;
    } catch (error) {
      console.error('Error updating Pro status:', error);
      throw error;
    }
  }
  
  static updateProFeaturesVisibility(isPro) {
    if (!this.hasDOM) {
      console.log(`Pro status updated to: ${isPro} (no DOM available)`);
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
      
      console.log(`Pro features ${isPro ? 'enabled' : 'disabled'}`);
    } catch (error) {
      console.error('Error updating Pro features visibility:', error);
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
      console.error('Error notifying Pro status change:', error);
    }
  }
  
  static async initializeProFeatures() {
    try {
      const isPro = await this.isPro();
      if (this.hasDOM) {
        this.updateProFeaturesVisibility(isPro);
      }
      return isPro;
    } catch (error) {
      console.error('Error initializing Pro features:', error);
      return false;
    }
  }
  
  static async setProStatusFromWorker(isPro, subscriptionData = {}) {
    try {
      console.log(`Service worker updating Pro status to: ${isPro}`);
      return await this.updateProStatus(isPro, subscriptionData);
    } catch (error) {
      console.error('Error updating Pro status from service worker:', error);
      throw error;
    }
  }
}