import test from 'node:test';
import assert from 'node:assert/strict';

import { ScheduleEditor } from '../schedules/scheduleEditor.js';

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...values) {
    values.forEach(value => this.values.add(value));
  }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this.className = '';
    this.textContent = '';
    this.type = '';
    this.checked = false;
    this.hidden = false;
    this.nodeType = 1;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) || []) {
      listener({ target: this });
    }
  }

  querySelector(selector) {
    const visit = element => {
      if (selector.startsWith('.') && element.className.split(/\s+/).includes(selector.slice(1))) {
        return element;
      }
      for (const child of element.children) {
        const match = visit(child);
        if (match) return match;
      }
      return null;
    };

    return visit(this);
  }
}

function withFakeDom(run) {
  const previousDocument = globalThis.document;
  const previousChrome = globalThis.browser;

  globalThis.document = {
    createElement(tagName) {
      return new FakeElement(tagName);
    }
  };
  globalThis.browser = {
    i18n: {
      getMessage(key) {
        return key;
      }
    }
  };

  try {
    return run();
  } finally {
    globalThis.document = previousDocument;
    globalThis.browser = previousChrome;
  }
}

test('an enabled schedule without opening the editor returns the default schedule', () => {
  withFakeDom(() => {
    const editor = new ScheduleEditor();
    const section = editor.createSection(null, true);
    const toggle = section.querySelector('.enable-schedule-toggle');

    toggle.checked = true;

    assert.deepEqual(editor.getSchedule(section), {
      version: 2,
      periods: [{
        days: [1, 2, 3, 4, 5],
        startTime: '09:00',
        endTime: '17:00'
      }]
    });
  });
});

test('schedule sections pass their dialog host to the schedule editor modal', () => {
  withFakeDom(() => {
    const editor = new ScheduleEditor();
    const dialogHost = new FakeElement('dialog');
    let receivedOptions = null;

    editor.openDialog = (_schedule, _onSave, options) => {
      receivedOptions = options;
    };

    const section = editor.createSection(null, true, { dialogHost });
    const toggle = section.querySelector('.enable-schedule-toggle');
    const editButton = section.querySelector('.schedule-edit-button');

    toggle.checked = true;
    toggle.dispatch('change');
    editButton.dispatch('click');

    assert.equal(receivedOptions.dialogHost, dialogHost);
  });
});
