// ════════════════════════════════════════════════════════════════════════════
// GAME ENGINE
// ════════════════════════════════════════════════════════════════════════════
// The pure rules live in supabase/functions/_shared/engine/ so the server runs
// the same code. They're inlined here at build time.
/* @engine cards.js */
/* @engine config.js */
/* @engine payouts.js */

// Mutable — can be edited in lobby before game starts
let BLIND_LEVELS = DEFAULT_BLIND_LEVELS.map(l => ({ ...l }));
let blindDurationSeconds = DEFAULT_BLIND_DURATION;
let gameBuyIn = 20; // Default $20 buy-in
let gameFormat = 'tournament'; // 'tournament' | 'home'
let gameVariant = 'holdem';    // for tournament: 'holdem' | 'omaha'

function getFormatConfig() {
  return FORMATS[G?.format || gameFormat] || FORMATS.tournament;
}

// Format a chip count for display. In tournament mode, returns "1,500".
// In home (money) mode, returns "$20.00" (chips represent cents).
function formatChips(chipCount) {
  if (chipCount == null) return '—';
  if (getFormatConfig().moneyMode) {
    // Chip count is in cents. Render as dollars with 2 decimals.
    const dollars = chipCount / 100;
    if (Math.abs(dollars) >= 10) return '$' + dollars.toFixed(2);
    return '$' + dollars.toFixed(2);
  }
  return chipCount.toLocaleString();
}

// Compact version for tiny labels (opponent badges). Drops zero-cent decimals.
function formatChipsCompact(chipCount) {
  if (chipCount == null) return '—';
  if (getFormatConfig().moneyMode) {
    const dollars = chipCount / 100;
    // Show cents if non-zero, else just $X
    if (chipCount % 100 === 0) return '$' + Math.floor(dollars);
    return '$' + dollars.toFixed(2);
  }
  return chipCount.toLocaleString();
}
function getVariantConfig() {
  return VARIANTS[G?.variant || gameVariant] || VARIANTS.holdem;
}
// What a player has paid in, in cents: their buy-in plus any re-buys/add-ons.
// Tournament players start with totalBuyInCents = 0 (it only gets set by a
// re-buy), so fall back to the game's buy-in.
function buyInCentsOf(p) {
  const base = (typeof gameBuyIn !== 'undefined' ? gameBuyIn : 0) || 0;
  return p.totalBuyInCents || base * 100;
}

function actualPrizePool() {
  if (!G || !G.players) return 0;
  // Was: sum of totalBuyInCents only, so a tournament pool with one $10
  // re-buy came out as $30 instead of $70.
  const totalCents = G.players.reduce((sum, p) => sum + buyInCentsOf(p), 0);
  return totalCents / 100;
}
function getBlinds(levelIndex) {
  return blindsAt(BLIND_LEVELS, levelIndex);
}
