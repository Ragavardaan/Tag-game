import { Room } from '../types';

interface ScoreboardProps {
  room: Room;
  personalId: string;
}

export default function Scoreboard({ room, personalId }: ScoreboardProps) {
  // Sort players by score/survival descending
  const sortedPlayers = Object.values(room.players).sort((a, b) => b.score - a.score);
  const now = Date.now();

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-xl flex flex-col h-full select-none">
      <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-4">
        <h3 className="font-bold text-sm tracking-wider text-slate-350 flex items-center gap-1.5 uppercase font-sans">
          🎯 Arena Standings
        </h3>
        <span className="text-xs bg-slate-800 text-slate-400 font-mono px-2 py-0.5 rounded-full">
          {Object.keys(room.players).length} Players
        </span>
      </div>

      <div className="flex-1 space-y-2.5 overflow-y-auto max-h-[350px] pr-1">
        {sortedPlayers.map((player, index) => {
          const isUser = player.id === personalId;
          const isHost = player.id === room.hostId;
          const isIt = player.isIt;
          const isAlive = player.isAlive;
          
          const isShielded = now < player.shieldUntil;
          const isSpeedBoosted = now < player.speedBoostUntil;
          const isFrozen = now < player.frozenUntil;

          return (
            <div
              id={`scoreboard-row-${player.id}`}
              key={player.id}
              className={`flex items-center justify-between p-3 rounded-lg border transition-all ${
                isIt
                  ? 'bg-rose-950/25 border-rose-800/60 shadow-md shadow-rose-950/20'
                  : 'bg-slate-950/40 border-slate-800/80 hover:border-slate-700/80'
              } ${!isAlive ? 'opacity-40 filter grayscale' : ''}`}
            >
              {/* Left Column: Color tag & Name */}
              <div className="flex items-center gap-3">
                {/* Placement Number */}
                <span className="text-xs font-mono font-bold text-slate-500 w-4">
                  #{index + 1}
                </span>

                {/* Avatar Visual badge */}
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center font-black text-xs border border-white/20 text-white font-sans shrink-0 relative"
                  style={{ backgroundColor: player.color }}
                >
                  {isIt ? '👿' : player.name.substring(0, 2).toUpperCase()}
                  
                  {/* Alive status micro dot */}
                  <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-slate-900 ${isAlive ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                </div>

                {/* Name & Special Tags */}
                <div className="flex flex-col">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className={`text-sm font-bold truncate max-w-[120px] ${isUser ? 'text-sky-400' : 'text-slate-200'}`}>
                      {player.name}
                    </span>
                    {isUser && (
                      <span className="text-[10px] font-black uppercase text-sky-400 bg-sky-500/10 border border-sky-400/20 px-1 py-0 rounded">
                        You
                      </span>
                    )}
                    {isHost && (
                      <span className="text-[10px] font-black uppercase text-amber-400 bg-amber-500/10 border border-amber-400/20 px-1 py-0 rounded">
                        Host
                      </span>
                    )}
                  </div>

                  {/* Active buffs list */}
                  <div className="flex gap-1 mt-1">
                    {player.isIt && (
                      <span className="text-[9px] font-extrabold uppercase tracking-wide bg-rose-500 text-rose-950 px-1.5 rounded">
                        {room.config.mode === 'bomb' ? '💣 Hot Bomb' : '🔴 YOU ARE IT'}
                      </span>
                    )}
                    {isShielded && (
                      <span className="text-[9px] font-extrabold uppercase bg-blue-500 text-blue-950 px-1.5 rounded animate-pulse">
                        🛡️ Shielded
                      </span>
                    )}
                    {isSpeedBoosted && (
                      <span className="text-[9px] font-extrabold uppercase bg-yellow-500 text-yellow-950 px-1.5 rounded animate-pulse">
                        ⚡ Burst
                      </span>
                    )}
                    {isFrozen && (
                      <span className="text-[9px] font-extrabold uppercase bg-cyan-400 text-cyan-950 px-1.5 rounded animate-bounce">
                        ❄️ Frozen
                      </span>
                    )}
                    {!isAlive && (
                      <span className="text-[9px] font-extrabold uppercase bg-slate-700 text-slate-350 px-1.5 rounded">
                        ☠️ Exploded
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Right Column: Points/Timer */}
              <div className="text-right">
                <div className="text-sm font-black font-mono text-slate-250">
                  {player.score} <span className="text-[10px] text-slate-500 font-normal">pts</span>
                </div>
                <div className="text-[10px] text-slate-500 uppercase font-bold tracking-wider">
                  {isAlive ? 'Active' : 'Eliminated'}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      
      {/* Quick guide details below */}
      <div className="mt-4 pt-3 border-t border-slate-800 text-[10px] text-slate-500 leading-normal">
        {room.config.mode === 'classic' ? (
          <div>💡 <strong className="text-slate-400">Classic Chase:</strong> Points accumulate non-stop for survivors. Tagging a target transfers IT. Current IT loses points when caught.</div>
        ) : (
          <div>💡 <strong className="text-slate-400">Hot Bomb:</strong> Random player starts with the bomb. Tag a target to shift it. When the round timer hits 0, the bomb carrier explodes!</div>
        )}
      </div>
    </div>
  );
}
