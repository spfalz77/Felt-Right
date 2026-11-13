// Formats, variants and blind structures.
// Shared by the browser app (inlined by scripts/build.mjs, which strips the
// import/export keywords) and the server (supabase/functions/table).
// Pure functions only: no DOM, no globals.

export const STARTING_CHIPS   = 1500;
export const DEFAULT_BLIND_DURATION = 10 * 60; // 10 minutes per level default

// Default tournament blind structure (the lobby can edit a copy before the game starts)
export const DEFAULT_BLIND_LEVELS = [
  {level:1,  small:10,  big:20  },
  {level:2,  small:15,  big:30  },
  {level:3,  small:25,  big:50  },
  {level:4,  small:50,  big:100 },
  {level:5,  small:75,  big:150 },
  {level:6,  small:100, big:200 },
  {level:7,  small:150, big:300 },
  {level:8,  small:200, big:400 },
  {level:9,  small:300, big:600 },
  {level:10, small:500, big:1000},
];

// Home games play in CENTS (not chips). Stack of $20 = 2000¢.
// Default home-game blinds: $0.05 / $0.10 (5¢ / 10¢ in our integer units)
export const HOME_GAME_BLINDS = { small: 5, big: 10 };
// Chip denominations in cents. UI can show stack as combinations of these,
// but the engine just uses integer cents internally.
export const HOME_CHIP_DENOMS = [5, 10, 25, 100]; // 5¢, 10¢, 25¢, $1
// In a home game, blinds don't escalate (cash game), so use a single fixed level.
export const HOME_BLIND_LEVELS = [{ level: 1, small: HOME_GAME_BLINDS.small, big: HOME_GAME_BLINDS.big }];
// Format configuration table — single source of truth for format-level rules.
export const FORMATS = {
  tournament: {
    name: 'Tournament',
    startingChips: 1500,
    blindsEscalate: true,
    chopAllowed: true,
    dealerChoiceVariant: false,
    moneyMode: false, // chips are abstract
  },
  home: {
    name: 'Home Game',
    startingChips: 2000, // $20 = 2000¢ at 1¢ resolution (matches buy-in default)
    blindsEscalate: false,
    chopAllowed: false,
    dealerChoiceVariant: true,
    moneyMode: true, // chips represent cents
  },
};
// Variant configuration table — single source of truth for cards-per-hand etc.
export const VARIANTS = {
  holdem: {
    name: "Texas Hold'em",
    short: 'HOLDEM',
    holeCards: 2,
    description: '2 hole cards · best 5 of 7',
    style: 'community',     // engine flow style
    homeOnly: false,
  },
  omaha: {
    name: 'Omaha',
    short: 'OMAHA',
    holeCards: 4,
    description: '4 hole cards · must use exactly 2',
    style: 'community',
    homeOnly: false,
  },
  // Pineapple family: 3 hole cards, discard 1, then play as Hold'em (best 5 of 7).
  // discardAt: 'preflop' = everyone discards right after the deal, before the
  // first betting round; 'flop' = after the flop is dealt, before flop betting.
  // serverOnly: needs the server engine (the phone-run engine can't discard).
  pineapple: {
    name: 'Pineapple',
    short: 'PINEAPPLE',
    holeCards: 3,
    keepCards: 2,
    discardAt: 'preflop',
    description: '3 hole cards · discard 1 before betting',
    style: 'community',
    homeOnly: false,
    serverOnly: true,
  },
  crazy_pineapple: {
    name: 'Crazy Pineapple',
    short: 'CRAZY PINEAPPLE',
    holeCards: 3,
    keepCards: 2,
    discardAt: 'flop',
    description: '3 hole cards · discard 1 after the flop',
    style: 'community',
    homeOnly: false,
    serverOnly: true,
  },
  // 5-card draw: blinds, a betting round, everyone draws 0–3 at once, a second
  // betting round, showdown. No board.
  draw5: {
    name: '5-Card Draw',
    short: 'DRAW',
    holeCards: 5,
    maxDraw: 3,
    description: '5 cards · draw up to 3 · two betting rounds',
    style: 'draw',
    homeOnly: false,
    serverOnly: true,
  },
  // 5-card stud: everyone antes the small blind; 1 card down + 1 up; the lowest
  // upcard brings it in for the small blind; one more upcard per street
  // (4 betting rounds); the best showing hand acts first after 2nd street.
  stud5: {
    name: '5-Card Stud',
    short: 'STUD',
    holeCards: 2,
    totalCards: 5,
    description: '1 down, 4 up · ante + bring-in',
    style: 'stud',
    homeOnly: false,
    serverOnly: true,
  },
  guts3: {
    name: '3-Card Guts',
    short: 'GUTS',
    holeCards: 3,
    description: '3 cards · in/out · match full pot',
    style: 'guts',
    homeOnly: true,
    // ante and re-deal ante always equal the BB (resolved at runtime via getBlinds())
    decisionTimerSec: 20,
    matchPotFraction: 1.0,
  },
};

// Seconds everyone gets to pick a discard (Pineapple variants), else one is picked for them
export const DISCARD_SECONDS = 20;
// Seconds everyone gets to choose cards to draw (5-card draw), else they stand pat
export const DRAW_SECONDS = 25;
// Everyone's all-in: the rest of the board is dealt one card at a time, this
// many seconds apart, with the hands face up (house setting: tune to taste)
export const RUNOUT_CARD_SECONDS = 4;
// A hand's result stays on screen until everyone still at the table taps OK,
// or this long at most
export const RESULT_MAX_SECONDS = 30;

// Blinds for a level index, from a blind structure. Beyond the defined
// structure, keep doubling from the last level.
export function blindsAt(levels, levelIndex) {
  if (levelIndex < levels.length) return levels[levelIndex];
  const last = levels[levels.length - 1];
  const factor = Math.pow(2, levelIndex - (levels.length - 1));
  return { level: levelIndex + 1, small: last.small * factor, big: last.big * factor };
}
