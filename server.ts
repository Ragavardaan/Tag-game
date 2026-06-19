import express from 'express';
import http from 'http';
import path from 'path';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import { GameConfig, Player, PowerUp, Room, ClientMessage, ServerMessage, Wall } from './src/types';
import { MAP_WIDTH, MAP_HEIGHT, PLAYER_RADIUS, POWERUP_RADIUS, MAP_WALLS, MAP_PORTALS, PORTAL_RADIUS, checkWallCollision } from './src/maps';

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

// Rooms database
const rooms: Record<string, Room> = {};
// Mapping of Socket connection ID to player detail/room code
const clients = new Map<string, { socket: Socket; playerId: string; roomCode: string }>();

// Generate unique room code (4 capital letters)
function generateRoomCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms[code]);
  return code;
}

// Generate unique ID
function generateId(): string {
  return Math.random().toString(36).substring(2, 9);
}

const BOT_PROFILES = [
  { name: '🤖 TurboBot', color: '#10B981' },
  { name: '🤖 PinkyPounce', color: '#EC4899' },
  { name: '🤖 AstroTagger', color: '#3B82F6' },
  { name: '🤖 SandSkater', color: '#F59E0B' },
  { name: '🤖 WarpCore', color: '#8B5CF6' },
  { name: '🤖 FreezeRay', color: '#06B6D4' }
];

function getSafeSpawnPosition(walls: Wall[]): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let valid = false;
  let attempts = 0;
  const radius = PLAYER_RADIUS;

  while (!valid && attempts < 100) {
    attempts++;
    x = Math.floor(Math.random() * (MAP_WIDTH - 200)) + 100;
    y = Math.floor(Math.random() * (MAP_HEIGHT - 200)) + 100;

    let hitWall = false;
    for (const wall of walls) {
      if (
        x + radius > wall.x &&
        x - radius < wall.x + wall.w &&
        y + radius > wall.y &&
        y - radius < wall.y + wall.h
      ) {
        hitWall = true;
        break;
      }
    }
    if (!hitWall) {
      valid = true;
    }
  }

  if (!valid) {
    x = MAP_WIDTH / 2;
    y = MAP_HEIGHT / 2;
  }

  return { x, y };
}

function populateBots(room: Room) {
  // Clear any existing bots from room.players
  for (const pid in room.players) {
    if (room.players[pid].isBot) {
      delete room.players[pid];
    }
  }

  const walls = MAP_WALLS[room.config.map] || [];
  const botCount = room.config.botsCount || 0;
  for (let i = 0; i < botCount; i++) {
    const profile = BOT_PROFILES[i % BOT_PROFILES.length];
    const botId = `bot_${generateId()}_${i}`;
    const spawnPos = getSafeSpawnPosition(walls);
    const botPlayer: Player = {
      id: botId,
      name: profile.name,
      color: profile.color,
      x: spawnPos.x,
      y: spawnPos.y,
      vx: 0,
      vy: 0,
      isIt: false,
      isAlive: true,
      score: 0,
      shieldUntil: 0,
      speedBoostUntil: 0,
      frozenUntil: 0,
      emoji: null,
      emojiExpiresAt: 0,
      message: null,
      messageExpiresAt: 0,
      isBot: true
    };
    room.players[botId] = botPlayer;
  }
}

// Send message to a socket safely
function sendMessage(socket: Socket, message: ServerMessage) {
  socket.emit('message', JSON.stringify(message));
}

// Broadcast to all players in a room
function broadcastToRoom(roomCode: string, message: ServerMessage) {
  const room = rooms[roomCode];
  if (!room) return;

  const msgStr = JSON.stringify(message);
  for (const [socketId, info] of clients.entries()) {
    if (info.roomCode === roomCode) {
      info.socket.emit('message', msgStr);
    }
  }
}

// Helper to spawn a safe powerup on the map
function spawnPowerUp(roomCode: string) {
  const room = rooms[roomCode];
  if (!room) return;

  // Max 5 concurrent powerups
  if (room.powerUps.filter(p => p.active).length >= 5) return;

  const types: Array<'speed' | 'shield' | 'teleport' | 'freeze'> = ['speed', 'shield', 'teleport', 'freeze'];
  const type = types[Math.floor(Math.random() * types.length)];
  const walls = MAP_WALLS[room.config.map] || [];

  let x = 0;
  let y = 0;
  let valid = false;
  let attempts = 0;

  while (!valid && attempts < 50) {
    attempts++;
    x = Math.floor(Math.random() * (MAP_WIDTH - 100)) + 50;
    y = Math.floor(Math.random() * (MAP_HEIGHT - 100)) + 50;
    
    // Check collision with walls
    let hitWall = false;
    for (const wall of walls) {
      if (
        x + POWERUP_RADIUS > wall.x &&
        x - POWERUP_RADIUS < wall.x + wall.w &&
        y + POWERUP_RADIUS > wall.y &&
        y - POWERUP_RADIUS < wall.y + wall.h
      ) {
        hitWall = true;
        break;
      }
    }

    if (!hitWall) {
      valid = true;
    }
  }

  const newPowerUp: PowerUp = {
    id: generateId(),
    type,
    x,
    y,
    active: true
  };

  room.powerUps.push(newPowerUp);
  broadcastToRoom(roomCode, { type: 'room_updated', room });
}

// Game interval loop references
const roomIntervals: Record<string, NodeJS.Timeout> = {};

function startGameLoop(roomCode: string) {
  if (roomIntervals[roomCode]) {
    clearInterval(roomIntervals[roomCode]);
  }

  let lastPowerUpSpawnTime = Date.now();
  let lastSecondTime = Date.now();

  const interval = setInterval(() => {
    const room = rooms[roomCode];
    if (!room) {
      clearInterval(interval);
      delete roomIntervals[roomCode];
      return;
    }

    const now = Date.now();

    // 1. COUNTDOWN STATE
    if (room.status === 'countdown') {
      if (now - lastSecondTime >= 1000) {
        room.countdownTimer--;
        lastSecondTime = now;
        if (room.countdownTimer <= 0) {
          room.status = 'playing';
          room.timer = room.config.duration;
          
          // Set a random player as IT
          const playerIds = Object.keys(room.players).filter(id => room.players[id].isAlive);
          if (playerIds.length > 0) {
            const randomItId = playerIds[Math.floor(Math.random() * playerIds.length)];
            for (const id in room.players) {
              room.players[id].isIt = (id === randomItId);
            }
          }
          room.tagCooldownUntil = Date.now() + 2000; // 2 seconds safety grace period
          room.lastTaggerId = null;

          broadcastToRoom(roomCode, { type: 'room_updated', room });
        } else {
          broadcastToRoom(roomCode, { type: 'room_updated', room });
        }
      }
      return;
    }

    // 2. PLAYING STATE
    if (room.status === 'playing') {
      // Tick general timer (once per second)
      if (now - lastSecondTime >= 1000) {
        room.timer--;
        lastSecondTime = now;

        // Give points/score to all alive, non-IT players in classic mode
        if (room.config.mode === 'classic') {
          for (const playerId in room.players) {
            const p = room.players[playerId];
            if (p.isAlive && !p.isIt) {
              p.score += 10; // score points for surviving
            }
          }
        }

        // Space powerups spawning is disabled - we only have static 3D teleport portals
        /*
        if (now - lastPowerUpSpawnTime >= 8000) {
          spawnPowerUp(roomCode);
          lastPowerUpSpawnTime = now;
        }
        */

        // Bomb explodes timer!
        if (room.timer <= 0) {
          if (room.config.mode === 'bomb') {
            // Player who is IT explodes!
            const itPlayerId = Object.keys(room.players).find(id => room.players[id].isIt && room.players[id].isAlive);
            if (itPlayerId) {
              const p = room.players[itPlayerId];
              p.isAlive = false;
              p.isIt = false;
              
              broadcastToRoom(roomCode, {
                type: 'explosion_event',
                playerName: p.name
              });

              // Check if any survivors remain
              const alivePlayers = Object.keys(room.players).filter(id => room.players[id].isAlive);
              if (alivePlayers.length <= 1) {
                // End game!
                endGame(roomCode);
                return;
              } else {
                // Reset timer for another bomb round and appoint next IT player
                room.timer = Math.max(15, Math.floor(room.config.duration * 0.75)); // successive bomb timers get 25% faster
                const newItId = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
                room.players[newItId].isIt = true;
                room.tagCooldownUntil = Date.now() + 3000; // 3 seconds shield on start/new bomb
                
                broadcastToRoom(roomCode, {
                  type: 'tag_event',
                  fromName: 'System (New Bomb)',
                  toName: room.players[newItId].name,
                  gameMode: 'bomb'
                });
              }
            } else {
              // No one is IT, maybe round over or pick one
              endGame(roomCode);
              return;
            }
          } else {
            // Classic mode: round ended normally
            endGame(roomCode);
            return;
          }
        }

        broadcastToRoom(roomCode, { type: 'room_updated', room });
      }

      // Update bots movement at 30 FPS on the server
      const currentAliveList = Object.values(room.players).filter(p => p.isAlive);
      const bots = currentAliveList.filter(p => p.isBot);
      
      if (bots.length > 0) {
        let botsMoved = false;
        const walls = MAP_WALLS[room.config.map] || [];
        const portals = MAP_PORTALS[room.config.map] || [];

        // Determine base speed according to game speed setting
        let baseSpeed = 3.2; // default normal
        if (room.config.speed === 'slow') baseSpeed = 2.0;
        else if (room.config.speed === 'fast') baseSpeed = 4.6;
        else if (room.config.speed === 'insane') baseSpeed = 6.5;

        for (const bot of bots) {
          // Skip if frozen
          if (now < bot.frozenUntil) {
            bot.vx = 0;
            bot.vy = 0;
            continue;
          }

          // Speed boost multiplier
          let currentSpeed = baseSpeed;
          if (now < bot.speedBoostUntil) {
            currentSpeed *= 1.35;
          }

          let targetVx = 0;
          let targetVy = 0;

          if (bot.isIt) {
            // Case A: Bot is IT - chase the nearest alive human / bot
            const targets = currentAliveList.filter(p => p.id !== bot.id && now >= p.shieldUntil);
            if (targets.length > 0) {
              // Find closest target
              let closestTarget = targets[0];
              let minDistance = Infinity;
              for (const t of targets) {
                const dx = t.x - bot.x;
                const dy = t.y - bot.y;
                const dist = dx * dx + dy * dy;
                if (dist < minDistance) {
                  minDistance = dist;
                  closestTarget = t;
                }
              }

              // Calculate direction vector
              const dx = closestTarget.x - bot.x;
              const dy = closestTarget.y - bot.y;
              const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;

              targetVx = (dx / dist) * currentSpeed;
              targetVy = (dy / dist) * currentSpeed;
            }
          } else {
            // Case B: Bot is not IT - run away from whoever IS IT
            const itPlayer = currentAliveList.find(p => p.isIt);
            if (itPlayer) {
              const dx = bot.x - itPlayer.x;
              const dy = bot.y - itPlayer.y;
              const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;

              // If IT is reasonably close, run away actively
              if (dist < 320) {
                targetVx = (dx / dist) * currentSpeed;
                targetVy = (dy / dist) * currentSpeed;
              } else {
                // Otherwise, perform some slight wandering/patrolling behavior
                if (!bot.vx && !bot.vy) {
                  const angle = Math.random() * Math.PI * 2;
                  bot.vx = Math.cos(angle) * (currentSpeed * 0.5);
                  bot.vy = Math.sin(angle) * (currentSpeed * 0.5);
                }
                if (Math.random() < 0.04) {
                  const angle = Math.random() * Math.PI * 2;
                  targetVx = Math.cos(angle) * (currentSpeed * 0.5);
                  targetVy = Math.sin(angle) * (currentSpeed * 0.5);
                } else {
                  targetVx = bot.vx || 0;
                  targetVy = bot.vy || 0;
                }
              }
            } else {
              // No one is IT, do random wander
              if (Math.random() < 0.04) {
                const angle = Math.random() * Math.PI * 2;
                targetVx = Math.cos(angle) * (currentSpeed * 0.4);
                targetVy = Math.sin(angle) * (currentSpeed * 0.4);
              } else {
                targetVx = bot.vx || 0;
                targetVy = bot.vy || 0;
              }
            }
          }

          // Smoothly interpolate to target velocity
          bot.vx = bot.vx * 0.8 + targetVx * 0.2;
          bot.vy = bot.vy * 0.8 + targetVy * 0.2;

          // Apply displacement
          let nextX = bot.x + bot.vx;
          let nextY = bot.y + bot.vy;

          // Check wall collision with sliding resolution
          const wallCol = checkWallCollision(nextX, nextY, PLAYER_RADIUS, walls);
          if (wallCol && wallCol.collided) {
            nextX = wallCol.x;
            nextY = wallCol.y;

            const nx = wallCol.normalX;
            const ny = wallCol.normalY;
            const dot = bot.vx * nx + bot.vy * ny;
            if (dot < 0) {
              bot.vx = bot.vx - dot * nx;
              bot.vy = bot.vy - dot * ny;
            }
          }

          // Check Teleport Portal usage for Bots
          if (portals.length === 2) {
            const lastTelePort = bot.lastTeleportTime || 0;
            if (now - lastTelePort > 1500) {
              for (let i = 0; i < 2; i++) {
                const portal = portals[i];
                const dx = nextX - portal.x;
                const dy = nextY - portal.y;
                if (Math.sqrt(dx * dx + dy * dy) < PLAYER_RADIUS + PORTAL_RADIUS) {
                  const destPortal = portals[1 - i];
                  nextX = destPortal.x;
                  nextY = destPortal.y;
                  bot.lastTeleportTime = now;
                  bot.vx = 0;
                  bot.vy = 0;
                  
                  broadcastToRoom(roomCode, {
                    type: 'powerup_grant',
                    powerupType: 'Portal Teleporter 🌀',
                    playerName: bot.name
                  });
                  break;
                }
              }
            }
          }

          // Move coordinates
          if (bot.x !== nextX || bot.y !== nextY) {
            bot.x = nextX;
            bot.y = nextY;
            botsMoved = true;
          }
        }

        if (botsMoved) {
          broadcastToRoom(roomCode, { type: 'room_updated', room });
        }
      }

      // Check player power-up collection on the server to prevent hacking/exploits
      const alivePlayers = Object.values(room.players).filter(p => p.isAlive);
      for (const player of alivePlayers) {
        for (let i = room.powerUps.length - 1; i >= 0; i--) {
          const pu = room.powerUps[i];
          if (!pu.active) continue;

          const dx = player.x - pu.x;
          const dy = player.y - pu.y;
          const distance = Math.sqrt(dx * dx + dy * dy);

          // Standard radii touch overlap check
          if (distance < PLAYER_RADIUS + POWERUP_RADIUS) {
            pu.active = false;
            room.powerUps.splice(i, 1);

            // Apply powerup
            if (pu.type === 'speed') {
              player.speedBoostUntil = Date.now() + 6000; // 6 seconds
              broadcastToRoom(roomCode, { type: 'powerup_grant', powerupType: 'Speed Boost ⚡', playerName: player.name });
            } else if (pu.type === 'shield') {
              player.shieldUntil = Date.now() + 5000; // 5 seconds
              broadcastToRoom(roomCode, { type: 'powerup_grant', powerupType: 'Shield Protection 🛡️', playerName: player.name });
            } else if (pu.type === 'teleport') {
              player.x = Math.floor(Math.random() * (MAP_WIDTH - 120)) + 60;
              player.y = Math.floor(Math.random() * (MAP_HEIGHT - 120)) + 60;
              broadcastToRoom(roomCode, { type: 'powerup_grant', powerupType: 'Instant Teleporter 🌀', playerName: player.name });
            } else if (pu.type === 'freeze') {
              // Freeze other players
              for (const otherId in room.players) {
                if (otherId !== player.id) {
                  room.players[otherId].frozenUntil = Date.now() + 1500; // 1.5 seconds freeze
                }
              }
              broadcastToRoom(roomCode, { type: 'powerup_grant', powerupType: 'Blizzard Freeze ❄️', playerName: player.name });
            }

            broadcastToRoom(roomCode, { type: 'room_updated', room });
          }
        }
      }

      // 3. TAG DETECTION MECHANICS
      // Loop over all possible pairs to check if IT collides with a non-IT
      const nowTs = Date.now();
      if (nowTs >= room.tagCooldownUntil) {
        const itPlayer = alivePlayers.find(p => p.isIt);
        if (itPlayer) {
          for (const other of alivePlayers) {
            if (other.id === itPlayer.id) continue;
            
            // Check shield
            if (nowTs < other.shieldUntil) continue;

            const dx = itPlayer.x - other.x;
            const dy = itPlayer.y - other.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < (PLAYER_RADIUS * 2) - 2) {
              // TAG!
              itPlayer.isIt = false;
              other.isIt = true;
              
              // Apply points deduction to the tagger, or boost receiver
              if (room.config.mode === 'classic') {
                itPlayer.score = Math.max(0, itPlayer.score - 20); // penalty
                other.score += 50; // extra points for catching or escaping? Wait, caught gets less. Actually other just gets tagged, no bonus!
              }

              // Set grace period
              room.tagCooldownUntil = nowTs + 2000; // 2 seconds safety
              room.lastTaggerId = itPlayer.id;

              broadcastToRoom(roomCode, {
                type: 'tag_event',
                fromName: itPlayer.name,
                toName: other.name,
                gameMode: room.config.mode
              });

              broadcastToRoom(roomCode, { type: 'room_updated', room });
              break; // Only 1 tag can occur at exactly the same time
            }
          }
        }
      }
    }
  }, 33); // ~30 fps state tick

  roomIntervals[roomCode] = interval;
}

function endGame(roomCode: string) {
  const room = rooms[roomCode];
  if (!room) return;

  room.status = 'gameover';

  // Determine loser (the player who has the tag - is IT)
  const playersArr = Object.values(room.players);
  const currentIt = playersArr.find(p => p.isIt);
  room.loserId = currentIt ? currentIt.id : null;

  if (room.config.mode === 'bomb') {
    // Winner is the last one surviving
    const survivors = playersArr.filter(p => p.isAlive);
    if (survivors.length > 0) {
      room.winnerId = survivors[0].id;
    } else {
      room.winnerId = playersArr[0]?.id || null;
    }
    // If no currentIt is alive, the one who just exploded is the loser
    if (!room.loserId) {
      const deadPlayers = playersArr.filter(p => !p.isAlive);
      if (deadPlayers.length > 0) {
        room.loserId = deadPlayers[deadPlayers.length - 1].id;
      }
    }
  } else {
    // Classic mode: penalty for the unfortunate current IT.
    if (currentIt) {
      currentIt.score = Math.max(0, currentIt.score - 100);
    }
    
    let highestScore = -9999;
    let winnerId: string | null = null;
    for (const p of playersArr) {
      if (p.score > highestScore) {
        highestScore = p.score;
        winnerId = p.id;
      }
    }
    room.winnerId = winnerId;
  }

  // Clear running loops
  if (roomIntervals[roomCode]) {
    clearInterval(roomIntervals[roomCode]);
    delete roomIntervals[roomCode];
  }

  broadcastToRoom(roomCode, { type: 'room_updated', room });
}

// WS Connection handler
io.on('connection', (socket) => {
  socket.on('message', (messageData) => {
    try {
      const data: ClientMessage = typeof messageData === 'string' ? JSON.parse(messageData) : messageData;
      
      switch (data.type) {
        case 'create': {
          const roomCode = generateRoomCode();
          const playerId = generateId();
          
          const newPlayer: Player = {
            id: playerId,
            name: data.name.trim() || 'Anonymous',
            color: data.color || '#EF4444',
            x: Math.random() * (MAP_WIDTH - 200) + 100,
            y: Math.random() * (MAP_HEIGHT - 200) + 100,
            vx: 0,
            vy: 0,
            isIt: false,
            isAlive: true,
            score: 0,
            shieldUntil: 0,
            speedBoostUntil: 0,
            frozenUntil: 0,
            emoji: null,
            emojiExpiresAt: 0,
            message: null,
            messageExpiresAt: 0
          };

          rooms[roomCode] = {
            code: roomCode,
            hostId: playerId,
            status: 'lobby',
            config: {
              maxPlayers: data.config.maxPlayers || 8,
              duration: data.config.duration || 60,
              speed: data.config.speed || 'normal',
              mode: data.config.mode || 'classic',
              map: data.config.map || 'arena',
              botsCount: Math.min(6, Math.max(0, data.config.botsCount !== undefined ? data.config.botsCount : 0))
            },
            players: { [playerId]: newPlayer },
            powerUps: [],
            timer: data.config.duration || 60,
            countdownTimer: 5,
            tagCooldownUntil: 0,
            lastTaggerId: null,
            winnerId: null,
            loserId: null
          };

          clients.set(socket.id, { socket, playerId, roomCode });
          
          sendMessage(socket, {
            type: 'room_snapshot',
            room: rooms[roomCode],
            personalId: playerId
          });

          break;
        }

        case 'join': {
          const code = data.roomCode.trim().toUpperCase();
          const room = rooms[code];
          
          if (!room) {
            sendMessage(socket, { type: 'error', message: 'Room not found! Double check the room code.' });
            return;
          }

          if (room.status !== 'lobby') {
            sendMessage(socket, { type: 'error', message: 'Game has already started or finished.' });
            return;
          }

          const currentPlayersCount = Object.keys(room.players).length;
          if (currentPlayersCount >= room.config.maxPlayers) {
            sendMessage(socket, { type: 'error', message: 'This room is currently full.' });
            return;
          }

          const playerId = generateId();
          
          const newPlayer: Player = {
            id: playerId,
            name: data.name.trim() || `Player_${currentPlayersCount + 1}`,
            color: data.color || '#3B82F6',
            x: Math.random() * (MAP_WIDTH - 200) + 100,
            y: Math.random() * (MAP_HEIGHT - 200) + 100,
            vx: 0,
            vy: 0,
            isIt: false,
            isAlive: true,
            score: 0,
            shieldUntil: 0,
            speedBoostUntil: 0,
            frozenUntil: 0,
            emoji: null,
            emojiExpiresAt: 0,
            message: null,
            messageExpiresAt: 0
          };

          room.players[playerId] = newPlayer;
          clients.set(socket.id, { socket, playerId, roomCode: code });

          sendMessage(socket, {
            type: 'room_snapshot',
            room,
            personalId: playerId
          });

          // Broadcast join message to everyone
          broadcastToRoom(code, { type: 'room_updated', room });
          broadcastToRoom(code, {
            type: 'chat_feed',
            id: 'system',
            name: 'System',
            color: '#10B981',
            text: `👋 ${newPlayer.name} joined the arena!`,
            timestamp: Date.now()
          });

          break;
        }

        case 'update_config': {
          const info = clients.get(socket.id);
          if (!info) return;

          const room = rooms[info.roomCode];
          if (!room || room.hostId !== info.playerId) return;

          room.config = {
            maxPlayers: data.config.maxPlayers,
            duration: data.config.duration,
            speed: data.config.speed,
            mode: data.config.mode,
            map: data.config.map,
            botsCount: Math.min(6, Math.max(0, data.config.botsCount !== undefined ? data.config.botsCount : 0))
          };

          broadcastToRoom(info.roomCode, { type: 'room_updated', room });
          break;
        }

        case 'start_game': {
          const info = clients.get(socket.id);
          if (!info) return;

          const room = rooms[info.roomCode];
          if (!room || room.hostId !== info.playerId) return;

          // Populate configured AI bots!
          populateBots(room);

          if (Object.keys(room.players).length < 2) {
            sendMessage(socket, { type: 'error', message: 'Need at least 2 players or AI bots to start a match!' });
            return;
          }

          // Reset scores, spawn items and start countdown safely
          room.winnerId = null;
          room.loserId = null;
          room.powerUps = [];
          
          const walls = MAP_WALLS[room.config.map] || [];
          for (const pid in room.players) {
            const p = room.players[pid];
            const spawnPos = getSafeSpawnPosition(walls);
            p.x = spawnPos.x;
            p.y = spawnPos.y;
            p.vx = 0;
            p.vy = 0;
            p.isAlive = true;
            p.score = 0;
            p.isIt = false;
            p.shieldUntil = 0;
            p.speedBoostUntil = 0;
            p.frozenUntil = 0;
            p.emoji = null;
            p.message = null;
          }

          room.status = 'countdown';
          room.countdownTimer = 5; 
          room.timer = room.config.duration;

          broadcastToRoom(info.roomCode, { type: 'room_updated', room });
          startGameLoop(info.roomCode);

          break;
        }

        case 'back_to_lobby': {
          const info = clients.get(socket.id);
          if (!info) return;

          const room = rooms[info.roomCode];
          if (!room || room.hostId !== info.playerId) return;

          room.status = 'lobby';
          room.winnerId = null;
          room.loserId = null;
          room.powerUps = [];

          // Clean up running loops so they don't leak or conflict
          if (roomIntervals[info.roomCode]) {
            clearInterval(roomIntervals[info.roomCode]);
            delete roomIntervals[info.roomCode];
          }

          broadcastToRoom(info.roomCode, { type: 'room_updated', room });
          broadcastToRoom(info.roomCode, {
            type: 'chat_feed',
            id: 'system',
            name: 'System',
            color: '#10B981',
            text: '🔄 Host returned the room to the lobby for configuration!',
            timestamp: Date.now()
          });

          break;
        }

        case 'move': {
          const info = clients.get(socket.id);
          if (!info) return;

          const room = rooms[info.roomCode];
          if (!room || room.status !== 'playing') return;

          const player = room.players[info.playerId];
          if (!player || !player.isAlive) return;

          // Update player coordinates and velocity direct from client
          // Ignore move updates that contradict a very recent teleportation (to let the client catch up)
          const nowTs = Date.now();
          const lastTele = player.lastTeleportTime || 0;
          if (nowTs - lastTele < 350) {
            // Keep velocity matching for graphics, but block client override of position coordinate
            player.vx = data.vx;
            player.vy = data.vy;
          } else {
            player.x = data.x;
            player.y = data.y;
            player.vx = data.vx;
            player.vy = data.vy;
          }

          // Process permanent active two-point portal teleportation
          const portals = MAP_PORTALS[room.config.map];
          if (portals && portals.length === 2) {
            const nowTs = Date.now();
            const lastTele = player.lastTeleportTime || 0;
            if (nowTs - lastTele > 1500) { // 1.5 seconds cooldown
              for (let i = 0; i < 2; i++) {
                const portal = portals[i];
                const dx = player.x - portal.x;
                const dy = player.y - portal.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < PLAYER_RADIUS + PORTAL_RADIUS) {
                  const otherPortal = portals[1 - i];
                  player.x = otherPortal.x;
                  player.y = otherPortal.y;
                  player.lastTeleportTime = nowTs;
                  player.vx = 0;
                  player.vy = 0;

                  // Broadcast a nice ticker event for everyone
                  broadcastToRoom(info.roomCode, {
                    type: 'powerup_grant',
                    powerupType: 'Portal Teleporter 🌀',
                    playerName: player.name
                  });
                  break;
                }
              }
            }
          }

          // Broadcast quick minimal delta positions or full update?
          // To keep code highly reliable and robust, broadcast fully synced rooms 
          // Let's broadcast the coordinates change instantly to keep lag minimal!
          broadcastToRoom(info.roomCode, { type: 'room_updated', room });
          break;
        }

        case 'emoji': {
          const info = clients.get(socket.id);
          if (!info) return;

          const room = rooms[info.roomCode];
          if (!room) return;

          const player = room.players[info.playerId];
          if (!player) return;

          player.emoji = data.emoji;
          player.emojiExpiresAt = Date.now() + 3000; // lasts 3s

          broadcastToRoom(info.roomCode, { type: 'room_updated', room });
          break;
        }

        case 'chat': {
          const info = clients.get(socket.id);
          if (!info) return;

          const room = rooms[info.roomCode];
          if (!room) return;

          const player = room.players[info.playerId];
          if (!player) return;

          player.message = data.text.substring(0, 45); // Max 45 chars for clean speech bubble
          player.messageExpiresAt = Date.now() + 4000; // lasts 4s

          broadcastToRoom(info.roomCode, { type: 'room_updated', room });
          broadcastToRoom(info.roomCode, {
            type: 'chat_feed',
            id: generateId(),
            name: player.name,
            color: player.color,
            text: data.text,
            timestamp: Date.now()
          });

          break;
        }

        case 'leave': {
          handleDisconnect(socket);
          break;
        }
      }
    } catch (err) {
      console.error('Error handling ws message:', err);
    }
  });

  socket.on('disconnect', () => {
    handleDisconnect(socket);
  });
});

function handleDisconnect(socket: Socket) {
  const info = clients.get(socket.id);
  if (!info) return;

  const { playerId, roomCode } = info;
  clients.delete(socket.id);

  const room = rooms[roomCode];
  if (!room) return;

  const disconnectedPlayer = room.players[playerId];
  delete room.players[playerId];

  const activePlayers = Object.keys(room.players);

  if (activePlayers.length === 0) {
    // Empty room, clear interval and clean up
    if (roomIntervals[roomCode]) {
      clearInterval(roomIntervals[roomCode]);
      delete roomIntervals[roomCode];
    }
    delete rooms[roomCode];
  } else {
    // Notify room
    if (disconnectedPlayer) {
      broadcastToRoom(roomCode, {
        type: 'chat_feed',
        id: 'system',
        name: 'System',
        color: '#EF4444',
        text: `🚪 ${disconnectedPlayer.name} left the game.`,
        timestamp: Date.now()
      });
    }

    // Host left, assign new host
    if (room.hostId === playerId) {
      const newHostId = activePlayers[0];
      room.hostId = newHostId;
      broadcastToRoom(roomCode, {
        type: 'chat_feed',
        id: 'system',
        name: 'System',
        color: '#D97706',
        text: `👑 ${room.players[newHostId].name} is now the Host!`,
        timestamp: Date.now()
      });
    }

    // If game was playing, check if we need to end it
    if (room.status === 'playing') {
      const alivePlayers = activePlayers.filter(id => room.players[id].isAlive);
      if (alivePlayers.length <= 1) {
        endGame(roomCode);
      } else {
        // If the player who left was IT, select a new random IT player
        if (disconnectedPlayer?.isIt) {
          const newItId = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
          room.players[newItId].isIt = true;
          room.tagCooldownUntil = Date.now() + 2000;
          
          broadcastToRoom(roomCode, {
            type: 'tag_event',
            fromName: 'System (Migration)',
            toName: room.players[newItId].name,
            gameMode: room.config.mode
          });
        }
        broadcastToRoom(roomCode, { type: 'room_updated', room });
      }
    } else {
      broadcastToRoom(roomCode, { type: 'room_updated', room });
    }
  }
}

// Full Stack express routing setup
async function startServer() {
  // Serve built assets in production, use Vite in development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Classic-modern Multiplayer Tag Server running on http://localhost:${PORT}`);
  });
}

startServer();
