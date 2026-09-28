import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ChatMessage, SubmitAck, Usage } from '@tide/shared';
import { useAuth } from '../lib/auth';
import { api, errMsg } from '../lib/api';
import { getSocket, socketReady, useNetworkStats } from '../lib/socket';
import {
  buildContext, loadChats, saveChats, splitThink, stripThink, titleFrom, uid,
  type ChatMsg, type Conversation, type MsgStatus,
} from '../lib/chatStore';
import type { ModelInfo } from '../lib/types';
import { Markdown } from '../components/Markdown';
import { CopyButton } from '../components/CopyButton';
import { LogoMark } from '../components/Logo';
import { IconArrow, IconChevron, IconMenu, IconPlus, IconRefresh, IconSend, IconStop, IconTrash, IconX } from '../components/Icons';
import { fmtInt, timeAgo } from '../lib/format';
import { PENDING_PROMPT_KEY } from './Home';

const MODEL_KEY = 'tide_model';
const THINK_KEY = 'tide_think';
const ACTIVE_KEY = 'tide_chat_active';
const CONTINUE_PROMPT = 'Continue exactly where you left off. Do not repeat what you already wrote.';

const SUGGESTIONS = [
  { t: 'Explain', d: 'how ocean tides actually work, simply' },
  { t: 'Write', d: 'a Python script that renames photos by date taken' },
  { t: 'Compare', d: 'SQLite vs Postgres for a side project' },
  { t: 'Plan', d: 'a 3-day trip to Lisbon on a budget' },
];

interface ActiveJob { jobId?: string; convId: string; msgId: string; append: boolean }

export default function Chat() {
  const { me, signedIn, ensureSession, refresh, openSignIn } = useAuth();
  const stats = useNetworkStats();
  const [chats, setChats] = useState<Conversation[]>(() => loadChats());
  const [activeId, setActiveId] = useState<string | null>(() => {
    const id = localStorage.getItem(ACTIVE_KEY);
    return id && loadChats().some((c) => c.id === id) ? id : null;
  });
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState<string>(() => localStorage.getItem(MODEL_KEY) ?? '');
  const [think, setThink] = useState(() => localStorage.getItem(THINK_KEY) === '1');
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [sideOpen, setSideOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [job, setJob] = useState<ActiveJob | null>(null);
  const jobRef = useRef<ActiveJob | null>(null);
  jobRef.current = job;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const active = chats.find((c) => c.id === activeId) ?? null;
  const busy = !!job;

  // ---------------------------------------------------------------- persistence
  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  useEffect(() => {
    const t = setTimeout(() => saveChats(chats), 300);
    return () => clearTimeout(t);
  }, [chats]);
  useEffect(() => {
    // Flush pending writes when the tab is hidden/closed or the page unmounts.
    const flush = () => saveChats(chatsRef.current);
    addEventListener('pagehide', flush);
    return () => { removeEventListener('pagehide', flush); flush(); };
  }, []);
  useEffect(() => {
    if (activeId) localStorage.setItem(ACTIVE_KEY, activeId);
    else localStorage.removeItem(ACTIVE_KEY);
  }, [activeId]);
  useEffect(() => { localStorage.setItem(THINK_KEY, think ? '1' : '0'); }, [think]);

  // ---------------------------------------------------------------- models
  const loadModels = useCallback(async () => {
    try {
      const r = await api<{ data: ModelInfo[] }>('/v1/models', { token: null });
      setModels(r.data);
    } catch { /* keep last list */ }
  }, []);
  useEffect(() => {
    loadModels();
    const t = setInterval(loadModels, 20_000);
    return () => clearInterval(t);
  }, [loadModels]);
  const statsKey = stats ? JSON.stringify(stats.byModel) : '';
  useEffect(() => { if (statsKey) loadModels(); }, [statsKey, loadModels]);

  useEffect(() => {
    if (!models.length) return;
    const cur = models.find((m) => m.id === model);
    if (cur?.available) return;
    const pick = models.find((m) => m.available) ?? cur ?? models[0];
    if (pick && pick.id !== model) setModel(pick.id);
  }, [models, model]);
  const selectModel = (id: string) => {
    setModel(id);
    localStorage.setItem(MODEL_KEY, id);
    setPickerOpen(false);
  };
  const current = models.find((m) => m.id === model);

  // ---------------------------------------------------------------- message helpers
  const patchMsg = useCallback((convId: string, msgId: string, fn: (m: ChatMsg) => ChatMsg) => {
    setChats((cs) => cs.map((c) => (c.id !== convId ? c : {
      ...c,
      updatedAt: Date.now(),
      messages: c.messages.map((m) => (m.id === msgId ? fn(m) : m)),
    })));
  }, []);

  const finish = useCallback((status: MsgStatus, extra: Partial<ChatMsg> = {}) => {
    const j = jobRef.current;
    if (!j) return;
    patchMsg(j.convId, j.msgId, (m) => ({ ...m, status, queuePos: undefined, ...extra }));
    jobRef.current = null;
    setJob(null);
    refresh();
  }, [patchMsg, refresh]);

  // ---------------------------------------------------------------- socket events
  useEffect(() => {
    const s = getSocket();
    const mine = (jobId: string) => jobRef.current?.jobId === jobId ? jobRef.current : null;
    const onToken = ({ jobId, token }: { jobId: string; token: string }) => {
      const j = mine(jobId);
      if (j) patchMsg(j.convId, j.msgId, (m) => ({ ...m, status: 'streaming', queuePos: undefined, content: m.content + token }));
    };
    const onQueue = ({ jobId, position }: { jobId: string; position: number }) => {
      const j = mine(jobId);
      if (j) patchMsg(j.convId, j.msgId, (m) => (m.status === 'streaming' ? m : { ...m, status: 'queued', queuePos: position }));
    };
    const onAssigned = ({ jobId }: { jobId: string }) => {
      const j = mine(jobId);
      if (j) patchMsg(j.convId, j.msgId, (m) => (m.status === 'streaming' ? m : { ...m, status: 'assigned', queuePos: undefined }));
    };
    const onComplete = (r: { jobId: string; response: string; usage: Usage; truncated: boolean }) => {
      const j = mine(r.jobId);
      if (!j) return;
      patchMsg(j.convId, j.msgId, (m) => {
        const prev = j.append ? m.usage : undefined;
        const usage = prev
          ? { inputTokens: prev.inputTokens + r.usage.inputTokens, outputTokens: prev.outputTokens + r.usage.outputTokens, credits: prev.credits + r.usage.credits }
          : r.usage;
        // If no tokens streamed (rare), fall back to the final response text.
        const content = m.content || r.response || '';
        return { ...m, content, usage, truncated: r.truncated };
      });
      finish('done');
    };
    const onError = ({ jobId, error, code }: { jobId: string; error: string; code?: string }) => {
      if (!mine(jobId)) return;
      if (code === 'ABORTED') finish('stopped');
      else finish('error', { error, errorCode: code });
    };
    s.on('job:token', onToken);
    s.on('queue:position', onQueue);
    s.on('job:assigned', onAssigned);
    s.on('job:complete', onComplete);
    s.on('job:error', onError);
    const onDisconnect = () => {
      // The server aborts a disconnected client's jobs.
      if (jobRef.current?.jobId) finish('error', { error: 'Connection lost — the answer was interrupted.', errorCode: 'DISCONNECTED' });
    };
    s.on('disconnect', onDisconnect);
    return () => {
      s.off('job:token', onToken);
      s.off('queue:position', onQueue);
      s.off('job:assigned', onAssigned);
      s.off('job:complete', onComplete);
      s.off('job:error', onError);
      s.off('disconnect', onDisconnect);
    };
  }, [patchMsg, finish]);

  // Stop the running job if the user leaves the page.
  useEffect(() => () => {
    const j = jobRef.current;
    if (j?.jobId) getSocket().emit('job:abort', { jobId: j.jobId });
  }, []);

  // ---------------------------------------------------------------- run a job
  const runJob = useCallback(async (convId: string, msgId: string, messages: ChatMessage[], append: boolean, useModel: string) => {
    const j: ActiveJob = { convId, msgId, append };
    jobRef.current = j;
    setJob(j);
    stick.current = true;
    try {
      await ensureSession();
      const s = await socketReady();
      const ack = (await s.timeout(20_000).emitWithAck('job:submit', { messages, model: useModel, think })) as SubmitAck;
      if (jobRef.current !== j) return; // stopped meanwhile
      if ('error' in ack) {
        if (ack.code === 'FREE_EXHAUSTED') openSignIn('You have used your free prompts. Sign in with a Solana wallet to keep chatting — Free accounts get a daily credit grant.');
        finish('error', { error: ack.error, errorCode: ack.code });
        return;
      }
      j.jobId = ack.jobId;
      patchMsg(convId, msgId, (m) => (m.status === 'pending' ? { ...m, status: 'queued' } : m));
    } catch (e) {
      if (jobRef.current === j) finish('error', { error: errMsg(e) === 'operation has timed out' ? 'The network did not respond. Try again.' : errMsg(e) });
    }
  }, [ensureSession, think, openSignIn, finish, patchMsg]);

  const send = useCallback((text: string, forceNew = false) => {
    const content = text.trim();
    if (!content || jobRef.current || !model) return;
    const now = Date.now();
    const userMsg: ChatMsg = { id: uid(), role: 'user', content, createdAt: now };
    const asst: ChatMsg = { id: uid(), role: 'assistant', content: '', createdAt: now, model, status: 'pending' };
    let conv = forceNew ? undefined : chats.find((c) => c.id === activeId);
    let history: ChatMsg[];
    if (!conv) {
      conv = { id: uid(), title: titleFrom(content), messages: [userMsg, asst], createdAt: now, updatedAt: now };
      history = [userMsg];
      const created = conv;
      setChats((cs) => [created, ...cs]);
      setActiveId(created.id);
    } else {
      history = [...conv.messages, userMsg];
      const id = conv.id;
      setChats((cs) => cs.map((c) => (c.id === id ? { ...c, messages: [...c.messages, userMsg, asst], updatedAt: now } : c)));
    }
    setInput('');
    runJob(conv.id, asst.id, buildContext(history), false, model);
  }, [chats, activeId, model, runJob]);

  const stop = () => {
    const j = jobRef.current;
    if (!j) return;
    if (j.jobId) getSocket().emit('job:abort', { jobId: j.jobId });
    else finish('stopped');
  };

  const regenerate = () => {
    if (!active || busy || !model) return;
    const idx = active.messages.length - 1;
    const last = active.messages[idx];
    if (last?.role !== 'assistant') return;
    const history = active.messages.slice(0, idx);
    patchMsg(active.id, last.id, (m) => ({ ...m, content: '', status: 'pending', usage: undefined, truncated: false, error: undefined, errorCode: undefined, model }));
    runJob(active.id, last.id, buildContext(history), false, model);
  };

  const continueMsg = (m: ChatMsg) => {
    if (!active || busy) return;
    const idx = active.messages.findIndex((x) => x.id === m.id);
    const ctx = buildContext(active.messages.slice(0, idx + 1));
    ctx.push({ role: 'user', content: CONTINUE_PROMPT });
    patchMsg(active.id, m.id, (x) => ({ ...x, status: 'pending', truncated: false }));
    runJob(active.id, m.id, ctx, true, m.model ?? model);
  };

  // Pending prompt from the landing page.
  const pendingDone = useRef(false);
  useEffect(() => {
    if (pendingDone.current || !models.length || !model) return;
    const p = sessionStorage.getItem(PENDING_PROMPT_KEY);
    pendingDone.current = true;
    if (!p) return;
    sessionStorage.removeItem(PENDING_PROMPT_KEY);
    sendRef.current(p, true);
  }, [models, model]);
  const sendRef = useRef(send);
  sendRef.current = send;

  // ---------------------------------------------------------------- conversations
  const newChat = () => {
    if (busy) stop();
    setActiveId(null);
    setSideOpen(false);
    setTimeout(() => taRef.current?.focus(), 0);
  };
  const openChat = (id: string) => {
    if (busy && id !== activeId) stop();
    setActiveId(id);
    setSideOpen(false);
    stick.current = true;
  };
  const deleteChat = (id: string) => {
    if (!confirm('Delete this conversation?')) return;
    if (busy && jobRef.current?.convId === id) stop();
    setChats((cs) => cs.filter((c) => c.id !== id));
    if (activeId === id) setActiveId(null);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!q) return list;
    return list.filter((c) => c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)));
  }, [chats, search]);
  const grouped = useMemo(() => {
    const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
    const week = startToday.getTime() - 6 * 86_400_000;
    const g: { label: string; items: Conversation[] }[] = [
      { label: 'Today', items: [] }, { label: 'Previous 7 days', items: [] }, { label: 'Older', items: [] },
    ];
    for (const c of filtered) g[c.updatedAt >= startToday.getTime() ? 0 : c.updatedAt >= week ? 1 : 2].items.push(c);
    return g.filter((x) => x.items.length);
  }, [filtered]);

  // ---------------------------------------------------------------- scrolling
  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [active?.messages]);

  // Composer autosize
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
  }, [input]);

  const lastAssistantId = active?.messages.at(-1)?.role === 'assistant' ? active.messages.at(-1)!.id : null;

  // ---------------------------------------------------------------- quota line
  const quota = (() => {
    if (!me) return <span><b>5</b> free prompts · no sign-up</span>;
    if (me.user.kind === 'anon') {
      return <span><b>{me.freePrompts.remaining}</b>/{me.freePrompts.limit} free prompts left{me.freePaused ? ' · free lane paused' : ''}</span>;
    }
    return (
      <>
        {me.plan.id === 'free' && me.freePrompts.remaining > 0 && <span><b>{me.freePrompts.remaining}</b> free prompts</span>}
        {me.grant && <span>grant <b>{fmtInt(me.grant.remaining)}</b>/{fmtInt(me.grant.total)}</span>}
        <span>credits <b>{fmtInt(me.credits)}</b></span>
      </>
    );
  })();

  const canSend = !!input.trim() && !busy && !!model;

  return (
    <div className="chat-app">
      <div className={`sidebar-backdrop${sideOpen ? ' open' : ''}`} onClick={() => setSideOpen(false)} />
      <aside className={`sidebar${sideOpen ? ' open' : ''}`} aria-label="Conversations">
        <div className="sidebar-top">
          <div className="row-between">
            <button className="btn btn-foam btn-sm grow" onClick={newChat}><IconPlus width={15} height={15} /> New chat</button>
            <button className="icon-btn show-sm" onClick={() => setSideOpen(false)} aria-label="Close sidebar"><IconX /></button>
          </div>
          <div className="sidebar-search">
            <input className="input" placeholder="Search chats" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search chats" />
          </div>
        </div>
        <div className="conv-list">
          {grouped.map((g) => (
            <div key={g.label}>
              <div className="conv-group">{g.label}</div>
              {g.items.map((c) => (
                <div key={c.id} className={`conv-item${c.id === activeId ? ' active' : ''}`}>
                  <button className="t" onClick={() => openChat(c.id)} title={c.title}>{c.title}</button>
                  <button className="icon-btn" onClick={() => deleteChat(c.id)} aria-label="Delete conversation"><IconTrash /></button>
                </div>
              ))}
            </div>
          ))}
          {!filtered.length && <div className="empty small">{search ? 'No matches' : 'No conversations yet'}</div>}
        </div>
        <div className="sidebar-foot muted">
          {signedIn
            ? <Link to="/settings#credits" className="link">Credits &amp; plan →</Link>
            : <button className="link" onClick={() => openSignIn()}>Sign in to keep going →</button>}
          <div className="tiny dim" style={{ marginTop: 6 }}>Chats are stored only in this browser.</div>
        </div>
      </aside>

      <main className="chat-main">
        <div className="chat-top">
          <button className="icon-btn show-sm" onClick={() => setSideOpen(true)} aria-label="Open conversations"><IconMenu /></button>
          <div className="model-pick">
            <button className="model-btn" onClick={() => setPickerOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={pickerOpen}>
              <span className={`dot${current?.available ? '' : ' off'}`} />
              <span className="nm">{current?.name ?? (models.length ? 'Pick a model' : 'Loading…')}</span>
              <IconChevron width={14} height={14} />
            </button>
            {pickerOpen && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 29 }} onClick={() => setPickerOpen(false)} />
                <div className="model-menu" role="listbox">
                  {models.map((m) => (
                    <button key={m.id} className={`model-opt${m.id === model ? ' sel' : ''}`} disabled={m.nodes === 0} onClick={() => selectModel(m.id)} role="option" aria-selected={m.id === model}>
                      <span className={`dot${m.available ? '' : ' off'}`} />
                      <span className="grow">
                        <b>{m.name} <span className="mono dim tiny">{m.id}</span></b>
                        <small>{m.description}</small>
                        <small className="mono" style={{ marginTop: 4, color: m.nodes ? 'var(--foam)' : 'var(--muted)' }}>
                          {m.nodes ? `${m.nodes} node${m.nodes === 1 ? '' : 's'} online` : 'no nodes online'}
                        </small>
                      </span>
                    </button>
                  ))}
                  {!models.length && <div className="empty small">Loading models…</div>}
                </div>
              </>
            )}
          </div>
          <button className={`toggle${think ? ' on' : ''}`} onClick={() => setThink((t) => !t)} aria-pressed={think} title="Let the model reason before answering">
            <span className="sw" /> Think
          </button>
          <div className="title hide-sm" style={{ textAlign: 'right' }}>{active?.title ?? ''}</div>
        </div>

        {active && active.messages.length ? (
          <div className="messages" ref={scroller} onScroll={onScroll}>
            <div className="messages-inner">
              {active.messages.map((m) => m.role === 'user' ? (
                <div key={m.id} className="msg user"><div className="bubble">{m.content}</div></div>
              ) : (
                <AssistantMessage
                  key={m.id}
                  m={m}
                  modelName={models.find((x) => x.id === m.model)?.name ?? m.model ?? 'Tide'}
                  isLast={m.id === lastAssistantId}
                  busy={busy}
                  onRegenerate={regenerate}
                  onContinue={() => continueMsg(m)}
                  onSignIn={() => openSignIn()}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="welcome">
            <LogoMark size={48} />
            <h1>What should the network <em>think</em> about?</h1>
            <p className="muted">
              {stats ? `${fmtInt(stats.nodesOnline)} node${stats.nodesOnline === 1 ? '' : 's'} online` : 'Connecting…'} · prompts are never stored
            </p>
            <div className="suggest">
              {SUGGESTIONS.map((s) => (
                <button key={s.t} onClick={() => send(`${s.t} ${s.d}`)} disabled={!model || busy}><b>{s.t}</b>{s.d}</button>
              ))}
            </div>
          </div>
        )}

        <div className="composer-wrap">
          {current && !current.available && (
            <div className="chat-banner notice warn">
              <span>No nodes are serving {current.name} right now — <Link className="link" to="/earn">run one on the Earn page</Link>.</span>
            </div>
          )}
          <form className="composer" onSubmit={(e) => { e.preventDefault(); send(input); }}>
            <textarea
              ref={taRef}
              rows={1}
              value={input}
              placeholder={current ? `Message ${current.name}…` : 'Message Tide…'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send(input);
                }
              }}
              aria-label="Message"
              autoFocus
            />
            <div className="composer-bar">
              <div className="quota">{quota}</div>
              {busy ? (
                <button type="button" className="send-btn stop" onClick={stop} aria-label="Stop generating"><IconStop /></button>
              ) : (
                <button type="submit" className="send-btn" disabled={!canSend} aria-label="Send"><IconSend /></button>
              )}
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}

function AssistantMessage({ m, modelName, isLast, busy, onRegenerate, onContinue, onSignIn }: {
  m: ChatMsg; modelName: string; isLast: boolean; busy: boolean;
  onRegenerate(): void; onContinue(): void; onSignIn(): void;
}) {
  const live = m.status === 'pending' || m.status === 'queued' || m.status === 'assigned' || m.status === 'streaming';
  const { segments } = splitThink(m.content);
  const answer = stripThink(m.content);

  return (
    <div className="msg assistant">
      <div className="who"><LogoMark size={20} /> {modelName}</div>

      {segments.map((s, i) => s.kind === 'think' ? (
        <details key={i} className="think" open={live && s.open ? true : undefined}>
          <summary>{live && s.open ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Thinking…</> : 'Thought process'}</summary>
          <div className="think-body"><Markdown text={s.text.trim()} /></div>
        </details>
      ) : (
        <Markdown key={i} text={s.text} />
      ))}

      {live && !m.content && (
        <div className="msg-status">
          {m.status === 'queued' && m.queuePos ? <>Queued #{m.queuePos} — waiting for a free node</>
            : m.status === 'assigned' ? <><span className="typing"><i /><i /><i /></span> Node found</>
            : <><span className="typing"><i /><i /><i /></span> {m.status === 'pending' ? 'Sending…' : 'Finding a node…'}</>}
        </div>
      )}
      {live && m.content && <span className="cursor" />}

      {m.status === 'error' && <ErrorNote m={m} onSignIn={onSignIn} />}
      {m.status === 'stopped' && <div className="tiny dim mono">Stopped</div>}

      {!live && (m.status === 'done' || m.status === 'stopped' || m.status === 'error') && (
        <div className="msg-actions">
          {answer && <CopyButton text={answer} />}
          {isLast && <button className="icon-btn" onClick={onRegenerate} disabled={busy} title="Regenerate" aria-label="Regenerate"><IconRefresh /></button>}
          {m.truncated && isLast && (
            <button className="btn btn-ghost btn-xs" onClick={onContinue} disabled={busy}>Continue <IconArrow width={12} height={12} /></button>
          )}
          {m.usage && (
            <span className="usage">
              {fmtInt(m.usage.inputTokens)} in · {fmtInt(m.usage.outputTokens)} out · {fmtInt(m.usage.credits)} credit{m.usage.credits === 1 ? '' : 's'}
            </span>
          )}
          {!m.usage && <span className="usage">{timeAgo(m.createdAt)}</span>}
        </div>
      )}
    </div>
  );
}

function ErrorNote({ m, onSignIn }: { m: ChatMsg; onSignIn(): void }) {
  switch (m.errorCode) {
    case 'FREE_EXHAUSTED':
      return <div className="notice warn msg-error"><span>{m.error} <button className="link" onClick={onSignIn}>Sign in →</button></span></div>;
    case 'INSUFFICIENT_CREDITS':
      return <div className="notice warn msg-error"><span>{m.error}. <Link className="link" to="/settings#credits">Add credits or upgrade →</Link></span></div>;
    case 'NO_CAPACITY':
      return <div className="notice warn msg-error"><span>No nodes serving this model — <Link className="link" to="/earn">run one on the Earn page</Link>.</span></div>;
    case 'RATE_LIMIT':
      return <div className="notice warn msg-error"><span>{m.error}. Try again in a minute.</span></div>;
    default:
      return <div className="notice danger msg-error"><span>{m.error ?? 'Something went wrong.'}</span></div>;
  }
}
