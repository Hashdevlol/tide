import type { ChatMessage, Usage } from '@tide/shared';

export type MsgStatus = 'pending' | 'queued' | 'assigned' | 'streaming' | 'done' | 'error' | 'stopped';

export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  model?: string;
  status?: MsgStatus;
  queuePos?: number;
  usage?: Usage;
  truncated?: boolean;
  error?: string;
  errorCode?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMsg[];
  createdAt: number;
  updatedAt: number;
}

export const CHATS_KEY = 'tide_chats_v1';
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function loadChats(): Conversation[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CHATS_KEY) ?? '[]') as Conversation[];
    if (!Array.isArray(raw)) return [];
    // Anything that was mid-flight when the tab closed is over now.
    return raw.map((c) => ({
      ...c,
      messages: (c.messages ?? []).map((m) =>
        m.status && ['pending', 'queued', 'assigned', 'streaming'].includes(m.status)
          ? { ...m, status: m.content ? 'stopped' : 'error', error: m.content ? undefined : 'Interrupted' }
          : m,
      ),
    }));
  } catch {
    return [];
  }
}

export function saveChats(chats: Conversation[]) {
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(chats.slice(0, 200)));
  } catch {
    // Quota exceeded: drop the oldest half and retry once.
    try { localStorage.setItem(CHATS_KEY, JSON.stringify(chats.slice(0, Math.ceil(chats.length / 2)))); } catch { /* give up */ }
  }
}

export const titleFrom = (text: string) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 48 ? t.slice(0, 46) + '…' : t || 'New chat';
};

export interface ThinkSplit {
  segments: { kind: 'think' | 'text'; text: string; open: boolean }[];
}

/** Split `<think>…</think>` blocks out of a response. An unclosed block is still streaming. */
export function splitThink(content: string): ThinkSplit {
  const segments: ThinkSplit['segments'] = [];
  let rest = content;
  while (rest.length) {
    const start = rest.indexOf('<think>');
    if (start < 0) { segments.push({ kind: 'text', text: rest, open: false }); break; }
    if (start > 0) segments.push({ kind: 'text', text: rest.slice(0, start), open: false });
    const after = rest.slice(start + 7);
    const end = after.indexOf('</think>');
    if (end < 0) { segments.push({ kind: 'think', text: after, open: true }); break; }
    segments.push({ kind: 'think', text: after.slice(0, end), open: false });
    rest = after.slice(end + 8);
  }
  return { segments: segments.filter((s) => s.kind === 'text' ? s.text.trim() : s.text.trim() || s.open) };
}

export const stripThink = (s: string) =>
  s.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '').trim();

/** Last 10 turns (20 messages) of finished context, think blocks removed. */
export function buildContext(messages: ChatMsg[]): ChatMessage[] {
  const usable = messages
    .filter((m) => m.role === 'user' || ((m.status === 'done' || m.status === 'stopped') && m.content))
    .map((m) => ({ role: m.role, content: m.role === 'assistant' ? stripThink(m.content) : m.content }))
    .filter((m) => m.content);
  let out = usable.slice(-20);
  while (out.length && out[0].role !== 'user') out = out.slice(1);
  return out;
}
