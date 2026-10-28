import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createDnrStartupProbe, dnrReadinessReport, assertDnrReadiness, measurementEnvironment } from './dnr-readiness.mjs';
import { poll } from './fixtures.mjs';

export const dnrReadinessScenarios = [{
  id: '66', persistent: true,
  title: 'cold process DNR navigation is measured before the first extension UI',
  async prepare(e) {
    e.dnrStartupProbe = createDnrStartupProbe();
    e.config.fixtureHtml = url => e.dnrStartupProbe.htmlFor(url);
  },
  async run(e) {
    const probe = e.dnrStartupProbe;
    const report = { schemaVersion: 1, scenario: '66', scope: 'Firefox Desktop persistent process restart; first probe after WebDriver attachment, before extension UI; not earliest restored-tab traffic',
      version: e.manifest.version, environment: measurementEnvironment(),
      browser: e.result.browser.browserVersion, beforePid: e.result.browser['moz:processID'], stage: 'positive control' };
    assert.ok(Number.isInteger(report.beforePid) && report.beforePid > 0, 'original native Firefox PID');
    const marker = probe.token;
    try {
      const reachable = await e.newPage(probe.urls.reachable);
      assert.equal(await reachable.evaluate(() => document.documentElement.dataset.dnrFixture), marker);
      await e.seed({ rules: [{ id: 991, blockURL: probe.host, redirectURL: '', category: 'social', isWhitelist: false,
        assignments: [{ listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }] }] });
      const options = await e.openOptions(); await e.reconcile(options);
      await e.assertBlocked(probe.urls.target, 'always');
      await e.probe.evaluate(async token => browser.storage.local.set({ __bdDnrStartupMarker: token }), marker);
      report.stage = 'cold restart before UI';
      await e.restart({ beforeExtensionProbe: async launch => {
        report.launchedAt = launch.launchedAt;
        report.afterPid = launch.processId;
        assert.ok(Number.isInteger(report.afterPid) && report.afterPid > 0, 'new native Firefox PID');
        assert.notEqual(report.afterPid, report.beforePid, 'new Firefox process');
        probe.startColdLaunch(report.launchedAt);
        const observationFloorAt = Date.now();
        const page = await e.newPage();
        await e.command('browsingContext.navigate', { context: page.context, url: probe.urls.control, wait: 'none' });
        await poll(() => page.url(), value => {
          const url = new URL(value);
          return value.startsWith(e.baseUrl + '/blocked.html') && url.searchParams.get('url') === probe.host &&
            url.searchParams.get('reason') === 'always';
        }, 'actual DNR main-frame redirect before extension probe');
        const document = await page.evaluate(() => ({ url: location.href, documentOrigin: performance.timeOrigin }));
        report.dnr = dnrReadinessReport(probe, { ...document, at: Date.now() }, {
          extensionOrigin: e.baseUrl, observationFloorAt });
        assertDnrReadiness(report.dnr);
        report.stage = 'native DNR observed before extension UI';
      } });
      assert.equal(await e.probe.evaluate(async () =>
        (await browser.storage.local.get('__bdDnrStartupMarker')).__bdDnrStartupMarker), marker,
      'same persistent profile and installation');
      report.stage = 'complete';
    } finally {
      report.partial = probe.snapshot();
      await writeFile(path.join(e.config.output, 'cold-startup-dnr-measurement.json'), JSON.stringify(report, null, 2) + '\n');
    }
  }
}];
