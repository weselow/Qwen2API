const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const dashboard = fs.readFileSync(require.resolve('../public/src/views/dashboard.vue'), 'utf8');

test('dashboard renders inactive CLI states as hover-only gray hint', () => {
  assert.match(dashboard, /v-if="isCliInactive\(token\.email\)"/);
  assert.match(dashboard, /\:title="getStatusTooltip\(token\.email\)"/);
  assert.match(dashboard, /getCliInactiveLabel\(token\.email\)/);
  assert.match(dashboard, /text-gray-400/);
  assert.match(dashboard, /v-if="cliExpanded && !isCliInactive\(token\.email\) && getStatusKind\(token\.email\) !== 'cli_pending'"/);
});

test('inactive CLI states cover both unsupported and disabled', () => {
  assert.match(dashboard, /cli_unsupported: 'dash\.acct\.cliUnavailableShort'/);
  assert.match(dashboard, /cli_disabled: 'dash\.acct\.cliDisabledShort'/);
  assert.match(dashboard, /cli_disabled: '⚫'/);
  assert.match(dashboard, /kind === 'cli_disabled'/);
});

test('dashboard renders pending CLI state as blue hint', () => {
  assert.match(dashboard, /v-else-if="getStatusKind\(token\.email\) === 'cli_pending'"/);
  assert.match(dashboard, /cliPendingShort/);
  assert.match(dashboard, /text-blue-400/);
});

test('every locale defines the new cli_disabled strings', () => {
  for (const lang of ['ru', 'zh', 'en']) {
    const messages = JSON.parse(fs.readFileSync(require.resolve(`../public/src/locales/${lang}.json`), 'utf8'));
    assert.ok(messages.dash.acct.cliDisabledShort, `${lang}: dash.acct.cliDisabledShort is missing`);
    assert.ok(messages.dash.acct.status.cliDisabled, `${lang}: dash.acct.status.cliDisabled is missing`);
  }
});
