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
let gameBuyIn = 20; // Stored in hundreds of chips: 20 = a 2,000-chip buy-in
let gameFormat = 'tournament'; // 'tournament' | 'home'
let gameVariant = 'holdem';    // for tournament: 'holdem' | 'omaha'

function getFormatConfig() {
  return FORMATS[G?.format || gameFormat] || FORMATS.tournament;
}

// Format a chip count for display: whole chips, e.g. "1,500". Home games
// store stacks in what used to be cents; on screen 1 unit = 1 chip, and there
// is no currency anywhere in the app.
function formatChips(chipCount) {
  if (chipCount == null) return '—';
  return Math.round(chipCount).toLocaleString();
}
function formatChipsCompact(chipCount) {
  return formatChips(chipCount);
}

// Amounts outside a hand (buy-ins, re-buys, cash-outs, prizes, standings) are
// stored as cents for history (buy_in_amount and payout_ledger.amount are in
// "dollars", i.e. hundreds of chips). Show them as whole chips.
function chipAmt(cents) { return Math.round(cents || 0).toLocaleString(); }
function chipNet(cents) {
  const v = Math.round(cents || 0);
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString();
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
  const totalCents = G.players.reduce((sum, p) => sum + buyInCentsOf(p), 0);
  return totalCents / 100;
}
function getBlinds(levelIndex) {
  return blindsAt(BLIND_LEVELS, levelIndex);
}
