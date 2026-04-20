const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

// ─── Constants ────────────────────────────────────────────────────
const GW = 800, GH = 800;
const WALL          = 14;
const PAD_W         = 14;
const PAD_LEN       = 90;
const BALL_R        = 10;
const STAR_R        = 13;
const APPLE_R       = 16;
const FIREBALL_R    = 15;
const INIT_SPD      = 280;
const MAX_SPD       = 560;
const ACCEL_RATE    = 5;      // px/s² – gradual natural acceleration
const LIVES         = 3;
const FPS           = 60;
const LASER_DUR     = 6;
const FREEZE        = 2;
const BIG_FACTOR    = 1.5;
const BIG_DUR       = 6;
const FIRE_DUR      = 12;     // seconds ball stays fiery
const COLL_TOL      = 6;      // extra px on each paddle edge for forgiveness
const SPIN_FACTOR   = 0.32;   // how much paddle velocity transfers to ball
const AI_SPD_NORM   = 255;
const AI_SPD_HARD   = 365;
const AI_REACT      = 0.13;

// ─── Native American names for AI bots ──────────────────────────
const INDIAN_NAMES = [
  'Aiyana','Akando','Alaqua','Aponi','Aquene','Askook','Avonaco','Awenasa','Awan',
  'Ayasha','Bidziil','Cetan','Chayton','Cheyenne','Chochmo','Cochise','Dakota',
  'Dyami','Elan','Enola','Etu','Halona','Hiawatha','Honovi','Hototo','Huritt',
  'Inteus','Istas','Kangi','Kaya','Keokuk','Kiowa','Kohana','Koko','Kuruk',
  'Lenape','Luta','Mahpee','Maka','Makwa','Mato','Mingan','Nahele','Namid',
  'Napayshni','Nashoba','Nita','Nokomis','Ohanzee','Ohitika','Onida','Pakwa',
  'Pavati','Sahale','Sapa','Shilah','Shuman','Sihu','Suni','Takoda','Tallulah',
  'Tasunka','Tawa','Tokala','Tocho','Wambli','Wapasha','Waya','Winona',
  'Wohali','Yahto','Yancy','Zaltana','Chayton','Dyami','Kangee','Mahkah',
  'Miwak','Ogima','Paytah','Sahkonteah','Skatah','Unkechaug','Wahanassatta',
];
function randomIndianName(used) {
  const pool = INDIAN_NAMES.filter(n => !used.includes(n));
  return pool[Math.floor(Math.random() * pool.length)] || 'Waya';
}

// ─── Rooms ───────────────────────────────────────────────────────
const rooms = {};
function uid4() {
  return [...Array(4)].map(() => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random()*32)]).join('');
}
function midAxis(s) { return (s==='left'||s==='right') ? GH/2 : GW/2; }
function effLen(room, s) {
  return room.powerups[s]?.type === 'big' ? PAD_LEN * BIG_FACTOR : PAD_LEN;
}

function makeRoom(mode, botSides, difficulty) {
  const id    = uid4();
  const sides = mode === 2 ? ['left','right'] : ['left','right','top','bottom'];
  // Assign random Indian names to bot sides
  const usedNames = [];
  const botNames  = {};
  (botSides||[]).forEach(s => {
    const n = randomIndianName(usedNames);
    usedNames.push(n); botNames[s] = n;
  });
  const room  = {
    id, mode, sides,
    difficulty: difficulty || 'normal',
    bots:    Object.fromEntries((botSides||[]).map(s => [s, true])),
    names:   Object.fromEntries(sides.map(s => [s, botNames[s] || ''])),
    players: {},
    phase:   'lobby',
    interval: null, starInterval: null, appleInterval: null, fireballInterval: null,
    lastTick: 0,
    ball: null,
    stars: [], apples: [], fireballs: [],
    paddles:    Object.fromEntries(sides.map(s => [s, { pos: midAxis(s)-PAD_LEN/2, alive: true }])),
    lives:      Object.fromEntries(sides.map(s => [s, LIVES])),
    scores:     Object.fromEntries(sides.map(s => [s, 0])),
    lasers:     Object.fromEntries(sides.map(s => [s, null])),
    powerups:   Object.fromEntries(sides.map(s => [s, null])),
    paddleVel:  Object.fromEntries(sides.map(s => [s, 0])),
    prevPadPos: Object.fromEntries(sides.map(s => [s, midAxis(s)-PAD_LEN/2])),
    aiTarget:   Object.fromEntries(sides.map(s => [s, midAxis(s)-PAD_LEN/2])),
    lastPaddle: null,
  };
  rooms[id] = room;
  return room;
}

// ─── Ball ────────────────────────────────────────────────────────
function spawnBall(room) {
  const alive = room.sides.filter(s => room.paddles[s]?.alive);
  const t     = alive[Math.floor(Math.random()*alive.length)];
  const base  = { left: Math.PI, right: 0, top: -Math.PI/2, bottom: Math.PI/2 };
  const angle = (base[t]||0) + (Math.random()-.5)*Math.PI*.5;
  room.ball = {
    x: GW/2, y: GH/2,
    vx: Math.cos(angle)*INIT_SPD, vy: Math.sin(angle)*INIT_SPD,
    spawnTime: Date.now(),
    frozen: false, freezeTimer: 0, freezeVx: 0, freezeVy: 0,
    frozenSide: null, frozenOffset: 0,
    fire: false, fireTimer: 0,
  };
  room.lastPaddle = null;
}

// ─── Start ───────────────────────────────────────────────────────
function startGame(room) {
  room.phase = 'playing';
  spawnBall(room);
  room.lastTick = Date.now();

  setTimeout(() => {
    if (room.phase !== 'playing') return;
    spawnItem(room,'star');
    room.starInterval = setInterval(() => {
      if (room.phase==='playing' && room.stars.length < 2) spawnItem(room,'star');
    }, 10000);
  }, 12000);

  setTimeout(() => {
    if (room.phase !== 'playing') return;
    spawnItem(room,'apple');
    room.appleInterval = setInterval(() => {
      if (room.phase==='playing' && room.apples.length < 1) spawnItem(room,'apple');
    }, 14000);
  }, 20000);

  setTimeout(() => {
    if (room.phase !== 'playing') return;
    spawnItem(room,'fireball');
    room.fireballInterval = setInterval(() => {
      if (room.phase==='playing' && room.fireballs.length < 1) spawnItem(room,'fireball');
    }, 18000);
  }, 25000);

  room.interval = setInterval(() => tick(room), 1000/FPS);
}

function spawnItem(room, type) {
  const item = {
    id: Math.random().toString(36).substr(2,6),
    x: GW*.22 + Math.random()*GW*.56,
    y: GH*.22 + Math.random()*GH*.56,
  };
  room[type === 'star' ? 'stars' : type === 'apple' ? 'apples' : 'fireballs'].push(item);
  broadcast(room);
}

// ─── AI ──────────────────────────────────────────────────────────
function tickBots(room, dt) {
  if (!room.ball) return;
  const b   = room.ball;
  const spd = room.difficulty==='hard' ? AI_SPD_HARD : AI_SPD_NORM;
  for (const side of room.sides) {
    if (!room.bots[side]) continue;
    const pad = room.paddles[side]; if (!pad?.alive) continue;
    const isV  = side==='left'||side==='right';
    const eLen = effLen(room, side);
    const ideal = (isV ? b.y : b.x) - eLen/2;
    room.aiTarget[side] += (ideal - room.aiTarget[side]) * Math.min(1, dt/AI_REACT);
    const diff = room.aiTarget[side] - pad.pos;
    const move = Math.sign(diff) * Math.min(Math.abs(diff), spd*dt);
    const lim  = (isV ? GH : GW) - WALL - PAD_W - eLen;
    pad.pos = Math.max(WALL+PAD_W, Math.min(lim, pad.pos + move));
  }
}

// ─── Tick ────────────────────────────────────────────────────────
function tick(room) {
  const now = Date.now();
  const dt  = Math.min((now - room.lastTick)/1000, 0.05);
  room.lastTick = now;
  const ball = room.ball;
  if (!ball) return;

  // Timers
  for (const s of room.sides) {
    if (room.lasers[s])   { room.lasers[s].t -= dt;        if (room.lasers[s].t   <= 0) room.lasers[s] = null; }
    if (room.powerups[s]) { room.powerups[s].timer -= dt;  if (room.powerups[s].timer <= 0) room.powerups[s] = null; }
  }
  if (ball.fire) {
    ball.fireTimer -= dt;
    if (ball.fireTimer <= 0) ball.fire = false;
  }

  // Paddle velocity tracking (for spin transfer)
  for (const s of room.sides) {
    const rawVel = (room.paddles[s].pos - room.prevPadPos[s]) / Math.max(dt, 0.001);
    room.paddleVel[s] = room.paddleVel[s]*0.6 + rawVel*0.4; // smooth
    room.prevPadPos[s] = room.paddles[s].pos;
  }

  tickBots(room, dt);

  // ── Frozen ball: moves with paddle ──────────────────────────────
  if (ball.frozen) {
    ball.freezeTimer -= dt;
    // Keep ball glued to laser / paddle
    if (ball.frozenSide) {
      const pad = room.paddles[ball.frozenSide];
      if (pad) {
        if (ball.frozenSide==='left'||ball.frozenSide==='right') ball.y = pad.pos + ball.frozenOffset;
        else                                                       ball.x = pad.pos + ball.frozenOffset;
      }
    }
    if (ball.freezeTimer <= 0) {
      ball.frozen = false;
      ball.frozenSide = null;
      ball.vx = ball.freezeVx;
      ball.vy = ball.freezeVy;
    }
    broadcast(room); return;
  }

  // ── Move ball ────────────────────────────────────────────────────
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  // ── Gradual acceleration (FIX #2) ────────────────────────────────
  const curSpd = Math.hypot(ball.vx, ball.vy);
  const newSpd = Math.min(curSpd + ACCEL_RATE * dt, MAX_SPD);
  if (curSpd > 0) { ball.vx = ball.vx/curSpd*newSpd; ball.vy = ball.vy/curSpd*newSpd; }

  // ── Star → laser ─────────────────────────────────────────────────
  room.stars = room.stars.filter(st => {
    if (Math.hypot(ball.x-st.x, ball.y-st.y) < BALL_R+STAR_R) {
      if (room.lastPaddle) room.lasers[room.lastPaddle] = { t: LASER_DUR };
      return false;
    }
    return true;
  });

  // ── Apple → big paddle ───────────────────────────────────────────
  room.apples = room.apples.filter(ap => {
    if (Math.hypot(ball.x-ap.x, ball.y-ap.y) < BALL_R+APPLE_R) {
      if (room.lastPaddle) room.powerups[room.lastPaddle] = { type:'big', timer: BIG_DUR };
      return false;
    }
    return true;
  });

  // ── Fireball item → ball on fire (FIX #4) ────────────────────────
  room.fireballs = room.fireballs.filter(fb => {
    if (Math.hypot(ball.x-fb.x, ball.y-fb.y) < BALL_R+FIREBALL_R) {
      ball.fire = true;
      ball.fireTimer = FIRE_DUR;
      return false;
    }
    return true;
  });

  // ── Laser collision ──────────────────────────────────────────────
  for (const side of room.sides) {
    if (!room.lasers[side]) continue;
    const pad = room.paddles[side]; if (!pad?.alive) continue;
    const eLen = effLen(room, side);
    const lx = side==='left' ? WALL+PAD_W+22 : side==='right' ? GW-WALL-PAD_W-22 : null;
    const ly = side==='top'  ? WALL+PAD_W+22 : side==='bottom'? GH-WALL-PAD_W-22 : null;
    let hit = false;
    if (lx !== null) {
      const toward = (side==='left'&&ball.vx<0)||(side==='right'&&ball.vx>0);
      if (toward && Math.abs(ball.x-lx)<BALL_R+3 && ball.y>=pad.pos-COLL_TOL && ball.y<=pad.pos+eLen+COLL_TOL) hit=true;
    } else {
      const toward = (side==='top'&&ball.vy<0)||(side==='bottom'&&ball.vy>0);
      if (toward && Math.abs(ball.y-ly)<BALL_R+3 && ball.x>=pad.pos-COLL_TOL && ball.x<=pad.pos+eLen+COLL_TOL) hit=true;
    }
    if (hit) {
      ball.frozen = true;
      ball.freezeTimer = FREEZE;
      ball.frozenSide = side;
      // Store offset so ball follows paddle while frozen (FIX #3)
      ball.frozenOffset = (lx!==null) ? ball.y - pad.pos : ball.x - pad.pos;
      ball.freezeVx = lx!==null ? -ball.vx : ball.vx;
      ball.freezeVy = ly!==null ? -ball.vy : ball.vy;
      ball.vx=0; ball.vy=0;
      broadcast(room); return;
    }
  }

  if (checkBoundaries(room, ball)) return;
  broadcast(room);
}

// ─── Boundaries (FIX #1 #5 #6 #7) ───────────────────────────────
function checkBoundaries(room, ball) {
  const checks = [
    { s:'left',   padHit: ball.x-BALL_R<=WALL+PAD_W, wallHit: ball.x-BALL_R<=WALL },
    { s:'right',  padHit: ball.x+BALL_R>=GW-WALL-PAD_W, wallHit: ball.x+BALL_R>=GW-WALL },
    { s:'top',    padHit: ball.y-BALL_R<=WALL+PAD_W, wallHit: ball.y-BALL_R<=WALL },
    { s:'bottom', padHit: ball.y+BALL_R>=GH-WALL-PAD_W, wallHit: ball.y+BALL_R>=GH-WALL },
  ];

  for (const { s, padHit, wallHit } of checks) {
    if (!room.sides.includes(s)) {
      // Side has no player → plain wall
      if (!wallHit) continue;
      wallBounce(ball, s);
    } else {
      const pad = room.paddles[s];
      if (!pad?.alive) {
        // FIX #5 – eliminated side: solid wall (not a pass-through!)
        if (!wallHit) continue;
        wallBounce(ball, s);
      } else {
        // Active paddle
        if (!padHit) continue;
        const isV  = s==='left'||s==='right';
        const eLen = effLen(room, s);
        const bp   = isV ? ball.y : ball.x;
        // FIX #1 #6 – generous tolerance on both edges
        if (bp >= pad.pos - COLL_TOL && bp <= pad.pos + eLen + COLL_TOL) {
          padBounce(ball, s, room);   // FIX #7 – spin from paddle velocity
          room.lastPaddle = s;
          room.scores[s]++;
          // FIX #4 – fire ball destroys paddle
          if (ball.fire) {
            ball.fire = false; ball.fireTimer = 0;
            room.lives[s] = 0;
            loseLife(room, s);
            return true;
          }
        } else {
          loseLife(room, s);
          return true;
        }
      }
    }
  }
  return false;
}

// FIX #7 – paddle velocity adds spin to ball trajectory
function padBounce(b, s, room) {
  const vel  = room.paddleVel[s] || 0;
  const spin = vel * SPIN_FACTOR;
  const f    = 1.02;
  if (s==='left')   { b.vx= Math.abs(b.vx)*f; b.x=WALL+PAD_W+BALL_R+1;    b.vy=clampPerp(b.vy+spin); }
  if (s==='right')  { b.vx=-Math.abs(b.vx)*f; b.x=GW-WALL-PAD_W-BALL_R-1; b.vy=clampPerp(b.vy+spin); }
  if (s==='top')    { b.vy= Math.abs(b.vy)*f; b.y=WALL+PAD_W+BALL_R+1;    b.vx=clampPerp(b.vx+spin); }
  if (s==='bottom') { b.vy=-Math.abs(b.vy)*f; b.y=GH-WALL-PAD_W-BALL_R-1; b.vx=clampPerp(b.vx+spin); }
}
function clampPerp(v) { return Math.max(-MAX_SPD*.75, Math.min(MAX_SPD*.75, v)); }

function wallBounce(b, s) {
  if (s==='left')   { b.vx= Math.abs(b.vx); b.x=WALL+BALL_R+1; }
  if (s==='right')  { b.vx=-Math.abs(b.vx); b.x=GW-WALL-BALL_R-1; }
  if (s==='top')    { b.vy= Math.abs(b.vy); b.y=WALL+BALL_R+1; }
  if (s==='bottom') { b.vy=-Math.abs(b.vy); b.y=GH-WALL-BALL_R-1; }
}

function loseLife(room, side) {
  room.lives[side] = Math.max(0, room.lives[side]-1);
  room.ball = null;
  broadcast(room);
  if (room.lives[side] === 0) {
    room.paddles[side].alive = false;
    const alive = room.sides.filter(s => room.paddles[s]?.alive);
    if (alive.length <= 1) { endGame(room); return; }
  }
  setTimeout(() => { if (room.phase==='playing') { spawnBall(room); broadcast(room); } }, 1500);
}

function endGame(room) {
  room.phase = 'gameover';
  ['interval','starInterval','appleInterval','fireballInterval'].forEach(k => clearInterval(room[k]));
  const winner = room.sides.find(s => room.paddles[s]?.alive) || null;
  io.to(room.id).emit('gameover', { winner, scores: room.scores });
  setTimeout(() => delete rooms[room.id], 60000);
}

function broadcast(room) {
  io.to(room.id).emit('state', {
    ball: room.ball,
    paddles: room.paddles,
    stars: room.stars, apples: room.apples, fireballs: room.fireballs,
    lasers: room.lasers, powerups: room.powerups,
    scores: room.scores, lives: room.lives,
    bots: room.bots, names: room.names,
  });
}

// ─── Sockets ─────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('solo', ({ mode, difficulty, name }) => {
    const m    = parseInt(mode)||2;
    const bots = m===2 ? ['right'] : ['right','top','bottom'];
    const room = makeRoom(m, bots, difficulty||'normal');
    room.players[socket.id] = 'left';
    room.names['left'] = (name||'Игрок').slice(0,16);
    socket.join(room.id);
    socket.emit('joined', { roomId: room.id, side: 'left', solo: true });
    io.to(room.id).emit('countdown', {});
    setTimeout(() => startGame(room), 3000);
  });

  socket.on('create', ({ mode, name }) => {
    const room = makeRoom(parseInt(mode)||2, []);
    room.players[socket.id] = room.sides[0];
    room.names[room.sides[0]] = (name||'Игрок').slice(0,16);
    socket.join(room.id);
    socket.emit('joined', { roomId: room.id, side: room.sides[0] });
    io.to(room.id).emit('lobby', { players: [room.sides[0]], mode: room.mode, names: room.names });
  });

  socket.on('join', ({ roomId, name }) => {
    const room = rooms[roomId?.toUpperCase()];
    if (!room)                  return socket.emit('err','Комната не найдена');
    if (room.phase !== 'lobby') return socket.emit('err','Игра уже идёт');
    const taken = Object.values(room.players);
    const free  = room.sides.filter(s => !taken.includes(s));
    if (!free.length)           return socket.emit('err','Комната заполнена');
    const side = free[0];
    room.players[socket.id] = side;
    room.names[side] = (name||'Игрок').slice(0,16);
    socket.join(room.id);
    socket.emit('joined', { roomId: room.id, side });
    const all = Object.values(room.players);
    io.to(room.id).emit('lobby', { players: all, mode: room.mode, names: room.names });
    if (all.length === room.mode) {
      io.to(room.id).emit('countdown', {});
      setTimeout(() => startGame(room), 3000);
    }
  });

  socket.on('move', ({ pos }) => {
    const room = Object.values(rooms).find(r => r.players[socket.id]);
    if (!room || room.phase !== 'playing') return;
    const side = room.players[socket.id];
    const pad  = room.paddles[side]; if (!pad) return;
    const isV  = side==='left'||side==='right';
    const eLen = effLen(room, side);
    const lim  = (isV ? GH : GW) - WALL - PAD_W - eLen;
    pad.pos = Math.max(WALL+PAD_W, Math.min(lim, pos));
  });

  socket.on('disconnect', () => {
    const room = Object.values(rooms).find(r => r.players[socket.id]);
    if (!room) return;
    delete room.players[socket.id];
    if (room.phase === 'playing') {
      ['interval','starInterval','appleInterval','fireballInterval'].forEach(k => clearInterval(room[k]));
      room.phase = 'gameover';
      io.to(room.id).emit('playerLeft', {});
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Quad Pong v3  →  http://localhost:${PORT}`));
