export class PasswordUtils {
  static async hashPassword(password, salt = null) {
    if (!salt) {
      salt = crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
    }
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
    );
    const hashBuffer = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' },
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

    title.textContent = type === 'set' ? t('setpassword') : t('enterpassword');
    input2.classList.toggle('hidden', type !== 'set');
    forgot.classList.toggle('hidden', type !== 'set');
    modal.classList.remove('hidden');

    const closeModal = () => {
      modal.classList.add('hidden');
      input1.value = input2.value = '';
      error.classList.add('hidden');
    };

    cancelBtn.onclick = closeModal;

    confirmBtn.onclick = async () => {
      error.classList.add('hidden');
      const pass1 = input1.value;
      if (type === 'set') {
        const pass2 = input2.value;
        if (pass1 !== pass2) {
          error.textContent = t('passwordmismatch');
          error.classList.remove('hidden');
          return;
        }
        if (pass1.length < 6) {
          error.textContent = t('passwordtooshort');
          error.classList.remove('hidden');
          return;
        }
        const hash = await this.hashPassword(pass1);
        callback(hash);
        closeModal();
      } else {
        const settings = await browser.storage.sync.get(['settings']);
        const isValid = await this.verifyPassword(pass1, settings.settings.passwordHash);
        callback(isValid);
        closeModal();
      }
    };

    forgot.onclick = async () => {
      if (confirm(t('resetpasswordconfirm'))) {
        const settings = await browser.storage.sync.get(['settings']);
        settings.settings.enablePassword = false;
        settings.settings.passwordHash = null;
        await browser.storage.sync.set({ settings });
        document.getElementById('enablePassword').checked = false;
        callback(null);
        closeModal();
      }
    };
  }
}