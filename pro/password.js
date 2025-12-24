export class PasswordUtils {
  static async hashPassword(password, salt = null) {
    if (!salt) {
      salt = crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
    }
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
    );
    const hashBuffer = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' },
      key, 256
    );
    const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${salt}:${hash}`;
  }
  
  static async verifyPassword(input, storedHash) {
    if (!storedHash) return false;
    const [salt, hash] = storedHash.split(':');
    const newHash = await this.hashPassword(input, salt);
    return newHash === storedHash;
  }
  
  static showPasswordModal(type, callback, t) {
    const modal = document.getElementById('passwordModal');
    const title = document.getElementById('modalTitle');
    const input1 = document.getElementById('passwordInput1');
    const input2 = document.getElementById('passwordInput2');
    const error = document.getElementById('passwordError');
    const forgot = document.getElementById('forgotPassword');
    const confirmBtn = document.getElementById('confirmPassword');
    const cancelBtn = document.getElementById('cancelPassword');

    input1.type = 'password';
    input1.value = '';
    input1.placeholder = t('enterpassword') || 'Enter password';
    input2.value = '';
    error.classList.add('hidden');

    title.textContent = type === 'set' ? t('setpassword') : t('enterpassword');
    confirmBtn.textContent = t('modalconfirm');

    input2.style.display = (type === 'set') ? 'block' : 'none';

    forgot.style.display = (type === 'set') ? 'none' : 'block';
    
    modal.classList.remove('hidden');
    input1.focus();
    
    const closeModal = () => {
      modal.classList.add('hidden');
      input1.value = input2.value = '';
      error.classList.add('hidden');

      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      forgot.onclick = null;
      input1.onkeydown = null;
    };
    
    cancelBtn.onclick = closeModal;

    input1.onkeydown = (e) => {
      if (e.key === 'Enter') confirmBtn.click();
      if (e.key === 'Escape') closeModal();
    };

    confirmBtn.onclick = async () => {
      error.classList.add('hidden');
      const val1 = input1.value.trim();
      
      if (type === 'set') {
        const val2 = input2.value.trim();
        if (val1 !== val2) {
          error.textContent = t('passwordmismatch') || 'Passwords do not match';
          error.classList.remove('hidden');
          return;
        }
        if (val1.length < 6) {
          error.textContent = t('passwordtooshort') || 'Password too short';
          error.classList.remove('hidden');
          return;
        }
        const hash = await this.hashPassword(val1);
        callback(hash);
        closeModal();
      } else {
        const settings = await browser.storage.sync.get(['settings']);
        const storedHash = settings.settings ? settings.settings.passwordHash : null;
        const isValid = await this.verifyPassword(val1, storedHash);
        
        if (!isValid) {
          error.textContent = t('invalidpassword') || 'Invalid password';
          error.classList.remove('hidden');
          input1.classList.add('shake');
          setTimeout(() => input1.classList.remove('shake'), 500);
          return;
        }
        
        callback(true);
        closeModal();
      }
    };

    forgot.onclick = (e) => {
      e.preventDefault();

      title.textContent = t('restoreaccess');
      input1.value = '';
      input1.type = 'text';
      input1.placeholder = 'License Key (BD-PRO-...)';
      forgot.style.display = 'none';
      error.classList.add('hidden');
      confirmBtn.textContent = t('restoreaccess');

      confirmBtn.onclick = async () => {
        const enteredKey = input1.value.trim();
        if (!enteredKey) return;

        const storage = await browser.storage.sync.get(['credentials', 'settings']);
        const actualKey = storage.credentials?.licenseKey;
        
        if (actualKey && enteredKey === actualKey) {
          const newSettings = {
            ...storage.settings,
            enablePassword: false,
            passwordHash: null
          };
          
          await browser.storage.sync.set({ settings: newSettings });
          
          alert(t('passwordreset') || 'Password protection has been reset.');
          window.location.reload();
        } else {
          error.textContent = t('subscriptionnotfound') || 'Invalid License Key';
          error.classList.remove('hidden');
        }
      };
    };
  }
}