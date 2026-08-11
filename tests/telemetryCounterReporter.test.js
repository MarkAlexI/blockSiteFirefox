import test from 'node:test';
import assert from 'node:assert/strict';
import { recordTelemetryCounter } from '../telemetry/telemetryCounterReporter.js';

test('telemetry counter reporter sends allowlisted counters through Firefox messaging', () => {
  const messages = [];
  let catchCalls = 0;
  const runtimeApi = {
    sendMessage(message) {
      messages.push(message);
      return {
        catch(handler) {
          catchCalls += 1;
          handler(new Error('No receiver'));
        }
      };
    }
  };

  const reported = recordTelemetryCounter('feedback_review_clicked', { runtimeApi });

  assert.equal(reported, true);
  assert.deepEqual(messages, [{
    type: 'telemetry:incrementCounter',
    name: 'feedback_review_clicked'
  }]);
  assert.equal(catchCalls, 1);
});

test('telemetry counter reporter rejects unknown counters before messaging', () => {
  let calls = 0;
  const runtimeApi = {
    sendMessage() { calls += 1; }
  };

  assert.equal(recordTelemetryCounter('feedback_private_value', { runtimeApi }), false);
  assert.equal(calls, 0);
});

test('telemetry counter reporter never propagates runtime messaging failures', () => {
  const runtimeApi = {
    sendMessage() { throw new Error('runtime unavailable'); }
  };

  assert.doesNotThrow(() => {
    assert.equal(recordTelemetryCounter('feedback_prompt_shown', { runtimeApi }), false);
  });
});
