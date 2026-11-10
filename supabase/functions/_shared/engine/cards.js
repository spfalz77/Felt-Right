// Cards, deck and hand evaluation (Hold'em, Omaha, 3-card Guts).
// Shared by the browser app (inlined by scripts/build.mjs, which strips the
// import/export keywords) and the server (supabase/functions/table).
// Pure functions only: no DOM, no globals.

export const SUITS     = ['♠','♥','♦','♣'];
export const RANKS     = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
export const RANK_VAL  = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};

// rng: () => number in [0, 1). The server passes a cryptographic one.
export function makeDeck(rng = Math.random) {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({rank:r,suit:s});
  for (let i=d.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[d[i],d[j]]=[d[j],d[i]];}
  return d;
}
export function isRed(c){ return c.suit==='♥'||c.suit==='♦'; }

export function choose5(cards) {
  if(cards.length===5) return [cards];
  const res=[];
  function comb(s,cur){
    if(cur.length===5){res.push(cur.slice());return;}
    for(let i=s;i<=cards.length-(5-cur.length);i++){cur.push(cards[i]);comb(i+1,cur);cur.pop();}
  }
  comb(0,[]);return res;
}
export function score5(cards) {
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
export function evalBest(hole, comm, variant) {
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
export function evalBestOmaha(hole, comm) {
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

export function cmpScore(a, b) {
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
export const RANK_WORDS = {2:['Two','Twos'],3:['Three','Threes'],4:['Four','Fours'],5:['Five','Fives'],6:['Six','Sixes'],
  7:['Seven','Sevens'],8:['Eight','Eights'],9:['Nine','Nines'],10:['Ten','Tens'],11:['Jack','Jacks'],
  12:['Queen','Queens'],13:['King','Kings'],14:['Ace','Aces']};
export const rankWord = (v, plural) => (RANK_WORDS[v] || [String(v), `${v}s`])[plural ? 1 : 0];

export function evalBest3Card(hole) {
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
