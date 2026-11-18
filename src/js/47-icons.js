// ════════════════════════════════════════════════════════════════════════════
// ICONS
// ════════════════════════════════════════════════════════════════════════════
// One stroke icon set, drawn in the current text color. The shapes live in the
// sprite at the top of index.html (<symbol id="i-NAME">); markup uses
// <svg class="ic"><use href="#i-NAME"></use></svg>, and JS uses icon(name).
function icon(name, extraClass) {
  return `<svg class="ic${extraClass ? ' ' + extraClass : ''}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}
