import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { NetworkStats, NodeStatus } from '@tide/shared';
import { getToken, onTokenChange } from './api';

let socket: Socket | null = null;
let lastToken: string | null = null;

/** Singleton socket. The auth callback reads the current token on every (re)connect. */
export function getSocket(): Socket {
  if (!socket) {
    lastToken = getToken();
    socket = io({
      transports: ['websocket'],
      auth: (cb) => cb({ token: getToken() ?? undefined }),
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
    });
    socket.on('stats:update', (s: NetworkStats) => { lastStats = s; statsSubs.forEach((f) => f(s)); });
    socket.on('node:status', (n: NodeStatus[]) => { lastNodes = n; nodeSubs.forEach((f) => f(n)); });
    onTokenChange((t) => {
      if (t === lastToken) return;
      lastToken = t;
      lastNodes = [];
      nodeSubs.forEach((f) => f([]));
      socket!.disconnect().connect();
    });
  }
  return socket;
}

/** Resolve once the socket is connected (with whatever token is current). */
export function socketReady(timeoutMs = 10_000): Promise<Socket> {
  const s = getSocket();
  if (s.connected) return Promise.resolve(s);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { s.off('connect', ok); reject(new Error('Could not reach the Tide network')); }, timeoutMs);
    const ok = () => { clearTimeout(t); resolve(s); };
    s.once('connect', ok);
    if (!s.active) s.connect();
  });
}

let lastStats: NetworkStats | null = null;
let lastNodes: NodeStatus[] = [];
const statsSubs = new Set<(s: NetworkStats) => void>();
const nodeSubs = new Set<(n: NodeStatus[]) => void>();

export function useNetworkStats(): NetworkStats | null {
  const [stats, setStats] = useState<NetworkStats | null>(lastStats);
  useEffect(() => {
    getSocket();
    statsSubs.add(setStats);
    if (!lastStats) {
      fetch('/api/stats').then((r) => r.json()).then((s: NetworkStats) => { if (!lastStats) { lastStats = s; setStats(s); } }).catch(() => {});
    }
    return () => { statsSubs.delete(setStats); };
  }, []);
  return stats;
}

export function useNodeStatus(): NodeStatus[] {
  const [nodes, setNodes] = useState<NodeStatus[]>(lastNodes);
  useEffect(() => {
    getSocket();
    nodeSubs.add(setNodes);
    return () => { nodeSubs.delete(setNodes); };
  }, []);
  return nodes;
}

export function useSocketConnected(): boolean {
  const [c, setC] = useState(() => getSocket().connected);
  useEffect(() => {
    const s = getSocket();
    const on = () => setC(true), off = () => setC(false);
    s.on('connect', on); s.on('disconnect', off);
    setC(s.connected);
    return () => { s.off('connect', on); s.off('disconnect', off); };
  }, []);
  return c;
}
