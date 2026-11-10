const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const sass = require('sass');

test('all seven navigation actions keep their mobile emoji, accessible name and hover title', () => {
  const html = fs.readFileSync('main.html', 'utf8');
  const buttons = [...html.matchAll(/<button\b[^>]*data-icon="([^"]+)"[^>]*>/g)];
  assert.deepEqual(buttons.map(match => match[1]), ['🚪', '⚙️', '➕', '💰', '📋', '🗓️', '📖']);
  for (const [tag] of buttons) {
    const label = tag.match(/aria-label="([^"]+)"/)[1];
    assert.equal(tag.match(/title="([^"]+)"/)[1], label);
  }
});

test('icon styles are applied globally after responsive overrides', () => {
  const css = sass.compile('src/scss/robocha/_menu.scss').css;
  const globalRules = css.slice(css.lastIndexOf('@media'));
  assert.ok(globalRules.lastIndexOf('content: attr(data-icon)') > globalRules.indexOf('width: 108px'));
  assert.match(globalRules, /font-size: 0/);
  assert.match(globalRules, /:focus-visible/);
});

test('open count is a number-only badge over the calendar and does not intercept clicks', () => {
  const css = sass.compile('src/scss/robocha/tablucya/_act-counters.scss').css;
  const badge = css.match(/\.act-counters \{([^}]+)\}/)[1];
  assert.match(badge, /position: absolute/);
  assert.match(badge, /top: -3px/);
  assert.match(badge, /right: -4px/);
  assert.match(badge, /pointer-events: none/);
  assert.ok(!css.includes('Відкриті'));
  assert.match(css, /\.act-counters\[hidden\] \{\s*display: none/);
});
