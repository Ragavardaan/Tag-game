/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, FormEvent } from 'react';
import { io } from 'socket.io-client';
import { GameConfig, Room, Player, ClientMessage, ServerMessage } from './types';
import GameCanvas from './components/GameCanvas';
import Scoreboard from './components/Scoreboard';
import ChatBox from './components/ChatBox';
import { Shield, Zap, Sparkles, Trophy, Users, Clock, Flame, ChevronRight, Copy, Check, LogOut, Swords, Settings, Award } from 'lucide-react';
import { motion } from 'motion/react';

const DIGNITY_COLORS = [
  '#EF4444', // Red
  '#3B82F6', // Blue
  '#10B981', // Emerald
  '#F59E0B', // Amber
  '#8B5CF6', // Violet
  '#EC4899', // Pink
  '#06B6D4', // Cyan
  '#F97316'  // Orange
];

export default function App() {
  const [ws, setWs] = useState<any>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [personalId, setPersonalId] = useState<string>('');
  const [chatFeed, setChatFeed] = useState<Array<{ id: string; name: string; color: string; text: string; timestamp: number }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // User details
  const [name, setName] = useState(() => localStorage.getItem('tag_player_name') || '');
  const [color, setColor] = useState(() => localStorage.getItem('tag_player_color') || DIGNITY_COLORS[Math.floor(Math.random() * DIGNITY_COLORS.length)]);

  // Screen selection state
  const [activeTab, setActiveTab] = useState<'create' | 'join'>('create');
  const [roomCodeInput, setRoomCodeInput] = useState('');

  // Host configuration state (defaults)
  const [maxPlayers, setMaxPlayers] = useState(8);
  const [duration, setDuration] = useState(60);
  const [speed, setSpeed] = useState<'slow' | 'normal' | 'fast' | 'insane'>('normal');
  const [gameMode, setGameMode] = useState<'classic' | 'bomb'>('classic');
  const [mapSelection, setMapSelection] = useState<'arena' | 'maze' | 'open' | 'blocks'>('arena');

  // Active status ticker for events
  const [tickerMessage, setTickerMessage] = useState<string | null>(null);

  // Manage Localstorage saving
  useEffect(() => {
    localStorage.setItem('tag_player_name', name);
  }, [name]);

  useEffect(() => {
    localStorage.setItem('tag_player_color', color);
  }, [color]);

  // Connect & handle WS messages
  const connectToServer = (messagePayload: ClientMessage) => {
    setError(null);

    // Derive server connection host dynamically based on browser location
    const protocol = window.location.protocol;
    const wsUrl = `${protocol}//${window.location.host}`;
    
    // Connect using Socket.IO starting with standard HTTP Long Polling for 100% firewall compatibility
    const socket = io(wsUrl, {
      transports: ['polling', 'websocket']
    });

    socket.on('connect', () => {
      // Polyfill WebSocket qualities for seamless Drop-In compatibility with GameCanvas and ChatBox
      (socket as any).readyState = 1; // 1 means OPEN
      (socket as any).OPEN = 1;
      
      // Send initial request (create or join) when socket establishes
      socket.send(JSON.stringify(messagePayload));
    });

    socket.on('message', (data) => {
      try {
        const msg: ServerMessage = typeof data === 'string' ? JSON.parse(data) : data;

        switch (msg.type) {
          case 'room_snapshot':
            setRoom(msg.room);
            setPersonalId(msg.personalId);
            setChatFeed([]);
            setError(null);
            break;

          case 'room_updated':
            setRoom(msg.room);
            break;

          case 'chat_feed':
            setChatFeed((prev) => [...prev, msg].slice(-100)); // limit feed to 100 entries
            break;

          case 'tag_event': {
            // Trigger quick global ticker notice
            const description = msg.gameMode === 'bomb'
              ? `💣 BOMB TRANSFERRED! ${msg.fromName} passed the bomb to ${msg.toName}!`
              : `🏃 TAG! ${msg.fromName} tagged ${msg.toName}!`;
            setTickerMessage(description);
            setTimeout(() => setTickerMessage((curr) => curr === description ? null : curr), 4000);
            break;
          }

          case 'explosion_event': {
            const desc = `💥 BOOOOM! ${msg.playerName} exploded!`;
            setTickerMessage(desc);
            setTimeout(() => setTickerMessage((curr) => curr === desc ? null : curr), 4000);
            break;
          }

          case 'powerup_grant': {
            const desc = `⚡ ${msg.playerName} grabbed ${msg.type}!`;
            setTickerMessage(desc);
            setTimeout(() => setTickerMessage((curr) => curr === desc ? null : curr), 2500);
            break;
          }

          case 'error':
            setError(msg.message);
            socket.close();
            break;
        }
      } catch (err) {
        console.error('Error handling server payload:', err);
      }
    });

    socket.on('disconnect', () => {
      (socket as any).readyState = 3; // 3 means CLOSED
      setWs(null);
      setRoom(null);
    });

    setWs(socket);
  };

  // Disconnect cleanly
  const leaveRoom = () => {
    if (ws) {
      ws.send(JSON.stringify({ type: 'leave' }));
      ws.close();
    }
    setWs(null);
    setRoom(null);
  };

  // Host triggers config changes in real-time
  const updateHostConfig = (updatedConfig: GameConfig) => {
    if (ws && ws.readyState === 1 && room?.hostId === personalId) {
      ws.send(JSON.stringify({ type: 'update_config', config: updatedConfig }));
    }
  };

  // Triggers when host updates a config parameter locally
  useEffect(() => {
    if (room && room.hostId === personalId) {
      updateHostConfig({
        maxPlayers,
        duration,
        speed,
        mode: gameMode,
        map: mapSelection
      });
    }
  }, [maxPlayers, duration, speed, gameMode, mapSelection]);

  // Handle Host settings sync to UI (when joined a room hosted by someone else)
  useEffect(() => {
    if (room && room.hostId !== personalId) {
      setMaxPlayers(room.config.maxPlayers);
      setDuration(room.config.duration);
      setSpeed(room.config.speed);
      setGameMode(room.config.mode);
      setMapSelection(room.config.map);
    }
  }, [room, personalId]);

  const handleCreateRoom = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Please choose a nickname to enter the arena!');
      return;
    }

    const payload: ClientMessage = {
      type: 'create',
      name: name.trim(),
      color,
      config: {
        maxPlayers,
        duration,
        speed,
        mode: gameMode,
        map: mapSelection
      }
    };

    connectToServer(payload);
  };

  const handleJoinRoom = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Please choose a nickname to enter the arena!');
      return;
    }
    if (!roomCodeInput.trim() || roomCodeInput.length !== 4) {
      setError('Room codes must be exactly 4 letters.');
      return;
    }

    const payload: ClientMessage = {
      type: 'join',
      name: name.trim(),
      color,
      roomCode: roomCodeInput.trim().toUpperCase()
    };

    connectToServer(payload);
  };

  const handleStartGame = () => {
    if (ws && ws.readyState === 1 && room?.hostId === personalId) {
      ws.send(JSON.stringify({ type: 'start_game' }));
    }
  };

  const copyRoomCode = () => {
    if (!room) return;
    navigator.clipboard.writeText(room.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // Render Setup/Auth panel
  if (!room) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4 md:p-6 select-none font-sans overflow-y-auto">
        {/* Decorative Grid Halo Backgrounds */}
        <div className="absolute inset-x-0 top-0 h-96 bg-gradient-to-b from-sky-500/10 via-transparent to-transparent pointer-events-none blur-3xl" />
        <div className="absolute top-[40%] right-[10%] w-80 h-80 bg-rose-500/5 pointer-events-none blur-3xl rounded-full" />

        {/* Global Error Alert Banner */}
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="w-full max-w-xl mb-4 bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs px-4 py-3 rounded-lg text-center font-semibold font-sans tracking-wide shadow-xl flex items-center justify-center gap-2"
          >
            <span className="w-2 h-2 rounded-full bg-rose-500 inline-block animate-pulse shrink-0" />
            {error}
          </motion.div>
        )}

        {/* Main Brand header */}
        <div className="text-center z-10 mb-8 max-w-xl">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-sky-950 border border-sky-850 text-sky-400 rounded-full font-mono text-xs font-black tracking-widest uppercase mb-4 shadow-lg shadow-sky-950/40">
            <Sparkles className="w-3.5 h-3.5" /> Next-Gen Websockets Realtime
          </div>
          <h1 className="text-4xl md:text-5xl font-black font-display tracking-tight text-white uppercase drop-shadow-md">
            Multiplayer <span className="text-transparent bg-clip-text bg-gradient-to-r from-sky-400 via-indigo-400 to-rose-400">Tag Arena</span>
          </h1>
          <p className="text-slate-400 text-xs md:text-sm mt-2 font-mono leading-relaxed">
            Invite friends to connect in real-time from their own screens! Pick a nickname, choose your color, customize speed config as host, and dodge the bomb!
          </p>
        </div>

        {/* Main configuration Container Box */}
        <div className="w-full max-w-3xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl relative z-10 grid grid-cols-1 md:grid-cols-12 gap-0 overflow-hidden">
          
          {/* Identity/Profile column (left side on desktop) */}
          <div className="md:col-span-5 p-5 md:p-6 bg-slate-950/50 border-b md:border-b-0 md:border-r border-slate-800 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2 mb-4">
                <div className="w-2.5 h-2.5 rounded-full bg-sky-500" />
                <h3 className="font-bold text-xs uppercase tracking-widest text-slate-400">
                  Player Identity
                </h3>
              </div>

              {/* Name field */}
              <div className="space-y-1.5 mb-6">
                <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block label-no-margin">
                  Your Nickname
                </label>
                <input
                  id="nickname-input"
                  type="text"
                  maxLength={14}
                  value={name}
                  onChange={(e) => setName(e.target.value.replace(/[^a-zA-Z0-9_ ]/g, ''))}
                  placeholder="LuckyTagger..."
                  className="w-full bg-slate-950 border border-slate-800 text-slate-100 font-mono text-sm px-4 py-2.5 rounded-xl placeholder-slate-700 focus:border-sky-500 hover:border-slate-700 outline-none transition"
                />
              </div>

              {/* Color picker Grid */}
              <div className="space-y-2">
                <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block label-no-margin">
                  Avatar Color
                </label>
                <div className="grid grid-cols-4 gap-2.5">
                  {DIGNITY_COLORS.map((col) => (
                    <button
                      id={`color-choice-${col}`}
                      key={col}
                      onClick={() => setColor(col)}
                      className={`h-11 rounded-lg border-2 relative transition-all active:scale-95 cursor-pointer flex items-center justify-center ${
                        color === col
                          ? 'border-white scale-105 shadow-lg shadow-white/15'
                          : 'border-transparent select-none scale-95 opacity-70 hover:opacity-100'
                      }`}
                      style={{ backgroundColor: col }}
                    >
                      {color === col && (
                        <span className="text-white text-xs block drop-shadow-md">👁️</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Visual Preview */}
            <div className="mt-8 pt-4 border-t border-slate-800/80 hidden md:block">
              <div className="flex items-center gap-3 bg-slate-900/60 p-3 rounded-xl border border-slate-800/50">
                <div className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-black text-white shrink-0 shadow-md shadow-black/30 animate-pulse border border-white/20" style={{ backgroundColor: color }}>
                  {name ? name.substring(0, 2).toUpperCase() : '👤'}
                </div>
                <div className="flex flex-col">
                  <span className="text-xs font-black text-slate-300 font-mono tracking-wide truncate max-w-[130px]">
                    {name || 'Unknown Runner'}
                  </span>
                  <span className="text-[10px] text-slate-500 uppercase font-bold tracking-wider">
                    Ready to Play
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Action Tabs/Lobby creation column (right side) */}
          <div className="md:col-span-7 flex flex-col h-full bg-slate-900">
            {/* Tabs Trigger Headers */}
            <div className="flex border-b border-slate-800 shrink-0">
              <button
                id="tab-create-trigger"
                onClick={() => { setActiveTab('create'); setError(null); }}
                className={`flex-1 py-4 text-xs font-bold font-mono uppercase tracking-wider border-b-2 transition-colors ${
                  activeTab === 'create'
                    ? 'border-sky-500 text-sky-400 bg-slate-950/10'
                    : 'border-transparent text-slate-500 hover:text-slate-300 hover:bg-slate-950/20'
                }`}
              >
                🎮 Create Battle Arena
              </button>
              <button
                id="tab-join-trigger"
                onClick={() => { setActiveTab('join'); setError(null); }}
                className={`flex-1 py-4 text-xs font-bold font-mono uppercase tracking-wider border-b-2 transition-colors ${
                  activeTab === 'join'
                    ? 'border-sky-500 text-sky-400 bg-slate-950/10'
                    : 'border-transparent text-slate-500 hover:text-slate-300 hover:bg-slate-950/20'
                }`}
              >
                🔑 Join Room Code
              </button>
            </div>

            {/* Tab 1 Content: Create Match config */}
            {activeTab === 'create' ? (
              <form onSubmit={handleCreateRoom} className="p-5 md:p-6 flex-1 flex flex-col justify-between space-y-4">
                <div className="space-y-4">
                  {/* Max Players (More than 4!) */}
                  <div>
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block label-no-margin flex items-center gap-1.5">
                        <Users className="w-3.5 h-3.5 text-slate-500" /> Max Players
                      </span>
                      <span className="text-xs font-mono font-black text-sky-400">{maxPlayers} Slots</span>
                    </div>
                    <input
                      id="lobby-max-players-slider"
                      type="range"
                      min={2}
                      max={16}
                      value={maxPlayers}
                      onChange={(e) => setMaxPlayers(parseInt(e.target.value))}
                      className="w-full accent-sky-500 cursor-pointer"
                    />
                    <div className="flex justify-between text-[9px] text-slate-600 font-mono mt-0.5">
                      <span>2 (Duels)</span>
                      <span>8 (Standard)</span>
                      <span>16 (Party Chaos)</span>
                    </div>
                  </div>

                  {/* Dual Grid Options: Game Mode & Map Selection */}
                  <div className="grid grid-cols-2 gap-3.5">
                    {/* Game Mode */}
                    <div className="space-y-1.5">
                      <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block label-no-margin flex items-center gap-1.5">
                        <Flame className="w-3.5 h-3.5 text-slate-500" /> Game Mode
                      </span>
                      <div className="flex flex-col gap-1.5">
                        <button
                          id="mode-classic-btn"
                          type="button"
                          onClick={() => setGameMode('classic')}
                          className={`w-full text-left p-2.5 rounded-lg border text-xs font-bold transition flex flex-col ${
                            gameMode === 'classic'
                              ? 'bg-sky-500/10 border-sky-500 text-sky-400'
                              : 'bg-slate-950/40 border-slate-800 text-slate-400 hover:border-slate-700'
                          }`}
                        >
                          <span>🏃 Classic Tag</span>
                          <span className="text-[9px] font-normal text-slate-500 mt-0.5">Survive & stack points</span>
                        </button>
                        <button
                          id="mode-bomb-btn"
                          type="button"
                          onClick={() => setGameMode('bomb')}
                          className={`w-full text-left p-2.5 rounded-lg border text-xs font-bold transition flex flex-col ${
                            gameMode === 'bomb'
                              ? 'bg-rose-500/10 border-rose-500 text-rose-400'
                              : 'bg-slate-950/40 border-slate-800 text-slate-400 hover:border-slate-700'
                          }`}
                        >
                          <span>💥 Hot Bomb</span>
                          <span className="text-[9px] font-normal text-slate-500 mt-0.5">Lose bomb before boom!</span>
                        </button>
                      </div>
                    </div>

                    {/* Arena Map Selector */}
                    <div className="space-y-1.5">
                      <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block label-no-margin flex items-center gap-1.5">
                        <Settings className="w-3.5 h-3.5 text-slate-500" /> Match Map
                      </span>
                      <select
                        id="lobby-map-select"
                        value={mapSelection}
                        onChange={(e) => setMapSelection(e.target.value as any)}
                        className="w-full bg-slate-950 text-xs font-bold text-slate-300 border border-slate-800 rounded-lg p-2.5 hover:border-slate-700 outline-none capitalize"
                      >
                        <option value="open">🍀 Summer Garden</option>
                        <option value="blocks">❄️ Winter Mountains</option>
                        <option value="arena">🏖️ Sandy Beach</option>
                        <option value="maze">🐫 Egyptian Desert</option>
                      </select>
                      <div className="text-[9px] text-slate-500 italic mt-1 bg-slate-950/30 p-1.5 border border-slate-850 rounded">
                        {mapSelection === 'open' && 'Lush green summer meadow with a center monument.'}
                        {mapSelection === 'blocks' && 'Chilly snowfields packed with ice columns and frosty structures.'}
                        {mapSelection === 'arena' && 'Sun-soaked seaside sand with coral barricades and palms.'}
                        {mapSelection === 'maze' && 'Ancient hot Egyptian valley and deep sandstone pyramids.'}
                      </div>
                    </div>
                  </div>

                  {/* Dual options: Speeds & Round durations */}
                  <div className="grid grid-cols-2 gap-3.5">
                    {/* custom movement speeds */}
                    <div className="space-y-1">
                      <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block label-no-margin flex items-center gap-1">
                        🏃‍♂️ Move Speed
                      </span>
                      <div className="grid grid-cols-2 gap-1.5 text-center">
                        {(['slow', 'normal', 'fast', 'insane'] as const).map((spd) => (
                          <button
                            id={`speed-btn-${spd}`}
                            key={spd}
                            type="button"
                            onClick={() => setSpeed(spd)}
                            className={`py-1.5 rounded text-[10px] font-black uppercase transition shrink-0 ${
                              speed === spd
                                ? 'bg-sky-500 text-slate-950'
                                : 'bg-slate-950/50 text-slate-500 hover:text-slate-350 border border-slate-800 hover:border-slate-750'
                            }`}
                          >
                            {spd}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* specific round durations */}
                    <div className="space-y-1">
                      <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block label-no-margin flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5 text-slate-500" /> Duration
                      </span>
                      <select
                        id="lobby-duration-select"
                        value={duration}
                        onChange={(e) => setDuration(parseInt(e.target.value))}
                        className="w-full bg-slate-950 text-xs font-mono font-bold text-slate-300 border border-slate-800 rounded p-1.5 hover:border-slate-700 outline-none"
                      >
                        <option value={15}>15 seconds</option>
                        <option value={30}>30 seconds</option>
                        <option value={60}>60 seconds (1 Min)</option>
                        <option value={90}>90 seconds</option>
                        <option value={120}>120 seconds (2 Min)</option>
                        <option value={180}>180 seconds (3 Min)</option>
                      </select>
                    </div>
                  </div>
                </div>

                {/* Create Arena Call action button */}
                <button
                  id="create-lobby-submit"
                  type="submit"
                  className="w-full mt-4 bg-sky-600 hover:bg-sky-500 text-slate-950 font-display font-extrabold text-sm py-3 px-4 rounded-xl uppercase tracking-wider transition-all shadow-lg hover:shadow-sky-500/20 active:scale-[0.99] flex items-center justify-center gap-2 cursor-pointer text-white"
                >
                  <Swords className="w-4 h-4" /> Host Multiplayer Lobby <ChevronRight className="w-4 h-4" />
                </button>
              </form>
            ) : (
              /* Tab 2 Content: Join with code */
              <form onSubmit={handleJoinRoom} className="p-5 md:p-6 flex-1 flex flex-col justify-between space-y-6">
                <div className="space-y-4 my-auto">
                  <div className="text-center pb-4">
                    <span className="text-3xl">🔑</span>
                    <h3 className="text-sm font-bold text-slate-200 mt-2">Enter Active Lobby Code</h3>
                    <p className="text-xs text-slate-500 mt-1">Lobby host must share their 4-character room code with you.</p>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block label-no-margin text-center">
                      4-Letter Room Code
                    </label>
                    <input
                      id="room-code-input"
                      type="text"
                      maxLength={4}
                      value={roomCodeInput}
                      onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
                      placeholder="ABCD"
                      className="w-full max-w-[200px] mx-auto block bg-slate-950 border-2 border-slate-800 text-slate-100 font-mono text-2xl font-black text-center tracking-[0.25em] py-3 rounded-xl focus:border-sky-500 outline-none uppercase placeholder-slate-800"
                    />
                  </div>
                </div>

                <button
                  id="join-lobby-submit"
                  type="submit"
                  disabled={roomCodeInput.length !== 4}
                  className="w-full bg-sky-600 hover:bg-sky-500 text-slate-950 font-display font-extrabold text-sm py-3 px-4 rounded-xl uppercase tracking-wider transition-all disabled:opacity-40 disabled:hover:bg-sky-500 active:scale-[0.99] flex items-center justify-center gap-2 cursor-pointer text-white"
                >
                  Enter Combat Arena <ChevronRight className="w-4 h-4" />
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Pre-game staging area: room exists and room.status is 'lobby'
  if (room.status === 'lobby') {
    const isHost = room.hostId === personalId;
    const playersList = Object.values(room.players) as Player[];

    return (
      <div className="min-h-screen bg-slate-950 p-4 md:p-8 select-none font-sans flex flex-col items-center justify-center relative">
        <div className="absolute inset-0 bg-gradient-to-b from-slate-900/40 via-transparent to-transparent pointer-events-none" />

        {/* Global Error message */}
        {error && (
          <div className="w-full max-w-4xl mb-4 bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs px-4 py-2.5 rounded-lg text-center font-semibold font-mono shadow-xl shrink-0">
            ⚠ Warning: {error}
          </div>
        )}

        <div className="w-full max-w-4xl bg-slate-900 border-2 border-slate-800 rounded-2xl shadow-2xl relative overflow-hidden flex flex-col z-10">
          {/* Header Bar */}
          <div className="p-4 md:p-6 bg-slate-950 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-emerald-500 animate-ping" />
              <h1 className="text-xl font-extrabold tracking-tight text-white font-display uppercase">
                Staging Lobby
              </h1>
            </div>

            {/* Room code copy box */}
            <div className="flex items-center gap-2 bg-slate-900 p-1.5 pr-3 border border-slate-800 rounded-xl relative">
              <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider pl-2">Room Code:</span>
              <span className="text-lg font-black font-mono text-cyan-400 select-all">{room.code}</span>
              <button
                id="copy-code-btn"
                onClick={copyRoomCode}
                className="p-1 px-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded text-xs font-mono font-bold flex items-center gap-1 transition select-none cursor-pointer"
              >
                {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>

            {/* Leave lobby option */}
            <button
              id="leave-lobby-btn"
              onClick={leaveRoom}
              className="flex items-center gap-1 text-xs text-rose-400 hover:text-rose-300 bg-rose-950/15 border border-rose-950/40 hover:border-rose-900/60 px-3 py-1.5 rounded-lg font-mono font-bold transition cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" /> Leave Cabin
            </button>
          </div>

          {/* Core Staging Columns */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-0 flex-1">
            
            {/* Host Lobby Config panel */}
            <div className="md:col-span-5 p-5 md:p-6 border-b md:border-b-0 md:border-r border-slate-850 bg-slate-950/20">
              <div className="flex items-center gap-2 mb-4">
                <Settings className="w-4 h-4 text-slate-500" />
                <h3 className="font-bold text-xs uppercase tracking-widest text-slate-400">
                  Arena Configuration
                </h3>
                {!isHost && (
                  <span className="text-[8px] font-bold text-amber-500 bg-amber-500/10 border border-amber-500/20 px-1 rounded uppercase">
                    Read-Only
                  </span>
                )}
              </div>

              {/* Editable options (Host only) */}
              <div className="space-y-4">
                {/* Max Players */}
                <div className="bg-slate-900/40 p-3 rounded-lg border border-slate-800/40">
                  <div className="flex justify-between items-center text-xs mb-1.5">
                    <span className="text-slate-400 font-bold">Max Players (2-16)</span>
                    <span className="font-mono font-extrabold text-sky-400">{maxPlayers} Slots</span>
                  </div>
                  <input
                    id="staging-max-players-slider"
                    type="range"
                    min={2}
                    max={16}
                    disabled={!isHost}
                    value={maxPlayers}
                    onChange={(e) => setMaxPlayers(parseInt(e.target.value))}
                    className="w-full accent-sky-500 disabled:opacity-50"
                  />
                </div>

                {/* Game Mode */}
                <div className="bg-slate-900/40 p-3 rounded-lg border border-slate-800/40">
                  <span className="text-slate-400 font-bold block text-xs mb-1.5">Rule Preset</span>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      id="staging-mode-classic-btn"
                      type="button"
                      disabled={!isHost}
                      onClick={() => setGameMode('classic')}
                      className={`py-2 rounded text-xs font-black transition ${
                        gameMode === 'classic'
                          ? 'bg-sky-500/15 border border-sky-500/40 text-sky-400'
                          : 'bg-slate-950 border border-slate-850 text-slate-500'
                      }`}
                    >
                      Classic Tag
                    </button>
                    <button
                      id="staging-mode-bomb-btn"
                      type="button"
                      disabled={!isHost}
                      onClick={() => setGameMode('bomb')}
                      className={`py-2 rounded text-xs font-black transition ${
                        gameMode === 'bomb'
                          ? 'bg-rose-500/15 border border-rose-500/40 text-rose-400'
                          : 'bg-slate-950 border border-slate-850 text-slate-500'
                      }`}
                    >
                      Hot Bomb
                    </button>
                  </div>
                  <div className="text-[9px] text-slate-500 leading-snug mt-2 text-center">
                    {gameMode === 'classic' 
                      ? '⏱ Score accumulates for chaser survivors. Most points wins!' 
                      : '💥 Hot Potato: Player holding the tick-box explodes when timer runs out!'
                    }
                  </div>
                </div>

                {/* Map Select */}
                <div className="bg-slate-900/40 p-3 rounded-lg border border-slate-800/40">
                  <span className="text-slate-400 font-bold block text-xs mb-1.5">Map Layout</span>
                  <select
                    id="staging-map-select"
                    disabled={!isHost}
                    value={mapSelection}
                    onChange={(e) => setMapSelection(e.target.value as any)}
                    className="w-full bg-slate-950 text-xs font-bold text-slate-350 border border-slate-800 rounded p-2 outline-none capitalize disabled:opacity-60"
                  >
                    <option value="open">🍀 Summer Garden</option>
                    <option value="blocks">❄️ Winter Mountains</option>
                    <option value="arena">🏖️ Sandy Beach</option>
                    <option value="maze">🐫 Egyptian Desert</option>
                  </select>
                </div>

                {/* custom movement speeds */}
                <div className="bg-slate-900/40 p-3 rounded-lg border border-slate-800/40">
                  <span className="text-slate-400 font-bold block text-xs mb-1.5">Runner Base Speeds</span>
                  <div className="grid grid-cols-4 gap-1">
                    {(['slow', 'normal', 'fast', 'insane'] as const).map((spd) => (
                      <button
                        id={`staging-speed-${spd}`}
                        key={spd}
                        disabled={!isHost}
                        onClick={() => setSpeed(spd)}
                        className={`py-1 rounded text-[9px] font-black uppercase transition ${
                          speed === spd
                            ? 'bg-sky-500 text-slate-950 font-bold'
                            : 'bg-slate-950 text-slate-500'
                        }`}
                      >
                        {spd}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Round Duration */}
                <div className="bg-slate-900/40 p-3 rounded-lg border border-slate-800/40">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-slate-400 font-bold">Match Time Limit</span>
                    <span className="font-mono text-slate-300 font-bold">{duration}s</span>
                  </div>
                  <select
                    id="staging-duration-select"
                    disabled={!isHost}
                    value={duration}
                    onChange={(e) => setDuration(parseInt(e.target.value))}
                    className="w-full bg-slate-950 text-xs text-slate-300 border border-slate-800 rounded p-1.5 outline-none disabled:opacity-60"
                  >
                    <option value={15}>15 Seconds</option>
                    <option value={30}>30 Seconds</option>
                    <option value={60}>60 Seconds (1 Min)</option>
                    <option value={90}>90 Seconds</option>
                    <option value={120}>120 Seconds (2 Min)</option>
                    <option value={180}>180 Seconds (3 Min)</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Players List in Lobby & Launch matches controls */}
            <div className="md:col-span-7 p-5 md:p-6 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-4">
                  <h3 className="font-bold text-xs uppercase tracking-widest text-slate-400 flex items-center gap-2">
                    <Users className="w-4 h-4 text-slate-500" /> Connected Runners
                  </h3>
                  <span className="text-[10px] bg-slate-800 text-slate-400 px-2 py-0.5 rounded font-mono font-bold">
                    {playersList.length} Connected
                  </span>
                </div>

                <div className="space-y-2 max-h-[290px] overflow-y-auto pr-1">
                  {playersList.map((player) => {
                    const isSelf = player.id === personalId;
                    const isPlayerHost = player.id === room.hostId;

                    return (
                      <div
                        id={`player-row-${player.id}`}
                        key={player.id}
                        className="flex items-center justify-between p-2.5 bg-slate-950 border border-slate-850 hover:border-slate-800 rounded-xl transition"
                      >
                        <div className="flex items-center gap-3">
                          {/* Avatar Circle with initials */}
                          <div
                            className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-black text-white relative border border-white/10 shrink-0"
                            style={{ backgroundColor: player.color }}
                          >
                            {player.name.substring(0, 2).toUpperCase()}
                            <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-emerald-500 border-2 border-slate-950 rounded-full" />
                          </div>

                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-bold text-slate-200">
                              {player.name}
                            </span>
                            {isSelf && (
                              <span className="text-[9px] font-black uppercase text-sky-450 bg-sky-500/10 border border-sky-500/20 px-1 py-0.5 rounded">
                                You
                              </span>
                            )}
                            {isPlayerHost && (
                              <span className="text-[9px] font-black uppercase text-amber-500 bg-amber-500/10 border border-amber-500/20 px-1 py-0.5 rounded">
                                Host
                              </span>
                            )}
                          </div>
                        </div>

                        <span className="text-[10px] font-mono text-slate-600 uppercase font-black tracking-wider">
                          READY 🟢
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Game Start Launch Call panel */}
              <div className="mt-8 pt-4 border-t border-slate-800 flex flex-col gap-2 select-none">
                {isHost ? (
                  <div className="space-y-2">
                    <button
                      id="start-game-btn"
                      onClick={handleStartGame}
                      disabled={playersList.length < 2}
                      className="w-full bg-emerald-600 hover:bg-emerald-500 hover:scale-[1.01] text-slate-950 font-display font-black tracking-wider text-sm py-3 px-6 rounded-xl uppercase transition shadow-lg hover:shadow-emerald-500/20 disabled:scale-100 disabled:opacity-40 disabled:hover:scale-100 disabled:hover:shadow-none flex items-center justify-center gap-2 cursor-pointer text-white"
                    >
                      🚀 Start Tag Arena Match
                    </button>
                    {playersList.length < 2 ? (
                      <p className="text-center font-mono text-[10px] text-zinc-500 italic">
                        Need at least 2 players in lobby to trigger real-time chase!
                      </p>
                    ) : (
                      <p className="text-center font-mono text-[10px] text-emerald-500/80 uppercase font-extrabold tracking-wider animate-bounce">
                        All runners ready! Trigger and play!
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="bg-slate-950 border border-slate-850 p-4 rounded-xl flex items-center justify-center gap-3 relative text-ellipsis">
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block animate-ping" />
                    <span className="text-xs text-slate-400 font-bold font-sans text-center">
                      Staged. Waiting for Chief Host <span className="text-amber-400 font-mono font-black">({room.players[room.hostId]?.name || 'Host'})</span> to launch the game...
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Active playing match (Staging status is countdown or playing)
  if (room.status === 'countdown' || room.status === 'playing') {
    return (
      <div className="min-h-screen bg-slate-950 px-4 py-3 md:p-6 flex flex-col justify-between select-none relative font-sans overflow-x-hidden">
        
        {/* Floating live feed ticker alert notice bar */}
        {tickerMessage && (
          <div className="fixed top-24 left-1/2 -translate-x-1/2 z-50 bg-slate-950 border-2 border-rose-500/70 text-slate-100 px-6 py-2 rounded-full font-mono text-xs font-black shadow-2xl backdrop-blur-md text-center max-w-md w-[90%] truncate tracking-wide animate-bounce flex items-center justify-center gap-2">
            <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping shrink-0" />
            {tickerMessage}
          </div>
        )}

        {/* HUD Navigation header bar */}
        <div className="w-full max-w-7xl mx-auto flex items-center justify-between bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5 mb-4 shadow-lg shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-lg">👹</span>
            <span className="text-lg font-black tracking-tight text-white font-display uppercase hidden sm:inline-block">Tag Arena Actives</span>
          </div>

          <div className="flex items-center gap-3 font-mono font-bold text-xs bg-slate-950 py-1.5 px-3 rounded-lg border border-slate-850 text-slate-400">
            <span>Room Code: <strong className="text-cyan-400 font-extrabold select-all">{room.code}</strong></span>
          </div>

          <button
            id="abort-match-btn"
            onClick={leaveRoom}
            className="text-xs text-rose-450 bg-rose-500/10 border border-rose-500/20 px-3 py-1.5 hover:bg-rose-500/20 rounded-md font-mono font-bold transition cursor-pointer"
          >
            Leave Match
          </button>
        </div>

        {/* Central Game Workspace: Canvas (Left side) + Scoreboard/Chat logs (Right side) */}
        <div className="flex-1 w-full max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
          
          {/* Canvas column */}
          <div className="lg:col-span-8 flex flex-col justify-center">
            <GameCanvas room={room} personalId={personalId} ws={ws} />
          </div>

          {/* Standings list and feeds Column */}
          <div className="lg:col-span-4 flex flex-col justify-between gap-4 h-full min-h-[460px]">
            {/* Top Half: scoreboard standings */}
            <div className="flex-1">
              <Scoreboard room={room} personalId={personalId} />
            </div>

            {/* Bottom Half: chat feed and reactions logs */}
            <div className="flex-1">
              <ChatBox ws={ws} chatFeed={chatFeed} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // GAME OVER SCORE SUMMARY / PODIUM SCREEN
  if (room.status === 'gameover') {
    const isHost = room.hostId === personalId;
    const sortedStandings = (Object.values(room.players) as Player[]).sort((a, b) => b.score - a.score);
    const winnerPlayer = sortedStandings[0];

    return (
      <div className="min-h-screen bg-slate-950 p-4 md:p-8 select-none font-sans flex flex-col items-center justify-center relative">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-amber-500/5 via-transparent to-transparent pointer-events-none blur-3xl" />

        <div className="w-full max-w-3xl bg-slate-900 border-2 border-slate-800 rounded-3xl shadow-2xl p-6 md:p-8 z-10 flex flex-col items-center text-center relative overflow-hidden">
          
          {/* Decorative glowing background stars */}
          <div className="absolute top-0 left-0 p-4 opacity-10">
            <Award className="w-48 h-48 text-amber-500" />
          </div>

          {/* Winner Trophy Box heading */}
          <div className="mb-6 relative z-10 flex flex-col items-center">
            <div className="w-20 h-20 bg-amber-500/10 border border-amber-500/30 text-amber-400 rounded-full flex items-center justify-center shadow-lg relative mb-4">
              <Trophy className="w-10 h-10 animate-bounce" />
              <span className="absolute -top-1 -right-1 text-2xl">👑</span>
            </div>
            
            <span className="text-[10px] font-black tracking-widest text-amber-400 uppercase font-mono px-3 py-1 bg-amber-950/40 border border-amber-900/60 rounded-full mb-1">
              Arena Champion Victory
            </span>
            <h1 className="text-3xl md:text-4xl font-extrabold text-white uppercase tracking-tight font-display">
              {winnerPlayer ? winnerPlayer.name : 'Unknown User'} Wins!
            </h1>
            <p className="text-xs text-slate-500 mt-1">
              Defeated all opponents with an extraordinary score of{' '}
              <strong className="text-amber-400 font-mono text-sm font-black">{winnerPlayer ? winnerPlayer.score : 0} points!</strong>
            </p>
          </div>

          {/* Full Standings Table */}
          <div className="w-full max-w-lg bg-slate-950/60 border border-slate-800 rounded-xl p-4 mb-6 z-10 text-left select-none">
            <h3 className="font-bold text-xs uppercase tracking-wider text-slate-500 mb-3 font-mono">
              Final scoreboard standings
            </h3>
            <div className="space-y-2 max-h-[180px] overflow-y-auto pr-1">
              {sortedStandings.map((player, idx) => {
                const placingColor = idx === 0 ? 'text-amber-400' : idx === 1 ? 'text-slate-300' : idx === 2 ? 'text-amber-600' : 'text-slate-500';

                return (
                  <div
                    id={`gameover-standing-${player.id}`}
                    key={player.id}
                    className="flex items-center justify-between p-2 rounded bg-slate-900/50 border border-slate-850"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className={`text-sm font-black font-mono w-4 ${placingColor}`}>
                        #{idx + 1}
                      </span>
                      <div className="w-5 h-5 rounded-full" style={{ backgroundColor: player.color }} />
                      <span className="text-xs font-bold text-slate-300 truncate max-w-[150px]">
                        {player.name}
                      </span>
                    </div>

                    <div className="text-right">
                      <span className="text-xs font-black font-mono text-slate-200">{player.score} pts</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Game controls / chat during lobby */}
          <div className="w-full max-w-lg z-10 flex flex-col gap-4 select-none">
            <div className="bg-slate-950 border border-slate-850 rounded-lg p-3">
              <ChatBox ws={ws} chatFeed={chatFeed} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              {/* Reset Play button (Host only) */}
              {isHost ? (
                <button
                  id="play-again-btn"
                  onClick={handleStartGame}
                  className="bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-display font-extrabold text-xs py-3 px-4 rounded-xl uppercase tracking-wider transition-all cursor-pointer text-white shadow-md flex items-center justify-center gap-1.5"
                >
                  🚀 Play Again
                </button>
              ) : (
                <div className="bg-slate-950 border border-slate-850 p-2 text-slate-400 text-center rounded-xl flex items-center justify-center text-[11px] font-sans">
                  ⌛ Waiting for host to trigger next match...
                </div>
              )}

              {/* Exit to Staging */}
              <button
                id="exit-to-lobby-btn"
                onClick={leaveRoom}
                className="bg-slate-800 hover:bg-slate-700 text-slate-200 font-display font-extrabold text-xs py-3 px-4 rounded-xl uppercase tracking-wider transition-all cursor-pointer border border-slate-700"
              >
                🚪 Exit Arena
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
