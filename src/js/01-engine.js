// ════════════════════════════════════════════════════════════════════════════
// GAME ENGINE
// ════════════════════════════════════════════════════════════════════════════
const SUITS     = ['♠','♥','♦','♣'];
const RANKS     = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VAL  = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};
const STARTING_CHIPS   = 1500;
const DEFAULT_BLIND_DURATION = 10 * 60; // 10 minutes per level default

// Mutable — can be edited in lobby before game starts
let BLIND_LEVELS = [
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
let blindDurationSeconds = DEFAULT_BLIND_DURATION;
let gameBuyIn = 20; // Default $20 buy-in
let gameFormat = 'tournament'; // 'tournament' | 'home'
let gameVariant = 'holdem';    // for tournament: 'holdem' | 'omaha'

// Home games play in CENTS (not chips). Stack of $20 = 2000¢.
// Default home-game blinds: $0.05 / $0.10 (5¢ / 10¢ in our integer units)
const HOME_GAME_BLINDS = { small: 5, big: 10 };
// Chip denominations in cents. UI can show stack as combinations of these,
// but the engine just uses integer cents internally.
const HOME_CHIP_DENOMS = [5, 10, 25, 100]; // 5¢, 10¢, 25¢, $1
// In a home game, blinds don't escalate (cash game), so use a single fixed level.
const HOME_BLIND_LEVELS = [{ level: 1, small: HOME_GAME_BLINDS.small, big: HOME_GAME_BLINDS.big }];

// Format configuration table — single source of truth for format-level rules.
const FORMATS = {
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

// Variant configuration table — single source of truth for cards-per-hand etc.
const VARIANTS = {
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

function getVariantConfig() {
  return VARIANTS[G?.variant || gameVariant] || VARIANTS.holdem;
}

// ── PAYOUT CALCULATION ──
// Round up to nearest $10
function roundUpTo10(amount) {
  return Math.ceil(amount / 10) * 10;
}

// Compute how the prize pool is distributed.
// Returns array of { placement: 1|2|3, amount: $ } or for chops, equal splits.
function computePayouts(buyIn, totalPlayers, isChop, actualPoolOverride) {
  // pool = sum of all dollars contributed (buy-ins + rebuys + add-ons).
  // For tournaments without rebuys, this equals buyIn × totalPlayers.
  // For tournaments WITH rebuys, the caller passes the actual pool computed
  // from sum of player totalBuyInCents.
  const pool = actualPoolOverride != null ? actualPoolOverride : (buyIn || 0) * (totalPlayers || 0);
  if (pool <= 0) return [];

  // For 7+ players, 3rd still gets buy-in back even if a chop happens
  const thirdGetsPayout = totalPlayers >= 7;
  const thirdShare = thirdGetsPayout ? buyIn : 0;
  const topTwoPool = pool - thirdShare;

  if (isChop) {
    const half = topTwoPool / 2;
    const result = [
      { placement: 1, amount: half, label: 'Chop' },
      { placement: 2, amount: half, label: 'Chop' },
    ];
    if (thirdGetsPayout) result.push({ placement: 3, amount: thirdShare });
    return result;
  }

  if (totalPlayers <= 4) {
    return [{ placement: 1, amount: pool }];
  }

  if (totalPlayers <= 6) {
    const winnerShare = roundUpTo10(pool * 0.75);
    const secondShare = pool - winnerShare;
    return [
      { placement: 1, amount: winnerShare },
      { placement: 2, amount: secondShare },
    ];
  }

  const winnerShare = roundUpTo10(topTwoPool * 0.75);
  const secondShare = topTwoPool - winnerShare;
  return [
    { placement: 1, amount: winnerShare },
    { placement: 2, amount: secondShare },
    { placement: 3, amount: thirdShare },
  ];
}

// Helper: compute the actual prize pool from G state (sums all rebuy/add-on contributions).
// Returns dollars (not cents).
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
  if (levelIndex < BLIND_LEVELS.length) {
    return BLIND_LEVELS[levelIndex];
  }
  // Beyond the defined structure: keep doubling from the last level
  const last = BLIND_LEVELS[BLIND_LEVELS.length - 1];
  const doublings = levelIndex - (BLIND_LEVELS.length - 1);
  const factor = Math.pow(2, doublings);
  return {
    level: levelIndex + 1,
    small: last.small * factor,
    big:   last.big   * factor,
  };
}

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({rank:r,suit:s});
  for (let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]];}
  return d;
}
function isRed(c){ return c.suit==='♥'||c.suit==='♦'; }

function choose5(cards) {
  if(cards.length===5) return [cards];
  const res=[];
  function comb(s,cur){
    if(cur.length===5){res.push(cur.slice());return;}
    for(let i=s;i<=cards.length-(5-cur.length);i++){cur.push(cards[i]);comb(i+1,cur);cur.pop();}
  }
  comb(0,[]);return res;
}
function score5(cards) {
  const vals=cards.map(c=>RANK_VAL[c.rank]).sort((a,b)=>b-a);
  const suits=cards.map(c=>c.suit);
  const flush=suits.every(s=>s===suits[0]);
  const straight=vals[0]-vals[4]===4&&new Set(vals).size===5;
  const wheel=vals.join()===[14,5,4,3,2].join();
  const cnt={};for(const v of vals)cnt[v]=(cnt[v]||0)+1;
  const grps=Object.entries(cnt).map(([v,c])=>({val:+v,count:c})).sort((a,b)=>b.count-a.count||b.val-a.val);
  const gc=grps.map(g=>g.count);
  let rank,name;
  if((straight||wheel)&&flush){rank=8;name='Straight Flush';}
  else if(gc[0]===4){rank=7;name='Four of a Kind';}
  else if(gc[0]===3&&gc[1]===2){rank=6;name='Full House';}
  else if(flush){rank=5;name='Flush';}
  else if(straight||wheel){rank=4;name='Straight';}
  else if(gc[0]===3){rank=3;name='Three of a Kind';}
  else if(gc[0]===2&&gc[1]===2){rank=2;name='Two Pair';}
  else if(gc[0]===2){rank=1;name='One Pair';}
  else{rank=0;name='High Card';}
  // A-2-3-4-5 (wheel) is a 5-high straight: the ace plays low for tiebreaks.
  const tieVals=(wheel&&rank>=4&&rank!==5)?[5,4,3,2,1]:grps.flatMap(g=>Array(g.count).fill(g.val));
  return{rank,name,tieVals};
}
function evalBest(hole, comm, variant) {
  // Route to variant-specific evaluation
  if (variant === 'omaha') return evalBestOmaha(hole, comm);
  if (variant === 'guts3') return evalBest3Card(hole);
  // Default: Hold'em — best 5 of any 7 (2 hole + 5 community)
  const all = [...hole, ...comm];
  // Tag each card with its source so we can identify it after picking
  const tagged = all.map((c, i) => ({
    ...c,
    _idx: i,
    _src: i < hole.length ? 'hole' : 'comm',
    _srcIdx: i < hole.length ? i : i - hole.length,
  }));
  let best = null;
  let bestCards = null;
  // Iterate all C(7,5) = 21 combinations
  const n = tagged.length;
  for (let a = 0; a < n - 4; a++) {
    for (let b = a + 1; b < n - 3; b++) {
      for (let c = b + 1; c < n - 2; c++) {
        for (let d = c + 1; d < n - 1; d++) {
          for (let e = d + 1; e < n; e++) {
            const five = [tagged[a], tagged[b], tagged[c], tagged[d], tagged[e]];
            const score = score5(five);
            if (!best || cmpScore(score, best) > 0) {
              best = score;
              bestCards = five;
            }
          }
        }
      }
    }
  }
  if (best) {
    best.usedHoleIdx = bestCards.filter(c => c._src === 'hole').map(c => c._srcIdx);
    best.usedCommIdx = bestCards.filter(c => c._src === 'comm').map(c => c._srcIdx);
  }
  return best;
}

// Omaha: must use EXACTLY 2 hole cards + EXACTLY 3 community cards.
// C(4,2) × C(5,3) = 60 combinations.
function evalBestOmaha(hole, comm) {
  if (!hole || hole.length < 4 || comm.length < 5) {
    // Fallback if cards are missing — shouldn't happen but be safe
    return evalBest(hole, comm); // hold'em mode
  }
  let best = null;
  let usedHole = null;
  let usedComm = null;
  for (let h1 = 0; h1 < hole.length; h1++) {
    for (let h2 = h1 + 1; h2 < hole.length; h2++) {
      for (let c1 = 0; c1 < comm.length; c1++) {
        for (let c2 = c1 + 1; c2 < comm.length; c2++) {
          for (let c3 = c2 + 1; c3 < comm.length; c3++) {
            const five = [hole[h1], hole[h2], comm[c1], comm[c2], comm[c3]];
            const score = score5(five);
            if (!best || cmpScore(score, best) > 0) {
              best = score;
              usedHole = [h1, h2];
              usedComm = [c1, c2, c3];
            }
          }
        }
      }
    }
  }
  if (best) {
    best.usedHoleIdx = usedHole;
    best.usedCommIdx = usedComm;
  }
  return best;
}

function cmpScore(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < a.tieVals.length; i++) if (a.tieVals[i] !== b.tieVals[i]) return a.tieVals[i] - b.tieVals[i];
  return 0;
}

// ── 3-CARD HAND EVALUATION (for Guts) ────────────────────────────────────────
// House rankings (high to low):
//   5: Three of a kind
//   4: Straight (3 sequential ranks)
//   3: Flush (all same suit)
//   2: Pair
//   1: High card
// Note: A straight beats a flush in this house rule (unusual but per rules).
// Returns { rank, name, tieVals, usedHoleIdx }
// 14 → 'Aces' / 'Ace', 6 → 'Sixes' / 'Six', for 3-card hand names
const RANK_WORDS = {2:['Two','Twos'],3:['Three','Threes'],4:['Four','Fours'],5:['Five','Fives'],6:['Six','Sixes'],
  7:['Seven','Sevens'],8:['Eight','Eights'],9:['Nine','Nines'],10:['Ten','Tens'],11:['Jack','Jacks'],
  12:['Queen','Queens'],13:['King','Kings'],14:['Ace','Aces']};
const rankWord = (v, plural) => (RANK_WORDS[v] || [String(v), `${v}s`])[plural ? 1 : 0];

function evalBest3Card(hole) {
  if (!hole || hole.length !== 3) return null;
  // Map ranks to numeric values. A=14, K=13, ..., 2=2. A can also be low for A-2-3.
  const rankMap = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
  const vals = hole.map(c => rankMap[c.rank]);
  const suits = hole.map(c => c.suit);
  const sortedVals = [...vals].sort((a,b) => b-a); // high to low

  const allSameSuit = suits[0] === suits[1] && suits[1] === suits[2];

  // Check straight (3 consecutive, A high or A low)
  const sortedAsc = [...vals].sort((a,b) => a-b);
  let isStraight = (sortedAsc[1] === sortedAsc[0]+1 && sortedAsc[2] === sortedAsc[1]+1);
  // Ace-low straight: A-2-3 → vals [14,2,3]
  const isWheel = sortedAsc[0]===2 && sortedAsc[1]===3 && sortedAsc[2]===14;
  if (isWheel) isStraight = true;

  // Count rank frequencies
  const counts = {};
  vals.forEach(v => counts[v] = (counts[v]||0) + 1);
  const countVals = Object.values(counts).sort((a,b)=>b-a);

  // Three of a kind
  if (countVals[0] === 3) {
    return { rank: 5, name: `Three ${rankWord(vals[0], true)}`, tieVals: [vals[0]], usedHoleIdx: [0,1,2] };
  }
  // Straight (beats flush per house rule)
  if (isStraight) {
    const topCard = isWheel ? 3 : sortedAsc[2]; // wheel: 3 is top, otherwise highest
    return { rank: 4, name: 'Straight', tieVals: [topCard], usedHoleIdx: [0,1,2] };
  }
  // Flush
  if (allSameSuit) {
    return { rank: 3, name: 'Flush', tieVals: sortedVals, usedHoleIdx: [0,1,2] };
  }
  // Pair
  if (countVals[0] === 2) {
    const pairVal = parseInt(Object.keys(counts).find(k => counts[k]===2));
    const kicker = parseInt(Object.keys(counts).find(k => counts[k]===1));
    return { rank: 2, name: `Pair of ${rankWord(pairVal, true)}`, tieVals: [pairVal, kicker], usedHoleIdx: [0,1,2] };
  }
  // High card
  return { rank: 1, name: `${rankWord(sortedVals[0])} high`, tieVals: sortedVals, usedHoleIdx: [0,1,2] };
}

