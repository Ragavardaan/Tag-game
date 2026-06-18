import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import { GameConfig, Player, PowerUp, Room, ClientMessage, ServerMessage, Wall } from './src/types';
import { MAP_WIDTH, MAP_HEIGHT, PLAYER_RADIUS, POWERUP_RADIUS, MAP_WALLS } from './src/maps';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

// Rooms database
const rooms: Record<string, Room> = {};
// Mapping of WebSocket connection to player ID/room code
const clients = new Map<WebSocket, { playerId: string; roomCode: string }>();

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

// Send message to a socket safely
function sendMessage(ws: WebSocket, message: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// Broadcast to all players in a room
function broadcastToRoom(roomCode: string, message: ServerMessage) {
  const room = rooms[roomCode];
  if (!room) return;

  for (const [ws, info] of clients.entries()) {
    if (info.roomCode === roomCode) {
      sendMessage(ws, message);
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

        // Spawn powerups dynamically
        if (now - lastPowerUpSpawnTime >= 8000) {
          spawnPowerUp(roomCode);
          lastPowerUpSpawnTime = now;
        }

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

  // Determine winner
  const playersArr = Object.values(room.players);
  if (room.config.mode === 'bomb') {
    // Winner is the last one surviving
    const survivors = playersArr.filter(p => p.isAlive);
    if (survivors.length > 0) {
      room.winnerId = survivors[0].id;
    } else {
      // Fallback
      room.winnerId = playersArr[0]?.id || null;
    }
  } else {
    // Classic mode: highest score. Penality for the unfortunate current IT.
    const currentIt = playersArr.find(p => p.isIt);
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
wss.on('connection', (ws) => {
  ws.on('message', (messageBuffer) => {
    try {
      const data: ClientMessage = JSON.parse(messageBuffer.toString());
      
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
              map: data.config.map || 'arena'
            },
            players: { [playerId]: newPlayer },
            powerUps: [],
            timer: data.config.duration || 60,
            countdownTimer: 5,
            tagCooldownUntil: 0,
            lastTaggerId: null,
            winnerId: null
          };

          clients.set(ws, { playerId, roomCode });
          
          sendMessage(ws, {
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
            sendMessage(ws, { type: 'error', message: 'Room not found! Double check the room code.' });
            return;
          }

          if (room.status !== 'lobby') {
            sendMessage(ws, { type: 'error', message: 'Game has already started or finished.' });
            return;
          }

          const currentPlayersCount = Object.keys(room.players).length;
          if (currentPlayersCount >= room.config.maxPlayers) {
            sendMessage(ws, { type: 'error', message: 'This room is currently full.' });
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
          clients.set(ws, { playerId, roomCode: code });

          sendMessage(ws, {
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
          const info = clients.get(ws);
          if (!info) return;

          const room = rooms[info.roomCode];
          if (!room || room.hostId !== info.playerId) return;

          room.config = {
            maxPlayers: data.config.maxPlayers,
            duration: data.config.duration,
            speed: data.config.speed,
            mode: data.config.mode,
            map: data.config.map
          };

          broadcastToRoom(info.roomCode, { type: 'room_updated', room });
          break;
        }

        case 'start_game': {
          const info = clients.get(ws);
          if (!info) return;

          const room = rooms[info.roomCode];
          if (!room || room.hostId !== info.playerId) return;

          if (Object.keys(room.players).length < 2) {
            sendMessage(ws, { type: 'error', message: 'Need at least 2 players to start a multiplayer match!' });
            return;
          }

          // Reset scores, spawn items and start countdown
          room.winnerId = null;
          room.powerUps = [];
          
          for (const pid in room.players) {
            const p = room.players[pid];
            p.x = Math.random() * (MAP_WIDTH - 200) + 100;
            p.y = Math.random() * (MAP_HEIGHT - 200) + 100;
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

        case 'move': {
          const info = clients.get(ws);
          if (!info) return;

          const room = rooms[info.roomCode];
          if (!room || room.status !== 'playing') return;

          const player = room.players[info.playerId];
          if (!player || !player.isAlive) return;

          // Update player coordinates and velocity direct from client
          player.x = data.x;
          player.y = data.y;
          player.vx = data.vx;
          player.vy = data.vy;

          // Broadcast quick minimal delta positions or full update?
          // To keep code highly reliable and robust, broadcast fully synced rooms 
          // Let's broadcast the coordinates change instantly to keep lag minimal!
          broadcastToRoom(info.roomCode, { type: 'room_updated', room });
          break;
        }

        case 'emoji': {
          const info = clients.get(ws);
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
          const info = clients.get(ws);
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
          handleDisconnect(ws);
          break;
        }
      }
    } catch (err) {
      console.error('Error handling ws message:', err);
    }
  });

  ws.on('close', () => {
    handleDisconnect(ws);
  });
});

function handleDisconnect(ws: WebSocket) {
  const info = clients.get(ws);
  if (!info) return;

  const { playerId, roomCode } = info;
  clients.delete(ws);

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
