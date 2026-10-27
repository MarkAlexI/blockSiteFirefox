import { customAlert } from './scripts/customAlert.js';
import { isBlockedURL } from './scripts/isBlockedURL.js';
import { getCurrentTabs } from './scripts/getCurrentTabs.js';
import { normalizeDomainRule } from './rules/normalizeDomainRule.js';
import { t } from './scripts/t.js';
import { RulesManager } from './rules/rulesManager.js';
import { readRulesViewSnapshot } from './rules/rulesViewSnapshot.js';
import { RulesClient } from './rules/rulesClient.js';
import { getRulesMutationFeedback } from './rules/rulesMutationFeedback.js';
import { isExpectedRulesRejection } from './rules/rulesErrorClassification.js';
import { RulesUI, formatDailyLimitUsageMinutes } from './rules/rulesUI.js';
import { RuleEditorFeedback } from './rules/ruleEditorFeedback.js';
import { ProManager } from './pro/proManager.js';
import { PasswordUtils } from './pro/password.js';
import { initializeNoSpaceInputs } from './utils/noSpaces.js';
import { configureUrlInput } from './dom/urlInput.js';
import Logger from './utils/logger.js';
import { getFocusSessionState } from './utils/focusSession.js';
import { MAX_RULES_LIMIT } from './utils/constants.js';
import { scrollToTop, mountScroll } from './dom/scrollToTop.js';
import { ScheduleFormatter } from './utils/scheduleFormatter.js';
import { SettingsManager } from './options/settings.js';
import { RuleListsManager, GENERAL_RULE_LIST_ID } from './rules/ruleListsManager.js';
import { countFreeRules, getAssignmentUsageSeconds, getRuleAssignment, getRuleAssignments } from './rules/ruleAssignments.js';
import { DailyLimitManager } from './rules/dailyLimitManager.js';
import {
  BLOCKING_MODE_SCHEDULE,
  BLOCKING_MODE_DAILY_LIMIT,
  getRuleBlockingMode,
  normalizeDailyLimit
} from './rules/blockingMode.js';
import { installPageErrorReporter } from './telemetry/pageErrorReporter.js';
import { initFeedbackPrompt } from './feedback/feedbackPrompt.js';
import { StatisticsManager } from './pro/statisticsManager.js';

installPageErrorReporter('popup');

const logger = new Logger('Popup');

class PopupPage {
  constructor() {
    this.logger = logger;
    this.rulesManager = new RulesManager();
    this.ruleListsManager = new RuleListsManager();
    this.dailyLimitManager = new DailyLimitManager();
    this.rulesClient = new RulesClient();
    this.rulesUI = new RulesUI();
    this.scheduleFormatter = new ScheduleFormatter();
    
    this.rulesContainer = document.getElementById('rules-container');
    this.addRuleButton = document.getElementById('add-rule');
    this.addWhitelistRuleButton = document.getElementById('add-whitelist-rule');
    this.statusOutput = document.getElementById('status');
    this.currentModeElement = document.getElementById('current-mode');
    this.blockedTodayElement = document.getElementById('popup-blocked-today');
    this.scrollToTopBtn = document.getElementById('scrollToTopBtn');
    
    this.focusSection = document.getElementById('focus-session-section');
    this.startFocusBtn = document.getElementById('start-focus-btn');
    this.stopFocusBtn = document.getElementById('stop-focus-btn');
    this.focusDurationInput = document.getElementById('focus-duration');
    this.focusDurationError = document.getElementById('focus-duration-error');
    this.focusControls = document.getElementById('focus-controls');
    this.focusActiveLabel = document.getElementById('focus-active-label');
    this.focusHardcoreDescription = document.getElementById('focus-hardcore-description');
    this.focusTimerDisplay = document.getElementById('focus-timer-display');
    this.focusStartView = document.getElementById('focus-start-view');
    this.focusActiveView = document.getElementById('focus-active-view');
    this.focusProNote = document.getElementById('focus-pro-note');
    this.focusModeControl = document.getElementById('focus-mode-control');
    this.focusModeSelect = document.getElementById('focus-mode-select');
    this.hardcoreModeControl = document.getElementById('hardcore-mode-control');
    this.hardcoreModeCheckbox = document.getElementById('focus-hardcore-mode');
    this.focusTimerInterval = null;
    
    this.thisTabs = [];
    this.settings = {};
    this.ruleLists = [];
    this.activeRuleListId = GENERAL_RULE_LIST_ID;
    this.activeDisabledCategories = [];
    
    this.currentRuleCount = 0;
    this.isPro = false;
    this.isLegacyUser = false;
    this.storageChangeHandler = null;
    
    this.init();
  }
  
  async init() {
    this.initializeUI();
    this.setupEventListeners();
    this.setupStorageListeners();
    await this.loadSettings();
    await this.loadCurrentTabs();
    mountScroll(this.currentModeElement, this.scrollToTopBtn, document.getElementById('options-link'));
    
    try {
      const access = await ProManager.getAccess();
      this.isPro = access.isPro;
      this.isLegacyUser = access.isLegacyUser;
    } catch (error) {
      this.logger.info('Error initializing Pro/Legacy status:', error);
    }
    
    this.updateWhitelistButtonState();
    
    await this.loadStatisticsSummary();
    await this.loadRules();
    await this.initFocusSession();
    await initFeedbackPrompt();
  }
  
  initializeUI() {
    this.setupMotivationalQuote();
  }
  
  setupMotivationalQuote() {
    const quoteElement = document.getElementById('motivational-quote');
    const totalQuotes = 40;
    const randomIndex = Math.floor(Math.random() * totalQuotes) + 1;
    const quoteKey = `quote${randomIndex}`;
    const message = t(quoteKey);
    quoteElement.textContent = message || 'Stay motivated!';
  }
  
  setupStorageListeners() {
    this.storageChangeHandler = (changes, areaName) => {
      if (areaName !== 'local') return;

      if (changes?.focusSession) void this.updateFocusUI();

      if (changes?.statistics) {
        this.updateStatisticsSummary(changes.statistics.newValue);
      }

      if (changes?.rulesGeneration && changes.rulesGeneration.oldValue !== changes.rulesGeneration.newValue) {
        void this.loadRules();
        return;
      }
      if (!changes?.dailyRuleUsage) return;
      const previousUsage = changes.dailyRuleUsage.oldValue?.usageSeconds || {};
      const nextUsage = changes.dailyRuleUsage.newValue?.usageSeconds || {};
      if (JSON.stringify(previousUsage) === JSON.stringify(nextUsage)) return;
      void this.loadRules();
    };
    browser.storage.onChanged.addListener(this.storageChangeHandler);
  }

  async loadStatisticsSummary() {
    const statistics = await StatisticsManager.getStatistics();
    this.updateStatisticsSummary(statistics);
  }

  updateStatisticsSummary(statistics = {}) {
    if (!this.blockedTodayElement) return;
    const value = Number(statistics?.blockedToday);
    this.blockedTodayElement.textContent = String(
      Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
    );
  }

  async loadSettings() {
    try {
      const result = await browser.storage.sync.get(['settings']);
      this.settings = result.settings || {};
      const mode = this.settings.mode || 'normal';
      
      if (this.currentModeElement) {
        if (mode === 'strict') {
          this.currentModeElement.setAttribute('data-i18n', 'strictmodetitle');
          this.currentModeElement.textContent = t('strictmodetitle') || 'Strict Mode';
          this.currentModeElement.className = 'strict-mode';
        } else {
          this.currentModeElement.setAttribute('data-i18n', 'normalmodetitle');
          this.currentModeElement.textContent = t('normalmodetitle') || 'Normal Mode';
          this.currentModeElement.className = 'normal-mode';
        }
      }
      
    } catch (error) {
      this.logger.error('Error loading security mode:', error);
      if (this.currentModeElement) {
        this.currentModeElement.setAttribute('data-i18n', 'normalmodetitle');
        this.currentModeElement.textContent = t('normalmodetitle') || 'Normal Mode';
        this.currentModeElement.className = 'normal-mode';
      }
    }
  }
  
  setupEventListeners() {
    for (const id of ['options-link', 'rule-help-options']) {
      document.getElementById(id)?.addEventListener('click', (e) => {
        e.preventDefault();
        this.openOptionsPage();
      });
    }
    
    const feedbackButton = document.getElementById('feedback-btn');
    feedbackButton.addEventListener('click', () => {
      this.openFeedbackEmail();
    });
    
    this.addRuleButton.addEventListener('click', async () => {
      if (!this.isPro && !this.isLegacyUser) {
        const rules = await this.rulesManager.getRules();
        this.currentRuleCount = countFreeRules(rules);
        
        if (this.currentRuleCount >= MAX_RULES_LIMIT) {
          customAlert(t('rulelimitreached', MAX_RULES_LIMIT));
          return;
        }
      }
      this.createRuleInputs();
    });
    
    if (this.addWhitelistRuleButton) {
      this.addWhitelistRuleButton.addEventListener('click', () => {
        this.createRuleInputs('', '', null, false, 'whitelist', null, true);
      });
    }
    
    this.scrollToTopBtn.addEventListener('click', () => scrollToTop(document.getElementById('options-link')));
  }
  
  updateWhitelistButtonState() {
    if (!this.addWhitelistRuleButton) return;
    const hasAccess = this.isPro || this.isLegacyUser;
    
    this.addWhitelistRuleButton.disabled = !hasAccess;
    this.addWhitelistRuleButton.title = hasAccess ?
      (t('addwhitelistrule') || 'Add Whitelist Rule') :
      (t('prorequired') || 'Pro mode required');
  }
  
  openOptionsPage() {
    const closePopup = () => {
      setTimeout(() => {
        window.close();
      }, 100);
    };
    
    if (browser.runtime.openOptionsPage) {
      browser.runtime.openOptionsPage(() => {
        closePopup();
      });
    } else {
      browser.tabs.create({ url: browser.runtime.getURL('options/options.html') }, () => {
        closePopup();
      });
    }
  }
  
  openFeedbackEmail() {
    const manifest = browser.runtime.getManifest();
    const browserInfo = navigator.userAgent;
    
    const email = 'support@blockdistraction.com';
    const subject = encodeURIComponent(t('sendfeedbacksubject'));
    const body = encodeURIComponent(
      `Browser: ${browserInfo}\n\nExtension Version: ${manifest.version}\n\n${t('sendfeedbackbody')}`
    );
    
    const mailtoLink = `mailto:${email}?subject=${subject}&body=${body}`;
    
    const link = document.createElement('a');
    link.href = mailtoLink;
    link.target = "_top";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
  
  async loadCurrentTabs() {
    this.thisTabs = await getCurrentTabs();
  }
  
  async loadRules() {
    const refreshId = this.rulesRefreshId = (this.rulesRefreshId || 0) + 1;
    try {
      const { snapshot, ruleListState, dailyUsageSeconds } = await readRulesViewSnapshot();
      if (refreshId !== this.rulesRefreshId) return;
      const { rules, generation, revisions = {} } = snapshot;
      const hasRuleListAccess = this.isPro || this.isLegacyUser;
      const ruleLists = hasRuleListAccess
        ? ruleListState.lists
        : ruleListState.lists.filter(list => list.id === GENERAL_RULE_LIST_ID);
      this.ruleLists = ruleLists;
      this.ruleListSnapshot = ruleListState;
      this.activeRuleListId = hasRuleListAccess
        ? ruleListState.activeRuleListId
        : GENERAL_RULE_LIST_ID;
      this.activeDisabledCategories = ruleLists.find(list => list.id === this.activeRuleListId)?.disabledCategories || [];
      
      this.currentRuleCount = countFreeRules(rules);
      
      const active = document.activeElement;
      const focusedRow = active?.classList?.contains('rule-toggle-popup')
        ? [...this.rulesContainer.children].find(row => row.querySelector('.rule-toggle-popup') === active)
        : null;
      if (focusedRow) {
        this.ruleToggleFocus = { ruleId: String(focusedRow.dataset.ruleId),
          listId: focusedRow.dataset.assignmentListId, previous: active };
      } else if (this.ruleToggleFocus && active !== document.body && active !== this.ruleToggleFocus.previous) {
        this.ruleToggleFocus = null;
      }
      this.rulesUI?.rememberDeletionFocus?.(this.rulesContainer, () => this.addRuleButton);
      this.rulesContainer.innerHTML = '';
      
      const visibleRules = rules.filter(rule =>
        rule.isWhitelist || Boolean(getRuleAssignment(rule, this.activeRuleListId))
      );

      visibleRules.forEach(rule => {
        const assignment = rule.isWhitelist
          ? getRuleAssignments(rule)[0]
          : getRuleAssignment(rule, this.activeRuleListId);
        if (!assignment) return;
        this.createRuleInputs(
          rule.blockURL,
          rule.redirectURL,
          rule.id,
          assignment.disabledByUser === true,
          rule.category,
          assignment.schedule,
          rule.isWhitelist ?? false,
          assignment.listId,
          assignment.blockingMode,
          assignment.dailyLimit,
          getAssignmentUsageSeconds(dailyUsageSeconds, rule.id, assignment.listId),
          [assignment],
          generation,
          revisions[rule.id] ?? null
        );
      });

      if (this.ruleToggleFocus && !visibleRules.some(rule =>
        String(rule.id) === this.ruleToggleFocus.ruleId &&
        getRuleAssignment(rule, this.ruleToggleFocus.listId)?.listId === this.activeRuleListId)) {
        this.restoreRuleToggleFocus(null, refreshId);
      }
      this.updateStatus(visibleRules.length);
      this.showBlockThisSiteButton(rules);
      // Saved rows are inserted by the existing zero-delay callbacks above.
      setTimeout(() => {
        if (refreshId === this.rulesRefreshId) this.rulesUI?.restoreDeletionFocus?.(this.rulesContainer);
      }, 0);
      
    } catch (error) {
      if (refreshId !== this.rulesRefreshId) return;
      this.logger.error("Load rules error:", error);
      customAlert(t('errorupdatingrules'));
    }
  }
  
  restoreRuleToggleFocus(row, refreshId) {
    const pending = this.ruleToggleFocus;
    if (!pending || refreshId !== this.rulesRefreshId) return;
    if (row && (String(row.dataset.ruleId) !== pending.ruleId ||
        row.dataset.assignmentListId !== pending.listId)) return;
    this.ruleToggleFocus = null;
    // Deferred row insertion must respect a later keyboard or pointer choice.
    const active = document.activeElement;
    if (active !== document.body && active !== pending.previous) return;
    if (this.rulesContainer.classList.contains('focus-lock-active')) return;
    const toggle = row?.querySelector('.rule-toggle-popup');
    const target = toggle && !toggle.disabled ? toggle : this.addRuleButton;
    target?.focus({ preventScroll: true });
  }

  showBlockThisSiteButton(rules) {
    const existingButton = document.getElementById('block-that');
    if (existingButton) {
      existingButton.remove();
    }
    
    const currentUrl = normalizeDomainRule(this.thisTabs[0]?.url || '');
    const alreadyBlocked = rules.some(rule =>
      rule.blockURL === currentUrl && (rule.isWhitelist || Boolean(getRuleAssignment(rule, this.activeRuleListId)))
    );
    
    if (!isBlockedURL(this.thisTabs) && !alreadyBlocked && currentUrl) {
      const favIcon = this.thisTabs[0]?.favIconUrl || 'images/icon-32.png';
      this.createBlockThisSiteButton(currentUrl, favIcon);
    }
  }
  
  createBlockThisSiteButton(url, favIconUrl = 'images/icon-32.png') {
    if (!url || url.trim() === '') return;
    
    const newButton = document.createElement('button');
    const blockThat = t('blockthat');
    newButton.id = 'block-that';
    newButton.title = `${blockThat} ${url}`;
    newButton.textContent = blockThat;
    
    const icon = document.createElement('img');
    icon.src = favIconUrl;
    icon.alt = '';
    icon.setAttribute('aria-hidden', 'true');
    icon.style.width = '16px';
    icon.style.height = '16px';
    icon.style.marginLeft = '16px';
    icon.style.verticalAlign = 'middle';
    newButton.appendChild(icon);
    
    if (this.isTouchDevice()) {
      const domain = this.extractDomain(url);
      const domainDiv = document.createElement('div');
      domainDiv.className = 'site-domain';
      domainDiv.textContent = `(${domain})`;
      newButton.appendChild(domainDiv);
    }
    
    const listContext = {
      listId: this.isPro || this.isLegacyUser ? this.activeRuleListId : GENERAL_RULE_LIST_ID,
      generation: this.ruleListSnapshot?.generation ?? null,
      revisions: { ...this.ruleListSnapshot?.revisions }
    };
    newButton.addEventListener('click', async () => {
      if (!this.isPro && !this.isLegacyUser) {
        const rules = await this.rulesManager.getRules();
        if (countFreeRules(rules) >= MAX_RULES_LIMIT) {
          customAlert(t('rulelimitreached', MAX_RULES_LIMIT));
          return;
        }
      }
      await this.blockCurrentSite(url, newButton, listContext);
    });
    
    this.addRuleButton.insertAdjacentElement('afterend', newButton);
  }
  
  isTouchDevice() {
    return ('ontouchstart' in window) ||
      (navigator.maxTouchPoints > 0) ||
      (navigator.msMaxTouchPoints > 0);
  }
  
  extractDomain(url) {
    try {
      let domain = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
      domain = domain.split('/')[0];
      return domain.length > 20 ? domain.substring(0, 17) + '...' : domain;
    } catch (error) {
      return url.substring(0, 20) + (url.length > 20 ? '...' : '');
    }
  }
  
  async blockCurrentSite(url, button, listContext) {
    try {
      const rules = await this.rulesManager.getRules();
      // Preserve the displayed destination through waits/access changes. The
      // worker validates whether that original intent is still permitted.
      const targetListId = listContext.listId;
      const alreadyExists = rules.some(rule =>
        rule.blockURL === url && Boolean(getRuleAssignment(rule, targetListId))
      );
      
      if (!alreadyExists) {
        if (!this.isPro && !this.isLegacyUser) {
          if (countFreeRules(rules) >= MAX_RULES_LIMIT) {
            customAlert(t('rulelimitreached', MAX_RULES_LIMIT));
            return;
          }
        }
        
        const response = await this.rulesClient.addRule({
          expectedGeneration: listContext.generation,
          expectedListRevisions: listContext.revisions,
          blockURL: url,
          redirectURL: '',
          category: 'social',
          assignment: {
            listId: targetListId,
            blockingMode: 'always',
            schedule: null,
            dailyLimit: null
          },
          isWhitelist: false
        });
        this.showRulesMutationResult(response, '+ 1');
        button.remove();
      }
    } catch (error) {
      this.logRulesMutationFailure('Block current site error:', error);
      this.handleRulesMutationError(error, 'erroraddingrule');
    }
  }
  
  createRuleInputs(blockURLValue = '', redirectURLValue = '', ruleId = null, disabledByUser = false, category = 'uncategorized', schedule = null, isWhitelist = false, listIds = [GENERAL_RULE_LIST_ID], blockingMode = null, dailyLimit = null, dailyUsageSeconds = 0, assignments = null, expectedGeneration = null, expectedRevision = null) {
    const refreshId = this.rulesRefreshId;
    const listContext = {
      listId: isWhitelist || (!this.isPro && !this.isLegacyUser) ? GENERAL_RULE_LIST_ID : this.activeRuleListId,
      generation: this.ruleListSnapshot?.generation ?? null,
      revisions: { ...this.ruleListSnapshot?.revisions }
    };
    const ruleDiv = document.createElement('div');
    const isCategoryMuted = this.activeDisabledCategories.includes(category);
    const normalizedListIds = isWhitelist ? [GENERAL_RULE_LIST_ID] : (Array.isArray(listIds) ? listIds : [listIds]);
    const effectiveAssignments = Array.isArray(assignments) && assignments.length > 0
      ? assignments
      : normalizedListIds.map(listId => ({
          listId,
          disabledByUser,
          blockingMode: blockingMode || 'always',
          schedule,
          dailyLimit
        }));
    const isMuted = isCategoryMuted;
    
    let className = isMuted ? 'rule category-muted' : 'rule';
    if (isWhitelist) {
      className += ' rule-whitelist';
    }
    ruleDiv.className = className;
    ruleDiv.dataset.ruleId = ruleId;
    ruleDiv.dataset.isWhitelist = isWhitelist;
    ruleDiv.dataset.assignmentListId = effectiveAssignments[0]?.listId || GENERAL_RULE_LIST_ID;
    
    if (isMuted) {
      ruleDiv.title = t('category_muted_no_edit');
    }
    
    const blockURL = document.createElement('input');
    blockURL.type = 'text';
    configureUrlInput(blockURL);
    blockURL.placeholder = t('blockurl');
    blockURL.setAttribute('aria-label', t('blockurl'));
    blockURL.value = blockURLValue;

    const mobileLinkHint = !blockURLValue && !isWhitelist
      ? document.createElement('small')
      : null;

    if (mobileLinkHint) {
      mobileLinkHint.className = 'mobile-link-hint';
      mobileLinkHint.textContent = t('mobilecopylinkhint');
    }
    
    const focusAtCreation = document.activeElement;
    
    const redirectURL = document.createElement('input');
    redirectURL.type = 'text';
    configureUrlInput(redirectURL);
    redirectURL.setAttribute('aria-label', t('redirecturl'));
    
    if (isWhitelist) {
      redirectURL.placeholder = 'N/A';
      redirectURL.value = '';
      redirectURL.disabled = true;
      redirectURL.classList.add('input-disabled');
    } else {
      redirectURL.placeholder = t('redirecturl');
      redirectURL.value = redirectURLValue;
    }
    
    let showButtons = true;
    
    if (!blockURLValue) {
      const isFreeUser = !this.isPro && !this.isLegacyUser;
      if (isFreeUser && this.currentRuleCount >= MAX_RULES_LIMIT) {
        showButtons = false;
      }
    }
    
    setTimeout(() => {
      // A newer refresh may have cleared the container before this row inserts.
      if (refreshId !== this.rulesRefreshId) return;
      ruleDiv.appendChild(blockURL);
      if (mobileLinkHint) ruleDiv.appendChild(mobileLinkHint);
      ruleDiv.appendChild(redirectURL);
      
      if (!blockURLValue) {
        if (showButtons) {
          const saveButton = this.createSaveButton(blockURL, redirectURL, ruleDiv, isWhitelist, listContext);
          ruleDiv.appendChild(saveButton);
        } else {
          const proMessage = document.createElement('span');
          proMessage.textContent = t('proonlyactions') || 'Upgrade to add more';
          proMessage.className = 'pro-message';
          ruleDiv.appendChild(proMessage);
        }
      } else {
        this.makeInputReadOnly(blockURL);
        this.makeInputReadOnly(redirectURL);

        const activeAssignment = effectiveAssignments[0];
        if (!isWhitelist && activeAssignment?.listId !== GENERAL_RULE_LIST_ID) {
          const listTag = document.createElement('span');
          listTag.className = 'rule-list-popup';
          listTag.textContent = this.ruleLists.find(list => list.id === activeAssignment.listId)?.name || activeAssignment.listId;
          listTag.title = t('rulelist_header');
          ruleDiv.appendChild(listTag);
        }
        
        if (isWhitelist) {
          const staticDash = document.createElement('span');
          staticDash.className = 'status-static-popup';
          staticDash.textContent = t('status_allow') || 'Allow';
          staticDash.title = t('status_allow');
          ruleDiv.appendChild(staticDash);
        } else if (getRuleBlockingMode({ blockingMode, schedule, dailyLimit }) === BLOCKING_MODE_SCHEDULE && schedule) {
          const scheduleElement = document.createElement('span');
          scheduleElement.className = 'rule-schedule-popup';
          scheduleElement.textContent = this.scheduleFormatter.formatSchedule(schedule);
          scheduleElement.title = t('rule_scheduled') || 'Scheduled rule';
          ruleDiv.appendChild(scheduleElement);
        } else if (getRuleBlockingMode({ blockingMode, schedule, dailyLimit }) === BLOCKING_MODE_DAILY_LIMIT) {
          const limit = normalizeDailyLimit(dailyLimit);
          const limitElement = document.createElement('span');
          limitElement.className = 'rule-daily-limit-popup';
          if (limit) {
            const shownUsed = formatDailyLimitUsageMinutes(dailyUsageSeconds, limit.minutes);
            limitElement.textContent = t('daily_limit_usage', [shownUsed, limit.minutes]) || `${shownUsed} / ${limit.minutes} min`;
            if (dailyUsageSeconds >= limit.minutes * 60) {
              limitElement.classList.add('limit-reached');
              limitElement.title = t('daily_limit_reached') || 'Daily limit reached';
            }
          } else {
            limitElement.textContent = t('daily_limit_invalid') || 'Invalid daily limit';
          }
          ruleDiv.appendChild(limitElement);
        } else {
          const toggleElement = document.createElement('button');
          toggleElement.type = 'button';
          toggleElement.className = 'rule-toggle-popup';
          toggleElement.textContent = disabledByUser ? '✗' : '✓';
          toggleElement.setAttribute('aria-label', `${t('blockingmode_header')}: ${blockURLValue}`);
          toggleElement.setAttribute('aria-pressed', String(!disabledByUser));
          toggleElement.disabled = isMuted || Boolean(this.rulesContainer.classList?.contains('focus-lock-active'));
          toggleElement.title = disabledByUser ? t('rule_disabled') || 'Disabled' : t('rule_enabled') || 'Enabled';
          let pending = false;
          toggleElement.addEventListener('click', async () => {
            if (pending || toggleElement.disabled) return;
            pending = true;
            toggleElement.setAttribute('aria-disabled', 'true');
            try {
              await this.handleRuleToggle(
                ruleId,
                activeAssignment?.listId || this.activeRuleListId || GENERAL_RULE_LIST_ID,
                disabledByUser,
                isMuted,
                expectedGeneration,
                expectedRevision
              );
            } catch (error) {
              this.logger.error('Toggle rule error:', error);
            } finally {
              pending = false;
              toggleElement.removeAttribute('aria-disabled');
            }
          });
          ruleDiv.appendChild(toggleElement);
        }
      }
      
      if (blockURLValue || (showButtons && !blockURLValue)) {
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'delete-btn';
        deleteButton.textContent = t('deletebtn');
        deleteButton.setAttribute('aria-label', `${t('deletebtn')}: ${blockURLValue}`);
        
        deleteButton.addEventListener('click', async () => {
          if (isMuted) return;
          await this.handleRuleDeletion(deleteButton, ruleId, blockURL.value, ruleDiv, expectedGeneration, effectiveAssignments[0]?.listId || GENERAL_RULE_LIST_ID, expectedRevision);
        });
        
        ruleDiv.appendChild(deleteButton);
      }
      
      this.rulesContainer.insertAdjacentElement('afterbegin', ruleDiv);
      if (this.ruleToggleFocus) this.restoreRuleToggleFocus(ruleDiv, refreshId);
      // Schedule only after insertion, and never steal a later user focus choice.
      if (!ruleId && !blockURLValue) {
        requestAnimationFrame(() => {
          if (refreshId === this.rulesRefreshId && blockURL.isConnected &&
              document.activeElement === focusAtCreation) blockURL.focus();
        });
      }
    }, 0);
  }
  
  createSaveButton(blockURL, redirectURL, ruleDiv, isWhitelist = false, listContext = null) {
    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'save-btn';
    saveButton.textContent = t('savebtn');
    ruleDiv.classList.add('rule-editor-row');
    const feedback = new RuleEditorFeedback(ruleDiv, saveButton, {
      block: { control: blockURL, label: t('blockurl') },
      redirect: { control: redirectURL, label: t('redirecturl') }
    }, {
      translate: code => this.rulesUI.getValidationMessage(code),
      notify: customAlert,
      unexpected: error => {
        this.logRulesMutationFailure('Save new rule error:', error);
        customAlert(t('erroraddingrule'));
      }
    });
    ruleDiv._ruleEditorFeedback = feedback;
    saveButton.addEventListener('click', () => feedback.submit(() =>
      this.saveNewRule(blockURL, redirectURL, ruleDiv, saveButton, isWhitelist, listContext)));
    
    return saveButton;
  }
  
  async initFocusSession() {
    this.startFocusBtn.addEventListener('click', () => this.startFocusSession());
    this.stopFocusBtn.addEventListener('click', () => this.stopFocusSession());
    this.focusDurationInput.addEventListener('input', () => this.clearFocusDurationError());
    await this.updateFocusUI();
  }
  
  toggleUIAccessibility(locked) {
    const elementsToLock = [
      document.querySelector('.controls'),
      this.rulesContainer
    ];
    
    elementsToLock.forEach(el => {
      if (el) {
        el.classList.toggle('focus-lock-active', locked);
        if (el === this.rulesContainer) {
          for (const row of el.children) {
            const toggle = row.querySelector('.rule-toggle-popup');
            if (toggle) toggle.disabled = locked || row.classList.contains('category-muted');
          }
        }
      }
    });
  }
  
  async updateFocusUI() {
    if (this.focusDisposed) return false;
    const generation = this.focusRenderGeneration = (this.focusRenderGeneration || 0) + 1;
    const refresh = (async () => {
      let state;
      try { state = await getFocusSessionState({ throwOnError: true }); }
      catch (error) {
        if (this.focusDisposed) return false;
        if (generation !== this.focusRenderGeneration) return this.focusRefresh;
        this.logger.error('Error refreshing Focus Session:', error);
        if (!this.focusAction) customAlert(t('errorupdatingrules'));
        return false;
      }
      if (this.focusDisposed) return false;
      if (generation !== this.focusRenderGeneration) return this.focusRefresh;
      if (this.focusTimerInterval) clearInterval(this.focusTimerInterval);
      if (this.focusExpiryTimeout) clearTimeout(this.focusExpiryTimeout);
      this.focusTimerInterval = this.focusExpiryTimeout = null;
      const { focusActive, focusEndTime, isHardcore, focusMode } = state;
      const active = Boolean(focusActive && focusEndTime > Date.now());
      const previous = this.focusViewState, focused = document.activeElement;
      const disappearing = active ? this.focusStartView : this.focusActiveView;
      const losesPaidControl = !active && !this.isPro && !this.isLegacyUser &&
        (focused === this.focusDurationInput || this.focusModeControl?.contains(focused) || this.hardcoreModeControl.contains(focused));
      const needsFocus = disappearing.contains(focused) || losesPaidControl || (active && isHardcore && focused === this.stopFocusBtn);
      this.focusViewState = { ...state, focusActive: active };
      this.focusStartView.hidden = active;
      this.focusActiveView.hidden = !active;
      this.focusStartView.classList.toggle('hidden', active);
      this.focusActiveView.classList.toggle('hidden', !active);
      this.toggleUIAccessibility(active);
      if (active) {
        this.stopFocusBtn.classList.toggle('hidden', isHardcore);
        this.stopFocusBtn.hidden = isHardcore;
        this.focusHardcoreDescription.hidden = !isHardcore;
        if (isHardcore) this.focusActiveLabel.setAttribute('aria-describedby', 'focus-hardcore-description');
        else this.focusActiveLabel.removeAttribute('aria-describedby');
        this.updateTimerDisplay(focusEndTime);
        if (Date.now() < focusEndTime) this.focusTimerInterval = setInterval(() => this.updateTimerDisplay(focusEndTime), 1000);
      } else {
        const paid = this.isPro || this.isLegacyUser;
        this.focusProNote.classList.toggle('hidden', paid);
        this.hardcoreModeControl.classList.toggle('hidden', !paid);
        this.focusModeControl?.classList.toggle('hidden', !paid);
        if (!paid) this.focusDurationInput.value = 25;
        if (this.focusModeSelect) this.focusModeSelect.value = paid && focusMode ? focusMode : 'blacklist';
      }
      this.syncFocusPending();
      const action = this.focusAction;
      if (needsFocus || (action?.ownsFocus && !action.moved && (focused === action.anchor || focused === document.body))) {
        this.restoreFocusSessionFocus(active ? (isHardcore ? this.focusActiveLabel : this.stopFocusBtn) : this.startFocusBtn);
      }
      if (!action && previous) this.announceFocusTransition(previous);
      return true;
    })();
    this.focusRefresh = refresh;
    return refresh;
  }

  syncFocusPending() {
    const pending = Boolean(this.focusAction);
    if (pending) this.focusControls.setAttribute('aria-busy', 'true');
    else this.focusControls.removeAttribute('aria-busy');
    for (const button of [this.startFocusBtn, this.stopFocusBtn]) {
      if (pending) button.setAttribute('aria-disabled', 'true');
      else button.removeAttribute('aria-disabled');
    }
    this.focusDurationInput.disabled = pending || (!this.isPro && !this.isLegacyUser);
    this.focusModeSelect.disabled = pending;
    this.hardcoreModeCheckbox.disabled = pending;
  }

  restoreFocusSessionFocus(target) {
    if (this.focusDisposed || document.hidden || !target || target.disabled ||
        !document.documentElement.contains(target) || document.querySelector('dialog[open]')) return;
    for (let node = target; node; node = node.parentNode) {
      if (node.hidden || node.inert || node.classList?.contains('hidden')) return;
    }
    if (this.focusAction) this.focusAction.anchor = target;
    target.focus();
  }

  clearFocusDurationError() {
    if (this.focusDurationError.hidden) return;
    const ids = (this.focusDurationInput.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== 'focus-duration-error');
    if (ids.length) this.focusDurationInput.setAttribute('aria-describedby', ids.join(' '));
    else this.focusDurationInput.removeAttribute('aria-describedby');
    if (this.focusPreviousInvalid === null) this.focusDurationInput.removeAttribute('aria-invalid');
    else this.focusDurationInput.setAttribute('aria-invalid', this.focusPreviousInvalid);
    this.focusDurationError.hidden = true;
    this.focusDurationError.textContent = '';
  }

  reportFocusDurationError() {
    const message = t('focussessioninvalidduration');
    if (this.focusDurationError.hidden) this.focusPreviousInvalid = this.focusDurationInput.getAttribute('aria-invalid');
    this.focusDurationError.textContent = message;
    this.focusDurationError.hidden = false;
    this.focusDurationInput.setAttribute('aria-invalid', 'true');
    const ids = new Set((this.focusDurationInput.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    ids.add('focus-duration-error'); this.focusDurationInput.setAttribute('aria-describedby', [...ids].join(' '));
    if (!this.focusDurationInput.disabled && this.focusStartView.contains(document.activeElement) && !document.hidden && !document.querySelector('dialog[open]')) {
      this.restoreFocusSessionFocus(this.focusDurationInput);
    } else customAlert(message);
  }

  announceFocusTransition(previous) {
    const state = this.focusViewState;
    if (!state || (previous?.focusActive === state.focusActive && previous?.focusEndTime === state.focusEndTime && previous?.isHardcore === state.isHardcore)) return;
    if (state.focusActive) {
      // The focused Hardcore description already conveys this transition.
      if (state.isHardcore && document.activeElement === this.focusActiveLabel) return;
      customAlert([t('focussessionactivebanner'), this.focusTimerDisplay.textContent,
        state.isHardcore ? t('focussessionhardcore') : ''].filter(Boolean).join(' '));
    } else if (previous?.focusActive) customAlert(t('focussessionended'));
  }

  updateTimerDisplay(endTime) {
    const remaining = endTime - Date.now();
    if (remaining <= 0) {
      this.focusTimerDisplay.textContent = '00:00';
      clearInterval(this.focusTimerInterval);
      this.focusTimerInterval = null;
      if (!this.focusExpiryTimeout) this.focusExpiryTimeout = setTimeout(() => {
        this.focusExpiryTimeout = null;
        if (!this.focusDisposed) void this.updateFocusUI();
      }, 1000);
      return;
    }
    const total = Math.floor(remaining / 1000);
    const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60).toString().padStart(2, '0'), seconds = (total % 60).toString().padStart(2, '0');
    this.focusTimerDisplay.textContent = hours > 0 ? `${hours.toString().padStart(2, '0')}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
  }

  async startFocusSession() {
    if (this.focusAction || this.focusDisposed) return;
    const duration = Number(this.focusDurationInput.value);
    if (!Number.isInteger(duration) || duration < 1 || duration > 240) {
      this.reportFocusDurationError(); return;
    }
    this.clearFocusDurationError();
    const paid = this.isPro || this.isLegacyUser;
    await this.runFocusAction('start', { type: 'start_focus_session', duration,
      isHardcore: Boolean(paid && this.hardcoreModeCheckbox.checked),
      focusMode: paid && this.focusModeSelect ? this.focusModeSelect.value : 'blacklist' });
  }

  async stopFocusSession() {
    await this.runFocusAction('stop', { type: 'stop_focus_session' });
  }

  async runFocusAction(kind, message) {
    if (this.focusAction || this.focusDisposed) return;
    const anchor = document.activeElement, sourceView = kind === 'start' ? this.focusStartView : this.focusActiveView;
    const action = { anchor, ownsFocus: sourceView.contains(anchor), moved: false };
    const previous = this.focusViewState || { focusActive: kind === 'stop' };
    const onFocus = event => { if (event.target !== action.anchor && event.target !== document.body) action.moved = true; };
    document.addEventListener('focusin', onFocus);
    this.focusAction = action;
    this.syncFocusPending();
    let response, refreshed = false;
    try { response = await browser.runtime.sendMessage(message); }
    catch (error) { this.logger.error('Error changing Focus Session:', error); }
    try { if (!this.focusDisposed) refreshed = await this.updateFocusUI(); }
    catch (error) { this.logger.error('Error refreshing Focus Session:', error); }
    finally {
      document.removeEventListener('focusin', onFocus);
      this.focusAction = null;
      if (!this.focusDisposed) this.syncFocusPending();
    }
    if (this.focusDisposed) return;
    if (response?.success !== true || !refreshed) {
      customAlert(t(response?.code === 'pro_required' ? 'prorequired' : response?.code === 'invalid_focus_duration' ? 'focussessioninvalidduration' : 'errorupdatingrules'));
    } else if (response.syncPending === true) customAlert(t('ruleschangessavedpending'));
    else this.announceFocusTransition(previous);
  }

  logRulesMutationFailure(label, error) {
    if (isExpectedRulesRejection(error)) {
      this.logger.info(label, error?.code || 'rejected');
    } else {
      this.logger.error(label, error);
    }
  }

  async authorizePasswordProtectedRuleChange() {
    if (!this.isPro && !this.isLegacyUser) return true;

    try {
      const settings = await SettingsManager.getSettings({ throwOnError: true });
      if (!settings.enablePassword) return true;
      return await this.promptForPassword();
    } catch (error) {
      this.logger.error('Error checking password protection before a rule change:', error);
      customAlert(t('errorloadingsettings'));
      return false;
    }
  }

  async handleRuleToggle(ruleId, listId, disabledByUser, isMuted = false, expectedGeneration = null, expectedRevision = null) {
    if (isMuted) return;

    const isDisablingRule = disabledByUser !== true;
    if (isDisablingRule && !await this.authorizePasswordProtectedRuleChange()) return;

    try {
      const response = await this.rulesClient.toggleRule(ruleId, listId || GENERAL_RULE_LIST_ID, expectedGeneration, expectedRevision);
      await this.loadRules();
      this.showRulesMutationResult(response);
    } catch (error) {
      this.logRulesMutationFailure('Toggle rule error:', error);
      this.handleRulesMutationError(error, 'errorupdatingrules');
    }
  }

  handleRulesMutationError(error, fallbackKey = 'erroraddingrule', row = null) {
    if (error.code === 'validation_failed') {
      this.rulesUI.showValidationErrors(error.validationErrors || [], row);
    } else if (row?._ruleEditorFeedback && ['rule_already_exists', 'conflict_blacklist', 'conflict_whitelist', 'redundant_whitelist'].includes(error.code)) {
      this.rulesUI.showValidationErrors([error.code], row, { rule_already_exists: t('alertruleexist') });
    } else if (error.code === 'rules_state_changed') {
      customAlert(t('errorupdatingrules'));
      void this.loadRules();
    } else if (error.code === 'rule_already_exists') {
      customAlert(t('alertruleexist'));
    } else if (error.code === 'conflict_blacklist') {
      customAlert(t('conflict_blacklist_err') || 'This site is already in your Blacklist. Remove it first.');
    } else if (error.code === 'conflict_whitelist') {
      customAlert(t('conflict_whitelist_err') || 'This site is already in your Whitelist. Remove it first.');
    } else if (error.code === 'redundant_whitelist') {
      customAlert(t('redundant_whitelist_err') || 'This rule is already covered by another whitelist rule.');
    } else if (error.code === 'rule_limit_reached') {
      customAlert(t('rulelimitreached', MAX_RULES_LIMIT));
    } else if (error.code === 'pro_required') {
      customAlert(t('prorequired'));
    } else {
      customAlert(t(fallbackKey));
    }
  }
  
  async saveNewRule(blockURL, redirectURL, ruleDiv, saveButton, isWhitelist = false, listContext = {
    listId: !this.isPro && !this.isLegacyUser ? GENERAL_RULE_LIST_ID : (this.activeRuleListId || GENERAL_RULE_LIST_ID),
    generation: this.ruleListSnapshot?.generation ?? null,
    revisions: { ...this.ruleListSnapshot?.revisions }
  }) {
    try {
      if (!isWhitelist && !this.isPro && !this.isLegacyUser) {
        const currentRules = await this.rulesManager.getRules();
        if (countFreeRules(currentRules) >= MAX_RULES_LIMIT) {
          customAlert(t('rulelimitreached', MAX_RULES_LIMIT));
          return;
        }
      }
      
      const response = await this.rulesClient.addRule({
        expectedGeneration: listContext?.generation ?? null,
        expectedListRevisions: listContext?.revisions || {},
        blockURL: blockURL.value,
        redirectURL: isWhitelist ? '' : redirectURL.value,
        category: isWhitelist ? 'whitelist' : 'social',
        assignment: {
          listId: isWhitelist ? GENERAL_RULE_LIST_ID : listContext?.listId,
          blockingMode: 'always',
          schedule: null,
          dailyLimit: null
        },
        isWhitelist
      });
      
      ruleDiv._ruleEditorFeedback?.focusAfterSave(() =>
        isWhitelist && this.addWhitelistRuleButton && !this.addWhitelistRuleButton.disabled
          ? this.addWhitelistRuleButton : this.addRuleButton);
      ruleDiv.remove();
      this.showRulesMutationResult(response, '+ 1');
    } catch (error) {
      this.logRulesMutationFailure('Save new rule error:', error);
      this.handleRulesMutationError(error, 'erroraddingrule', ruleDiv);
    }
  }
  
  async handleRuleDeletion(deleteButton, ruleId, blockURL, ruleDiv, expectedGeneration = null, assignmentListId = GENERAL_RULE_LIST_ID, expectedRevision = null) {
    const key = ruleDiv.dataset?.isWhitelist === 'true' ? `rule:${ruleId}` : `assignment:${ruleId}:${assignmentListId}`;
    this.ruleDeletionRequests ||= new Set();
    if (this.ruleDeletionRequests.has(key) || this.rulesUI.isDeleteConfirmationInProgress(deleteButton)) return;
    this.ruleDeletionRequests.add(key);
    const previousDisabled = deleteButton.getAttribute?.('aria-disabled') ?? null;
    deleteButton.setAttribute?.('aria-disabled', 'true');
    try {
      if (!blockURL) {
        ruleDiv.remove();
        return;
      }
      
      
      const hasPaidAccess = this.isPro === true || this.isLegacyUser === true;
      const settings = await SettingsManager.getSettings({
        throwOnError: hasPaidAccess
      });
      if (hasPaidAccess && settings.enablePassword) {
        const isValid = await this.promptForPassword();
        if (!isValid) {
          customAlert(t('invalidpassword'));
          return;
        }
      }
      
      const isStrictMode = settings.mode === 'strict';
      if (deleteButton.isConnected === false || this.rulesUI.deletion?.disposed) return;
      await this.rulesUI.handleRuleDeletion(
        deleteButton,
        async () => {
            try {
              if (blockURL && ruleId !== null) {
                const response = ruleDiv.dataset.isWhitelist === 'true'
                  ? await this.rulesClient.deleteRule(ruleId, expectedGeneration, expectedRevision)
                  : await this.rulesClient.removeAssignment(ruleId, assignmentListId, expectedGeneration, expectedRevision);
                await this.loadRules();
                this.showRulesMutationResult(response, '- 1');
              } else {
                ruleDiv.remove();
              }
              
            } catch (error) {
              this.logger.info("Delete rule error:", error);
              await this.loadRules();
              customAlert(t('errorremovingrule'));
            }
          },
          isStrictMode,
          t('deletebtn'),
          { container: this.rulesContainer, fallback: () => this.addRuleButton }
      );
      
    } catch (error) {
      this.logger.error("Handle deletion error:", error);
      customAlert(t('errorremovingrule'));
    } finally {
      this.ruleDeletionRequests.delete(key);
      if (previousDisabled === null) deleteButton.removeAttribute?.('aria-disabled');
      else deleteButton.setAttribute?.('aria-disabled', previousDisabled);
    }
  }
  
  showRulesMutationResult(response, successMessage = '') {
    const { message } = getRulesMutationFeedback(response, successMessage);
    if (message) customAlert(message);
  }

  async promptForPassword() {
    return new Promise((resolve) => {
      PasswordUtils.showPasswordModal('verify', (isValid) => {
        resolve(isValid);
      }, t);
    });
  }
  
  makeInputReadOnly(input) {
    input.readOnly = true;
    input.tabIndex = -1;
    input.placeholder = '';
    input.classList.add('input-readonly');
  }
  
  updateStatus(count) {
    const outputText = t('savedrules', ' ' + count + ' ');
    this.statusOutput.value = outputText;
    
    if (this.focusSection) {
      this.focusSection.classList.toggle('hidden', count === 0);
    }
  }
  
  cleanup() {
    this.focusDisposed = true;
    this.focusRenderGeneration = (this.focusRenderGeneration || 0) + 1;
    if (this.focusExpiryTimeout) clearTimeout(this.focusExpiryTimeout);
    this.rulesUI.cleanup();
    if (this.storageChangeHandler) {
      browser.storage.onChanged.removeListener(this.storageChangeHandler);
      this.storageChangeHandler = null;
    }
    if (this.focusTimerInterval) {
      clearInterval(this.focusTimerInterval);
    }
  }
}

const popupPage = new PopupPage();

window.addEventListener('beforeunload', () => {
  popupPage.cleanup();
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'rules:changed') {
    if (message.settings) {
      popupPage.settings = message.settings;
    }
    if (message.migrated) {
      customAlert(t('rulesmigrated'));
    }
    popupPage.loadRules();
  }
  
  if (message.type === 'pro_status_changed') {
    logger.log(`Pro status changed: ${message.isPro}`);
    
    ProManager.updateProFeaturesVisibility(message.isPro || popupPage.isLegacyUser);
    popupPage.isPro = message.isPro;
    popupPage.updateWhitelistButtonState();
    void popupPage.updateFocusUI();
    popupPage.loadRules();
    
    sendResponse({ received: true });
  }
});

document.addEventListener('DOMContentLoaded', () => {
  initializeNoSpaceInputs();
  
  setTimeout(() => {
    window.scrollTo({
      top: 0,
      left: 0,
      behavior: 'instant'
    });
    
    document.body.classList.add('ready')
  }, 75);
});
