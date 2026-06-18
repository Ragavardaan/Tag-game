import React, { useState, useRef, useEffect } from 'react';
import { ServerMessage } from '../types';

interface ChatBoxProps {
  ws: any;
  chatFeed: Array<{ id: string; name: string; color: string; text: string; timestamp: number }>;
}

const QUICK_EMOJIS = ['😂', '🏃‍♂️', '🎯', '🤪', '🤫', '🔥', '🛡️', '⚡', '❄️', '👀', '💀', '💥'];

export default function ChatBox({ ws, chatFeed }: ChatBoxProps) {
  const [chatText, setChatText] = useState('');
  const feedEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll chat feed
  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatFeed]);

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatText.trim() || !ws) return;

    ws.send(JSON.stringify({ type: 'chat', text: chatText.trim() }));
    setChatText('');
  };

  const handleSendEmoji = (emoji: string) => {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'emoji', emoji }));
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-xl flex flex-col h-full select-none">
      <h3 className="font-bold text-sm tracking-wider text-slate-350 pb-3 border-b border-slate-800 mb-3 uppercase flex items-center gap-1.5 font-sans">
        💬 Live Feed & Actions
      </h3>

      {/* Floating Emojis Fast Dispatch Panel */}
      <div className="mb-4">
        <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider block mb-1.5 label-no-margin">
          Quick Reaction (Floats Over Your Head)
        </label>
        <div className="grid grid-cols-6 gap-1 w-full">
          {QUICK_EMOJIS.map(emoji => (
            <button
              id={`emoji-btn-${emoji}`}
              key={emoji}
              onClick={() => handleSendEmoji(emoji)}
              className="text-base py-1 px-1 bg-slate-950/60 border border-slate-800/80 hover:border-slate-600/80 rounded transition active:scale-90 flex items-center justify-center cursor-pointer"
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>

      {/* Chat Messages Log Feed Container */}
      <div className="flex-1 bg-slate-950/45 border border-slate-800/60 rounded-lg p-3 min-h-[140px] max-h-[220px] overflow-y-auto mb-3 flex flex-col gap-2 font-mono scrollbar-thin">
        {chatFeed.length === 0 ? (
          <div className="text-[11px] text-slate-600 italic text-center my-auto">
            Say something in chat or click reaction!
          </div>
        ) : (
          chatFeed.map((msg, idx) => {
            const timeStr = new Date(msg.timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            });

            const isSystem = msg.name === 'System';

            return (
              <div id={`chat-feed-row-${idx}`} key={msg.id || idx} className="text-xs leading-relaxed break-words">
                <span className="text-[9px] text-slate-500 mr-1.5 select-none font-sans font-medium">{timeStr}</span>
                {isSystem ? (
                  <span className="italic font-sans text-slate-400 font-medium">
                    {msg.text}
                  </span>
                ) : (
                  <>
                    <span className="font-extrabold mr-1.5" style={{ color: msg.color }}>
                      {msg.name}:
                    </span>
                    <span className="text-slate-200">{msg.text}</span>
                  </>
                )}
              </div>
            );
          })
        )}
        <div ref={feedEndRef} />
      </div>

      {/* Text Chat Send Form */}
      <form onSubmit={handleSendChat} className="flex gap-1.5">
        <input
          id="chat-text-input"
          type="text"
          maxLength={40}
          value={chatText}
          onChange={e => setChatText(e.target.value)}
          placeholder="Type message (~40 chars max)..."
          className="flex-1 bg-slate-950 text-xs text-slate-200 px-3 py-2 border border-slate-800 focus:border-sky-500 placeholder-slate-600 rounded-lg outline-none font-mono"
        />
        <button
          id="chat-send-submit"
          type="submit"
          disabled={!chatText.trim()}
          className="bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-40 disabled:hover:bg-sky-600 px-3.5 py-2 text-xs font-bold rounded-lg font-mono tracking-wide transition uppercase cursor-pointer shrink-0"
        >
          Send
        </button>
      </form>
    </div>
  );
}
