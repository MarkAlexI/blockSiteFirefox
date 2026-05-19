import {
  SNOOZE_DURATION_MS,
  INITIAL_DELAY_MS,
  REVIEWS_LINK,
  SUPPORT_LINK
} from '../utils/constants.js';

const storageObj = browser.storage.sync;

export async function initFeedbackPopup() {
  const needsPopup = await shouldShowFeedbackPopup();
  
  if (!needsPopup) return;

  const dialog = document.getElementById('feedback-dialog');
  if (!dialog) return;

  dialog.showModal();

  const closeBtn = document.getElementById('feedback-close-btn');
  const likeBtn = document.getElementById('feedback-like-btn');
  const dislikeBtn = document.getElementById('feedback-dislike-btn');

  closeBtn.addEventListener('click', async () => {
    dialog.close();
    await updateFeedbackStatus(false);
  });

  dialog.addEventListener('click', async (e) => {
    const dialogDimensions = dialog.getBoundingClientRect();
    if (
      e.clientX < dialogDimensions.left ||
      e.clientX > dialogDimensions.right ||
      e.clientY < dialogDimensions.top ||
      e.clientY > dialogDimensions.bottom
    ) {
      dialog.close();
      await updateFeedbackStatus(false);
    }
  });

  likeBtn.addEventListener('click', async () => {
    await updateFeedbackStatus(true);
    dialog.close();
      
    window.open(REVIEWS_LINK, '_blank');
  });

  dislikeBtn.addEventListener('click', async () => {
    await updateFeedbackStatus(true);
    dialog.close();
    window.open(SUPPORT_LINK, '_blank');
  });
}

function shouldShowFeedbackPopup() {
  return new Promise((resolve) => {
    storageObj.get(['ui_prefs'], (result) => {
      const prefs = result.ui_prefs || {};
      const feedback = prefs.feedback || {
        completed: false,
        last_prompted: 0,
        install_time: null
      };
      const now = Date.now();

      if (feedback.completed) {
        resolve(false);
        return;
      }

      if (!feedback.install_time) {
        prefs.feedback = { ...feedback, install_time: now };
        storageObj.set({ ui_prefs: prefs });
        resolve(false);
        return;
      }

      if (now - feedback.install_time < INITIAL_DELAY_MS) {
        resolve(false);
        return;
      }

      if (feedback.last_prompted > 0 && (now - feedback.last_prompted < SNOOZE_DURATION_MS)) {
        resolve(false);
        return;
      }

      resolve(true);
    });
  });
}

async function updateFeedbackStatus(isCompleted) {
  const result = await storageObj.get(['ui_prefs']);
  
  const prefs = result.ui_prefs || {};
  const feedback = prefs.feedback || {};
  
  prefs.feedback = {
    ...feedback,
    install_time: feedback.install_time || Date.now(),
    last_prompted: Date.now(),
    
    completed: feedback.completed || isCompleted
  };
  
  await storageObj.set({ ui_prefs: prefs });
}