const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ─── Game constants ───────────────────────────────────────────────
const GW = 800, GH = 800;
const WALL      = 14;
const PAD_W     = 14;
const PAD_LEN   = 90;
const BALL_R    = 10;
const STAR_R    = 13;
const INIT_SPD  = 300;
const MAX_SPD   = 520;
const LIVES     = 3;
const FPS       = 60;
const LASER_DUR = 6;   // seconds laser stays on
const FREEZE    = 2;   // seconds ball freezes on laser

// ─── Rooms ───────────────────────────────────────────────────────
const rooms = {};

function uid4() {
  return [...Array(4)].map(() => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random()*32)]).join('');
}

function makeRoom(mode) {
  const id    = uid4();
  const sides = mode === 2 ? ['left','right'] : ['left','right','top','bottom'];
  const room  = {
    id, mode, sides,
    players:  {},
    phase:    'lobby',
    interval: null, starInterval: null, lastTick: 0,
    ball: null, stars: [],
    paddles: Object.fromEntries(sides.map(s => [s, { pos: mid(s) - PAD_LEN/2, alive: true }])),
    lives:   Object.fromEntries(sides.map(s => [s, LIVES])),
    scores:  Object.fromEntries(sides.map(s => [s, 0])),
    lasers:  Object.fromEntries(sides.map(s => [s, null])),
    lastPaddle: null,
  };
  rooms[id] = room;
  return room;
}

function mid(side) { return (side==='left'||side==='right') ? GH/2 : GW/2; }

// ─── Ball spawn ───────────────────────────────────────────────────
function spawnBall(room) {
  const alive = room.sides.filter(s => room.paddles[s]?.alive);
  const target = alive[Math.floor(Math.random()*alive.length)];
  const bases = { left: Math.PI, right: 0, top: -Math.PI/2, bottom: Math.PI/2 };
  const angle = (bases[target]||0) + (Math.random()-0.5)*Math.PI*0.5;
  room.ball = {
    x: GW/2, y: GH/2,
    vx: Math.cos(angle)*INIT_SPD,
    vy: Math.sin(angle)*INIT_SPD,
    frozen: false, freezeTimer: 0,
    freezeVx: 0,   freezeVy: 0,
  };
  room.lastPaddle = null;
}

// ─── Game start ───────────────────────────────────────────────────
function startGame(room) {
  room.phase = 'playing';
  spawnBall(room);
  room.lastTick = Date.now();

  // Stars: first after 12 s, then every 10 s
  setTimeout(() => {
    if (room.phase !== 'playing') return;
    spawnStar(room);
    room.starInterval = setInterval(() => {
      if (room.phase === 'playing' && room.stars.length < 2) spawnStar(room);
    }, 10000);
  }, 12000);

  room.interval = setInterval(() => tick(room), 1000/FPS);
}

function spawnStar(room) {
  room.stars.push({
    id: Math.random().toString(36).substr(2,6),
    x: GW*0.2 + Math.random()*GW*0.6,
    y: GH*0.2 + Math.random()*GH*0.6,
  });
  broadcast(room);
}

// ─── Main tick ────────────────────────────────────────────────────
function tick(room) {
  const now = Date.now();
  const dt  = Math.min((now - room.lastTick)/1000, 0.05);
  room.lastTick = now;
  const ball = room.ball;
  if (!ball) return;

  // Laser timers
  for (const s of room.sides) {
    if (room.lasers[s]) {
      room.lasers[s].t -= dt;
      if (room.lasers[s].t <= 0) room.lasers[s] = null;
    }
  }

  // Frozen ball
  if (ball.frozen) {
    ball.freezeTimer -= dt;
    if (ball.freezeTimer <= 0) {
      ball.frozen = false;
      ball.vx = ball.freezeVx;
      ball.vy = ball.freezeVy;
    }
    broadcast(room); return;
  }

  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  // Cap speed
  const spd = Math.hypot(ball.vx, ball.vy);
  if (spd > MAX_SPD) { ball.vx = ball.vx/spd*MAX_SPD; ball.vy = ball.vy/spd*MAX_SPD; }

  // Star collision
  room.stars = room.stars.filter(st => {
    if (Math.hypot(ball.x-st.x, ball.y-st.y) < BALL_R+STAR_R) {
      if (room.lastPaddle) room.lasers[room.lastPaddle] = { t: LASER_DUR };
      return false;
    }
    return true;
  });

  // Laser collision
  for (const side of room.sides) {
    if (!room.lasers[side]) continue;
    const pad = room.paddles[side];
    if (!pad?.alive) continue;
    const lx = side==='left' ? WALL+PAD_W+18 : side==='right' ? GW-WALL-PAD_W-18 : null;
    const ly = side==='top'  ? WALL+PAD_W+18 : side==='bottom'? GH-WALL-PAD_W-18 : null;
    let hit = false;
    if (lx !== null) {
      const toward = (side==='left' && ball.vx<0)||(side==='right' && ball.vx>0);
      if (toward && Math.abs(ball.x-lx)<BALL_R+3 && ball.y>=pad.pos && ball.y<=pad.pos+PAD_LEN) hit=true;
    } else {
      const toward = (side==='top' && ball.vy<0)||(side==='bottom' && ball.vy>0);
      if (toward && Math.abs(ball.y-ly)<BALL_R+3 && ball.x>=pad.pos && ball.x<=pad.pos+PAD_LEN) hit=true;
    }
    if (hit) {
      ball.frozen=true; ball.freezeTimer=FREEZE;
      ball.freezeVx = lx!==null ? -ball.vx : ball.vx;
      ball.freezeVy = ly!==null ? -ball.vy : ball.vy;
      ball.vx=0; ball.vy=0;
      broadcast(room); return;
    }
  }

  // Boundary / paddle checks
  const result = checkBoundaries(room, ball);
  if (result === 'miss') return; // loseLife already called
  broadcast(room);
}

function checkBoundaries(room, ball) {
  const dirs = [
    { s:'left',   active: ball.x-BALL_R <= WALL+PAD_W, wall: ball.x-BALL_R <= WALL },
    { s:'right',  active: ball.x+BALL_R >= GW-WALL-PAD_W, wall: ball.x+BALL_R >= GW-WALL },
    { s:'top',    active: ball.y-BALL_R <= WALL+PAD_W, wall: ball.y-BALL_R <= WALL },
    { s:'bottom', active: ball.y+BALL_R >= GH-WALL-PAD_W, wall: ball.y+BALL_R >= GH-WALL },
  ];
  for (const { s, active, wall } of dirs) {
    if (room.sides.includes(s)) {
      if (!active) continue;
      const pad = room.paddles[s];
      if (!pad?.alive) { bounceWall(ball, s); continue; }
      const isV = s==='left'||s==='right';
      const bp  = isV ? ball.y : ball.x;
      if (bp >= pad.pos && bp <= pad.pos+PAD_LEN) {
        bounceHit(ball, s); room.lastPaddle=s; room.scores[s]++;
      } else {
        loseLife(room, s); return 'miss';
      }
    } else {
      if (!wall) continue;
      bounceWall(ball, s);
    }
  }
  return null;
}

function bounceHit(b, s) {
  const f = 1.025;
  if (s==='left')   { b.vx= Math.abs(b.vx)*f; b.x=WALL+PAD_W+BALL_R+1; }
  if (s==='right')  { b.vx=-Math.abs(b.vx)*f; b.x=GW-WALL-PAD_W-BALL_R-1; }
  if (s==='top')    { b.vy= Math.abs(b.vy)*f; b.y=WALL+PAD_W+BALL_R+1; }
  if (s==='bottom') { b.vy=-Math.abs(b.vy)*f; b.y=GH-WALL-PAD_W-BALL_R-1; }
}

function bounceWall(b, s) {
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
  clearInterval(room.interval);
  clearInterval(room.starInterval);
  const winner = room.sides.find(s => room.paddles[s]?.alive) || null;
  io.to(room.id).emit('gameover', { winner, scores: room.scores });
  setTimeout(() => delete rooms[room.id], 60000);
}

function broadcast(room) {
  io.to(room.id).emit('state', {
    ball: room.ball, paddles: room.paddles,
    stars: room.stars, lasers: room.lasers,
    scores: room.scores, lives: room.lives,
  });
}

// ─── Socket events ────────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('create', ({ mode }) => {
    const room = makeRoom(parseInt(mode)||2);
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
    const lim  = (isV ? GH : GW) - WALL - PAD_W - PAD_LEN;
    pad.pos = Math.max(WALL+PAD_W, Math.min(lim, pos));
  });

  socket.on('disconnect', () => {
    const room = Object.values(rooms).find(r => r.players[socket.id]);
    if (!room) return;
    const side = room.players[socket.id];
    delete room.players[socket.id];
    if (room.phase === 'playing') {
      clearInterval(room.interval); clearInterval(room.starInterval);
      room.phase = 'gameover';
      io.to(room.id).emit('playerLeft', { side });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Quad Pong running on http://localhost:${PORT}`));
