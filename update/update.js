document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const version = params.get('version') || '–';
  document.getElementById('version').textContent = version;
  
  const features = [
    "📊 Optional Technical Analytics: Privacy-preserving usage counters and error reports can now be enabled from Settings.",
    "🔒 Off by Default: No telemetry is collected until you explicitly opt in.",
    "🧩 Error Fingerprints: Technical failures are aggregated without URLs, raw messages, or stack traces.",
    "🩺 Better Diagnostics: Diagnostic reports now include telemetry queue and delivery status without exposing event contents."
  ];
  
  const ul = document.getElementById('features');
  features.forEach(item => {
    const li = document.createElement('li');
    li.textContent = item;
    ul.append(li);
  });
  
  document.getElementById('privacy-settings-btn')?.addEventListener('click', () => {
    browser.runtime.openOptionsPage?.();
  });

  const closeBtn = document.getElementById('close-btn');
  
  closeBtn.addEventListener('click', () => {
    browser.runtime.sendMessage({
      type: 'close_current_tab'
    });
  });
});