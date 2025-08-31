export class ProManager {
  static defaultCredentials = {
    isPro: false,
    subscriptionEmail: null,
    subscriptionDate: null,
    expiryDate: null
  };

  static async isPro() {
    try {
      const result = await browser.storage.sync.get(['credentials']);
      
      if (!result.credentials) {
        await browser.storage.sync.set({ credentials: this.defaultCredentials });
        return false;
      }
      
      const credentials = { ...this.defaultCredentials, ...result.credentials };

      if (credentials.isPro && credentials.expiryDate) {
        const isExpired = new Date() > new Date(credentials.expiryDate);
        if (isExpired) {
          await this.updateProStatus(false);
          return false;
        }
      }
      
      return credentials.isPro === true;
    } catch (error) {
      console.error('Error checking Pro status:', error);
      return false;
    }
  }

  static async getCredentials() {
    try {
      const result = await browser.storage.sync.get(['credentials']);
      
      if (!result.credentials) {
        await browser.storage.sync.set({ credentials: this.defaultCredentials });
        return this.defaultCredentials;
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
        subscriptionEmail: isPro ? subscriptionData.email || currentCredentials.subscriptionEmail : null,
        subscriptionDate: isPro ? subscriptionData.subscriptionDate || currentCredentials.subscriptionDate : null,
        expiryDate: isPro ? subscriptionData.expiryDate || currentCredentials.expiryDate : null
      };
      
      await browser.storage.sync.set({ credentials: updatedCredentials });

      this.updateProFeaturesVisibility(isPro);
      
      return updatedCredentials;
    } catch (error) {
      console.error('Error updating Pro status:', error);
      throw error;
    }
  }

  static updateProFeaturesVisibility(isPro) {
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

  static async initializeProFeatures() {
    try {
      const isPro = await this.isPro();
      this.updateProFeaturesVisibility(isPro);
      return isPro;
    } catch (error) {
      console.error('Error initializing Pro features:', error);
      return false;
    }
  }
}