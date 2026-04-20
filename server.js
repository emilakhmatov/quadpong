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
const INIT_SPD      = 300;
const MAX_SPD       = 560;
const LIVES         = 3;
const FPS           = 60;
const LASER_DUR     = 6;
const FREEZE        = 2;
const BIG_FACTOR    = 1.5;
const BIG_DUR       = 6;
const AI_SPEED_NORM = 260;
const AI_SPEED_HARD = 370;
const AI_REACT      = 0.13;

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
  const room  = {
    id, mode, sides,
    difficulty: difficulty || 'normal',
    bots:    Object.fromEntries((botSides||[]).map(s => [s, true])),
    players: {},
    phase:   'lobby',
    interval: null, starInterval: null, appleInterval: null,
    lastTick: 0,
    ball: null,
    stars: [], apples: [],
    paddles:  Object.fromEntries(sides.map(s => [s, { pos: midAxis(s) - PAD_LEN/2, alive: true }])),
    lives:    Object.fromEntries(sides.map(s => [s, LIVES])),
    scores:   Object.fromEntries(sides.map(s => [s, 0])),
    lasers:   Object.fromEntries(sides.map(s => [s, null])),
    powerups: Object.fromEntries(sides.map(s => [s, null])),
    aiTarget: Object.fromEntries(sides.map(s => [s, midAxis(s) - PAD_LEN/2])),
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
    frozen: false, freezeTimer: 0, freezeVx: 0, freezeVy: 0,
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
    spawnItem(room, 'star');
    room.starInterval = setInterval(() => {
      if (room.phase==='playing' && room.stars.length < 2) spawnItem(room, 'star');
    }, 10000);
  }, 12000);

  setTimeout(() => {
    if (room.phase !== 'playing') return;
    spawnItem(room, 'apple');
    room.appleInterval = setInterval(() => {
      if (room.phase==='playing' && room.apples.length < 1) spawnItem(room, 'apple');
    }, 14000);
  }, 20000);

  room.interval = setInterval(() => tick(room), 1000/FPS);
}

function spawnItem(room, type) {
  const item = {
    id: Math.random().toString(36).substr(2,6),
    x: GW*.22 + Math.random()*GW*.56,
    y: GH*.22 + Math.random()*GH*.56,
  };
  if (type==='star') room.stars.push(item);
  else               room.apples.push(item);
  broadcast(room);
}

// ─── AI ──────────────────────────────────────────────────────────
function tickBots(room, dt) {
  if (!room.ball || room.ball.frozen) return;
  const b   = room.ball;
  const spd = room.difficulty==='hard' ? AI_SPEED_HARD : AI_SPEED_NORM;

  for (const side of room.sides) {
    if (!room.bots[side]) continue;
    const pad  = room.paddles[side];
    if (!pad?.alive) continue;
    const isV  = side==='left'||side==='right';
    const eLen = effLen(room, side);
    const ideal = (isV ? b.y : b.x) - eLen/2;

    // Smooth lazy interpolation (simulates reaction delay)
    room.aiTarget[side] += (ideal - room.aiTarget[side]) * Math.min(1, dt/AI_REACT);

    const diff  = room.aiTarget[side] - pad.pos;
    const move  = Math.sign(diff) * Math.min(Math.abs(diff), spd*dt);
    const limit = (isV ? GH : GW) - WALL - PAD_W - eLen;
    pad.pos = Math.max(WALL+PAD_W, Math.min(limit, pad.pos + move));
  }
}

// ─── Main tick ───────────────────────────────────────────────────
function tick(room) {
  const now = Date.now();
  const dt  = Math.min((now - room.lastTick)/1000, 0.05);
  room.lastTick = now;
  const ball = room.ball;
  if (!ball) return;

  // Timers
  for (const s of room.sides) {
    if (room.lasers[s])   { room.lasers[s].t -= dt;          if (room.lasers[s].t <= 0)   room.lasers[s] = null; }
    if (room.powerups[s]) { room.powerups[s].timer -= dt;    if (room.powerups[s].timer <= 0) room.powerups[s] = null; }
  }

  tickBots(room, dt);

  // Frozen
  if (ball.frozen) {
    ball.freezeTimer -= dt;
    if (ball.freezeTimer <= 0) { ball.frozen=false; ball.vx=ball.freezeVx; ball.vy=ball.freezeVy; }
    broadcast(room); return;
  }

  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  const sp = Math.hypot(ball.vx, ball.vy);
  if (sp > MAX_SPD) { ball.vx=ball.vx/sp*MAX_SPD; ball.vy=ball.vy/sp*MAX_SPD; }

  // Stars → laser
  room.stars = room.stars.filter(st => {
    if (Math.hypot(ball.x-st.x, ball.y-st.y) < BALL_R+STAR_R) {
      if (room.lastPaddle) room.lasers[room.lastPaddle] = { t: LASER_DUR };
      return false;
    }
    return true;
  });

  // Apples → big paddle
  room.apples = room.apples.filter(ap => {
    if (Math.hypot(ball.x-ap.x, ball.y-ap.y) < BALL_R+APPLE_R) {
      if (room.lastPaddle) room.powerups[room.lastPaddle] = { type:'big', timer: BIG_DUR };
      return false;
    }
    return true;
  });

  // Laser collision
  for (const side of room.sides) {
    if (!room.lasers[side]) continue;
    const pad  = room.paddles[side];
    if (!pad?.alive) continue;
    const eLen = effLen(room, side);
    const lx = side==='left' ? WALL+PAD_W+22 : side==='right' ? GW-WALL-PAD_W-22 : null;
    const ly = side==='top'  ? WALL+PAD_W+22 : side==='bottom'? GH-WALL-PAD_W-22 : null;
    let hit = false;
    if (lx !== null) {
      const toward = (side==='left'&&ball.vx<0)||(side==='right'&&ball.vx>0);
      if (toward && Math.abs(ball.x-lx)<BALL_R+3 && ball.y>=pad.pos && ball.y<=pad.pos+eLen) hit=true;
    } else {
      const toward = (side==='top'&&ball.vy<0)||(side==='bottom'&&ball.vy>0);
      if (toward && Math.abs(ball.y-ly)<BALL_R+3 && ball.x>=pad.pos && ball.x<=pad.pos+eLen) hit=true;
    }
    if (hit) {
      ball.frozen=true; ball.freezeTimer=FREEZE;
      ball.freezeVx = lx!==null ? -ball.vx : ball.vx;
      ball.freezeVy = ly!==null ? -ball.vy : ball.vy;
      ball.vx=0; ball.vy=0;
      broadcast(room); return;
    }
  }

  if (checkBoundaries(room, ball)) return;
  broadcast(room);
}

// ─── Boundaries ──────────────────────────────────────────────────
function checkBoundaries(room, ball) {
  const dirs = [
    { s:'left',   pHit: ball.x-BALL_R<=WALL+PAD_W,     wHit: ball.x-BALL_R<=WALL },
    { s:'right',  pHit: ball.x+BALL_R>=GW-WALL-PAD_W,  wHit: ball.x+BALL_R>=GW-WALL },
    { s:'top',    pHit: ball.y-BALL_R<=WALL+PAD_W,     wHit: ball.y-BALL_R<=WALL },
    { s:'bottom', pHit: ball.y+BALL_R>=GH-WALL-PAD_W,  wHit: ball.y+BALL_R>=GH-WALL },
  ];
  for (const { s, pHit, wHit } of dirs) {
    if (room.sides.includes(s)) {
      if (!pHit) continue;
      const pad  = room.paddles[s];
      if (!pad?.alive) { wallBounce(ball,s); continue; }
      const isV  = s==='left'||s==='right';
      const eLen = effLen(room, s);
      const bp   = isV ? ball.y : ball.x;
      if (bp >= pad.pos && bp <= pad.pos+eLen) {
        padBounce(ball,s); room.lastPaddle=s; room.scores[s]++;
      } else {
        loseLife(room,s); return true;
      }
    } else {
      if (!wHit) continue;
      wallBounce(ball, s);
    }
  }
  return false;
}

function padBounce(b,s) {
  const f=1.025;
  if(s==='left')   {b.vx= Math.abs(b.vx)*f; b.x=WALL+PAD_W+BALL_R+1;}
  if(s==='right')  {b.vx=-Math.abs(b.vx)*f; b.x=GW-WALL-PAD_W-BALL_R-1;}
  if(s==='top')    {b.vy= Math.abs(b.vy)*f; b.y=WALL+PAD_W+BALL_R+1;}
  if(s==='bottom') {b.vy=-Math.abs(b.vy)*f; b.y=GH-WALL-PAD_W-BALL_R-1;}
}
function wallBounce(b,s) {
  if(s==='left')   {b.vx= Math.abs(b.vx); b.x=WALL+BALL_R+1;}
  if(s==='right')  {b.vx=-Math.abs(b.vx); b.x=GW-WALL-BALL_R-1;}
  if(s==='top')    {b.vy= Math.abs(b.vy); b.y=WALL+BALL_R+1;}
  if(s==='bottom') {b.vy=-Math.abs(b.vy); b.y=GH-WALL-BALL_R-1;}
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
  clearInterval(room.interval);
  clearInterval(room.starInterval);
  clearInterval(room.appleInterval);
  const winner = room.sides.find(s => room.paddles[s]?.alive) || null;
  io.to(room.id).emit('gameover', { winner, scores: room.scores });
  setTimeout(() => delete rooms[room.id], 60000);
}

function broadcast(room) {
  io.to(room.id).emit('state', {
    ball: room.ball, paddles: room.paddles,
    stars: room.stars, apples: room.apples,
    lasers: room.lasers, powerups: room.powerups,
    scores: room.scores, lives: room.lives,
    bots: room.bots,
  });
}

// ─── Sockets ─────────────────────────────────────────────────────
io.on('connection', socket => {

  socket.on('solo', ({ mode, difficulty }) => {
    const m    = parseInt(mode)||2;
    const bots = m===2 ? ['right'] : ['right','top','bottom'];
    const room = makeRoom(m, bots, difficulty||'normal');
    room.players[socket.id] = 'left';
    socket.join(room.id);
    socket.emit('joined', { roomId: room.id, side: 'left', solo: true });
    io.to(room.id).emit('countdown', {});
    setTimeout(() => startGame(room), 3000);
  });

  socket.on('create', ({ mode }) => {
    const room = makeRoom(parseInt(mode)||2, []);
    room.players[socket.id] = room.sides[0];
    socket.join(room.id);
    socket.emit('joined', { roomId: room.id, side: room.sides[0] });
    io.to(room.id).emit('lobby', { players: [room.sides[0]], mode: room.mode });
  });

  socket.on('join', ({ roomId }) => {
    const room = rooms[roomId?.toUpperCase()];
    if (!room)                  return socket.emit('err','Комната не найдена');
    if (room.phase !== 'lobby') return socket.emit('err','Игра уже идёт');
    const taken = Object.values(room.players);
    const free  = room.sides.filter(s => !taken.includes(s));
    if (!free.length)           return socket.emit('err','Комната заполнена');
    const side = free[0];
    room.players[socket.id] = side;
    socket.join(room.id);
    socket.emit('joined', { roomId: room.id, side });
    const all = Object.values(room.players);
    io.to(room.id).emit('lobby', { players: all, mode: room.mode });
    if (all.length === room.mode) {
      io.to(room.id).emit('countdown', {});
      setTimeout(() => startGame(room), 3000);
    }
  });

  socket.on('move', ({ pos }) => {
    const room = Object.values(rooms).find(r => r.players[socket.id]);
    if (!room || room.phase !== 'playing') return;
    const side = room.players[socket.id];
    const pad  = room.paddles[side];
    if (!pad) return;
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
      clearInterval(room.interval);
      clearInterval(room.starInterval);
      clearInterval(room.appleInterval);
      room.phase = 'gameover';
      io.to(room.id).emit('playerLeft', {});
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Quad Pong  →  http://localhost:${PORT}`));
