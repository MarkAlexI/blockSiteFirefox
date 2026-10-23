let nextErrorId = 0;

const fieldFor = code => {
  if (code.startsWith('blockurl_') || ['rule_already_exists', 'conflict_blacklist', 'conflict_whitelist', 'redundant_whitelist'].includes(code)) return 'block';
  if (code === 'redirect_invalid') return 'redirect';
  if (code === 'category_required') return 'category';
  if (code === 'daily_limit_invalid') return 'daily';
  if (code.startsWith('invalidSchedule') || ['schedule_required', 'invalid_days', 'invalid_time_format', 'start_after_end', 'schedule_day_overlap'].includes(code)) return 'schedule';
  return ['blocking_mode_invalid', 'blocking_mode_conflict'].includes(code) ? 'mode' : null;
};

function available(control) {
  if (!control || control.disabled || !control.ownerDocument.documentElement.contains(control)) return false;
  for (let node = control; node; node = node.parentNode) {
    if (node.hidden || node.inert || node.classList?.contains('focus-lock-active')) return false;
  }
  return true;
}

export class RuleEditorFeedback {
  constructor(row, saveButton, fields, { translate, notify, unexpected }) {
    Object.assign(this, { row, saveButton, fields, translate, notify, unexpected });
    this.errors = new Map();
    this.errorRow = null;
    this.session = null;
    for (const [name, field] of Object.entries(fields)) {
      if (!field?.control) continue;
      const clear = () => this.clearField(name);
      field.control.addEventListener('input', clear);
      field.control.addEventListener('change', clear);
    }
    fields.mode?.control.addEventListener('change', () => this.clearErrors());
    fields.schedule?.control.addEventListener('click', () => this.clearField('schedule'));
  }

  clearField(name) {
    const error = this.errors.get(name);
    if (!error) return;
    const control = this.fields[name].control;
    const descriptions = (control.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== error.node.id);
    if (descriptions.length) control.setAttribute('aria-describedby', descriptions.join(' '));
    else control.removeAttribute('aria-describedby');
    if (error.previousInvalid === null) control.removeAttribute('aria-invalid');
    else control.setAttribute('aria-invalid', error.previousInvalid);
    error.item.remove();
    this.errors.delete(name);
    if (this.errors.size === 0) { this.errorRow?.remove(); this.errorRow = null; }
  }

  clearErrors() {
    for (const name of this.errors.keys()) this.clearField(name);
  }

  errorContainer() {
    const tableRow = this.row.tagName === 'TR';
    if (!this.errorRow) {
      this.errorRow = this.row.ownerDocument.createElement(tableRow ? 'tr' : 'div');
      this.errorRow.className = tableRow ? 'rule-editor-feedback-row' : 'rule-editor-feedback';
      if (tableRow) {
        const cell = this.row.ownerDocument.createElement('td');
        cell.colSpan = this.row.children.length;
        this.errorRow.appendChild(cell);
      }
    }
    if (tableRow) {
      if (this.row.parentNode) this.row.after(this.errorRow);
      return this.errorRow.querySelector('td');
    }
    this.row.appendChild(this.errorRow);
    return this.errorRow;
  }

  report(codes, translate = this.translate) {
    const messages = [], unmapped = [];
    for (const code of new Set(codes)) {
      const message = translate(code);
      messages.push(message);
      const name = fieldFor(code), field = this.fields[name];
      if (!field?.control) { unmapped.push(message); continue; }
      let error = this.errors.get(name);
      if (!error) {
        const document = this.row.ownerDocument;
        const item = document.createElement('p');
        item.className = 'rule-field-error';
        const node = document.createElement('span');
        node.id = `rule-field-error-${++nextErrorId}`;
        if (!field.control.id) field.control.id = `rule-field-${nextErrorId}`;
        const link = document.createElement('a');
        link.href = `#${field.control.id}`;
        link.textContent = field.label;
        link.addEventListener('click', event => { event.preventDefault(); field.control.focus(); });
        if (field.label === message) { link.textContent = ''; link.appendChild(node); item.appendChild(link); }
        else item.append(link, document.createTextNode(': '), node);
        error = { item, node, previousInvalid: field.control.getAttribute('aria-invalid'), messages: [] };
        this.errors.set(name, error);
        this.errorContainer().appendChild(item);
        const descriptions = (field.control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
        field.control.setAttribute('aria-describedby', [...descriptions, node.id].join(' '));
      }
      if (!error.messages.includes(message)) error.messages.push(message);
      error.node.textContent = error.messages.join('\n');
      field.control.setAttribute('aria-invalid', 'true');
    }
    if (this.session) {
      this.session.messages.push(...messages);
      this.session.unmapped.push(...unmapped);
    } else if (messages.length) {
      // A caller outside the Save lifecycle cannot claim ownership of focus.
      this.notify(messages.join('\n'));
    }
  }

  focusAfterSave(resolve) {
    if (this.session) this.session.resolveFocus = resolve;
  }

  async submit(save) {
    if (this.session || this.saveButton.disabled) return;
    this.clearErrors();
    const document = this.row.ownerDocument;
    const start = document.activeElement;
    const session = { start, ownsFocus: this.row.contains(start), moved: false, messages: [], unmapped: [] };
    this.session = session;
    const onFocus = event => { if (event.target !== start && event.target !== document.body) session.moved = true; };
    document.addEventListener('focusin', onFocus);
    const controls = [...this.row.querySelectorAll('input, select, button')]
      .filter(control => control !== this.saveButton).map(control => [control, control.disabled]);
    const previousDisabled = this.saveButton.getAttribute('aria-disabled');
    this.row.setAttribute('aria-busy', 'true');
    this.saveButton.setAttribute('aria-disabled', 'true');
    for (const [control] of controls) control.disabled = true;
    try {
      await save();
    } catch (error) {
      if (typeof error?.message === 'string' && fieldFor(error.message)) this.report([error.message]);
      else this.unexpected(error);
    } finally {
      document.removeEventListener('focusin', onFocus);
      for (const [control, disabled] of controls) control.disabled = disabled;
      this.row.removeAttribute('aria-busy');
      if (previousDisabled === null) this.saveButton.removeAttribute('aria-disabled');
      else this.saveButton.setAttribute('aria-disabled', previousDisabled);
      this.session = null;
      const stillOwnsFocus = session.ownsFocus && !session.moved && !document.hidden &&
        (document.activeElement === start || document.activeElement === document.body || this.row.contains(document.activeElement));
      const firstInvalid = Object.entries(this.fields).find(([name, field]) => this.errors.has(name) && available(field?.control))?.[1].control;
      const target = (stillOwnsFocus ? session.resolveFocus?.() : null) || firstInvalid;
      const focusError = stillOwnsFocus && available(target) && target === firstInvalid;
      if (stillOwnsFocus && available(target)) target.focus();
      // Focused descriptions carry inline errors. Use one polite notice when
      // focus moved elsewhere or an error has no field, rather than both paths.
      const announcement = focusError ? session.unmapped : session.messages;
      if (announcement.length) this.notify([...new Set(announcement)].join('\n'));
    }
  }
}
