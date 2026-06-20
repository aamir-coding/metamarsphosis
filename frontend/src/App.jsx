import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { io } from "socket.io-client";


// ═══════════════════════════════════════════════════════════════════════
// CORPORATIONS  (12 total — 2 dealt per player, pick 1)
// ═══════════════════════════════════════════════════════════════════════
const CORPS = [
  { id:"credicor",    name:"CrediCor",    color:"#e74c3c", startMC:57,
    desc:"When TR goes above 30, gain 4 MC." },
  { id:"ecoline",     name:"EcoLine",     color:"#27ae60", startMC:36, startProd:{plants:2}, startRes:{plants:3},
    desc:"3 plants + 2 plant prod. Convert 6 plants (not 8) into a greenery." },
  { id:"helion",      name:"Helion",      color:"#e67e22", startMC:42, startProd:{heat:3}, startRes:{heat:3},
    desc:"3 heat + 3 heat prod. Heat may be used as MC." },
  { id:"inventrix",   name:"Inventrix",   color:"#3498db", startMC:45, bonusCards:3,
    desc:"Draw 3 free cards. Card global requirements are ±2." },
  { id:"mining",      name:"Mining Guild",color:"#95a5a6", startMC:30, startProd:{steel:1}, startRes:{steel:5},
    desc:"5 steel + 1 steel prod. Tile on steel/Ti bonus → +1 that production." },
  { id:"phobolog",    name:"PhoboLog",    color:"#8e44ad", startMC:23, startRes:{titanium:10},
    desc:"10 titanium. Each titanium worth 4 MC instead of 3." },
  { id:"saturn",      name:"Saturn Systems",color:"#2980b9",startMC:42, startProd:{titanium:1},
    desc:"1 titanium prod. Each Jovian tag (any player) → +1 MC prod for you." },
  { id:"tharsis",     name:"Tharsis Republic",color:"#c0392b",startMC:40, firstAction:"city",
    desc:"First action: place a city. Any city on Mars → you gain +1 MC prod. Your city → +3 MC." },
  { id:"thorgate",    name:"Thorgate",    color:"#f39c12", startMC:48, startProd:{energy:1},
    desc:"1 energy prod. Power-tag cards cost 3 MC less." },
  { id:"unmi",        name:"U.N. Mars Initiative",color:"#1abc9c",startMC:40,
    desc:"Action: if your TR was raised this generation, pay 3 MC to raise TR 1 step." },
  { id:"teractor",    name:"Teractor",    color:"#e91e63", startMC:60,
    desc:"Earth-tag cards cost 3 MC less." },
  { id:"interplanet", name:"Interplanetary Cinematics",color:"#607d8b",startMC:30, startRes:{steel:20},
    desc:"20 steel. When you play an event card, gain 2 MC." },
];

// ═══════════════════════════════════════════════════════════════════════
// GAME ENGINE HELPERS  (pure functions — no side effects)
// ═══════════════════════════════════════════════════════════════════════
const clamp = (v,lo,hi)=>Math.min(hi,Math.max(lo,v));

function upd(state,pIdx,fn){
  return {...state, players:state.players.map((p,i)=>i===pIdx?fn(p):p)};
}

function prodDelta(state,pIdx,d){
  return upd(state,pIdx,p=>{
    const r={};
    Object.entries(d).forEach(([k,v])=>{ r[k+"Prod"]=clamp((p[k+"Prod"]||0)+v,-5,99); });
    return {...p,...r};
  });
}
function resDelta(state,pIdx,d){
  return upd(state,pIdx,p=>{
    const r={};
    Object.entries(d).forEach(([k,v])=>{ r[k]=Math.max(0,(p[k]||0)+v); });
    return {...p,...r};
  });
}

function raiseTR(state,pid,amt=1){
  let ns = {
    ...state,
    players: state.players.map(p=>
      p.id===pid ? {...p, _prevTR:p.TR, TR:p.TR+amt, trRaisedThisGen:true} : p
    ),
  };
  return triggerCrediCor(ns);
}
function raiseTemp(state,pid){
  if(state.temperature>=8) return state;
  return raiseTR({...state,temperature:Math.min(8,state.temperature+2)},pid);
}
function raiseOxygen(state,pid){
  if(state.oxygen>=14) return state;
  let ns={...state,oxygen:Math.min(14,state.oxygen+1)};
  ns=raiseTR(ns,pid);
  if(state.oxygen<8&&ns.oxygen>=8) ns=raiseTemp(ns,pid);
  return ns;
}

function placementBonus(state,pIdx,hexId){
  const hex=state.board.find(h=>h.id===hexId);
  if(!hex) return state;
  const d={};
  hex.bonus.forEach(b=>{
    if(b==="mc")       d.mc=(d.mc||0)+1;
    else if(b==="steel")    d.steel=(d.steel||0)+1;
    else if(b==="titanium") d.titanium=(d.titanium||0)+1;
    else if(b==="plant")    d.plants=(d.plants||0)+1;
    // "card" → draw a card  (Phase 2)
  });
  const adjOceans=adjHexes(hexId,state.board).filter(h=>h.tileType==="ocean").length;
  d.mc=(d.mc||0)+adjOceans*2;
  return resDelta(state,pIdx,d);
}

function checkEnd(state){
  if(state.temperature>=8&&state.oxygen>=14&&state.oceansPlaced>=9)
    return {...state,gameOver:true};
  return state;
}
function spendAction(state,pIdx){
  const left=(state.players[pIdx].actionsLeft||2)-1;
  if(left<=0){
    let ns=upd(state,pIdx,p=>({...p,actionsLeft:0}));
    return nextActivePlayer(ns);
  }
  return upd(state,pIdx,p=>({...p,actionsLeft:left}));
}
function nextActivePlayer(state){
  const n=state.players.length;
  let idx=(state.activePlayerIdx+1)%n, tries=0;
  while(state.players[idx].passed&&tries<n){idx=(idx+1)%n;tries++;}
  return {...state,activePlayerIdx:idx};
}

// ═══════════════════════════════════════════════════════════════════════
// BOARD  (61 hexes — Tharsis map approximation)
// ═══════════════════════════════════════════════════════════════════════
const OCEAN_HEXES=new Set([
  "0,-4","1,-4","2,-4","3,-4","4,-4",
  "-1,-3","0,-3","1,-3","2,-3","3,-3","4,-3","2,-2"
]);
const BONUS_MAP={
  "1,-4":["steel","steel"],"2,-4":["titanium"],"3,-4":["titanium"],
  "0,-3":["card"],"3,-3":["steel"],
  "3,-2":["titanium"],"4,-2":["titanium"],
  "-2,-2":["plant"],"0,-2":["plant"],
  "-3,-1":["plant"],"-1,-1":["plant","plant"],"2,-1":["steel"],"3,-1":["steel"],"4,-1":["steel"],
  "-4,0":["plant"],"0,0":["mc","mc"],"2,0":["card"],"3,0":["steel"],
  "-4,1":["plant","plant"],"-3,1":["plant"],"-1,1":["plant"],"0,1":["plant"],
  "-4,2":["plant","plant"],"-3,2":["plant"],"-2,2":["plant"],"-1,2":["plant","plant"],"1,2":["card"],
  "-4,3":["plant"],
};
const HEX_NAMES={"-2,0":"Noctis"};

function genBoard(){
  const hexes=[];
  for(let r=-4;r<=4;r++){
    const qMin=Math.max(-4,-r-4),qMax=Math.min(4,-r+4);
    for(let q=qMin;q<=qMax;q++){
      const id=`${q},${r}`;
      hexes.push({id,q,r,isOcean:OCEAN_HEXES.has(id),bonus:BONUS_MAP[id]||[],
        name:HEX_NAMES[id]||null,tileType:null,owner:null});
    }
  }
  return hexes;
}

const HS=24, BW=460, BH=400;
function hcenter(q,r){return{x:BW/2+HS*Math.sqrt(3)*(q+r/2),y:BH/2+HS*1.5*r};}
function hpts(q,r,sz=HS){
  const{x:cx,y:cy}=hcenter(q,r);
  return Array.from({length:6},(_,i)=>{
    const a=Math.PI/3*i-Math.PI/6;
    return`${(cx+sz*Math.cos(a)).toFixed(1)},${(cy+sz*Math.sin(a)).toFixed(1)}`;
  }).join(" ");
}
function adjIds(q,r){
  return[[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]].map(([dq,dr])=>`${q+dq},${r+dr}`);
}
function adjHexes(hexId,board){
  const h=board.find(x=>x.id===hexId);
  if(!h)return[];
  return adjIds(h.q,h.r).map(id=>board.find(x=>x.id===id)).filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════
// MILESTONES & AWARDS
// ═══════════════════════════════════════════════════════════════════════
const MILESTONES=[
  {id:"terraformer",name:"Terraformer",req:"TR ≥ 35",     check:(p,_)=>p.TR>=35},
  {id:"mayor",      name:"Mayor",      req:"≥ 3 cities",  check:(p,s)=>s.board.filter(h=>h.owner===p.id&&h.tileType==="city").length>=3},
  {id:"gardener",   name:"Gardener",   req:"≥ 3 greeneries",check:(p,s)=>s.board.filter(h=>h.owner===p.id&&h.tileType==="greenery").length>=3},
  {id:"builder",    name:"Builder",    req:"≥ 8 bldg tags",check:(p,_)=>(p.tags?.building||0)>=8},
  {id:"planner",    name:"Planner",    req:"≥ 16 in hand", check:(p,_)=>p.hand.length>=16},
];
const AWARDS=[
  {id:"landlord",  name:"Landlord",  desc:"Most tiles",        score:(p,s)=>s.board.filter(h=>h.owner===p.id).length},
  {id:"banker",    name:"Banker",    desc:"Highest MC prod",   score:(p,_)=>p.mcProd},
  {id:"scientist", name:"Scientist", desc:"Most science tags",  score:(p,_)=>p.tags?.science||0},
  {id:"thermalist",name:"Thermalist",desc:"Most heat cubes",    score:(p,_)=>p.heat},
  {id:"miner",     name:"Miner",     desc:"Most steel+titanium",score:(p,_)=>p.steel+p.titanium},
];



// ═══════════════════════════════════════════════════════════════════════
// PROJECT CARDS  (25 cards — Green/Blue/Red)
// Each card: id, name, cost, type, tags[], req, desc
// play(state,pIdx)→state  |  action?{label,canUse,apply}  |  vp
// ═══════════════════════════════════════════════════════════════════════
function mkCard(o){return o;}

const CARDS_DATA = [
  // ── GREEN (automated) ─────────────────────────────────────────────
  mkCard({
    id:"adaptedLichen", name:"Adapted Lichen", cost:9, type:"green", tags:["plant"],
    req:null, desc:"+1 plant production", vp:0,
    play:(s,pi)=>prodDelta(s,pi,{plants:1}),
  }),
  mkCard({
    id:"nitrophilicMoss", name:"Nitrophilic Moss", cost:8, type:"green", tags:["plant"],
    req:{minOceans:2}, desc:"Req ≥2 oceans. +2 plant production", vp:0,
    play:(s,pi)=>prodDelta(s,pi,{plants:2}),
  }),
  mkCard({
    id:"solarPower", name:"Solar Power", cost:11, type:"green", tags:["power","space"],
    req:null, desc:"+1 energy production", vp:1,
    play:(s,pi)=>prodDelta(s,pi,{energy:1}),
  }),
  mkCard({
    id:"peroxidePower", name:"Peroxide Power", cost:7, type:"green", tags:["power"],
    req:null, desc:"-1 plant prod, +2 energy production", vp:0,
    play:(s,pi)=>prodDelta(s,pi,{plants:-1,energy:2}),
  }),
  mkCard({
    id:"undergroundDet", name:"Underground Detonations", cost:6, type:"green", tags:["building"],
    req:null, desc:"+2 heat production", vp:0,
    play:(s,pi)=>prodDelta(s,pi,{heat:2}),
  }),
  mkCard({
    id:"moholeExcavation", name:"Mohole Excavation", cost:13, type:"green", tags:["building"],
    req:null, desc:"+4 heat production", vp:0,
    play:(s,pi)=>prodDelta(s,pi,{heat:4}),
  }),
  mkCard({
    id:"nuclearPower", name:"Nuclear Power", cost:10, type:"green", tags:["earth","power"],
    req:null, desc:"-2 MC prod, +3 energy production", vp:0,
    play:(s,pi)=>prodDelta(s,pi,{mc:-2,energy:3}),
  }),
  mkCard({
    id:"tundraFarming", name:"Tundra Farming", cost:16, type:"green", tags:["plant"],
    req:{minTemp:-6}, desc:"Req temp ≥-6°C. +1 plant prod, +2 MC", vp:2,
    play:(s,pi)=>{let ns=prodDelta(s,pi,{plants:1}); return resDelta(ns,pi,{mc:2});},
  }),
  mkCard({
    id:"greenhouse", name:"Greenhouse", cost:6, type:"green", tags:["plant","building"],
    req:{minOceans:1}, desc:"Req ≥1 ocean. +1 plant production", vp:0,
    play:(s,pi)=>prodDelta(s,pi,{plants:1}),
  }),
  mkCard({
    id:"sponsors", name:"Sponsors", cost:6, type:"green", tags:["earth"],
    req:null, desc:"+1 MC production", vp:0,
    play:(s,pi)=>prodDelta(s,pi,{mc:1}),
  }),
  mkCard({
    id:"colonizer", name:"Colonizer Training Camp", cost:8, type:"green", tags:["plant","earth"],
    req:{maxOxygen:5}, desc:"Req O₂≤5%. +2 plant production", vp:0,
    play:(s,pi)=>prodDelta(s,pi,{plants:2}),
  }),
  mkCard({
    id:"immigrantCity", name:"Immigrant City", cost:13, type:"green", tags:["city","building"],
    req:null, desc:"+2 energy prod, -1 plant prod. Place a city. +1 MC prod per city on board.", vp:0,
    play:(s,pi)=>{
      // Count cities AFTER this one will be placed
      const cities=s.board.filter(h=>h.tileType==="city").length;
      let ns=prodDelta(s,pi,{energy:2,plants:-1,mc:cities+1});
      return {...ns, pendingTile:{type:"city",pid:s.players[pi].id,pIdx:pi,fromCard:"immigrantCity"}};
    },
  }),
  // ── BLUE (active) ──────────────────────────────────────────────────
  mkCard({
    id:"ironWorks", name:"Iron Works", cost:11, type:"blue", tags:["building"],
    req:null, desc:"Action: spend 4 energy → +1 steel, raise O₂", vp:0,
    play:(s,_)=>s,
    action:{
      label:"Iron Works: 4⚡→steel+O₂",
      canUse:(s,pi)=>s.players[pi].energy>=4&&s.oxygen<14,
      apply:(s,pi)=>{let ns=resDelta(s,pi,{energy:-4,steel:1});return raiseOxygen(ns,s.players[pi].id);},
    },
  }),
  mkCard({
    id:"caretakerContract", name:"Caretaker Contract", cost:3, type:"blue", tags:["earth"],
    req:{minTemp:0}, desc:"Req temp≥0°C. Action: spend 8 heat → raise TR 1 step", vp:0,
    play:(s,_)=>s,
    action:{
      label:"Caretaker: 8🔥→TR",
      canUse:(s,pi)=>s.players[pi].heat>=8,
      apply:(s,pi)=>{let ns=resDelta(s,pi,{heat:-8});return raiseTR(ns,s.players[pi].id);},
    },
  }),
  mkCard({
    id:"aquiferPumping", name:"Aquifer Pumping", cost:18, type:"blue", tags:["building"],
    req:null, desc:"Action: spend 8 steel → place an ocean tile", vp:0,
    play:(s,_)=>s,
    action:{
      label:"Pumping: 8⬡→Ocean",
      canUse:(s,pi)=>s.players[pi].steel>=8&&s.oceansPlaced<9,
      apply:(s,pi)=>{
        let ns=resDelta(s,pi,{steel:-8});
        return {...ns,pendingTile:{type:"ocean",pid:ns.players[pi].id,pIdx:pi,fromAction:true}};
      },
    },
  }),
  mkCard({
    id:"advancedAlloys", name:"Advanced Alloys", cost:9, type:"blue", tags:["science"],
    req:null, desc:"Effect: your steel = 3 MC, your titanium = 4 MC", vp:0,
    play:(s,pi)=>upd(s,pi,p=>({...p,steelValue:3,tiValue:4})),
  }),
  mkCard({
    id:"windmills", name:"Windmills", cost:6, type:"blue", tags:["power"],
    req:{minTemp:-20}, desc:"Effect: +1 energy production per 5 temp steps above -25°C", vp:1,
    play:(s,pi)=>{
      const steps=Math.floor((s.temperature+30)/2);
      const bonus=Math.max(0,Math.floor(steps/5));
      return prodDelta(s,pi,{energy:Math.max(1,bonus)});
    },
  }),
  mkCard({
    id:"powerGrid", name:"Power Grid", cost:18, type:"blue", tags:["power","building"],
    req:null, desc:"+1 energy production for each city currently on board", vp:0,
    play:(s,pi)=>{
      const cities=s.board.filter(h=>h.tileType==="city").length;
      return prodDelta(s,pi,{energy:Math.max(1,cities)});
    },
  }),
  // ── RED (events) ──────────────────────────────────────────────────
  mkCard({
    id:"miningExpedition", name:"Mining Expedition", cost:12, type:"red", tags:["building"],
    req:null, desc:"+1 steel production, raise O₂", vp:0,
    play:(s,pi)=>{let ns=prodDelta(s,pi,{steel:1});return raiseOxygen(ns,s.players[pi].id);},
  }),
  mkCard({
    id:"electrolyticSmelting", name:"Electrolytic Smelting", cost:17, type:"red", tags:["building"],
    req:null, desc:"+1 titanium production, raise O₂", vp:0,
    play:(s,pi)=>{let ns=prodDelta(s,pi,{titanium:1});return raiseOxygen(ns,s.players[pi].id);},
  }),
  mkCard({
    id:"importGHG", name:"Import of Advanced GHG", cost:9, type:"red", tags:["earth","space"],
    req:null, desc:"+2 heat production", vp:0,
    play:(s,pi)=>prodDelta(s,pi,{heat:2}),
  }),
  mkCard({
    id:"largeConvoy", name:"Large Convoy", cost:36, type:"red", tags:["earth","space"],
    req:null, desc:"+2 plant production, place an ocean tile", vp:2,
    play:(s,pi)=>{
      let ns=prodDelta(s,pi,{plants:2});
      return {...ns,pendingTile:{type:"ocean",pid:ns.players[pi].id,pIdx:pi}};
    },
  }),
  mkCard({
    id:"domedCrater", name:"Domed Crater", cost:24, type:"red", tags:["city","building"],
    req:{maxOxygen:7}, desc:"Req O₂≤7%. +3 plants, +3 energy prod, place city", vp:0,
    play:(s,pi)=>{
      let ns=resDelta(s,pi,{plants:3});
      ns=prodDelta(ns,pi,{energy:3});
      return {...ns,pendingTile:{type:"city",pid:ns.players[pi].id,pIdx:pi}};
    },
  }),
  mkCard({
    id:"releasedInertGases", name:"Released Inert Gases", cost:14, type:"red", tags:["space"],
    req:null, desc:"Raise TR 2 steps", vp:0,
    play:(s,pi)=>{let ns=raiseTR(s,s.players[pi].id);return raiseTR(ns,s.players[pi].id);},
  }),
  mkCard({
    id:"asteroidMining", name:"Asteroid Mining Consortium", cost:13, type:"red", tags:["space"],
    req:{minTiProdAny:1}, desc:"Steal 1 titanium prod from any player. +1 titanium prod.", vp:0,
    play:(s,pi)=>{
      const vi=s.players.findIndex((p,i)=>i!==pi&&p.titaniumProd>=1);
      if(vi<0) return s;
      let ns=prodDelta(s,vi,{titanium:-1});
      return prodDelta(ns,pi,{titanium:1});
    },
  }),
  // ── Phase 2: SCIENCE & ENGINE ─────────────────────────────────────
  mkCard({
    id:"solarWindPower", name:"Solar Wind Power", cost:12, type:"green",
    tags:["power","science","space"], req:null,
    desc:"+1 titanium production, draw 2 cards", vp:1,
    play:(s,pi)=>{ let ns=prodDelta(s,pi,{titanium:1}); return drawCards(ns,pi,2); },
  }),
  mkCard({
    id:"geneRepair", name:"Gene Repair", cost:12, type:"green",
    tags:["science"], req:{minSciTags:3},
    desc:"Req ≥3 science tags. +2 MC production", vp:2,
    play:(s,pi)=>prodDelta(s,pi,{mc:2}),
  }),
  mkCard({
    id:"viralEnhancers", name:"Viral Enhancers", cost:9, type:"green",
    tags:["microbe","plant","science"], req:null,
    desc:"When you play a plant, microbe, or animal card: gain 1 of that resource too", vp:0,
    play:(s,_)=>s, // effect handled in doPlayCard
  }),
  mkCard({
    id:"laboratory", name:"Laboratory", cost:4, type:"green",
    tags:["science","building"], req:{minSciTags:2},
    desc:"Req ≥2 science tags. Draw 2 cards", vp:1,
    play:(s,pi)=>drawCards(s,pi,2),
  }),
  mkCard({
    id:"advancedScreening", name:"Advanced Screening Technology", cost:8, type:"green",
    tags:["science","earth"], req:null,
    desc:"Draw 3 cards", vp:0,
    play:(s,pi)=>drawCards(s,pi,3),
  }),
  mkCard({
    id:"earthOffice", name:"Earth Office", cost:1, type:"green",
    tags:["earth","building"], req:null,
    desc:"Effect: Earth-tag cards cost 3 MC less (stacks with corp)", vp:0,
    play:(s,pi)=>upd(s,pi,p=>({...p,earthOffice:true})),
  }),
  mkCard({
    id:"spaceStation", name:"Space Station", cost:22, type:"green",
    tags:["space","building"], req:null,
    desc:"+2 titanium production. Space-tag cards cost 2 MC less", vp:1,
    play:(s,pi)=>{ let ns=prodDelta(s,pi,{titanium:2}); return upd(ns,pi,p=>({...p,spaceStation:true})); },
  }),
  // ── Phase 2: MICROBE RESOURCE CARDS ──────────────────────────────
  mkCard({
    id:"regolithEaters", name:"Regolith Eaters", cost:12, type:"blue",
    tags:["microbe","science"], req:null,
    desc:"Action: +1 microbe here. OR: spend 2 microbes → raise O₂. 1 VP per 2 microbes", vp:(p)=>Math.floor((p.cardResources?.regolithEaters||0)/2),
    play:(s,_)=>s,
    action:[
      { label:"+1 🦠 on Regolith Eaters", canUse:(_,__)=>true,
        apply:(s,pi)=>addCardRes(s,pi,"regolithEaters",1) },
      { label:"2🦠 → raise O₂", canUse:(s,pi)=>(s.players[pi].cardResources?.regolithEaters||0)>=2,
        apply:(s,pi)=>{ let ns=addCardRes(s,pi,"regolithEaters",-2); return raiseOxygen(ns,s.players[pi].id); } },
    ],
  }),
  mkCard({
    id:"tardigrades", name:"Tardigrades", cost:4, type:"blue",
    tags:["microbe"], req:null,
    desc:"Action: +1 microbe here. OR: 4 microbes → raise O₂. 1 VP per 4 microbes", vp:(p)=>Math.floor((p.cardResources?.tardigrades||0)/4),
    play:(s,_)=>s,
    action:[
      { label:"+1 🦠 on Tardigrades", canUse:(_,__)=>true,
        apply:(s,pi)=>addCardRes(s,pi,"tardigrades",1) },
      { label:"4🦠 → raise O₂", canUse:(s,pi)=>(s.players[pi].cardResources?.tardigrades||0)>=4,
        apply:(s,pi)=>{ let ns=addCardRes(s,pi,"tardigrades",-4); return raiseOxygen(ns,s.players[pi].id); } },
    ],
  }),
  mkCard({
    id:"ghgProducingBacteria", name:"GHG Producing Bacteria", cost:8, type:"blue",
    tags:["microbe","science"], req:{maxOxygen:4},
    desc:"Req O₂≤4%. Action: +1 microbe. OR: 2 microbes → raise temp. 1 VP per 4 microbes", vp:(p)=>Math.floor((p.cardResources?.ghgProducingBacteria||0)/4),
    play:(s,_)=>s,
    action:[
      { label:"+1 🦠 (GHG Bacteria)", canUse:(_,__)=>true,
        apply:(s,pi)=>addCardRes(s,pi,"ghgProducingBacteria",1) },
      { label:"2🦠 → raise temp", canUse:(s,pi)=>(s.players[pi].cardResources?.ghgProducingBacteria||0)>=2&&s.temperature<8,
        apply:(s,pi)=>{ let ns=addCardRes(s,pi,"ghgProducingBacteria",-2); return raiseTemp(ns,s.players[pi].id); } },
    ],
  }),
  mkCard({
    id:"decomposers", name:"Decomposers", cost:5, type:"blue",
    tags:["microbe"], req:{minOceans:3},  // changed from O2>=3 for variety
    desc:"When you play an animal, plant, or microbe card: +1 microbe here. 1 VP per 3 microbes", vp:(p)=>Math.floor((p.cardResources?.decomposers||0)/3),
    play:(s,_)=>s, // trigger in doPlayCard
  }),
  mkCard({
    id:"nitriteReducingBacteria", name:"Nitrite Reducing Bacteria", cost:11, type:"blue",
    tags:["microbe","plant"], req:null,
    desc:"Action: +1 microbe here. OR: 3 microbes → raise O₂. 1 VP per 3 microbes", vp:(p)=>Math.floor((p.cardResources?.nitriteReducingBacteria||0)/3),
    play:(s,_)=>s,
    action:[
      { label:"+1 🦠 (Nitrite Bacteria)", canUse:(_,__)=>true,
        apply:(s,pi)=>addCardRes(s,pi,"nitriteReducingBacteria",1) },
      { label:"3🦠 → raise O₂", canUse:(s,pi)=>(s.players[pi].cardResources?.nitriteReducingBacteria||0)>=3,
        apply:(s,pi)=>{ let ns=addCardRes(s,pi,"nitriteReducingBacteria",-3); return raiseOxygen(ns,s.players[pi].id); } },
    ],
  }),
  mkCard({
    id:"ants", name:"Ants", cost:9, type:"blue",
    tags:["microbe"], req:{minOxygen:4},
    desc:"Req O₂≥4%. Action: remove 1 microbe from any card → +1 here. 1 VP per 2 microbes", vp:(p)=>Math.floor((p.cardResources?.ants||0)/2),
    play:(s,_)=>s,
    action:[
      { label:"Ants: steal microbe from any card", canUse:(s,pi)=>{
          const hasTarget=s.players.some((x,i)=>i!==pi&&Object.values(x.cardResources||{}).some(v=>v>0));
          const selfTarget=Object.values(s.players[pi].cardResources||{}).reduce((a,b)=>a+b,0)>0;
          return hasTarget||selfTarget;
        },
        apply:(s,pi)=>{
          // Auto-steal from self first, then others (simplified)
          const cr=s.players[pi].cardResources||{};
          const selfTotal=Object.values(cr).reduce((a,b)=>a+b,0);
          if(selfTotal>0){
            const srcCard=Object.keys(cr).find(k=>cr[k]>0&&k!=="ants");
            if(srcCard){ let ns=addCardRes(s,pi,srcCard,-1); return addCardRes(ns,pi,"ants",1); }
          }
          // Steal from opponent with most microbes
          let bestPi=-1, bestAmt=0;
          s.players.forEach((x,i)=>{ if(i===pi) return;
            const tot=Object.values(x.cardResources||{}).reduce((a,b)=>a+b,0);
            if(tot>bestAmt){bestAmt=tot;bestPi=i;}
          });
          if(bestPi>=0){
            const srcCard=Object.keys(s.players[bestPi].cardResources).find(k=>(s.players[bestPi].cardResources[k]||0)>0);
            if(srcCard){ let ns=addCardRes(s,bestPi,srcCard,-1); return addCardRes(ns,pi,"ants",1); }
          }
          return s;
        }
      },
    ],
  }),
  mkCard({
    id:"extremeColdFungus", name:"Extreme Cold Fungus", cost:13, type:"blue",
    tags:["plant","microbe"], req:{maxTemp:-10},
    desc:"Req temp≤-10°C. Action: +1 plant OR add 2 microbes to any card you own", vp:0,
    play:(s,_)=>s,
    action:[
      { label:"Fungus: +1 plant", canUse:(_,__)=>true,
        apply:(s,pi)=>resDelta(s,pi,{plants:1}) },
      { label:"Fungus: +2 microbes on a card", canUse:(s,pi)=>{
          return s.players[pi].played.some(id=>!id.endsWith("_fd")&&CARDS[id]?.action);
        },
        apply:(s,pi)=>{
          // Add to card with most microbes or first microbe card
          const p=s.players[pi];
          const microbeCards=p.played.filter(id=>!id.endsWith("_fd")&&CARDS[id]?.tags?.includes("microbe"));
          const target=microbeCards[0];
          if(!target) return resDelta(s,pi,{plants:2});
          return addCardRes(s,pi,target,2);
        }
      },
    ],
  }),
  mkCard({
    id:"symbioticFungus", name:"Symbiotic Fungus", cost:4, type:"blue",
    tags:["microbe","plant"], req:{minOxygen:6},
    desc:"Req O₂≥6%. Action: add 1 microbe to any of your microbe cards", vp:0,
    play:(s,_)=>s,
    action:[{
      label:"Symbiotic: +1 microbe to any card",
      canUse:(s,pi)=>s.players[pi].played.some(id=>!id.endsWith("_fd")&&CARDS[id]?.tags?.includes("microbe")),
      apply:(s,pi)=>{
        const cards=s.players[pi].played.filter(id=>!id.endsWith("_fd")&&CARDS[id]?.tags?.includes("microbe"));
        return cards.length ? addCardRes(s,pi,cards[0],1) : s;
      }
    }],
  }),
  // ── Phase 2: ANIMAL RESOURCE CARDS ───────────────────────────────
  mkCard({
    id:"smallAnimals", name:"Small Animals", cost:6, type:"blue",
    tags:["animal","science"], req:{minOxygen:6},
    desc:"Req O₂≥6%. Action: +1 animal here. 1 VP per 2 animals", vp:(p)=>Math.floor((p.cardResources?.smallAnimals||0)/2),
    play:(s,_)=>s,
    action:[{ label:"+1 🐾 (Small Animals)", canUse:(_,__)=>true,
      apply:(s,pi)=>addCardRes(s,pi,"smallAnimals",1) }],
  }),
  mkCard({
    id:"birds", name:"Birds", cost:10, type:"blue",
    tags:["animal"], req:{minOxygen:6},
    desc:"Req O₂≥6%. -2 plant production. Each generation +1 animal here. 1 VP per animal", vp:(p)=>(p.cardResources?.birds||0),
    play:(s,pi)=>prodDelta(s,pi,{plants:-2}),
    action:[{ label:"+1 🐦 (Birds)", canUse:(_,__)=>true,
      apply:(s,pi)=>addCardRes(s,pi,"birds",1) }],
  }),
  mkCard({
    id:"pets", name:"Pets", cost:10, type:"green",
    tags:["earth","animal"], req:{minCities:1},
    desc:"Req ≥1 city. +1 animal here per city on board. 1 VP per 2 animals", vp:(p)=>Math.floor((p.cardResources?.pets||0)/2),
    play:(s,pi)=>{
      const cities=s.board.filter(h=>h.tileType==="city").length;
      return addCardRes(s,pi,"pets",cities);
    },
  }),
  mkCard({
    id:"fish", name:"Fish", cost:9, type:"blue",
    tags:["animal"], req:{minTemp:2},
    desc:"Req temp≥2°C. -1 plant prod. Action: +1 animal per ocean on board. 1 VP per animal", vp:(p)=>(p.cardResources?.fish||0),
    play:(s,pi)=>prodDelta(s,pi,{plants:-1}),
    action:[{ label:"+🐟 per ocean", canUse:(_,__)=>true,
      apply:(s,pi)=>addCardRes(s,pi,"fish",s.oceansPlaced) }],
  }),
  mkCard({
    id:"livestock", name:"Livestock", cost:13, type:"blue",
    tags:["animal"], req:{minOxygen:9},
    desc:"Req O₂≥9%. -1 plant prod. Action: +1 animal per city. 2 VP per 3 animals", vp:(p)=>Math.floor((p.cardResources?.livestock||0)/3)*2,
    play:(s,pi)=>prodDelta(s,pi,{plants:-1}),
    action:[{ label:"+🐄 per city", canUse:(_,__)=>true,
      apply:(s,pi)=>addCardRes(s,pi,"livestock",s.board.filter(h=>h.tileType==="city").length) }],
  }),
  // ── Phase 2: SCIENCE BLUE CARDS ───────────────────────────────────
  mkCard({
    id:"physicsComplex", name:"Physics Complex", cost:12, type:"blue",
    tags:["science","building","power"], req:null,
    desc:"Action: spend 6 energy → +1 science resource here. 2 VP per science resource", vp:(p)=>(p.cardResources?.physicsComplex||0)*2,
    play:(s,_)=>s,
    action:[{ label:"6⚡→+1 science res", canUse:(s,pi)=>s.players[pi].energy>=6,
      apply:(s,pi)=>{ let ns=resDelta(s,pi,{energy:-6}); return addCardRes(ns,pi,"physicsComplex",1); } }],
  }),
  mkCard({
    id:"searchForLife", name:"Search for Life", cost:3, type:"blue",
    tags:["science"], req:{maxOxygen:6},
    desc:"Req O₂≤6%. Action: spend 1 MC → draw 1 card; if it has microbe/animal tag, +1 science here", vp:(p)=>(p.cardResources?.searchForLife||0)*3,
    play:(s,_)=>s,
    action:[{ label:"1₡ → draw + maybe +science", canUse:(s,pi)=>s.players[pi].mc>=1,
      apply:(s,pi)=>{
        let ns=resDelta(s,pi,{mc:-1});
        ns=drawCards(ns,pi,1);
        const newCard=ns.players[pi].hand[ns.players[pi].hand.length-1];
        if(newCard&&(CARDS[newCard]?.tags?.includes("microbe")||CARDS[newCard]?.tags?.includes("animal")))
          ns=addCardRes(ns,pi,"searchForLife",1);
        return ns;
      }
    }],
  }),
  mkCard({
    id:"aiCentral", name:"AI Central", cost:21, type:"blue",
    tags:["science","earth"], req:{minSciTags:3},
    desc:"Req ≥3 science tags. Action: draw 2 cards per science tag you have", vp:1,
    play:(s,_)=>s,
    action:[{ label:"Draw 2 per sci tag", canUse:(s,pi)=>s.players[pi].mc>=0,
      apply:(s,pi)=>drawCards(s,pi,(s.players[pi].tags?.science||0)*2) }],
  }),
  mkCard({
    id:"directedImpactors", name:"Directed Impactors", cost:6, type:"blue",
    tags:["space","building"], req:null,
    desc:"Action: spend 3 titanium → raise temperature", vp:0,
    play:(s,_)=>s,
    action:[{ label:"3△→raise temp", canUse:(s,pi)=>s.players[pi].titanium>=3&&s.temperature<8,
      apply:(s,pi)=>{ let ns=resDelta(s,pi,{titanium:-3}); return raiseTemp(ns,s.players[pi].id); } }],
  }),
  mkCard({
    id:"industrialCenter", name:"Industrial Center", cost:4, type:"blue",
    tags:["building"], req:null,
    desc:"Action: spend 7 MC → +1 steel production", vp:0,
    play:(s,_)=>s,
    action:[{ label:"7₡→+1⬡prod", canUse:(s,pi)=>s.players[pi].mc>=7,
      apply:(s,pi)=>{ let ns=resDelta(s,pi,{mc:-7}); return prodDelta(ns,pi,{steel:1}); } }],
  }),
  mkCard({
    id:"businessNetwork", name:"Business Network", cost:4, type:"blue",
    tags:["earth","building"], req:null,
    desc:"Action: discard 1 card from hand → draw 1 card", vp:0,
    play:(s,_)=>s,
    action:[{ label:"Discard 1→draw 1", canUse:(s,pi)=>s.players[pi].hand.length>0,
      apply:(s,pi)=>{
        const h=s.players[pi].hand;
        if(!h.length) return s;
        const discard=[h[h.length-1]];
        let ns={...s,players:s.players.map((p,i)=>i===pi?{...p,hand:h.slice(0,-1)}:p),
          discard:[...s.discard,...discard]};
        return drawCards(ns,pi,1);
      }
    }],
  }),
  mkCard({
    id:"electroCatapult", name:"Electro Catapult", cost:17, type:"blue",
    tags:["building"], req:{maxOxygen:8},
    desc:"Req O₂≤8%. Action: spend 1 plant → gain 7 MC", vp:0,
    play:(s,_)=>s,
    action:[{ label:"1🌿→7₡", canUse:(s,pi)=>s.players[pi].plants>=1,
      apply:(s,pi)=>resDelta(s,pi,{plants:-1,mc:7}) }],
  }),
  // ── Phase 2: EVENT CARDS ──────────────────────────────────────────
  mkCard({
    id:"bigAsteroid", name:"Big Asteroid", cost:27, type:"red",
    tags:["space"], req:null,
    desc:"Raise temperature 2 steps. Gain 4 titanium", vp:0,
    play:(s,pi)=>{
      let ns=resDelta(s,pi,{titanium:4});
      ns=raiseTemp(ns,s.players[pi].id);
      return raiseTemp(ns,s.players[pi].id);
    },
  }),
  mkCard({
    id:"giantIceAsteroid", name:"Giant Ice Asteroid", cost:36, type:"red",
    tags:["space"], req:null,
    desc:"Raise temperature 2 steps. Place 2 ocean tiles", vp:0,
    play:(s,pi)=>{
      let ns=raiseTemp(s,s.players[pi].id);
      ns=raiseTemp(ns,s.players[pi].id);
      return {...ns, pendingTile:{type:"ocean",pid:s.players[pi].id,pIdx:pi,extra:1}};
    },
  }),
  mkCard({
    id:"towingComet", name:"Towing a Comet", cost:23, type:"red",
    tags:["space"], req:null,
    desc:"+2 plants. Raise O₂. Place ocean tile", vp:0,
    play:(s,pi)=>{
      let ns=resDelta(s,pi,{plants:2});
      ns=raiseOxygen(ns,s.players[pi].id);
      return {...ns, pendingTile:{type:"ocean",pid:s.players[pi].id,pIdx:pi}};
    },
  }),
  mkCard({
    id:"comet", name:"Comet", cost:21, type:"red",
    tags:["space"], req:null,
    desc:"+2 plants. Place ocean tile. Raise temperature", vp:0,
    play:(s,pi)=>{
      let ns=resDelta(s,pi,{plants:2});
      ns=raiseTemp(ns,s.players[pi].id);
      return {...ns, pendingTile:{type:"ocean",pid:s.players[pi].id,pIdx:pi}};
    },
  }),
  mkCard({
    id:"convoyFromEuropa", name:"Convoy from Europa", cost:15, type:"red",
    tags:["earth","space"], req:null,
    desc:"Place ocean tile. Draw 1 card", vp:0,
    play:(s,pi)=>{
      let ns=drawCards(s,pi,1);
      return {...ns, pendingTile:{type:"ocean",pid:ns.players[pi].id,pIdx:pi}};
    },
  }),
  mkCard({
    id:"corporateStronghold", name:"Corporate Stronghold", cost:11, type:"red",
    tags:["city","building"], req:null,
    desc:"Place a city tile. -2 plant production", vp:0,
    play:(s,pi)=>{
      let ns=prodDelta(s,pi,{plants:-2});
      return {...ns, pendingTile:{type:"city",pid:ns.players[pi].id,pIdx:pi}};
    },
  }),
  mkCard({
    id:"moholeLake", name:"Mohole Lake", cost:31, type:"red",
    tags:["building"], req:null,
    desc:"+2 plant production. Place ocean tile", vp:0,
    play:(s,pi)=>{
      let ns=prodDelta(s,pi,{plants:2});
      return {...ns, pendingTile:{type:"ocean",pid:ns.players[pi].id,pIdx:pi}};
    },
  }),
  mkCard({
    id:"nuclearZone", name:"Nuclear Zone", cost:10, type:"red",
    tags:["earth"], req:{minTemp:-2},
    desc:"Req temp≥-2°C. Raise temp 2 steps. -3 plant production", vp:0,
    play:(s,pi)=>{
      let ns=prodDelta(s,pi,{plants:-3});
      ns=raiseTemp(ns,s.players[pi].id);
      return raiseTemp(ns,s.players[pi].id);
    },
  }),
  mkCard({
    id:"mangrove", name:"Mangrove", cost:12, type:"red",
    tags:["plant"], req:{minTemp:4},
    desc:"Req temp≥4°C. Place a greenery tile, raise O₂", vp:1,
    play:(s,pi)=>({...s, pendingTile:{type:"greenery",pid:s.players[pi].id,pIdx:pi}}),
  }),
  mkCard({
    id:"ghgFactories", name:"GHG Factories", cost:11, type:"red",
    tags:["building"], req:{minEnergyProd:5},
    desc:"Req ≥5 energy production. -1 energy prod, +4 heat prod", vp:0,
    play:(s,pi)=>prodDelta(s,pi,{energy:-1,heat:4}),
  }),
  mkCard({
    id:"ioMiningIndustries", name:"Io Mining Industries", cost:41, type:"red",
    tags:["jovian","space"], req:null,
    desc:"+2 titanium production, +2 steel production, +6 titanium", vp:2,
    play:(s,pi)=>{
      let ns=prodDelta(s,pi,{titanium:2,steel:2});
      return resDelta(ns,pi,{titanium:6});
    },
  }),
  mkCard({
    id:"permafrostExtraction", name:"Permafrost Extraction", cost:8, type:"red",
    tags:["space"], req:null,
    desc:"Place an ocean tile", vp:0,
    play:(s,pi)=>({...s, pendingTile:{type:"ocean",pid:s.players[pi].id,pIdx:pi}}),
  }),
  mkCard({
    id:"stripMine", name:"Strip Mine", cost:25, type:"red",
    tags:["building"], req:null,
    desc:"-2 energy prod. +2 steel prod. +2 titanium prod. Raise O₂ twice", vp:0,
    play:(s,pi)=>{
      let ns=prodDelta(s,pi,{energy:-2,steel:2,titanium:2});
      ns=raiseOxygen(ns,s.players[pi].id);
      return raiseOxygen(ns,s.players[pi].id);
    },
  }),
  mkCard({
    id:"greatDam", name:"Great Dam", cost:12, type:"red",
    tags:["building","power","space"], req:{minEnergyProd:4},
    desc:"Req ≥4 energy production. +2 energy production", vp:1,
    play:(s,pi)=>prodDelta(s,pi,{energy:2}),
  }),
  mkCard({
    id:"fueledGenerators", name:"Fueled Generators", cost:1, type:"red",
    tags:["power","building"], req:null,
    desc:"-1 energy production. +1 MC production", vp:0,
    play:(s,pi)=>prodDelta(s,pi,{energy:-1,mc:1}),
  }),
  mkCard({
    id:"arcticAlgae", name:"Arctic Algae", cost:12, type:"green",
    tags:["plant"], req:{maxTemp:-12},
    desc:"Req temp≤-12°C. +1 plant. Whenever anyone places an ocean, you gain +2 plants", vp:0,
    play:(s,pi)=>resDelta(s,pi,{plants:1}), // ocean trigger handled in doPlaceTile
  }),
  mkCard({
    id:"colonizedMoon", name:"Colonized Moon", cost:11, type:"red",
    tags:["earth","space","city"], req:null,
    desc:"-2 steel production. +2 MC production", vp:0,
    play:(s,pi)=>prodDelta(s,pi,{steel:-2,mc:2}),
  }),
  mkCard({
    id:"flooding", name:"Flooding", cost:7, type:"red",
    tags:["space"], req:{minOceans:1},
    desc:"Req ≥1 ocean. Place ocean tile, gain +2 plants", vp:0,
    play:(s,pi)=>{
      let ns=resDelta(s,pi,{plants:2});
      return {...ns, pendingTile:{type:"ocean",pid:ns.players[pi].id,pIdx:pi}};
    },
  }),
];
const CARDS = Object.fromEntries(CARDS_DATA.map(c=>[c.id,c]));
function createDeck(){return CARDS_DATA.map(c=>c.id).sort(()=>Math.random()-0.5);}



// ── Phase-2 helpers ───────────────────────────────────────────────────
function drawCards(state, pIdx, n){
  const drawn = state.deck.slice(0, Math.min(n, state.deck.length));
  if(!drawn.length) return state;
  return {
    ...state,
    deck: state.deck.slice(drawn.length),
    players: state.players.map((p,i)=> i===pIdx ? {...p, hand:[...p.hand,...drawn]} : p),
  };
}

function addCardRes(state, pIdx, cardId, amount){
  const players = state.players.map((p,i)=>{
    if(i!==pIdx) return p;
    const cr = {...(p.cardResources||{})};
    cr[cardId] = Math.max(0, (cr[cardId]||0) + amount);
    return {...p, cardResources: cr};
  });
  return {...state, players};
}

// ─── Corp trigger: Saturn Systems – any Jovian tag played → +1 MC prod
function triggerSaturn(state, tags){
  if(!tags.includes("jovian")) return state;
  return {
    ...state,
    players: state.players.map(p=>
      p.corporation?.id==="saturn" ? {...p, mcProd:(p.mcProd||0)+1} : p
    ),
  };
}
// ─── Corp trigger: CrediCor – TR increases past 30 → +4 MC
function triggerCrediCor(state){
  return {
    ...state,
    players: state.players.map(p=>{
      if(p.corporation?.id!=="credicor") return p;
      if(p.TR>30 && (p._prevTR||0)<=30) return {...p, mc:(p.mc||0)+4};
      return p;
    }),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// GAME STATE  creation + phase transitions
// ═══════════════════════════════════════════════════════════════════════
const PC = ["#e74c3c","#3498db","#27ae60","#f39c12","#8e44ad"];

function makePlayer(p, i, corpOpts){
  return {
    id:p.id, name:p.name, color:PC[i],
    corporation:null, corpOptions:corpOpts, corpChosen:false,
    TR:20,
    mc:0,steel:0,titanium:0,plants:0,energy:0,heat:0,
    mcProd:0,steelProd:0,titaniumProd:0,plantsProd:0,energyProd:0,heatProd:0,
    steelValue:2, tiValue:3,
    hand:[], played:[], researchCards:[],
    tags:{},
    passed:false, doneResearch:false, actionsLeft:2, trRaisedThisGen:false,
    usedActions:[], cardResources:{}, _prevTR:20,
  };
}

function createInitialState(playerList){
  const pool=[...CORPS].sort(()=>Math.random()-0.5);
  return {
    phase:"corpSelection",
    generation:1, activePlayerIdx:0,
    temperature:-30, oxygen:0, oceansPlaced:0,
    board:genBoard(),
    players:playerList.map((p,i)=>makePlayer(p,i,[pool[i*2],pool[i*2+1]])),
    deck:createDeck(), discard:[],
    milestones:MILESTONES.map(m=>({...m,claimedBy:null})),
    awards:AWARDS.map(a=>({...a,fundedBy:null})),
    awardsFunded:0, milestonesClaimed:0,
    log:["Corporations selected. Choose yours!"],
    gameOver:false, pendingTile:null,
  };
}

function dealResearch(state){
  let deck=[...state.deck];
  const players=state.players.map(p=>{
    const cards=deck.splice(0,Math.min(4,deck.length));
    return {...p, researchCards:cards, doneResearch:false};
  });
  return {...state, deck, players};
}

function startResearch(state){
  let ns=dealResearch(state);
  return {...ns, phase:"research",
    log:[`Gen ${ns.generation} — Research phase`,...ns.log.slice(0,29)]};
}

function startAction(state){
  const players=state.players.map(p=>({...p,passed:false,actionsLeft:2,usedActions:[]}));
  return {...state, phase:"action", activePlayerIdx:0, players, pendingTile:null,
    log:[`Gen ${state.generation} — Action phase`,...state.log.slice(0,29)]};
}

function runProduction(state){
  let players=state.players.map(p=>{
    // Birds: +1 animal per generation
    // Titan Floating Launch-Pad: +1 microbe/gen to the first microbe card
    let cr={...(p.cardResources||{})};
    if(p.played.includes("birds")) cr["birds"]=(cr["birds"]||0)+1;
    if(p.played.includes("titanLaunchPad")){
      const mCard=p.played.find(id=>!id.endsWith("_fd")&&CARDS[id]?.tags?.includes("microbe")&&id!=="titanLaunchPad");
      if(mCard) cr[mCard]=(cr[mCard]||0)+1;
    }
    return {
      ...p,
      heat:   p.heat+p.energy+p.heatProd,
      energy: p.energyProd,
      mc:     p.mc+p.TR+p.mcProd,
      steel:  p.steel+p.steelProd,
      titanium:p.titanium+p.titaniumProd,
      plants: p.plants+p.plantsProd,
      trRaisedThisGen:false, passed:false, actionsLeft:2, doneResearch:false,
      usedActions:[], researchCards:[], cardResources:cr, _prevTR:p.TR,
    };
  });
  const gen=state.generation+1;
  const log=[`── Gen ${state.generation} Production ──`,...state.log.slice(0,29)];
  let ns={...state, players, generation:gen, log, pendingTile:null};
  ns=checkEnd(ns);
  return ns.gameOver ? ns : startResearch(ns);
}

// ═══════════════════════════════════════════════════════════════════════
// ACTION REDUCER
// ═══════════════════════════════════════════════════════════════════════
function applyAction(state, msg){
  if(state.gameOver) return state;
  const {t,pid}=msg;
  const pi=state.players.findIndex(p=>p.id===pid);
  if(pi<0) return state;
  switch(t){
    case"chooseCorp":      return doChooseCorp(state,pi,msg);
    case"doneResearch":    return doDoneResearch(state,pi,msg);
    case"pass":            return doPass(state,pi);
    case"stdProject":      return doStdProject(state,pi,msg);
    case"heatToTemp":      return doHeatToTemp(state,pi);
    case"plantsGreenery":  return doPlantsGreenery(state,pi);
    case"placeTile":       return doPlaceTile(state,pi,msg);
    case"playCard":        return doPlayCard(state,pi,msg);
    case"blueAction":      return doBlueAction(state,pi,msg);
    case"unmiAction":      return doUNMI(state,pi);
    case"claimMilestone":  return doMilestone(state,pi,msg);
    case"fundAward":       return doAward(state,pi,msg);
    default: return state;
  }
}

function doChooseCorp(state,pi,msg){
  const p=state.players[pi];
  if(p.corpChosen) return state;
  const corp=p.corpOptions.find(c=>c.id===msg.corpId);
  if(!corp) return state;

  let np={...p,corporation:corp,corpChosen:true,mc:corp.startMC||0};
  if(corp.startRes)  Object.entries(corp.startRes).forEach(([k,v])=>{np[k]=v;});
  if(corp.startProd) Object.entries(corp.startProd).forEach(([k,v])=>{np[k+"Prod"]=(np[k+"Prod"]||0)+v;});
  if(corp.bonusCards){
    const drawn=state.deck.slice(0,corp.bonusCards);
    np={...np,hand:[...np.hand,...drawn]};
  }

  const players=state.players.map((x,i)=>i===pi?np:x);
  let ns={...state,players,log:[`${p.name} → ${corp.name}`,...state.log.slice(0,29)]};
  if(players.every(x=>x.corpChosen)) ns=startResearch(ns);
  return ns;
}

function doDoneResearch(state,pi,msg){
  const p=state.players[pi];
  const toBuy=(msg.cardIds||[]).filter(id=>p.researchCards.includes(id));
  const cost=toBuy.length*3;
  if(p.mc<cost) return state;
  const players=state.players.map((x,i)=>i===pi
    ?{...x,mc:x.mc-cost,hand:[...x.hand,...toBuy],researchCards:[],doneResearch:true}:x);
  let ns={...state,players,
    log:[`${p.name} bought ${toBuy.length} card(s)`,...state.log.slice(0,29)]};
  if(players.every(x=>x.doneResearch)) ns=startAction(ns);
  return ns;
}

function doPass(state,pi){
  const p=state.players[pi];
  const players=state.players.map((x,i)=>i===pi?{...x,passed:true,actionsLeft:0}:x);
  // If this player still had an unresolved tile placement, release it rather
  // than leaving it dangling forever (defensive: prevents a permanently-stuck state).
  const pendingTile = state.pendingTile&&state.pendingTile.pid===p.id ? null : state.pendingTile;
  let ns={...state,players,pendingTile,log:[`${p.name} passes`,...state.log.slice(0,29)]};
  if(players.every(x=>x.passed)) return runProduction(ns);
  return nextActivePlayer(ns);
}

function doHeatToTemp(state,pi){
  const p=state.players[pi];
  if(p.heat<8||state.temperature>=8) return state;
  let ns=resDelta(state,pi,{heat:-8});
  ns=raiseTemp(ns,p.id);
  ns.log=[`${p.name}: 8🔥→temp`,...ns.log.slice(0,29)];
  return spendAction(ns,pi);
}

function doPlantsGreenery(state,pi){
  const p=state.players[pi];
  const threshold=p.corporation?.id==="ecoline"?6:8;
  if(p.plants<threshold) return state;
  let ns=resDelta(state,pi,{plants:-threshold});
  return {...ns,pendingTile:{type:"greenery",pid:p.id,pIdx:pi}};
}

function doStdProject(state,pi,msg){
  const p=state.players[pi];
  if(p.actionsLeft<=0) return state;
  const{project,cardIds}=msg;
  let ns=state;
  if(project==="powerPlant"){
    if(p.mc<11) return state;
    ns=resDelta(state,pi,{mc:-11}); ns=prodDelta(ns,pi,{energy:1});
    ns.log=[`${p.name}: Power Plant`,...ns.log.slice(0,29)];
    return spendAction(ns,pi);
  }
  if(project==="asteroid"){
    if(p.mc<14||state.temperature>=8) return state;
    ns=resDelta(state,pi,{mc:-14}); ns=raiseTemp(ns,p.id);
    ns.log=[`${p.name}: Asteroid`,...ns.log.slice(0,29)];
    return spendAction(ns,pi);
  }
  if(project==="aquifer"){
    if(p.mc<18||state.oceansPlaced>=9) return state;
    ns=resDelta(state,pi,{mc:-18});
    return {...ns,pendingTile:{type:"ocean",pid:p.id,pIdx:pi}};
  }
  if(project==="greenery"){
    if(p.mc<23) return state;
    ns=resDelta(state,pi,{mc:-23});
    return {...ns,pendingTile:{type:"greenery",pid:p.id,pIdx:pi}};
  }
  if(project==="city"){
    if(p.mc<25) return state;
    ns=resDelta(state,pi,{mc:-25}); ns=prodDelta(ns,pi,{mc:1});
    return {...ns,pendingTile:{type:"city",pid:p.id,pIdx:pi}};
  }
  if(project==="sellPatents"){
    const ids=(cardIds||[]).filter(id=>p.hand.includes(id));
    if(!ids.length) return state;
    const hand=p.hand.filter(id=>!ids.includes(id));
    ns={...state,players:state.players.map((x,i)=>i===pi?{...x,mc:x.mc+ids.length,hand}:x),
      discard:[...state.discard,...ids],
      log:[`${p.name}: sold ${ids.length} patent(s)`,...state.log.slice(0,29)]};
    return spendAction(ns,pi);
  }
  return state;
}

function doPlaceTile(state,pi,msg){
  const{hexId}=msg;
  const pt=state.pendingTile;
  if(!pt||pt.pid!==state.players[pi].id) return state;
  const hex=state.board.find(h=>h.id===hexId);
  if(!hex||hex.tileType) return state;
  const{type}=pt;
  const p=state.players[pi];

  // Validate placement rules
  if(type==="ocean"&&!hex.isOcean) return state;
  if(type!=="ocean"&&hex.isOcean) return state;
  if(type==="city"){
    const adjCities=adjHexes(hexId,state.board).filter(h=>h.tileType==="city");
    if(adjCities.length) return state;
  }
  if(type==="greenery"){
    const myTiles=state.board.filter(h=>h.owner===p.id&&h.tileType);
    if(myTiles.length>0){
      const adj=new Set(myTiles.flatMap(t=>adjIds(t.q,t.r)));
      const validAdj=[...adj].filter(id=>{const bh=state.board.find(h=>h.id===id);return bh&&!bh.tileType&&!bh.isOcean;});
      if(validAdj.length>0&&!adj.has(hexId)) return state;
    }
  }

  const owner=type==="ocean"?null:p.id;
  const board=state.board.map(h=>h.id===hexId?{...h,tileType:type,owner}:h);
  let ns={...state,board,pendingTile:null};
  ns=placementBonus(ns,pi,hexId);

  // Mining Guild: placing on steel/titanium bonus hex → +1 that production
  if(p.corporation?.id==="mining"){
    const hasSt=hex.bonus.includes("steel");
    const hasTi=hex.bonus.includes("titanium");
    if(hasSt) ns=prodDelta(ns,pi,{steel:1});
    if(hasTi) ns=prodDelta(ns,pi,{titanium:1});
  }

  if(type==="ocean"){
    ns={...ns,oceansPlaced:ns.oceansPlaced+1};
    ns=raiseTR(ns,p.id);
    // Arctic Algae: any player placing ocean → Arctic Algae owner gets +2 plants
    ns.players.forEach((pl,i)=>{
      if(pl.played.includes("arcticAlgae")) ns=resDelta(ns,i,{plants:2});
    });
    ns.log=[`${p.name}: Ocean at ${hexId}`,...ns.log.slice(0,29)];
    // Giant Ice Asteroid: chain a second ocean placement
    if(pt.extra && pt.extra>0){
      return {...ns, pendingTile:{type:"ocean",pid:p.id,pIdx:pi,extra:pt.extra-1}};
    }
  }
  if(type==="greenery"){
    ns=raiseOxygen(ns,p.id);
    ns.log=[`${p.name}: Greenery at ${hexId}`,...ns.log.slice(0,29)];
  }
  if(type==="city"){
    if(p.corporation?.id==="tharsis") ns=resDelta(ns,pi,{mc:3});
    // Tharsis: +1 MC prod per city for ALL tharsis corps
    ns={...ns,players:ns.players.map(x=>
      x.corporation?.id==="tharsis"?{...x,mcProd:x.mcProd+1}:x)};
    ns.log=[`${p.name}: City at ${hexId}`,...ns.log.slice(0,29)];
  }

  ns=checkEnd(ns);
  if(ns.gameOver) return ns;
  // If another tile is still pending (e.g. Giant Ice Asteroid chains 2 oceans) wait
  if(ns.pendingTile) return ns;
  return spendAction(ns,pi);
}

function corpCostDiscount(p,card){
  let d=0;
  if(p.corporation?.id==="thorgate"&&card.tags.includes("power"))     d+=3;
  if(p.corporation?.id==="teractor"&&card.tags.includes("earth"))      d+=3;
  if(p.corporation?.id==="interplanet"&&card.tags.includes("building")) d+=2;
  // Phase-2 card effects
  if(p.earthOffice  &&card.tags.includes("earth"))   d+=3;
  if(p.spaceStation &&card.tags.includes("space"))   d+=2;
  return d;
}

function reqMet(card,state,pi){
  const p=state.players[pi]; const r=card.req; if(!r) return true;
  const mod = p.corporation?.id==="inventrix" ? 2 : 0;
  if(r.minTemp!==undefined    && state.temperature < r.minTemp - mod)    return false;
  if(r.maxOxygen!==undefined  && state.oxygen      > r.maxOxygen + mod)  return false;
  if(r.minOceans!==undefined  && state.oceansPlaced < r.minOceans)        return false;
  if(r.minSciTags!==undefined && (p.tags?.science||0) < r.minSciTags)    return false;
  if(r.minEnergyProd!==undefined && (p.energyProd||0) < r.minEnergyProd) return false;
  if(r.minCities!==undefined && state.board.filter(h=>h.tileType==="city").length < r.minCities) return false;
  if(r.minTiProdAny!==undefined && !state.players.some((x,i)=>i!==pi&&x.titaniumProd>=r.minTiProdAny)) return false;
  if(r.minPlantProd!==undefined && (p.plantsProd||0) < r.minPlantProd) return false;
  if(r.minPowerTags!==undefined && (p.tags?.power||0) < r.minPowerTags) return false;
  if(r.minJovianTags!==undefined && (p.tags?.jovian||0) < r.minJovianTags) return false;
  return true;
}

function doPlayCard(state,pi,msg){
  const{cardId,steelPay=0,tiPay=0,heatPay=0}=msg;
  const p=state.players[pi];
  if(!p.hand.includes(cardId)||p.actionsLeft<=0) return state;
  const card=CARDS[cardId];
  if(!card) return state;
  if(!reqMet(card,state,pi)) return state;

  // Helion: may use heat as MC; others cannot
  const isHelion=p.corporation?.id==="helion";
  if(heatPay>0&&!isHelion) return state;
  if(p.heat<heatPay) return state;

  const sw=p.steelValue||2, tw=p.tiValue||3;
  let cost=Math.max(0,card.cost-steelPay*sw-tiPay*tw-heatPay-corpCostDiscount(p,card));
  if(p.mc<cost||p.steel<steelPay||p.titanium<tiPay) return state;

  // Deduct payment
  let ns=resDelta(state,pi,{mc:-cost,steel:-steelPay,titanium:-tiPay,heat:-heatPay});

  // Move card hand→played (events face-down)
  const hand=ns.players[pi].hand.filter(id=>id!==cardId);
  const faceId=card.type==="red"?cardId+"_fd":cardId;
  const played=[...ns.players[pi].played,faceId];
  const tags={...ns.players[pi].tags};
  if(card.type!=="red") card.tags.forEach(t=>{tags[t]=(tags[t]||0)+1;});
  ns=upd(ns,pi,p=>({...p,hand,played,tags}));

  // Event bonus for Interplanetary Cinematics
  if(card.type==="red"&&p.corporation?.id==="interplanet")
    ns=resDelta(ns,pi,{mc:2});
  // Media Group: when you play an event → +3 MC
  if(card.type==="red"&&ns.players[pi].played.includes("mediaGroup"))
    ns=resDelta(ns,pi,{mc:3});
  // Mars University: when you play a science card → draw 1
  if(card.tags.includes("science")&&ns.players[pi].played.includes("marsUniversity"))
    ns=drawCards(ns,pi,1);

  // Saturn Systems: Jovian tag played by anyone → +1 MC prod for Saturn player
  ns=triggerSaturn(ns, card.tags);

  // Viral Enhancers: when you play a plant/microbe/animal card, gain 1 extra of that resource
  const meAfterPlay=ns.players[pi];
  if(meAfterPlay.played.includes("viralEnhancers")||meAfterPlay.played.includes("viralEnhancers")){
    if(card.tags.includes("plant"))   ns=resDelta(ns,pi,{plants:1});
    if(card.tags.includes("microbe")) ns=resDelta(ns,pi,{plants:1});
    if(card.tags.includes("animal"))  ns=resDelta(ns,pi,{plants:1});
  }

  // Decomposers: when you play plant/microbe/animal tag, +1 microbe on Decomposers
  if(ns.players[pi].played.includes("decomposers")&&
     (card.tags.includes("plant")||card.tags.includes("microbe")||card.tags.includes("animal"))){
    ns=addCardRes(ns,pi,"decomposers",1);
  }

  ns=card.play(ns,pi);
  ns.log=[`${p.name} plays ${card.name}`,...ns.log.slice(0,29)];
  ns=checkEnd(ns);
  if(ns.gameOver) return ns;
  if(ns.pendingTile) return ns; // tile placement pending, action spent after tile
  return spendAction(ns,pi);
}

function doBlueAction(state,pi,msg){
  const{cardId, actionIdx=0}=msg;
  const p=state.players[pi];
  const playedId=p.played.find(id=>id===cardId);
  if(!playedId) return state;
  const usedKey=`${cardId}_${actionIdx}`;
  if((p.usedActions||[]).includes(usedKey)) return state;
  if(p.actionsLeft<=0) return state;
  const card=CARDS[cardId];
  if(!card) return state;
  // action can be single object or array
  const actions=Array.isArray(card.action)?card.action:[card.action];
  const act=actions[actionIdx];
  if(!act||!act.canUse(state,pi)) return state;

  let ns=act.apply(state,pi);
  ns=upd(ns,pi,p=>({...p,usedActions:[...(p.usedActions||[]),usedKey]}));
  ns.log=[`${p.name}: ${act.label}`,...ns.log.slice(0,29)];
  if(ns.pendingTile) return ns;
  return spendAction(ns,pi);
}

function doUNMI(state,pi){
  const p=state.players[pi];
  if(p.corporation?.id!=="unmi"||!p.trRaisedThisGen||p.mc<3||p.actionsLeft<=0) return state;
  let ns=resDelta(state,pi,{mc:-3});
  ns=raiseTR(ns,p.id);
  ns.log=[`${p.name}: UNMI +TR`,...ns.log.slice(0,29)];
  return spendAction(ns,pi);
}

function doMilestone(state,pi,msg){
  const p=state.players[pi];
  if(p.mc<8||state.milestonesClaimed>=3||p.actionsLeft<=0) return state;
  const ms=state.milestones.find(m=>m.id===msg.id&&!m.claimedBy);
  if(!ms||!ms.check(p,state)) return state;
  let ns=resDelta(state,pi,{mc:-8});
  ns={...ns,milestones:ns.milestones.map(m=>m.id===msg.id?{...m,claimedBy:p.id}:m),
    milestonesClaimed:ns.milestonesClaimed+1,
    log:[`${p.name} claims ${ms.name}!`,...ns.log.slice(0,29)]};
  return spendAction(ns,pi);
}

function doAward(state,pi,msg){
  const p=state.players[pi];
  const costs=[8,14,20]; const cost=costs[state.awardsFunded]??999;
  if(p.mc<cost||state.awardsFunded>=3||p.actionsLeft<=0) return state;
  const aw=state.awards.find(a=>a.id===msg.id&&!a.fundedBy);
  if(!aw) return state;
  let ns=resDelta(state,pi,{mc:-cost});
  ns={...ns,awards:ns.awards.map(a=>a.id===msg.id?{...a,fundedBy:p.id}:a),
    awardsFunded:ns.awardsFunded+1,
    log:[`${p.name} funds ${aw.name}`,...ns.log.slice(0,29)]};
  return spendAction(ns,pi);
}

// ═══════════════════════════════════════════════════════════════════════
// FINAL SCORING
// ═══════════════════════════════════════════════════════════════════════
function calcScores(state){
  return state.players.map(p=>{
    const trScore=p.TR;

    const msScore=state.milestones.filter(m=>m.claimedBy===p.id).length*5;

    let awScore=0;
    state.awards.filter(a=>a.fundedBy!==null).forEach(aw=>{
      const sorted=[...state.players].sort((a,b)=>aw.score(b,state)-aw.score(a,state));
      const mine=aw.score(p,state);
      if(mine>0&&mine===aw.score(sorted[0],state)) awScore+=5;
      else if(state.players.length>2&&mine>0&&sorted[1]&&mine===aw.score(sorted[1],state)&&aw.score(sorted[0],state)>mine) awScore+=2;
    });

    const greens=state.board.filter(h=>h.owner===p.id&&h.tileType==="greenery");
    const greenScore=greens.length;

    let cityScore=0;
    state.board.filter(h=>h.owner===p.id&&h.tileType==="city").forEach(city=>{
      cityScore+=adjHexes(city.id,state.board).filter(h=>h.tileType==="greenery").length;
    });

    let cardScore=0;
    const cardVPDetail=[];
    p.played.filter(id=>!id.endsWith("_fd")).forEach(id=>{
      const card=CARDS[id]; if(!card) return;
      const vp=card.vp;
      const v=typeof vp==="function"?vp(p):(typeof vp==="number"?vp:0);
      if(v>0){ cardScore+=v; cardVPDetail.push({name:card.name,vp:v}); }
    });

    const score=trScore+msScore+awScore+greenScore+cityScore+cardScore;
    return {
      id:p.id, name:p.name, color:p.color, score, TR:p.TR,
      corp:p.corporation?.name||"?",
      tiles:state.board.filter(h=>h.owner===p.id).length,
      breakdown:{tr:trScore,milestones:msScore,awards:awScore,
        greeneries:greenScore,cities:cityScore,cards:cardScore,cardDetail:cardVPDetail},
    };
  }).sort((a,b)=>b.score-a.score);
}



// ═══════════════════════════════════════════════════════════════════════
// UI HELPERS & THEME
// ═══════════════════════════════════════════════════════════════════════
const T={
  bg:"#050311",surf:"#0c0a1e",surfH:"#141030",surfB:"#1c1840",
  text:"#e8e2f8",muted:"#5e5680",border:"#26204a",
  red:"#e05535",green:"#28a860",blue:"#2272b0",gold:"#f0c040",
  orange:"#d97020",purple:"#9255d0",
  mars:"#b83808",marsMid:"#7a2400",marsDark:"#2c0d00",
  ocean:"#1454a0",greenery:"#187832",city:"#4a5560",
};

const B=(props)=><button {...props} style={{
  background:props.disabled?T.surfH:props.bg||`linear-gradient(160deg,${T.surfB},${T.surf})`,
  color:props.disabled?T.muted:props.col||T.text,
  border:`1px solid ${props.disabled?T.border+"44":T.border}`,
  borderRadius:7,padding:"7px 14px",fontSize:12,fontWeight:600,letterSpacing:"0.2px",
  cursor:props.disabled?"not-allowed":"pointer",
  fontFamily:"'Exo 2',sans-serif",transition:"filter .15s",
  boxShadow:props.disabled?"none":"0 2px 10px #00000050,inset 0 1px 0 #ffffff08",
  ...(props.full?{width:"100%",display:"block",textAlign:"left"}:{}),
  ...props.style,
}}/>;

// Resource icons
const RES_ICON={mc:"₡",steel:"⬡",titanium:"△",plants:"🌿",energy:"⚡",heat:"🔥"};
const RES_COLOR={mc:T.gold,steel:"#aaa",titanium:"#c0c0ff",plants:T.green,energy:"#a0f0ff",heat:T.red};

// Card-display tokens (kept together, away from function bodies, so future
// edits to neighboring components can't accidentally delete them)
const TAG_ICON={plant:"🌿",power:"⚡",space:"🚀",earth:"🌍",building:"🏗",
  science:"🔬",animal:"🐾",microbe:"🦠",jovian:"♃",city:"🏙"};
const TYPE_ACCENT={green:"#28a860",blue:"#2272b0",red:"#c83828"};
const TYPE_CLR=TYPE_ACCENT; // back-compat alias, same lookup table
const TYPE_LABEL={green:"AUTO",blue:"ACTIVE",red:"EVENT"};

function Res({k,v,prod}){
  const clr=RES_COLOR[k]||T.text;
  return(
    <div style={{textAlign:"center",minWidth:40}}>
      <div style={{width:32,height:32,borderRadius:"50%",
        background:`radial-gradient(circle at 35% 35%,${clr}28,${clr}08)`,
        border:`1.5px solid ${clr}55`,display:"flex",alignItems:"center",
        justifyContent:"center",margin:"0 auto 3px",fontSize:15,lineHeight:1}}>
        {RES_ICON[k]}
      </div>
      <div style={{color:clr,fontWeight:700,fontSize:13,lineHeight:1}}>{v}</div>
      {prod!==undefined&&(
        <div style={{color:prod>0?clr:prod<0?T.red:T.muted,fontSize:10,marginTop:1,fontWeight:600}}>
          {prod>0?"+":""}{prod}
        </div>
      )}
    </div>
  );
}

// ── Hex Board Component ───────────────────────────────────────────────
function HexFill(hex,valid,myTurn){
  if(valid&&myTurn) return "#f0c04044";
  if(hex.tileType==="ocean")    return "#1a5eaa";
  if(hex.tileType==="greenery") return "#1c7a30";
  if(hex.tileType==="city")     return "#4a5868";
  if(hex.isOcean) return "#0a2038";
  return "#8b2f08";
}

const BONUS_ICON={steel:"⬡",titanium:"△",plant:"🌿",card:"📜",mc:"₡"};

function HexCell({hex,valid,myTurn,owner,onClick}){
  const{x:cx,y:cy}=hcenter(hex.q,hex.r);
  const fill=HexFill(hex,valid,myTurn);
  const pts=hpts(hex.q,hex.r);
  const ptsI=hpts(hex.q,hex.r,HS-1.5);
  const clickable=valid&&myTurn&&!hex.tileType;
  const stroke=valid&&myTurn?"#f0c040":hex.tileType==="ocean"?"#1e70c0":hex.isOcean?"#0a2a48":"#1a0800";
  return(
    <g onClick={clickable?onClick:null} style={{cursor:clickable?"pointer":"default"}}>
      <polygon points={pts} fill="#000000" opacity={.5} stroke="none"/>
      <polygon points={ptsI} fill={fill} stroke={stroke} strokeWidth={valid&&myTurn?2:0.8}/>
      <polygon points={ptsI} fill="none" stroke="#ffffff" strokeWidth={0.4} opacity={0.06}/>
      {hex.tileType==="ocean"&&<text x={cx} y={cy+5} textAnchor="middle" fontSize={14} fill="#60b8f0" opacity={.9} style={{pointerEvents:"none"}}>≋</text>}
      {hex.tileType==="city"&&<text x={cx} y={cy+5} textAnchor="middle" fontSize={12} style={{pointerEvents:"none"}}>🏙</text>}
      {hex.tileType==="greenery"&&<text x={cx} y={cy+5} textAnchor="middle" fontSize={12} style={{pointerEvents:"none"}}>🌿</text>}
      {!hex.tileType&&hex.bonus.length>0&&(
        <text x={cx} y={cy+4} textAnchor="middle" fontSize={8} fill="#d8c868" opacity={.8} style={{pointerEvents:"none"}}>
          {[...new Set(hex.bonus)].map(b=>BONUS_ICON[b]||"").join("")}
        </text>
      )}
      {hex.name&&!hex.tileType&&<text x={cx} y={cy+3} textAnchor="middle" fontSize={7} fill="#b8b0e8" fontWeight="bold" style={{pointerEvents:"none"}}>{hex.name}</text>}
      {hex.isOcean&&!hex.tileType&&<text x={cx} y={cy+4} textAnchor="middle" fontSize={9} fill="#2860a0" opacity={.7} style={{pointerEvents:"none"}}>~</text>}
      {owner&&hex.tileType&&hex.tileType!=="ocean"&&(
        <circle cx={cx} cy={cy+9} r={4} fill={owner.color} stroke="#000" strokeWidth={1} opacity={.9}/>
      )}
      {valid&&myTurn&&!hex.tileType&&(
        <polygon points={pts} fill="none" stroke="#f0c040" strokeWidth={2} opacity={.55} style={{pointerEvents:"none"}}/>
      )}
    </g>
  );
}

function HexBoard({state,myPid,onHexClick}){
  const isMyTurn=state.players[state.activePlayerIdx]?.id===myPid;
  const pt=state.pendingTile;
  const myPIdx=state.players.findIndex(p=>p.id===myPid);

  const validSet=useMemo(()=>{
    if(!pt) return new Set();
    const v=new Set();
    const{type,pid}=pt;
    const myTiles=state.board.filter(h=>h.owner===pid&&h.tileType);
    const adjToMine=new Set(myTiles.flatMap(t=>adjIds(t.q,t.r)));
    state.board.forEach(hex=>{
      if(hex.tileType) return;
      if(type==="ocean"){ if(hex.isOcean) v.add(hex.id); return; }
      if(hex.isOcean) return;
      if(type==="city"){
        if(!adjHexes(hex.id,state.board).some(h=>h.tileType==="city")) v.add(hex.id);
        return;
      }
      if(type==="greenery"){
        if(myTiles.length===0){ v.add(hex.id); return; }
        const validAdj=[...adjToMine].filter(id=>{const bh=state.board.find(h=>h.id===id);return bh&&!bh.tileType&&!bh.isOcean;});
        if(validAdj.length>0){ if(adjToMine.has(hex.id)) v.add(hex.id); }
        else v.add(hex.id);
      }
    });
    return v;
  },[pt,state.board]);

  const playerMap=Object.fromEntries(state.players.map(p=>[p.id,p]));
  const canClick=isMyTurn&&pt&&pt.pid===myPid;

  const tileTypeColor={ocean:T.blue,greenery:T.green,city:"#aab"};
  const pendingColor=pt?tileTypeColor[pt.type]||T.gold:T.gold;

  return(
    <div style={{position:"relative",width:"100%",maxWidth:560,margin:"0 auto"}}>
      {/* Board glow border */}
      <div style={{borderRadius:10,overflow:"hidden",
        boxShadow:`0 0 32px #00000080, 0 0 2px ${T.border}`,
        border:`1px solid ${T.border}`}}>
        <svg viewBox={`0 0 ${BW} ${BH}`} preserveAspectRatio="xMidYMid meet"
          style={{display:"block",width:"100%",height:"auto",
          background:`radial-gradient(ellipse at 50% 40%,${T.marsMid} 0%,${T.marsDark} 70%,#000 100%)`}}>
          {state.board.map(hex=>(
            <HexCell key={hex.id} hex={hex}
              valid={validSet.has(hex.id)}
              myTurn={canClick}
              owner={hex.owner?playerMap[hex.owner]:null}
              onClick={()=>onHexClick&&onHexClick(hex.id)}/>
          ))}
        </svg>
      </div>
      {/* Bonus-icon legend */}
      <div style={{display:"flex",gap:10,flexWrap:"wrap",justifyContent:"center",
        padding:"5px 4px 0",fontSize:9,color:T.muted}}>
        <span>⬡ Steel</span><span>△ Titanium</span><span>🌿 Plant</span>
        <span>₡ MC</span><span>📜 Card</span><span>~ Ocean spot</span>
      </div>
      {/* Pending tile overlay */}
      {pt&&pt.pid===myPid&&(
        <div style={{
          position:"absolute",top:8,left:"50%",transform:"translateX(-50%)",
          background:`linear-gradient(135deg,${pendingColor}33,${pendingColor}11)`,
          border:`1.5px solid ${pendingColor}88`,
          borderRadius:8,padding:"5px 14px",
          color:pendingColor,fontSize:11,fontWeight:700,letterSpacing:"1px",
          backdropFilter:"blur(4px)",pointerEvents:"none",
          boxShadow:`0 0 16px ${pendingColor}44`,
        }}>
          🎯 Place {pt.type.toUpperCase()} — click a glowing hex
        </div>
      )}
      {pt&&pt.pid!==myPid&&(
        <div style={{
          position:"absolute",top:8,left:"50%",transform:"translateX(-50%)",
          background:"#00000099",border:`1px solid ${T.border}`,
          borderRadius:8,padding:"4px 12px",
          color:T.muted,fontSize:11,backdropFilter:"blur(4px)",pointerEvents:"none",
        }}>
          {state.players.find(p=>p.id===pt.pid)?.name} is placing {pt.type}…
        </div>
      )}
    </div>
  );
}

function CardView({cardId,mini=false,selected=false,onClick,disabled=false}){
  const card=CARDS[cardId];
  if(!card) return null;
  const acc=TYPE_ACCENT[card.type]||"#444";
  const lbl=TYPE_LABEL[card.type]||"";
  if(mini) return(
    <div onClick={disabled?null:onClick} title={card.name}
      style={{borderRadius:6,overflow:"hidden",cursor:disabled||!onClick?"default":"pointer",
        opacity:disabled?.45:1,width:68,flexShrink:0,
        border:`1.5px solid ${selected?"#f0c040":acc+"88"}`,
        background:selected?acc+"18":T.surfH,
        boxShadow:selected?`0 0 10px ${acc}44`:"none"}}>
      <div style={{height:3,background:acc}}/>
      <div style={{padding:"3px 5px"}}>
        <div style={{fontSize:10,color:T.gold,fontWeight:700,lineHeight:1}}>{card.cost}₡</div>
        <div style={{fontSize:9,color:T.text,fontWeight:600,lineHeight:1.25,marginTop:1,
          overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{card.name}</div>
        <div style={{fontSize:9,color:T.muted,marginTop:2,lineHeight:1}}>
          {card.tags.map(t=>TAG_ICON[t]||t[0]).join("")}
        </div>
      </div>
    </div>
  );
  return(
    <div onClick={disabled?null:onClick}
      style={{borderRadius:8,overflow:"hidden",marginBottom:6,
        border:`1.5px solid ${selected?"#f0c040":acc+"66"}`,
        background:selected?acc+"18":T.surf,
        cursor:disabled||!onClick?"default":"pointer",
        opacity:disabled?.45:1,width:"100%",boxSizing:"border-box",
        boxShadow:selected?`0 0 14px ${acc}44`:"0 2px 8px #00000040"}}>
      {/* Type stripe + cost */}
      <div style={{background:`linear-gradient(90deg,${acc}cc,${acc}44)`,
        padding:"4px 10px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span style={{fontSize:9,fontWeight:700,letterSpacing:"1px",color:"#fff",opacity:.85}}>{lbl}</span>
        <span style={{fontSize:12,fontWeight:800,color:T.gold,fontFamily:"'Orbitron',sans-serif"}}>{card.cost}₡</span>
      </div>
      {/* Body */}
      <div style={{padding:"7px 10px"}}>
        {/* Tags */}
        <div style={{display:"flex",gap:3,flexWrap:"wrap",marginBottom:4}}>
          {card.tags.map(t=>(
            <span key={t} style={{fontSize:9,background:T.surfB,border:`1px solid ${T.border}`,
              borderRadius:3,padding:"1px 5px",color:T.muted,display:"flex",alignItems:"center",gap:2}}>
              {TAG_ICON[t]||""} {t}
            </span>
          ))}
        </div>
        {/* Name */}
        <div style={{fontSize:12,fontWeight:700,color:T.text,marginBottom:4,lineHeight:1.2}}>{card.name}</div>
        {/* Desc */}
        <div style={{fontSize:10,color:T.muted,lineHeight:1.45}}>{card.desc}</div>
        {/* VP badge */}
        {card.vp&&typeof card.vp==="number"&&card.vp>0&&(
          <div style={{marginTop:5,display:"inline-block",background:T.purple+"33",
            border:`1px solid ${T.purple}66`,borderRadius:4,padding:"1px 7px",
            fontSize:10,color:T.purple,fontWeight:700}}>{card.vp} VP</div>
        )}
      </div>
    </div>
  );
}

// ── Player resource panel ─────────────────────────────────────────────
function PlayerPanel({player,isActive,isMe}){
  const corp=player.corporation;
  return(
    <div style={{
      borderRadius:9,padding:"8px 10px",marginBottom:6,
      background:isActive?`linear-gradient(135deg,${T.surfH},${T.surf})`:`linear-gradient(135deg,${T.surf},${T.bg})`,
      border:`1.5px solid ${isActive?player.color:T.border}`,
      boxShadow:isActive?`0 0 16px ${player.color}30`:"none",
      transition:"box-shadow .3s",
    }}>
      {/* Name row */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{width:8,height:8,borderRadius:"50%",background:player.color,
            flexShrink:0,boxShadow:isActive?`0 0 6px ${player.color}`:"none"}}/>
          <span style={{fontSize:12,fontWeight:700,color:isActive?player.color:T.text}}>
            {player.name}{isMe?<span style={{color:T.muted,fontWeight:400}}> (you)</span>:""}
          </span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          {corp&&<span style={{fontSize:10,color:T.muted}}>{corp.name}</span>}
          <span style={{
            background:`linear-gradient(135deg,${T.gold}33,${T.gold}11)`,
            border:`1px solid ${T.gold}44`,borderRadius:4,padding:"1px 7px",
            fontSize:11,fontWeight:700,color:T.gold,fontFamily:"'Orbitron',sans-serif",
          }}>TR {player.TR}</span>
        </div>
      </div>
      {/* Resources */}
      <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
        {["mc","steel","titanium","plants","energy","heat"].map(k=>(
          <Res key={k} k={k} v={player[k]} prod={player[k+"Prod"]}/>
        ))}
      </div>
      {/* Tag counts — visible for every player, not just yourself, since this
          drives milestone (Builder) and award (Scientist) strategy decisions */}
      {Object.keys(player.tags||{}).length>0&&(
        <div style={{display:"flex",gap:5,flexWrap:"wrap",marginTop:6,
          paddingTop:6,borderTop:`1px solid ${T.border}66`}}>
          {Object.entries(player.tags||{}).filter(([,v])=>v>0).map(([tag,count])=>(
            <span key={tag} title={tag} style={{
              background:T.surfB,border:`1px solid ${T.border}`,borderRadius:4,
              padding:"1px 6px",fontSize:10,color:T.muted,
              display:"flex",alignItems:"center",gap:3}}>
              {TAG_ICON[tag]||tag[0]}<span style={{color:T.text,fontWeight:600}}>{count}</span>
            </span>
          ))}
        </div>
      )}
      {isActive&&player.actionsLeft>0&&(
        <div style={{marginTop:5,fontSize:10,color:player.color,fontWeight:600}}>
          ● {player.actionsLeft} action{player.actionsLeft!==1?"s":""} remaining
        </div>
      )}
    </div>
  );
}

// ── Global parameters bar ─────────────────────────────────────────────
function GlobalBar({state}){
  const tempPct  = Math.min(100,((state.temperature+30)/38)*100);
  const oxyPct   = Math.min(100,(state.oxygen/14)*100);
  const oceanPct = Math.min(100,(state.oceansPlaced/9)*100);
  const allDone  = state.temperature>=8&&state.oxygen>=14&&state.oceansPlaced>=9;

  function Param({icon,val,pct,color,done}){
    return(
      <div style={{flex:1,minWidth:110}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:3}}>
          <span style={{fontSize:11,color:done?color:T.muted,fontWeight:600,letterSpacing:"0.3px"}}>
            {done?"✓ ":""}{icon}
          </span>
          <span style={{fontSize:12,color:done?color:T.text,fontWeight:700,
            fontFamily:"'Orbitron',sans-serif",letterSpacing:"0.5px"}}>{val}</span>
        </div>
        <div style={{height:5,background:T.surfB,borderRadius:3,overflow:"hidden",
          boxShadow:`inset 0 1px 3px #00000040`}}>
          <div style={{height:"100%",width:`${pct}%`,
            background:done?`linear-gradient(90deg,${color},${color}cc)`:color,
            borderRadius:3,transition:"width .5s ease",
            boxShadow:done?`0 0 8px ${color}88`:"none"}}/>
        </div>
      </div>
    );
  }

  return(
    <div style={{
      background:`linear-gradient(180deg,${T.surfH},${T.surf})`,
      borderBottom:`1px solid ${T.border}`,
      padding:"9px 16px",
      display:"flex",alignItems:"center",gap:16,flexWrap:"wrap",
      boxShadow:"0 2px 12px #00000060",
    }}>
      <div style={{fontFamily:"'Orbitron',sans-serif",
        background:`linear-gradient(135deg,${T.gold},${T.orange})`,
        WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",
        fontSize:14,fontWeight:700,flexShrink:0,letterSpacing:"1px"}}>
        GEN {state.generation}
      </div>
      <Param icon="🌡 TEMP" val={`${state.temperature}°C`} pct={tempPct}  color={T.red}   done={state.temperature>=8}/>
      <Param icon="🌿 OXY"  val={`${state.oxygen}%`}       pct={oxyPct}   color={T.green} done={state.oxygen>=14}/>
      <Param icon="🌊 SEA"  val={`${state.oceansPlaced}/9`} pct={oceanPct} color={T.blue}  done={state.oceansPlaced>=9}/>
      {allDone&&(
        <div style={{fontFamily:"'Orbitron',sans-serif",fontSize:10,letterSpacing:"2px",
          background:`linear-gradient(90deg,${T.gold},${T.orange},${T.gold})`,
          backgroundSize:"200%",animation:"shimmer 2s linear infinite",
          WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",fontWeight:700}}>
          ✦ TERRAFORM COMPLETE ✦
        </div>
      )}
    </div>
  );
}



// ═══════════════════════════════════════════════════════════════════════
// ACTION PANEL  (right-side panel during action phase)
// ═══════════════════════════════════════════════════════════════════════
function ActionPanel({state,myPid,send}){
  const pi=state.players.findIndex(p=>p.id===myPid);
  const p=state.players[pi];
  const isMyTurn=state.activePlayerIdx===pi&&state.phase==="action";
  const [showStd,setShowStd]=useState(false);
  const [showMilestones,setShowMilestones]=useState(false);
  const [showAwards,setShowAwards]=useState(false);
  const [sellMode,setSellMode]=useState(false);
  const [sellSel,setSellSel]=useState([]);

  if(!p) return null;

  const plantThresh=p.corporation?.id==="ecoline"?6:8;
  const canHeat=p.heat>=8&&state.temperature<8;
  const canPlants=p.plants>=plantThresh;
  const canUnmi=p.corporation?.id==="unmi"&&p.trRaisedThisGen&&p.mc>=3;

  function act(msg){ send(msg); setSellMode(false); setSellSel([]); }

  // ─── Section header helper ─────────────────────────────────────────
  function SectionBtn({label,badge,open,onClick,disabled}){
    return(
      <button onClick={onClick} disabled={disabled}
        style={{
          width:"100%",display:"flex",justifyContent:"space-between",
          alignItems:"center",padding:"7px 12px",marginBottom:open?0:4,
          background:open?T.surfH:T.surfB,color:disabled?T.muted:T.text,
          border:`1px solid ${open?T.border+"99":T.border}`,
          borderRadius:open?"7px 7px 0 0":7,fontSize:11,fontWeight:700,
          letterSpacing:"0.5px",textTransform:"uppercase",cursor:disabled?"not-allowed":"pointer",
          fontFamily:"'Exo 2',sans-serif",
        }}>
        <span>{label}</span>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          {badge&&<span style={{background:T.surfB,border:`1px solid ${T.border}`,
            borderRadius:4,padding:"1px 7px",fontSize:10,color:T.muted,fontWeight:600}}>
            {badge}</span>}
          <span style={{color:T.muted,fontSize:10}}>{open?"▲":"▼"}</span>
        </div>
      </button>
    );
  }

  function SectionBody({children}){
    return(
      <div style={{background:T.surf,border:`1px solid ${T.border}`,
        borderTop:"none",borderRadius:"0 0 7px 7px",padding:8,marginBottom:6}}>
        {children}
      </div>
    );
  }

  // Not my turn
  if(!isMyTurn) return(
    <div style={{padding:"12px 0"}}>
      {p.passed?(
        <div style={{textAlign:"center",padding:"16px 12px",
          background:T.surfH,borderRadius:8,border:`1px solid ${T.border}`,
          color:T.muted,fontSize:12,fontWeight:600}}>
          ✓ Passed this round
        </div>
      ):(
        <div style={{textAlign:"center",padding:"16px 12px",
          background:T.surfH,borderRadius:8,border:`1px solid ${T.border}`,
          color:T.muted,fontSize:12,fontWeight:600}}>
          ⏳ {state.players[state.activePlayerIdx]?.name}'s turn
        </div>
      )}
    </div>
  );

  // My turn, but I've already used both actions and haven't passed yet —
  // every other action would silently no-op, so show only the way out.
  if(p.actionsLeft<=0&&!state.pendingTile) return(
    <div style={{padding:"12px 0"}}>
      <div style={{textAlign:"center",padding:"14px 12px",marginBottom:10,
        background:`linear-gradient(135deg,${T.gold}18,${T.gold}06)`,
        border:`1px solid ${T.gold}44`,borderRadius:8,
        color:T.gold,fontSize:12,fontWeight:600}}>
        You've used both actions this turn
      </div>
      <button onClick={()=>send({t:"pass",pid:myPid})}
        style={{
          width:"100%",padding:"10px 12px",
          background:`linear-gradient(135deg,${T.mars}33,${T.mars}11)`,
          border:`1.5px solid ${T.mars}66`,borderRadius:7,
          color:"#e08070",fontSize:12,fontWeight:700,cursor:"pointer",
          fontFamily:"'Exo 2',sans-serif",letterSpacing:"0.5px",
        }}>
        ⏹ Pass — End My Turn
      </button>
    </div>
  );

  return(
    <div style={{fontSize:12}}>

      {/* Pending tile notice */}
      {state.pendingTile&&state.pendingTile.pid===myPid&&(
        <div style={{
          borderRadius:7,padding:"8px 12px",marginBottom:10,
          background:`linear-gradient(135deg,${T.gold}18,${T.gold}08)`,
          border:`1.5px solid ${T.gold}66`,color:T.gold,fontWeight:700,fontSize:12,
          boxShadow:`0 0 14px ${T.gold}22`,
        }}>
          🎯 Click a glowing hex on the board to place your {state.pendingTile.type}
        </div>
      )}

      {!state.pendingTile&&(
        <>
          {/* Convert Resources */}
          <div style={{marginBottom:6}}>
            <div style={{fontSize:9,fontWeight:700,letterSpacing:"2px",color:T.muted,
              textTransform:"uppercase",marginBottom:5}}>Convert Resources</div>
            <div style={{display:"flex",gap:6}}>
              <button disabled={!canHeat}
                onClick={()=>act({t:"heatToTemp",pid:myPid})}
                style={{flex:1,padding:"8px 6px",
                  background:canHeat?`linear-gradient(135deg,${T.red}33,${T.red}11)`:T.surfH,
                  border:`1.5px solid ${canHeat?T.red+"66":T.border}`,borderRadius:7,
                  color:canHeat?T.red:T.muted,cursor:canHeat?"pointer":"not-allowed",
                  fontSize:11,fontWeight:700,fontFamily:"'Exo 2',sans-serif",
                  boxShadow:canHeat?`0 0 12px ${T.red}33`:"none"}}>
                8🔥→🌡
                {!canHeat&&<div style={{fontSize:9,color:T.muted,marginTop:2}}>{p.heat}/8</div>}
              </button>
              <button disabled={!canPlants}
                onClick={()=>act({t:"plantsGreenery",pid:myPid})}
                style={{flex:1,padding:"8px 6px",
                  background:canPlants?`linear-gradient(135deg,${T.green}33,${T.green}11)`:T.surfH,
                  border:`1.5px solid ${canPlants?T.green+"66":T.border}`,borderRadius:7,
                  color:canPlants?T.green:T.muted,cursor:canPlants?"pointer":"not-allowed",
                  fontSize:11,fontWeight:700,fontFamily:"'Exo 2',sans-serif",
                  boxShadow:canPlants?`0 0 12px ${T.green}33`:"none"}}>
                {plantThresh}🌿→🌿
                {!canPlants&&<div style={{fontSize:9,color:T.muted,marginTop:2}}>{p.plants}/{plantThresh}</div>}
              </button>
            </div>
          </div>

          {/* UNMI */}
          {canUnmi&&(
            <button onClick={()=>act({t:"unmiAction",pid:myPid})}
              style={{width:"100%",padding:"7px 12px",marginBottom:6,
                background:`linear-gradient(135deg,${T.purple}33,${T.purple}11)`,
                border:`1.5px solid ${T.purple}66`,borderRadius:7,
                color:T.purple,fontSize:11,fontWeight:700,cursor:"pointer",
                fontFamily:"'Exo 2',sans-serif",
                boxShadow:`0 0 12px ${T.purple}33`}}>
              ⊕ UNMI Corp: pay 3₡ → +TR
            </button>
          )}

          {/* Standard Projects */}
          <SectionBtn label="Standard Projects" open={showStd}
            onClick={()=>setShowStd(!showStd)}/>
          {showStd&&(
            <SectionBody>
              {[
                {id:"powerPlant",icon:"⚡",label:"Power Plant",cost:11,desc:"+1 energy prod",
                  canAfford:p.mc>=11,avail:true},
                {id:"asteroid",icon:"☄️",label:"Asteroid",cost:14,desc:"Raise temp +2°C",
                  canAfford:p.mc>=14,avail:state.temperature<8},
                {id:"aquifer",icon:"🌊",label:"Aquifer",cost:18,desc:"Place ocean tile",
                  canAfford:p.mc>=18,avail:state.oceansPlaced<9},
                {id:"greenery",icon:"🌿",label:"Greenery",cost:23,desc:"Place greenery + raise O₂",
                  canAfford:p.mc>=23,avail:true},
                {id:"city",icon:"🏙",label:"City",cost:25,desc:"Place city + +1₡/gen",
                  canAfford:p.mc>=25,avail:true},
              ].map(sp=>(
                <button key={sp.id}
                  disabled={!sp.canAfford||!sp.avail}
                  onClick={()=>act({t:"stdProject",pid:myPid,project:sp.id})}
                  style={{
                    width:"100%",display:"flex",justifyContent:"space-between",
                    alignItems:"center",padding:"6px 10px",marginBottom:3,
                    background:sp.canAfford&&sp.avail?T.surfH:T.surfB,
                    border:`1px solid ${sp.canAfford&&sp.avail?T.border:T.border+"44"}`,
                    borderRadius:6,color:sp.canAfford&&sp.avail?T.text:T.muted,
                    cursor:sp.canAfford&&sp.avail?"pointer":"not-allowed",
                    fontSize:11,fontFamily:"'Exo 2',sans-serif",
                  }}>
                  <span>{sp.icon} {sp.label}</span>
                  <span style={{display:"flex",alignItems:"center",gap:8}}>
                    <span style={{color:T.muted,fontSize:10}}>{sp.desc}</span>
                    <span style={{color:sp.canAfford?T.gold:T.muted,fontWeight:700,
                      fontFamily:"'Orbitron',sans-serif",fontSize:11}}>{sp.cost}₡</span>
                  </span>
                </button>
              ))}
              {/* Sell Patents */}
              {p.hand.length>0&&(
                <>
                  <div style={{borderTop:`1px solid ${T.border}`,margin:"6px 0"}}/>
                  <button onClick={()=>{setSellMode(!sellMode);setSellSel([]);}}
                    style={{width:"100%",padding:"5px 10px",
                      background:sellMode?T.surfH:T.surfB,
                      border:`1px solid ${T.border}`,borderRadius:6,
                      color:T.muted,fontSize:11,cursor:"pointer",
                      fontFamily:"'Exo 2',sans-serif",
                      display:"flex",justifyContent:"space-between"}}>
                    <span>📜 Sell Patents (1₡ each)</span>
                    <span style={{fontSize:10}}>{sellMode?"▲":"▼"}</span>
                  </button>
                  {sellMode&&(
                    <div style={{marginTop:4,maxHeight:120,overflowY:"auto"}}>
                      {p.hand.map(id=>(
                        <label key={id} style={{display:"flex",alignItems:"center",gap:7,
                          padding:"3px 6px",cursor:"pointer",borderRadius:4,
                          background:sellSel.includes(id)?T.surfH:"transparent"}}>
                          <input type="checkbox" checked={sellSel.includes(id)}
                            onChange={e=>setSellSel(e.target.checked
                              ?[...sellSel,id]:sellSel.filter(x=>x!==id))}
                            style={{accentColor:T.gold}}/>
                          <span style={{fontSize:10,color:T.text}}>{CARDS[id]?.name||id}</span>
                          <span style={{marginLeft:"auto",fontSize:10,color:T.muted}}>1₡</span>
                        </label>
                      ))}
                      <B disabled={!sellSel.length} full style={{marginTop:4}}
                        bg={sellSel.length?`linear-gradient(135deg,${T.gold}33,${T.gold}11)`:""}
                        col={sellSel.length?T.gold:T.muted}
                        onClick={()=>act({t:"stdProject",pid:myPid,project:"sellPatents",cardIds:sellSel})}>
                        Sell {sellSel.length} patent{sellSel.length!==1?"s":""}
                        {sellSel.length>0&&<span style={{color:T.gold,fontFamily:"'Orbitron',sans-serif",marginLeft:6}}> +{sellSel.length}₡</span>}
                      </B>
                    </div>
                  )}
                </>
              )}
            </SectionBody>
          )}

          {/* Milestones */}
          <SectionBtn label="Milestones" badge={`${3-state.milestonesClaimed} left · 8₡`}
            open={showMilestones} onClick={()=>setShowMilestones(!showMilestones)}
            disabled={state.milestonesClaimed>=3}/>
          {showMilestones&&(
            <SectionBody>
              {state.milestones.map(ms=>{
                const met=ms.check(p,state);
                const taken=!!ms.claimedBy;
                const claimer=state.players.find(x=>x.id===ms.claimedBy);
                return(
                  <div key={ms.id} style={{display:"flex",alignItems:"center",
                    gap:8,marginBottom:5}}>
                    <button
                      disabled={taken||!met||p.mc<8||state.milestonesClaimed>=3}
                      onClick={()=>act({t:"claimMilestone",pid:myPid,id:ms.id})}
                      style={{
                        padding:"5px 10px",borderRadius:6,fontSize:11,fontWeight:700,
                        cursor:taken||!met||p.mc<8||state.milestonesClaimed>=3?"not-allowed":"pointer",
                        background:met&&!taken?`linear-gradient(135deg,${T.gold}22,${T.gold}08)`:T.surfB,
                        border:`1px solid ${met&&!taken?T.gold+"55":T.border}`,
                        color:taken?T.green:met?T.gold:T.muted,
                        fontFamily:"'Exo 2',sans-serif",flexShrink:0,
                      }}>
                      {taken?`✓ ${claimer?.name}`:met?"CLAIM":"✗"}
                    </button>
                    <div>
                      <div style={{fontWeight:700,color:taken?T.green:T.text,fontSize:11}}>
                        {ms.name}
                      </div>
                      <div style={{color:T.muted,fontSize:10}}>{ms.req}</div>
                    </div>
                  </div>
                );
              })}
            </SectionBody>
          )}

          {/* Awards */}
          <SectionBtn label="Awards" badge={`${[8,14,20][state.awardsFunded]||"—"}₡ to fund`}
            open={showAwards} onClick={()=>setShowAwards(!showAwards)}
            disabled={state.awardsFunded>=3}/>
          {showAwards&&(
            <SectionBody>
              {state.awards.map(aw=>{
                const cost=[8,14,20][state.awardsFunded];
                const funded=!!aw.fundedBy;
                const funder=state.players.find(x=>x.id===aw.fundedBy);
                return(
                  <div key={aw.id} style={{display:"flex",alignItems:"center",
                    gap:8,marginBottom:5}}>
                    <button
                      disabled={funded||p.mc<cost||state.awardsFunded>=3}
                      onClick={()=>act({t:"fundAward",pid:myPid,id:aw.id})}
                      style={{
                        padding:"5px 10px",borderRadius:6,fontSize:11,fontWeight:700,
                        cursor:funded||p.mc<cost||state.awardsFunded>=3?"not-allowed":"pointer",
                        background:!funded&&p.mc>=cost?`linear-gradient(135deg,${T.purple}22,${T.purple}08)`:T.surfB,
                        border:`1px solid ${!funded&&p.mc>=cost?T.purple+"55":T.border}`,
                        color:funded?T.purple:p.mc>=cost?T.purple:T.muted,
                        fontFamily:"'Exo 2',sans-serif",flexShrink:0,
                      }}>
                      {funded?`✓ ${funder?.name}`:cost+"₡"}
                    </button>
                    <div>
                      <div style={{fontWeight:700,color:funded?T.purple:T.text,fontSize:11}}>
                        {aw.name}
                      </div>
                      <div style={{color:T.muted,fontSize:10}}>{aw.desc}</div>
                    </div>
                  </div>
                );
              })}
            </SectionBody>
          )}

          {/* Pass */}
          <button onClick={()=>act({t:"pass",pid:myPid})}
            style={{
              width:"100%",padding:"9px 12px",marginTop:6,
              background:`linear-gradient(135deg,${T.mars}33,${T.mars}11)`,
              border:`1.5px solid ${T.mars}66`,borderRadius:7,
              color:"#e08070",fontSize:12,fontWeight:700,cursor:"pointer",
              fontFamily:"'Exo 2',sans-serif",letterSpacing:"0.5px",
              boxShadow:`0 0 12px ${T.mars}22`,
            }}>
            ⏹ Pass — End My Actions This Round
          </button>
        </>
      )}
    </div>
  );
}


function player_color(p){
  return p.color+"33";
}

// ── Hand Panel ────────────────────────────────────────────────────────
function HandPanel({state,myPid,send}){
  const pi=state.players.findIndex(p=>p.id===myPid);
  const p=state.players[pi];
  const myTileIsPending=state.pendingTile&&state.pendingTile.pid===myPid;
  const isMyTurn=state.activePlayerIdx===pi&&state.phase==="action"&&!myTileIsPending;
  const [selected,setSelected]=useState(null);
  const [steelPay,setSteelPay]=useState(0);
  const [tiPay,setTiPay]=useState(0);
  const [heatPay,setHeatPay]=useState(0);
  const [filter,setFilter]=useState("");

  if(!p) return null;

  if(myTileIsPending) return(
    <div style={{textAlign:"center",padding:"16px 12px",
      background:`linear-gradient(135deg,${T.gold}18,${T.gold}06)`,
      border:`1px solid ${T.gold}44`,borderRadius:8,
      color:T.gold,fontSize:12,fontWeight:600}}>
      🎯 Place your {state.pendingTile.type} on the board first — head to the Actions tab or click a glowing hex.
    </div>
  );

  const isHelion=p.corporation?.id==="helion";
  const hand=p.hand.filter(id=>{
    if(!filter.trim()) return true;
    const c=CARDS[id]; if(!c) return false;
    const q=filter.toLowerCase();
    return c.name.toLowerCase().includes(q)||c.tags.some(t=>t.includes(q))||c.desc.toLowerCase().includes(q);
  });

  if(!p.hand.length) return(
    <div style={{color:T.muted,fontSize:12,textAlign:"center",padding:"12px 0"}}>No cards in hand</div>
  );

  const card=selected?CARDS[selected]:null;
  const sw=p.steelValue||2, tw=p.tiValue||3;
  const effectiveCost=card?Math.max(0,card.cost-steelPay*sw-tiPay*tw-heatPay-corpCostDiscount(p,card)):0;
  const canAfford=card&&p.mc>=effectiveCost&&p.steel>=steelPay&&p.titanium>=tiPay&&(isHelion?p.heat>=heatPay:heatPay===0);
  const metReq=card&&reqMet(card,state,pi);
  const maxSteel=card&&card.tags.some(t=>t==="building")?Math.min(p.steel,Math.ceil(card.cost/sw)):0;
  const maxTi=card&&card.tags.some(t=>["space","jovian"].includes(t))?Math.min(p.titanium,Math.ceil(card.cost/tw)):0;
  const maxHeat=isHelion&&card?Math.min(p.heat,card.cost):0;

  function playSelected(){
    if(!selected||!isMyTurn||!canAfford||!metReq) return;
    send({t:"playCard",pid:myPid,cardId:selected,steelPay,tiPay,heatPay});
    setSelected(null); setSteelPay(0); setTiPay(0); setHeatPay(0);
  }

  // Blue card actions — now handles array of actions per card
  const blueActions=p.played
    .filter(id=>!id.endsWith("_fd"))
    .map(id=>CARDS[id])
    .filter(c=>c?.action);

  return(
    <div style={{fontSize:12}}>
      {/* Search bar */}
      <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:8}}>
        <input value={filter} onChange={e=>setFilter(e.target.value)}
          placeholder="🔍 Search cards…" style={{...INP_S,padding:"5px 10px",fontSize:12,flex:1}}/>
        {filter&&<button onClick={()=>setFilter("")}
          style={{background:"none",border:"none",color:T.muted,cursor:"pointer",fontSize:14}}>✕</button>}
        <span style={{color:T.muted,fontSize:11,whiteSpace:"nowrap"}}>{hand.length}/{p.hand.length}</span>
      </div>

      <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:8}}>
        {hand.map(id=>(
          <CardView key={id} cardId={id} mini
            selected={selected===id}
            onClick={()=>{setSelected(id===selected?null:id);setSteelPay(0);setTiPay(0);setHeatPay(0);}}
            disabled={!isMyTurn}/>
        ))}
        {hand.length===0&&filter&&<div style={{color:T.muted,fontSize:11}}>No cards match "{filter}"</div>}
      </div>

      {selected&&card&&(
        <div style={{background:T.surfH,borderRadius:8,padding:10,marginBottom:8,
          border:`1px solid ${TYPE_CLR[card.type]||T.border}`}}>
          <div style={{fontWeight:700,marginBottom:4}}>{card.name} — {card.cost}₡</div>
          <div style={{color:T.muted,marginBottom:6,lineHeight:1.4}}>{card.desc}</div>
          {card.req&&<div style={{color:metReq?T.green:T.red,fontSize:11,marginBottom:6,fontWeight:600}}>
            {metReq?"✓ Requirement met":"✗ Requirement not met"}
          </div>}
          {maxSteel>0&&(
            <div style={{marginBottom:4}}>
              Steel (worth {sw}₡):&nbsp;
              <button onClick={()=>setSteelPay(Math.max(0,steelPay-1))} style={{padding:"2px 8px",background:T.surfB,border:`1px solid ${T.border}`,borderRadius:4,color:T.text,cursor:"pointer"}}>−</button>
              <span style={{margin:"0 8px",color:T.gold}}>{steelPay}</span>
              <button onClick={()=>setSteelPay(Math.min(maxSteel,steelPay+1))} style={{padding:"2px 8px",background:T.surfB,border:`1px solid ${T.border}`,borderRadius:4,color:T.gold,cursor:"pointer"}}>+</button>
            </div>
          )}
          {maxTi>0&&(
            <div style={{marginBottom:4}}>
              Titanium (worth {tw}₡):&nbsp;
              <button onClick={()=>setTiPay(Math.max(0,tiPay-1))} style={{padding:"2px 8px",background:T.surfB,border:`1px solid ${T.border}`,borderRadius:4,color:T.text,cursor:"pointer"}}>−</button>
              <span style={{margin:"0 8px",color:T.gold}}>{tiPay}</span>
              <button onClick={()=>setTiPay(Math.min(maxTi,tiPay+1))} style={{padding:"2px 8px",background:T.surfB,border:`1px solid ${T.border}`,borderRadius:4,color:T.gold,cursor:"pointer"}}>+</button>
            </div>
          )}
          {isHelion&&maxHeat>0&&(
            <div style={{marginBottom:4,color:T.red}}>
              Heat as MC (Helion):&nbsp;
              <button onClick={()=>setHeatPay(Math.max(0,heatPay-1))} style={{padding:"2px 8px",background:T.surfB,border:`1px solid ${T.border}`,borderRadius:4,color:T.text,cursor:"pointer"}}>−</button>
              <span style={{margin:"0 8px",color:T.red}}>{heatPay}</span>
              <button onClick={()=>setHeatPay(Math.min(maxHeat,heatPay+1))} style={{padding:"2px 8px",background:T.surfB,border:`1px solid ${T.border}`,borderRadius:4,color:T.red,cursor:"pointer"}}>+</button>
              <span style={{color:T.muted,marginLeft:4,fontSize:10}}>(have {p.heat}🔥)</span>
            </div>
          )}
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            <B disabled={!canAfford||!metReq||!isMyTurn} bg="#1a4a1a" col={T.green}
              onClick={playSelected}>
              Play — {effectiveCost}₡
            </B>
            <B onClick={()=>{setSelected(null);setSteelPay(0);setTiPay(0);}}>Cancel</B>
          </div>
        </div>
      )}

      {isMyTurn&&blueActions.length>0&&(
        <div style={{marginTop:8}}>
          <div style={{color:T.blue,fontWeight:700,marginBottom:4}}>Blue Card Actions:</div>
          {blueActions.map(c=>{
            const actions=Array.isArray(c.action)?c.action:[c.action];
            return actions.map((act,idx)=>{
              const usedKey=`${c.id}_${idx}`;
              const used=(p.usedActions||[]).includes(usedKey);
              const resources=p.cardResources?.[c.id]||0;
              const vpNow=typeof c.vp==="function"?c.vp(p):0;
              return(
                <div key={usedKey} style={{marginBottom:4}}>
                  <B full disabled={used||!act.canUse(state,pi)}
                    bg={used?"#111":act.canUse(state,pi)?"#001833":T.surfB}
                    col={used?T.muted:T.blue}
                    onClick={()=>send({t:"blueAction",pid:myPid,cardId:c.id,actionIdx:idx})}>
                    {used?"✓ Used — ":""}{c.name}: {act.label}
                    {resources>0&&<span style={{color:T.green,marginLeft:6}}>({resources}🦠{vpNow>0?` · ${vpNow}VP`:""})</span>}
                  </B>
                </div>
              );
            });
          })}
        </div>
      )}

      {/* Played cards with resources */}
      {p.played.filter(id=>!id.endsWith("_fd")).length>0&&(
        <div style={{marginTop:10}}>
          <div style={{color:T.muted,fontSize:11,marginBottom:4}}>Played tableau:</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
            {p.played.filter(id=>!id.endsWith("_fd")).map(id=>{
              const card=CARDS[id]; if(!card) return null;
              const res=p.cardResources?.[id]||0;
              const vpNow=typeof card.vp==="function"?card.vp(p):(card.vp||0);
              return(
                <div key={id} style={{background:T.surf,border:`1px solid ${TYPE_CLR[card.type]||T.border}`,
                  borderRadius:4,padding:"3px 7px",fontSize:10,color:T.muted}}>
                  {card.name}
                  {res>0&&<span style={{color:T.green,marginLeft:4}}>{res}🦠</span>}
                  {vpNow>0&&<span style={{color:T.gold,marginLeft:4}}>{vpNow}VP</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Research Phase UI ─────────────────────────────────────────────────
function ResearchScreen({state,myPid,send}){
  const pi=state.players.findIndex(p=>p.id===myPid);
  const p=state.players[pi];
  const [chosen,setChosen]=useState([]);
  if(!p) return null;

  if(p.doneResearch) return(
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",
      justifyContent:"center",minHeight:"60vh",gap:14}}>
      <div style={{fontFamily:"'Orbitron',sans-serif",fontSize:14,fontWeight:700,
        color:T.gold,letterSpacing:"2px"}}>Research Done</div>
      <div style={{display:"flex",gap:6}}>
        {state.players.map(x=>(
          <div key={x.id} style={{width:28,height:28,borderRadius:"50%",
            background:x.doneResearch?x.color:T.surfH,
            border:`2px solid ${x.doneResearch?x.color:T.border}`,
            transition:"all .3s"}}/>
        ))}
      </div>
      <div style={{color:T.muted,fontSize:12}}>
        {state.players.filter(x=>x.doneResearch).length}/{state.players.length} ready
      </div>
    </div>
  );

  const cards=p.researchCards||[];
  const cost=chosen.length*3;
  const canAfford=p.mc>=cost;
  const toggle=id=>setChosen(c=>c.includes(id)?c.filter(x=>x!==id):[...c,id]);

  return(
    <div style={{padding:"28px 20px",maxWidth:700,margin:"0 auto"}}>
      {/* Header */}
      <div style={{textAlign:"center",marginBottom:20}}>
        <div style={{fontFamily:"'Orbitron',sans-serif",fontWeight:700,
          fontSize:"clamp(1rem,3vw,1.3rem)",letterSpacing:"3px",
          color:T.gold,marginBottom:4}}>
          RESEARCH PHASE
        </div>
        <div style={{color:T.muted,fontSize:12,letterSpacing:"1px"}}>
          Generation {state.generation} — Buy cards for 3₡ each
        </div>
        <div style={{marginTop:8,display:"inline-flex",gap:20,
          background:T.surfH,borderRadius:8,padding:"6px 20px",
          border:`1px solid ${T.border}`}}>
          <span style={{fontSize:12,color:T.muted}}>
            Your MC: <b style={{color:T.gold,fontFamily:"'Orbitron',sans-serif"}}>{p.mc}₡</b>
          </span>
          <span style={{color:T.border}}>|</span>
          <span style={{fontSize:12,color:T.muted}}>
            Cost: <b style={{color:canAfford?T.green:T.red}}>{cost}₡</b>
          </span>
        </div>
      </div>

      {/* Cards */}
      <div style={{display:"grid",
        gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))",
        gap:10,marginBottom:20}}>
        {cards.map((id,i)=>(
          <div key={id} onClick={()=>toggle(id)}
            style={{animation:`floatUp .25s ease ${i*.05}s both`,cursor:"pointer"}}>
            <CardView cardId={id} selected={chosen.includes(id)}/>
          </div>
        ))}
        {cards.length===0&&(
          <div style={{color:T.muted,gridColumn:"1/-1",textAlign:"center",padding:20}}>
            Deck is empty — no cards to draw
          </div>
        )}
      </div>

      {/* Confirm */}
      <div style={{textAlign:"center"}}>
        <button
          disabled={!canAfford&&chosen.length>0}
          onClick={()=>send({t:"doneResearch",pid:myPid,cardIds:chosen})}
          style={{...BTN_S,
            background:canAfford||chosen.length===0
              ?`linear-gradient(135deg,${T.green},#1a6030)`
              :T.surfH,
            color:canAfford||chosen.length===0?"#fff":T.muted,
            fontSize:14,fontWeight:700,padding:"12px 32px",
            letterSpacing:"1px",
            boxShadow:canAfford||chosen.length===0?`0 4px 20px ${T.green}44`:"none",
          }}>
          {chosen.length===0
            ?"Skip — Buy No Cards"
            :`Buy ${chosen.length} Card${chosen.length!==1?"s":""} for ${cost}₡`}
        </button>
      </div>
    </div>
  );
}

function EndScreen({state}){
  const scores=calcScores(state);
  const [detail,setDetail]=useState(null);
  const medals=["🥇","🥈","🥉","4","5"];

  return(
    <div style={{minHeight:"100vh",background:T.bg,
      fontFamily:"'Exo 2',sans-serif",color:T.text,
      display:"flex",flexDirection:"column",alignItems:"center",
      padding:"40px 20px 60px"}}>

      {/* Banner */}
      <div style={{textAlign:"center",marginBottom:32}}>
        <div style={{fontSize:"4rem",marginBottom:12,
          filter:"drop-shadow(0 0 30px #f0c04088)"}}>🏆</div>
        <div style={{fontFamily:"'Orbitron',sans-serif",fontWeight:900,
          fontSize:"clamp(1.4rem,4vw,2rem)",letterSpacing:"4px",
          background:`linear-gradient(90deg,${T.gold},${T.orange},${T.gold})`,
          backgroundSize:"200%",animation:"shimmer 3s linear infinite",
          WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",
          marginBottom:8}}>
          MARS TERRAFORMED
        </div>
        <div style={{color:T.muted,fontSize:11,letterSpacing:"3px",textTransform:"uppercase"}}>
          Temp {state.temperature}°C · O₂ {state.oxygen}% · {state.oceansPlaced} Oceans · Gen {state.generation}
        </div>
      </div>

      {/* Scores */}
      <div style={{width:"100%",maxWidth:560}}>
        {scores.map((s,i)=>{
          const isWin=i===0;
          const open=detail===s.id;
          return(
            <div key={s.id} style={{marginBottom:8,animation:`floatUp .35s ease ${i*.08}s both`}}>
              {/* Row */}
              <div onClick={()=>setDetail(open?null:s.id)}
                style={{
                  borderRadius:10,padding:"12px 16px",cursor:"pointer",
                  background:isWin
                    ?`linear-gradient(135deg,${T.gold}18,${T.surf})`
                    :T.surf,
                  border:`2px solid ${isWin?T.gold:T.border}`,
                  boxShadow:isWin?`0 4px 24px ${T.gold}33`:"0 2px 8px #00000040",
                  display:"flex",alignItems:"center",gap:12,
                  transition:"border-color .2s",
                }}>
                <span style={{fontSize:isWin?28:20,flexShrink:0}}>{medals[i]}</span>
                <div style={{flex:1}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:2}}>
                    <span style={{width:10,height:10,borderRadius:"50%",
                      background:s.color,flexShrink:0,
                      boxShadow:isWin?`0 0 8px ${s.color}`:"none"}}/>
                    <span style={{fontWeight:700,fontSize:15,color:isWin?T.text:T.text}}>
                      {s.name}
                    </span>
                    <span style={{color:T.muted,fontSize:11}}>{s.corp}</span>
                  </div>
                  <div style={{color:T.muted,fontSize:11}}>
                    TR {s.TR} · {s.tiles} tiles
                  </div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontFamily:"'Orbitron',sans-serif",
                    fontSize:isWin?26:20,fontWeight:900,
                    color:isWin?T.gold:T.text}}>
                    {s.score}
                  </div>
                  <div style={{color:T.muted,fontSize:10}}>VP</div>
                </div>
                <div style={{color:T.muted,fontSize:11,marginLeft:4}}>
                  {open?"▲":"▼"}
                </div>
              </div>
              {/* Breakdown */}
              {open&&(
                <div style={{
                  background:T.surfH,borderRadius:"0 0 10px 10px",
                  padding:"12px 16px",
                  border:`1px solid ${T.border}`,borderTop:"none",
                  animation:"fadeUp .2s ease",
                }}>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",
                    gap:"8px 16px",marginBottom:s.breakdown.cardDetail.length?10:0}}>
                    {[
                      ["TR",s.breakdown.tr,T.text],
                      ["Milestones",s.breakdown.milestones,T.gold],
                      ["Awards",s.breakdown.awards,T.purple],
                      ["Greeneries",s.breakdown.greeneries,T.green],
                      ["Cities",s.breakdown.cities,T.blue],
                      ["Card VP",s.breakdown.cards,T.orange],
                    ].map(([label,val,clr])=>(
                      <div key={label} style={{
                        background:T.surf,borderRadius:6,padding:"6px 10px",
                        border:`1px solid ${T.border}`}}>
                        <div style={{color:T.muted,fontSize:10,marginBottom:2}}>{label}</div>
                        <div style={{color:clr,fontWeight:700,fontSize:16,
                          fontFamily:"'Orbitron',sans-serif"}}>{val}</div>
                      </div>
                    ))}
                  </div>
                  {s.breakdown.cardDetail.length>0&&(
                    <div style={{fontSize:11,color:T.muted,lineHeight:1.7}}>
                      {s.breakdown.cardDetail.map(c=>(
                        <span key={c.name} style={{marginRight:10}}>
                          <span style={{color:T.orange}}>+{c.vp}</span> {c.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{color:T.muted,fontSize:11,marginTop:20,letterSpacing:"1px"}}>
        Tap a row to see VP breakdown · Refresh to play again
      </div>
    </div>
  );
}

function CorpSelection({state,myPid,send}){
  const pi=state.players.findIndex(p=>p.id===myPid);
  const p=state.players[pi];
  const [hovered,setHovered]=useState(null);
  if(!p) return null;

  const chosen=state.players.filter(x=>x.corpChosen).length;
  const total=state.players.length;

  if(p.corpChosen) return(
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",
      justifyContent:"center",minHeight:"60vh",gap:16}}>
      <div style={{fontFamily:"'Orbitron',sans-serif",fontSize:16,fontWeight:700,
        color:T.gold,letterSpacing:"2px"}}>Corporation Selected</div>
      <div style={{display:"flex",gap:6}}>
        {state.players.map(x=>(
          <div key={x.id} style={{width:32,height:32,borderRadius:"50%",
            background:x.corpChosen?x.color:T.surfH,
            border:`2px solid ${x.corpChosen?x.color:T.border}`,
            boxShadow:x.corpChosen?`0 0 10px ${x.color}66`:"none",
            transition:"all .3s"}}/>
        ))}
      </div>
      <div style={{color:T.muted,fontSize:12,letterSpacing:"1px"}}>
        {chosen} / {total} players ready
      </div>
    </div>
  );

  return(
    <div style={{padding:"32px 20px 64px",maxWidth:900,margin:"0 auto"}}>
      {/* Header */}
      <div style={{textAlign:"center",marginBottom:32}}>
        <div style={{fontFamily:"'Orbitron',sans-serif",fontWeight:900,
          fontSize:"clamp(1.1rem,3vw,1.5rem)",letterSpacing:"3px",
          background:`linear-gradient(135deg,${T.gold},${T.orange})`,
          WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",
          marginBottom:6}}>
          CHOOSE YOUR CORPORATION
        </div>
        <div style={{color:T.muted,fontSize:12,letterSpacing:"2px"}}>
          Each corporation gives you a unique starting position and ability
        </div>
      </div>

      {/* Corp cards grid */}
      <div style={{display:"grid",
        gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",
        gap:14}}>
        {(p.corpOptions||[]).map(corp=>{
          const isHov=hovered===corp.id;
          return(
            <div key={corp.id}
              onClick={()=>send({t:"chooseCorp",pid:myPid,corpId:corp.id})}
              onMouseEnter={()=>setHovered(corp.id)}
              onMouseLeave={()=>setHovered(null)}
              style={{
                borderRadius:12,overflow:"hidden",cursor:"pointer",
                border:`2px solid ${isHov?(corp.color||T.mars):T.border}`,
                background:isHov
                  ?`linear-gradient(160deg,${corp.color||T.mars}22,${T.surf})`
                  :T.surf,
                boxShadow:isHov?`0 8px 32px ${corp.color||T.mars}44`:"0 2px 12px #00000050",
                transition:"all .2s ease",
                transform:isHov?"translateY(-2px)":"translateY(0)",
              }}>
              {/* Corp colour stripe */}
              <div style={{height:4,
                background:`linear-gradient(90deg,${corp.color||T.mars},${corp.color||T.mars}44)`}}/>
              <div style={{padding:"16px 18px"}}>
                {/* Corp name */}
                <div style={{fontFamily:"'Orbitron',sans-serif",fontWeight:700,
                  fontSize:15,color:corp.color||T.text,
                  letterSpacing:"1px",marginBottom:10}}>
                  {corp.name}
                </div>
                {/* Starting resources */}
                <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:12}}>
                  <span style={{
                    background:`linear-gradient(135deg,${T.gold}22,${T.gold}08)`,
                    border:`1px solid ${T.gold}44`,borderRadius:5,
                    padding:"3px 10px",fontSize:12,color:T.gold,fontWeight:700,
                    fontFamily:"'Orbitron',sans-serif"}}>
                    {corp.startMC}₡
                  </span>
                  {corp.startRes&&Object.entries(corp.startRes).map(([k,v])=>(
                    <span key={k} style={{background:T.surfH,border:`1px solid ${T.border}`,
                      borderRadius:5,padding:"3px 9px",fontSize:11,color:T.text,
                      display:"flex",alignItems:"center",gap:3}}>
                      {v}{RES_ICON[k]}
                    </span>
                  ))}
                  {corp.startProd&&Object.entries(corp.startProd).map(([k,v])=>(
                    <span key={k} style={{background:T.surfH,border:`1px solid ${T.border}`,
                      borderRadius:5,padding:"3px 9px",fontSize:11,color:T.green,
                      display:"flex",alignItems:"center",gap:3}}>
                      +{v}{RES_ICON[k]}<span style={{color:T.muted,fontSize:9}}>/gen</span>
                    </span>
                  ))}
                </div>
                {/* Description */}
                <div style={{fontSize:12,color:T.muted,lineHeight:1.6,
                  borderTop:`1px solid ${T.border}`,paddingTop:10}}>
                  {corp.desc}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MilestonesAwardsBar({state}){
  return(
    <div style={{display:"flex",gap:5,flexWrap:"wrap",padding:"6px 12px",
      borderTop:`1px solid ${T.border}`,
      background:`linear-gradient(180deg,${T.surf},${T.bg})`,fontSize:10}}>
      <span style={{color:T.muted,fontWeight:600,alignSelf:"center",letterSpacing:"1px",
        fontSize:9,textTransform:"uppercase",marginRight:2}}>Milestones</span>
      {state.milestones.map(m=>{
        const c=state.players.find(p=>p.id===m.claimedBy);
        return(
          <div key={m.id} style={{
            background:c?`linear-gradient(135deg,${T.gold}22,${T.gold}08)`:T.surfH,
            border:`1px solid ${c?T.gold+"66":T.border}`,borderRadius:5,
            padding:"3px 8px",color:c?T.gold:T.muted,fontWeight:c?700:400,
            display:"flex",alignItems:"center",gap:4}}>
            {c&&<span style={{fontSize:9}}>✓</span>}
            {m.name}
            {c&&<span style={{opacity:.65,fontSize:9}}>·{c.name}</span>}
          </div>
        );
      })}
      <span style={{color:T.border,alignSelf:"center",margin:"0 2px"}}>│</span>
      <span style={{color:T.muted,fontWeight:600,alignSelf:"center",letterSpacing:"1px",
        fontSize:9,textTransform:"uppercase",marginRight:2}}>Awards</span>
      {state.awards.map((a,i)=>{
        const c=state.players.find(p=>p.id===a.fundedBy);
        const costs=[8,14,20];
        return(
          <div key={a.id} style={{
            background:c?`linear-gradient(135deg,${T.purple}22,${T.purple}08)`:T.surfH,
            border:`1px solid ${c?T.purple+"66":T.border}`,borderRadius:5,
            padding:"3px 8px",color:c?T.purple:T.muted,fontWeight:c?700:400,
            display:"flex",alignItems:"center",gap:4}}>
            {c?<span style={{fontSize:9}}>✓</span>:<span style={{color:T.gold,fontSize:9}}>{costs[i]||"—"}₡</span>}
            {a.name}
            {c&&<span style={{opacity:.65,fontSize:9}}>·{c.name}</span>}
          </div>
        );
      })}
    </div>
  );
}

function GameScreen({state,myPid,send}){
  const [tab,setTab]=useState("actions");
  const pi=state.players.findIndex(p=>p.id===myPid);
  const me=state.players[pi];
  const activeP=state.players[state.activePlayerIdx];
  const isMyTurn=activeP?.id===myPid;

  const TABS=["Actions","Hand","Log"];
  const tabBadge={Hand:me?.hand.length};

  return(
    <div style={{display:"flex",flexDirection:"column",height:"100vh",
      background:T.bg,color:T.text,fontFamily:"'Exo 2',sans-serif",overflow:"hidden"}}>

      {/* ── Top bar – global parameters ── */}
      <GlobalBar state={state}/>

      {/* ── Main area ── */}
      <div className="tm-main">

        {/* ── Left: Board + player list ── */}
        <div className="tm-board-col">

          <HexBoard state={state} myPid={myPid}
            onHexClick={hexId=>send({t:"placeTile",pid:myPid,hexId})}/>

          {/* Player cards below board */}
          <div style={{overflowY:"auto",marginTop:8,paddingBottom:8,flex:1}}>
            {state.players.map((p,i)=>(
              <PlayerPanel key={p.id} player={p}
                isActive={state.activePlayerIdx===i} isMe={p.id===myPid}/>
            ))}
          </div>
        </div>

        {/* ── Right: Side panel ── */}
        <div className="tm-side-col">

          {/* Active-player banner */}
          <div style={{
            padding:"8px 14px",flexShrink:0,
            background:isMyTurn
              ?`linear-gradient(90deg,${activeP?.color||T.mars}28,transparent)`
              :`linear-gradient(90deg,${T.surfH},${T.surf})`,
            borderBottom:`1px solid ${isMyTurn?(activeP?.color||T.mars)+"44":T.border}`,
            display:"flex",alignItems:"center",gap:10,
            boxShadow:isMyTurn?`0 2px 12px ${activeP?.color||T.mars}22`:"none",
          }}>
            {activeP&&(
              <>
                <span style={{width:9,height:9,borderRadius:"50%",
                  background:activeP.color,flexShrink:0,
                  boxShadow:isMyTurn?`0 0 8px ${activeP.color}`:"none"}}/>
                <span style={{fontWeight:700,fontSize:12,
                  color:isMyTurn?T.text:activeP.color}}>
                  {isMyTurn?"Your turn":""+activeP.name+"'s turn"}
                </span>
                {isMyTurn&&(
                  <span style={{marginLeft:"auto",
                    background:`linear-gradient(135deg,${activeP.color}22,${activeP.color}08)`,
                    border:`1px solid ${activeP.color}44`,borderRadius:5,
                    padding:"2px 8px",fontSize:10,color:activeP.color,fontWeight:700}}>
                    {activeP.actionsLeft} action{activeP.actionsLeft!==1?"s":""} left
                  </span>
                )}
                {state.pendingTile&&(
                  <span style={{marginLeft:"auto",color:T.gold,fontSize:10,fontWeight:700}}>
                    ➜ placing {state.pendingTile.type}
                  </span>
                )}
              </>
            )}
          </div>

          {/* My resources — pinned, always visible regardless of tab or left-column scroll */}
          {me&&(
            <div style={{
              display:"flex",alignItems:"center",gap:10,flexShrink:0,
              padding:"6px 14px",background:T.surf,
              borderBottom:`1px solid ${T.border}`,overflowX:"auto",
            }}>
              <span style={{fontSize:9,fontWeight:700,letterSpacing:"1.5px",
                color:T.muted,textTransform:"uppercase",flexShrink:0}}>You</span>
              {["mc","steel","titanium","plants","energy","heat"].map(k=>(
                <span key={k} style={{display:"flex",alignItems:"center",gap:3,
                  fontSize:11,color:RES_COLOR[k],flexShrink:0}}>
                  {RES_ICON[k]}<b style={{color:T.text}}>{me[k]}</b>
                  {me[k+"Prod"]!==0&&<span style={{fontSize:9,color:T.muted}}>
                    ({me[k+"Prod"]>0?"+":""}{me[k+"Prod"]})</span>}
                </span>
              ))}
              <span style={{marginLeft:"auto",fontSize:11,color:T.gold,fontWeight:700,
                fontFamily:"'Orbitron',sans-serif",flexShrink:0}}>TR {me.TR}</span>
            </div>
          )}

          {/* Tabs */}
          <div style={{display:"flex",flexShrink:0,
            borderBottom:`1px solid ${T.border}`,background:T.surf}}>
            {TABS.map(t=>{
              const key=t.toLowerCase();
              const active=tab===key;
              const badge=tabBadge[t];
              return(
                <button key={t} onClick={()=>setTab(key)}
                  style={{flex:1,padding:"9px 4px",fontSize:11,fontWeight:700,
                    letterSpacing:"0.5px",textTransform:"uppercase",
                    background:active?T.surfH:T.surf,
                    color:active?T.text:T.muted,
                    border:"none",
                    borderBottom:`2px solid ${active?T.gold:"transparent"}`,
                    cursor:"pointer",fontFamily:"'Exo 2',sans-serif",
                    transition:"color .15s, background .15s",
                    display:"flex",alignItems:"center",justifyContent:"center",gap:5,
                  }}>
                  {t}
                  {badge>0&&(
                    <span style={{background:T.gold,color:"#000",borderRadius:10,
                      padding:"0 5px",fontSize:9,fontWeight:900,lineHeight:"16px"}}>
                      {badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Tab content */}
          <div style={{flex:1,overflowY:"auto",padding:"10px 12px"}}>
            {tab==="actions"&&(
              <ActionPanel state={state} myPid={myPid} send={send}/>
            )}
            {tab==="hand"&&(
              <HandPanel state={state} myPid={myPid} send={send}/>
            )}
            {tab==="log"&&(
              <div>
                {state.log.map((l,i)=>(
                  <div key={i} style={{
                    fontSize:11,padding:"5px 0",
                    borderBottom:`1px solid ${T.border}22`,
                    color:i===0?T.text:T.muted,
                    display:"flex",alignItems:"baseline",gap:6,
                  }}>
                    <span style={{color:T.border,fontSize:9,flexShrink:0}}>
                      {String(state.log.length-i).padStart(2,"0")}
                    </span>
                    {l}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Footer: milestones + awards ── */}
      <MilestonesAwardsBar state={state}/>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// NETWORKING UTILS — stable per-tab player id + room code generator
// ═══════════════════════════════════════════════════════════════════════
const uid=()=>Math.random().toString(36).slice(2,10);
const mkCode=()=>Math.random().toString(36).slice(2,7).toUpperCase();
const getMyPid=()=>{
  try{
    const m=(window.name||"").match(/tmpid:([a-z0-9]{8})/);
    if(m) return m[1];
    const id=uid(); window.name=`tmpid:${id}|${window.name||""}`; return id;
  }catch{return uid();}
};

export default function App(){
  // ══ CONFIGURE: paste your Render URL below (no trailing slash) ══
  const SERVER_URL = "https://metamarsphosis.onrender.com";

  const [pid]=useState(getMyPid);
  const [gs,setGs]=useState(null);
  const [code,setCode]=useState("");
  const [screen,setScreen]=useState("home");
  const [nameIn,setNameIn]=useState("");
  const [joinIn,setJoinIn]=useState("");
  const [err,setErr]=useState("");
  const [socketReady]=useState(true); // socket.io-client loaded via npm
  const [status,setStatus]=useState("");

  const socketRef=useRef(null);
  const gsRef=useRef(null);
  const isHostRef=useRef(false);
  const codeRef=useRef("");

  useEffect(()=>{gsRef.current=gs;},[gs]);
  useEffect(()=>{codeRef.current=code;},[code]);

  // Fonts + global styles
  useEffect(()=>{
    const l=document.createElement("link");
    l.rel="stylesheet";
    l.href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;600;700;900&family=Exo+2:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,400&display=swap";
    document.head.appendChild(l);
    const s=document.createElement("style");
    s.textContent=`
      *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
      html,body{background:${T.bg};font-family:'Exo 2',sans-serif}
      button:hover{filter:brightness(1.12)} button:active{transform:scale(.96)}
      ::placeholder{color:${T.muted}}
      ::-webkit-scrollbar{width:5px}
      ::-webkit-scrollbar-track{background:${T.surf}}
      ::-webkit-scrollbar-thumb{background:${T.border};border-radius:3px}
      :focus-visible{outline:2px solid ${T.gold};outline-offset:2px;border-radius:4px}
      @keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
      @keyframes pop{0%{opacity:0;transform:scale(.85)}60%{transform:scale(1.05)}100%{opacity:1;transform:scale(1)}}
      @keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
      @keyframes shimmer{0%{background-position:200% center}100%{background-position:-200% center}}
      @keyframes floatUp{0%{opacity:0;transform:translateY(6px)}100%{opacity:1;transform:none}}
      @media (prefers-reduced-motion: reduce){
        *{animation-duration:.001s!important;animation-iteration-count:1!important;transition-duration:.001s!important}
      }
      .tm-main{display:flex;flex:1;overflow:hidden}
      .tm-board-col{display:flex;flex-direction:column;flex:1 1 480px;
        max-width:580px;min-width:300px;padding:10px 8px 0 10px;overflow:hidden}
      .tm-side-col{flex:1 1 380px;min-width:280px;display:flex;flex-direction:column;
        border-left:1px solid ${T.border};overflow:hidden;
        background:linear-gradient(180deg,${T.surfH}08,transparent)}
      @media (max-width: 880px){
        .tm-main{flex-direction:column;overflow-y:auto;overflow-x:hidden}
        .tm-board-col{max-width:100%;flex:0 0 auto}
        .tm-side-col{border-left:none;border-top:1px solid ${T.border};
          min-height:50vh;flex:1 1 auto}
      }
    `;
    document.head.appendChild(s);
  },[]);

  // Screen transitions driven by game phase
  useEffect(()=>{
    if(!gs) return;
    if(gs.phase==="corpSelection") setScreen("corp");
    else if(gs.phase==="research")   setScreen("research");
    else if(gs.phase==="action"||gs.phase==="production") setScreen("game");
    else if(gs.gameOver)             setScreen("end");
  },[gs?.phase, gs?.gameOver]);

  // ── Broadcast (host → all via server) ──────────────────────────────
  const broadcast=useCallback((ns)=>{
    setGs(ns); gsRef.current=ns;
    if(socketRef.current&&codeRef.current)
      socketRef.current.emit("stateUpdate",{code:codeRef.current,state:ns});
  },[]);

  // ── Handle incoming action (host only) ─────────────────────────────
  const handleMsg=useCallback((msg)=>{
    const cur=gsRef.current; if(!cur) return;
    const ns=applyAction(cur,msg);
    if(ns!==cur) broadcast(ns);
  },[broadcast]);

  // ── Create room ─────────────────────────────────────────────────────
  const createRoom=()=>{
    if(!nameIn.trim()) return setErr("Enter your name!");
    if(!socketReady)   return setErr("Still loading networking…");
    setErr(""); setStatus("Creating…");
    const rc=mkCode();
    const init=createInitialState([{id:pid,name:nameIn.trim()}]);
    isHostRef.current=true; gsRef.current=init; setGs(init);

    if(socketRef.current) socketRef.current.disconnect();
    const sock=io(SERVER_URL,{transports:["websocket","polling"],timeout:10000});
    socketRef.current=sock;

    sock.on("connect_error",()=>{ setErr("Cannot reach server. Check SERVER_URL at top of App.jsx."); setStatus(""); });
    sock.on("err",msg=>{ setErr(msg); setStatus(""); });
    sock.on("codeCollision",()=>{
      const rc2=mkCode(); codeRef.current=rc2; setCode(rc2);
      sock.emit("create",{code:rc2,pid,name:nameIn.trim(),state:gsRef.current});
    });
    sock.on("created",({code:c})=>{
      codeRef.current=c; setCode(c); setStatus(""); setScreen("lobby");
    });
    sock.on("joinRequest",({pid:jpid,name:jname})=>{
      const cur=gsRef.current;
      if(!cur||cur.phase!=="corpSelection") return;
      if(cur.players.find(p=>p.id===jpid)){ broadcast(cur); return; }
      const usedCorps=cur.players.flatMap(p=>p.corpOptions.map(c=>c.id));
      const fresh=[...CORPS].sort(()=>Math.random()-0.5).filter(c=>!usedCorps.includes(c.id));
      const newP=makePlayer({id:jpid,name:jname},cur.players.length,
        fresh.length>=2?fresh.slice(0,2):CORPS.slice(0,2));
      broadcast({...cur,players:[...cur.players,newP],
        log:[`${jname} joined`,...cur.log.slice(0,29)]});
    });
    sock.on("action",action=>handleMsg(action));
    sock.on("hostLeft",()=>setErr("Host disconnected. Game paused."));
    sock.emit("create",{code:rc,pid,name:nameIn.trim(),state:init});
  };

  // ── Join room ───────────────────────────────────────────────────────
  const joinRoom=()=>{
    const nm=nameIn.trim();
    const rc=joinIn.trim().toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,5);
    if(!nm) return setErr("Enter your name!");
    if(!rc) return setErr("Enter room code!");
    if(!socketReady) return setErr("Still loading networking…");
    setErr(""); setStatus("Connecting…");
    isHostRef.current=false; codeRef.current=rc;

    if(socketRef.current) socketRef.current.disconnect();
    const sock=io(SERVER_URL,{transports:["websocket","polling"],timeout:10000});
    socketRef.current=sock;

    sock.on("connect_error",()=>{ setErr("Cannot reach server. Check SERVER_URL at top of App.jsx."); setStatus(""); });
    sock.on("err",msg=>{ setErr(msg); setStatus(""); });
    sock.on("joined",({state})=>{
      gsRef.current=state; setGs(state);
      codeRef.current=rc; setCode(rc); setStatus(""); setScreen("lobby");
    });
    sock.on("state",state=>{ gsRef.current=state; setGs(state); });
    sock.on("hostLeft",()=>setErr("Host disconnected. Game paused — they may rejoin."));
    sock.emit("join",{code:rc,pid,name:nm});
  };

  // sendOrJoin: all actions go through here from game screens
  const sendOrJoin=useCallback((msg)=>{
    if(isHostRef.current){
      handleMsg(msg);
    } else {
      if(socketRef.current&&codeRef.current)
        socketRef.current.emit("action",{code:codeRef.current,action:msg});
    }
  },[handleMsg]);

  // ── Lobby screen ────────────────────────────────────────────────────
  if(screen==="lobby") return(
    <div style={{...LOBBY_S,minHeight:"100vh",
      background:`radial-gradient(ellipse at 50% 0%,#1a0808 0%,${T.bg} 70%)`}}>
      <div style={{...CARD_S,maxWidth:480}}>
        {/* Title */}
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{fontFamily:"'Orbitron',sans-serif",fontSize:11,fontWeight:600,
            letterSpacing:"4px",color:T.muted,marginBottom:8,textTransform:"uppercase"}}>
            Multiplayer Session
          </div>
          <div style={{fontFamily:"'Orbitron',sans-serif",fontSize:22,fontWeight:900,
            background:`linear-gradient(135deg,${T.gold},${T.orange})`,
            WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",
            letterSpacing:"3px",marginBottom:16}}>
            TERRAFORMING MARS
          </div>
          {/* Room code display */}
          <div style={{background:T.surfH,borderRadius:10,padding:"12px 20px",
            border:`1px solid ${T.border}`,marginBottom:10}}>
            <div style={{color:T.muted,fontSize:10,fontWeight:600,letterSpacing:"3px",
              textTransform:"uppercase",marginBottom:6}}>Room Code</div>
            <div style={{fontFamily:"'Orbitron',sans-serif",fontSize:38,fontWeight:900,
              letterSpacing:14,color:T.gold,lineHeight:1,
              textShadow:`0 0 20px ${T.gold}55`}}>
              {code||"···"}
            </div>
          </div>
          {code&&(
            <button onClick={()=>navigator.clipboard?.writeText(code).catch(()=>{})}
              style={{...BTN_S,fontSize:11,padding:"6px 16px",color:T.blue,
                border:`1px solid ${T.blue}44`,background:T.surfH}}>
              📋 Copy Code
            </button>
          )}
        </div>

        {/* Players list */}
        <div style={{marginBottom:20}}>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:"2px",textTransform:"uppercase",
            color:T.muted,marginBottom:10}}>
            Players — {gs?.players?.length||1} / 5
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {gs?.players?.map((p,i)=>(
              <div key={p.id} style={{display:"flex",alignItems:"center",gap:10,
                background:T.surfH,borderRadius:7,padding:"8px 12px",
                border:`1px solid ${p.id===pid?p.color+"66":T.border}`,
                animation:`floatUp .3s ease ${i*.06}s both`}}>
                <span style={{width:10,height:10,borderRadius:"50%",background:p.color,
                  flexShrink:0,boxShadow:`0 0 8px ${p.color}66`}}/>
                <span style={{fontSize:13,fontWeight:600,color:T.text,flex:1}}>{p.name}</span>
                {p.id===pid&&(
                  <span style={{fontSize:10,color:T.muted,background:T.surfB,
                    borderRadius:4,padding:"2px 7px"}}>you{isHostRef.current?" · host":""}</span>
                )}
                {i===0&&<span style={{fontSize:10,color:T.gold}}>👑</span>}
              </div>
            ))}
          </div>
        </div>

        {/* Start / waiting */}
        {isHostRef.current?(
          <>
            <button onClick={()=>{
                const cur=gsRef.current;
                if(!cur||cur.players.length<2) return setErr("Need 2–5 players");
                const ns=createInitialState(cur.players.map(p=>({id:p.id,name:p.name})));
                broadcast(ns);
              }}
              disabled={!cur_players_ok(gs)}
              style={{...BTN_S,width:"100%",textAlign:"center",
                background:cur_players_ok(gs)
                  ?`linear-gradient(135deg,${T.green},#1a6030)`
                  :T.surfH,
                color:cur_players_ok(gs)?"#fff":T.muted,
                fontSize:14,fontWeight:700,letterSpacing:"1px",
                boxShadow:cur_players_ok(gs)?`0 4px 20px ${T.green}44`:"none",
              }}>
              {cur_players_ok(gs)
                ?`🚀 START GAME  (${gs.players.length} players)`
                :`Waiting for players… (${gs?.players?.length||1}/2 min)`}
            </button>
            {err&&<div style={{color:T.red,fontSize:12,marginTop:8,textAlign:"center"}}>{err}</div>}
          </>
        ):(
          <div style={{textAlign:"center",color:T.muted,padding:"14px",
            background:T.surfH,borderRadius:8,border:`1px solid ${T.border}`,
            fontSize:12,fontWeight:600,letterSpacing:"0.5px"}}>
            ⏳ Waiting for host to start the game…
          </div>
        )}
      </div>
    </div>
  );

  // ── Home screen ─────────────────────────────────────────────────────
  if(screen==="home") return(
    <div style={{...LOBBY_S,minHeight:"100vh",flexDirection:"column",
      background:`radial-gradient(ellipse at 50% 0%,#1a0808 0%,${T.bg} 65%)`}}>

      {/* Hero title */}
      <div style={{textAlign:"center",marginBottom:32,animation:"pop .5s ease"}}>
        <div style={{fontSize:"4rem",marginBottom:8,
          filter:"drop-shadow(0 0 20px #c7380888)"}}>🌍</div>
        <div style={{fontFamily:"'Orbitron',sans-serif",fontWeight:900,
          fontSize:"clamp(1.6rem,5vw,2.4rem)",letterSpacing:"4px",
          background:`linear-gradient(135deg,${T.gold} 0%,${T.orange} 50%,${T.mars} 100%)`,
          WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",
          marginBottom:6}}>
          TERRAFORMING MARS
        </div>
        <div style={{color:T.muted,fontSize:12,letterSpacing:"3px",
          textTransform:"uppercase",fontWeight:500}}>
          2–5 Players · Strategy · Competitive
        </div>
      </div>

      {/* Card */}
      <div style={{...CARD_S,width:"100%",maxWidth:400}}>
        <input value={nameIn} onChange={e=>setNameIn(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&createRoom()}
          placeholder="Your name" maxLength={18} autoFocus
          style={{...INP_S,marginBottom:12}}/>

        <button onClick={createRoom}
          style={{...BTN_S,width:"100%",textAlign:"center",marginBottom:18,
            background:`linear-gradient(135deg,${T.mars},#7a2000)`,color:"#fff",
            fontSize:15,fontWeight:700,letterSpacing:"1px",
            boxShadow:`0 4px 24px ${T.mars}55`}}>
          {status==="Creating…"?"⏳ Creating room…":"🏠 Create Room"}
        </button>

        {/* Divider */}
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
          <div style={{flex:1,height:"1px",background:T.border}}/>
          <span style={{color:T.muted,fontSize:10,fontWeight:600,letterSpacing:"2px",
            textTransform:"uppercase"}}>or join</span>
          <div style={{flex:1,height:"1px",background:T.border}}/>
        </div>

        <input value={joinIn}
          onChange={e=>setJoinIn(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,5))}
          onKeyDown={e=>e.key==="Enter"&&joinRoom()}
          placeholder="ROOM CODE" maxLength={5}
          style={{...INP_S,marginBottom:12,textAlign:"center",
            fontFamily:"'Orbitron',sans-serif",fontSize:24,
            letterSpacing:12,fontWeight:700,color:T.gold}}/>

        <button onClick={joinRoom}
          style={{...BTN_S,width:"100%",textAlign:"center",
            background:`linear-gradient(135deg,${T.blue}cc,#153060)`,color:"#fff",
            fontSize:15,fontWeight:700,letterSpacing:"1px"}}>
          {status==="Connecting…"||status==="Joining…"
            ?`⏳ ${status}`:"🚀 Join Room"}
        </button>

        {err&&(
          <div style={{marginTop:12,padding:"8px 12px",borderRadius:6,
            background:T.red+"18",border:`1px solid ${T.red}44`,
            color:T.red,fontSize:12,textAlign:"center",fontWeight:600}}>
            ⚠ {err}
          </div>
        )}
        {!socketReady&&(
          <div style={{textAlign:"center",color:T.muted,fontSize:11,marginTop:10}}>
            Connecting to server…
          </div>
        )}
      </div>
    </div>
  );

  if(!gs) return(
    <div style={{...LOBBY_S,background:T.bg,color:T.muted,minHeight:"100vh",fontFamily:"'Exo 2',sans-serif",flexDirection:"column",gap:12}}><div style={{fontSize:"2rem",opacity:.4}}>🌍</div><div style={{letterSpacing:"3px",fontFamily:"'Orbitron',sans-serif",fontSize:12,color:T.muted}}>LOADING…</div></div>
  );

  if(gs.gameOver||screen==="end") return <EndScreen state={gs}/>;

  if(gs.phase==="corpSelection"||screen==="corp") return(
    <div style={{background:T.bg,color:T.text,minHeight:"100vh",fontFamily:"'Exo 2',sans-serif"}}>
      <div style={{background:`linear-gradient(180deg,${T.surfH},${T.surf})`,
        borderBottom:`1px solid ${T.border}`,boxShadow:"0 2px 12px #00000060",
        padding:"10px 20px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span style={{fontFamily:"'Orbitron',sans-serif",fontWeight:900,fontSize:"0.9rem",
          letterSpacing:"2px",background:`linear-gradient(135deg,${T.gold},${T.orange})`,
          WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>
          🌍 TERRAFORMING MARS</span>
        <span style={{color:T.muted,fontSize:11,letterSpacing:"1px"}}>Room: {code}</span>
      </div>
      <CorpSelection state={gs} myPid={pid} send={sendOrJoin}/>
      <div style={{position:"fixed",bottom:0,left:0,right:0,
        background:`linear-gradient(transparent,${T.bg}ee)`,backdropFilter:"blur(8px)",
        borderTop:`1px solid ${T.border}`,padding:"8px 20px",display:"flex",gap:8,flexWrap:"wrap"}}>
        {gs.players.map(p=>(
          <div key={p.id} style={{display:"flex",alignItems:"center",gap:5,
            background:p.corpChosen?T.surfH:T.surfB,borderRadius:20,padding:"3px 10px",
            border:`1px solid ${p.corpChosen?p.color+"66":T.border}`,fontSize:11,
            color:p.corpChosen?p.color:T.muted,fontWeight:p.corpChosen?700:400}}>
            <span style={{fontSize:9}}>{p.corpChosen?"✓":"○"}</span>{p.name}
          </div>
        ))}
      </div>
    </div>
  );

  if(gs.phase==="research"||screen==="research") return(
    <div style={{background:T.bg,color:T.text,minHeight:"100vh",fontFamily:"'Exo 2',sans-serif"}}>
      <div style={{background:`linear-gradient(180deg,${T.surfH},${T.surf})`,
        borderBottom:`1px solid ${T.border}`,boxShadow:"0 2px 12px #00000060",
        padding:"10px 20px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span style={{fontFamily:"'Orbitron',sans-serif",fontWeight:900,fontSize:"0.9rem",
          letterSpacing:"2px",background:`linear-gradient(135deg,${T.gold},${T.orange})`,
          WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>
          🌍 TERRAFORMING MARS</span>
        <span style={{color:T.muted,fontSize:11,letterSpacing:"1px"}}>
          Gen {gs.generation} · Room {code}</span>
      </div>
      <ResearchScreen state={gs} myPid={pid} send={sendOrJoin}/>
    </div>
  );

  return <GameScreen state={gs} myPid={pid} send={sendOrJoin}/>;
}

// ── Style constants ─────────────────────────────────────────────────
const LOBBY_S={display:"flex",alignItems:"center",justifyContent:"center"};
const CARD_S={
  background:`linear-gradient(160deg,${T.surfH},${T.surf})`,
  borderRadius:14,padding:28,width:"100%",maxWidth:460,
  border:`1px solid ${T.border}`,animation:"pop .4s ease",
  boxShadow:"0 8px 40px #00000080",
};
const BTN_S={
  background:`linear-gradient(160deg,${T.surfB},${T.surf})`,
  color:T.text,border:`1px solid ${T.border}`,borderRadius:8,
  padding:"12px 22px",fontSize:14,fontWeight:700,cursor:"pointer",
  fontFamily:"'Exo 2',sans-serif",letterSpacing:"0.3px",
  boxShadow:"0 2px 12px #00000050,inset 0 1px 0 #ffffff08",
  transition:"filter .15s",
};
const INP_S={
  width:"100%",padding:"11px 16px",borderRadius:8,
  border:`1.5px solid ${T.border}`,background:T.surfH,color:T.text,
  fontSize:15,outline:"none",fontFamily:"'Exo 2',sans-serif",
  boxSizing:"border-box",transition:"border-color .2s",
};

function cur_players_ok(gs){ return gs&&gs.players&&gs.players.length>=2; }


// ═══════════════════════════════════════════════════════════════════════
// PHASE 3 CARDS  (30 new — total ~101)
// ═══════════════════════════════════════════════════════════════════════
(function(){
  const phase3 = [
    // ── GREEN ─────────────────────────────────────────────────────────
    mkCard({
      id:"kelpFarming", name:"Kelp Farming", cost:17, type:"green", tags:["plant"],
      req:{minOceans:2}, desc:"Req ≥2 oceans. +2 MC production, +3 plant production", vp:1,
      play:(s,pi)=>prodDelta(s,pi,{mc:2,plants:3}),
    }),
    mkCard({
      id:"industrialMicrobes", name:"Industrial Microbes", cost:12, type:"green",
      tags:["microbe","building"], req:null, desc:"+1 energy production, +1 steel production", vp:0,
      play:(s,pi)=>prodDelta(s,pi,{energy:1,steel:1}),
    }),
    mkCard({
      id:"mine", name:"Mine", cost:4, type:"green", tags:["building"],
      req:null, desc:"+1 steel production", vp:0,
      play:(s,pi)=>prodDelta(s,pi,{steel:1}),
    }),
    mkCard({
      id:"magneticFieldGenerators", name:"Magnetic Field Generators", cost:20, type:"green",
      tags:["power","building"], req:null,
      desc:"-4 energy production. +3 plant production. Raise O₂ twice", vp:0,
      play:(s,pi)=>{
        let ns=prodDelta(s,pi,{energy:-4,plants:3});
        ns=raiseOxygen(ns,s.players[pi].id);
        return raiseOxygen(ns,s.players[pi].id);
      },
    }),
    mkCard({
      id:"wavePower", name:"Wave Power", cost:8, type:"green",
      tags:["power","space"], req:{minOceans:3},
      desc:"Req ≥3 oceans. +1 energy production", vp:1,
      play:(s,pi)=>prodDelta(s,pi,{energy:1}),
    }),
    mkCard({
      id:"geothermalPower", name:"Geothermal Power", cost:11, type:"green",
      tags:["power","building"], req:null, desc:"+2 energy production", vp:0,
      play:(s,pi)=>prodDelta(s,pi,{energy:2}),
    }),
    mkCard({
      id:"trees", name:"Trees", cost:13, type:"green", tags:["plant"],
      req:{minTemp:-4}, desc:"Req temp ≥ -4°C. +3 plant production", vp:1,
      play:(s,pi)=>prodDelta(s,pi,{plants:3}),
    }),
    mkCard({
      id:"protectedValley", name:"Protected Valley", cost:23, type:"green",
      tags:["plant","building"], req:null,
      desc:"Place a greenery tile, raise O₂. +2 MC production", vp:0,
      play:(s,pi)=>{
        let ns=prodDelta(s,pi,{mc:2});
        return {...ns, pendingTile:{type:"greenery",pid:ns.players[pi].id,pIdx:pi}};
      },
    }),
    mkCard({
      id:"convertedCoachWorks", name:"Converted Coach Works", cost:3, type:"green",
      tags:["building"], req:null, desc:"-1 energy production. +2 MC production", vp:0,
      play:(s,pi)=>prodDelta(s,pi,{energy:-1,mc:2}),
    }),
    mkCard({
      id:"transplantedCrops", name:"Transplanted Crops", cost:23, type:"green",
      tags:["plant"], req:{minPlantProd:2},
      desc:"Req ≥2 plant prod. +2 plant production", vp:0,
      play:(s,pi)=>prodDelta(s,pi,{plants:2}),
    }),
    // ── BLUE ──────────────────────────────────────────────────────────
    mkCard({
      id:"marsUniversity", name:"Mars University", cost:8, type:"blue",
      tags:["science","building"], req:{minSciTags:1},
      desc:"When you play a science card, draw 1. Action: 2₡ → draw 1 card", vp:1,
      play:(s,_)=>s,
      action:[{ label:"2₡ → draw 1 card", canUse:(s,pi)=>s.players[pi].mc>=2,
        apply:(s,pi)=>{ let ns=resDelta(s,pi,{mc:-2}); return drawCards(ns,pi,1); } }],
    }),
    mkCard({
      id:"mediaGroup", name:"Media Group", cost:6, type:"blue",
      tags:["earth","building"], req:null,
      desc:"When you play an event card, gain 3 MC. Action: draw 1 for 3₡", vp:0,
      play:(s,_)=>s,
      action:[{ label:"3₡ → draw 1", canUse:(s,pi)=>s.players[pi].mc>=3,
        apply:(s,pi)=>{ let ns=resDelta(s,pi,{mc:-3}); return drawCards(ns,pi,1); } }],
    }),
    mkCard({
      id:"jupiterFloatingStation", name:"Jupiter Floating Station", cost:13, type:"blue",
      tags:["jovian","space"], req:{minJovianTags:1},
      desc:"Req ≥1 Jovian tag. +1 titanium production per Jovian tag you have", vp:1,
      play:(s,pi)=>prodDelta(s,pi,{titanium:(s.players[pi].tags?.jovian||0)}),
    }),
    mkCard({
      id:"titanLaunchPad", name:"Titan Floating Launch-Pad", cost:18, type:"blue",
      tags:["jovian","space"], req:null,
      desc:"Each generation: +1 microbe to your first microbe card. Action: +2 microbes to any microbe card", vp:0,
      play:(s,_)=>s,
      action:[{ label:"+2 microbes to a card", canUse:(s,pi)=>{
          const p=s.players[pi];
          return p.played.some(id=>!id.endsWith("_fd")&&CARDS[id]?.tags?.includes("microbe"));
        },
        apply:(s,pi)=>{
          const p=s.players[pi];
          const mCard=p.played.find(id=>!id.endsWith("_fd")&&CARDS[id]?.tags?.includes("microbe"));
          return mCard ? addCardRes(s,pi,mCard,2) : s;
        }
      }],
    }),
    mkCard({
      id:"powerSupplyConsortium", name:"Power Supply Consortium", cost:5, type:"blue",
      tags:["power"], req:{minPowerTags:2},
      desc:"Req ≥2 power tags. Action: steal 1 energy production from any opponent", vp:0,
      play:(s,_)=>s,
      action:[{ label:"Steal 1 energy prod", canUse:(s,pi)=>s.players.some((x,i)=>i!==pi&&x.energyProd>0),
        apply:(s,pi)=>{
          const vi=s.players.findIndex((x,i)=>i!==pi&&x.energyProd>0);
          if(vi<0) return s;
          let ns=prodDelta(s,vi,{energy:-1});
          return prodDelta(ns,pi,{energy:1});
        }
      }],
    }),
    mkCard({
      id:"researchCoordination", name:"Research Coordination", cost:4, type:"blue",
      tags:["science"], req:null,
      desc:"Action: spend 2₡ → draw 1 card", vp:0,
      play:(s,_)=>s,
      action:[{ label:"2₡ → draw 1", canUse:(s,pi)=>s.players[pi].mc>=2,
        apply:(s,pi)=>{ let ns=resDelta(s,pi,{mc:-2}); return drawCards(ns,pi,1); } }],
    }),
    mkCard({
      id:"noctisCity", name:"Noctis City", cost:10, type:"blue",
      tags:["city","building"], req:null,
      desc:"Place a city tile. -1 plant production. +2 energy production", vp:0,
      play:(s,pi)=>{
        let ns=prodDelta(s,pi,{plants:-1,energy:2});
        return {...ns, pendingTile:{type:"city",pid:ns.players[pi].id,pIdx:pi}};
      },
    }),
    mkCard({
      id:"insulation", name:"Insulation", cost:2, type:"blue",
      tags:["building"], req:null,
      desc:"Action: convert 1 heat production → 1 MC production (up to 5 times)", vp:0,
      play:(s,_)=>s,
      action:[{ label:"-1🔥prod → +1₡prod", canUse:(s,pi)=>(s.players[pi].heatProd||0)>0,
        apply:(s,pi)=>prodDelta(s,pi,{heat:-1,mc:1}) }],
    }),
    mkCard({
      id:"naturalPreserve", name:"Natural Preserve", cost:4, type:"blue",
      tags:["science","building"], req:{maxOxygen:4},
      desc:"Req O₂≤4%. +1 MC production. Draw 1 card. Action: 3₡ → draw 1", vp:1,
      play:(s,pi)=>{ let ns=prodDelta(s,pi,{mc:1}); return drawCards(ns,pi,1); },
      action:[{ label:"3₡ → draw 1", canUse:(s,pi)=>s.players[pi].mc>=3,
        apply:(s,pi)=>{ let ns=resDelta(s,pi,{mc:-3}); return drawCards(ns,pi,1); } }],
    }),
    mkCard({
      id:"spacePortColony", name:"Space Port Colony", cost:27, type:"blue",
      tags:["city","space","building"], req:null,
      desc:"Place a city tile. +3 MC production", vp:0,
      play:(s,pi)=>{
        let ns=prodDelta(s,pi,{mc:3});
        return {...ns, pendingTile:{type:"city",pid:ns.players[pi].id,pIdx:pi}};
      },
    }),
    // ── RED / EVENT ────────────────────────────────────────────────────
    mkCard({
      id:"transneptunicProbe", name:"Transneptunic Probe", cost:6, type:"red",
      tags:["science","space"], req:null,
      desc:"Draw 2 cards. Gain 1 titanium", vp:0,
      play:(s,pi)=>{ let ns=resDelta(s,pi,{titanium:1}); return drawCards(ns,pi,2); },
    }),
    mkCard({
      id:"optimalAerobraking", name:"Optimal Aerobraking", cost:7, type:"red",
      tags:["space","earth"], req:null,
      desc:"Gain 3 MC and 3 heat", vp:0,
      play:(s,pi)=>resDelta(s,pi,{mc:3,heat:3}),
    }),
    mkCard({
      id:"hotSprings", name:"Hot Springs", cost:11, type:"red",
      tags:["space"], req:{minOceans:3},
      desc:"Req ≥3 oceans. Place an ocean tile. Gain 4 plants", vp:0,
      play:(s,pi)=>{
        let ns=resDelta(s,pi,{plants:4});
        return {...ns, pendingTile:{type:"ocean",pid:ns.players[pi].id,pIdx:pi}};
      },
    }),
    mkCard({
      id:"lavaFlows", name:"Lava Flows", cost:18, type:"red",
      tags:["space"], req:{minTemp:0},
      desc:"Req temp ≥ 0°C. Raise temperature 2 steps", vp:0,
      play:(s,pi)=>{
        let ns=raiseTemp(s,s.players[pi].id);
        return raiseTemp(ns,s.players[pi].id);
      },
    }),
    mkCard({
      id:"burningUp", name:"Burning Up", cost:13, type:"red",
      tags:["space"], req:{minOxygen:10},
      desc:"Req O₂ ≥ 10%. Raise temperature. Lose 4 plants", vp:0,
      play:(s,pi)=>{
        let ns=raiseTemp(s,s.players[pi].id);
        return resDelta(ns,pi,{plants:-4});
      },
    }),
    mkCard({
      id:"deliberateMutation", name:"Deliberate Mutation", cost:10, type:"red",
      tags:["science"], req:null,
      desc:"Gain 1 plant. Add 1 microbe to any of your microbe cards", vp:0,
      play:(s,pi)=>{
        let ns=resDelta(s,pi,{plants:1});
        const mCard=ns.players[pi].played.find(id=>!id.endsWith("_fd")&&CARDS[id]?.tags?.includes("microbe"));
        return mCard ? addCardRes(ns,pi,mCard,1) : ns;
      },
    }),
    mkCard({
      id:"massConverter", name:"Mass Converter", cost:8, type:"red",
      tags:["power","science"], req:{minSciTags:5},
      desc:"Req ≥5 science tags. +6 energy production", vp:0,
      play:(s,pi)=>prodDelta(s,pi,{energy:6}),
    }),
    mkCard({
      id:"waterImportEuropa", name:"Water Import from Europa", cost:25, type:"red",
      tags:["space","jovian"], req:{minTiProdAny:1},
      desc:"Req any player has ≥1 Ti prod. Spend 3 titanium → +1 Ti prod + place ocean", vp:1,
      play:(s,pi)=>{
        const p=s.players[pi];
        if(p.titanium<3) return s;
        let ns=resDelta(s,pi,{titanium:-3});
        ns=prodDelta(ns,pi,{titanium:1});
        return {...ns, pendingTile:{type:"ocean",pid:ns.players[pi].id,pIdx:pi}};
      },
    }),
    mkCard({
      id:"soletta", name:"Soletta", cost:35, type:"red",
      tags:["space"], req:null,
      desc:"Raise temperature 3 steps", vp:0,
      play:(s,pi)=>{
        let ns=raiseTemp(s,s.players[pi].id);
        ns=raiseTemp(ns,s.players[pi].id);
        return raiseTemp(ns,s.players[pi].id);
      },
    }),
    mkCard({
      id:"tectonicStressPower", name:"Tectonic Stress Power", cost:18, type:"red",
      tags:["power","building"], req:{minSciTags:3},
      desc:"Req ≥3 science tags. +3 energy production", vp:1,
      play:(s,pi)=>prodDelta(s,pi,{energy:3}),
    }),
  ];
  CARDS_DATA.push(...phase3);
  phase3.forEach(c=>{ CARDS[c.id]=c; });
})();
