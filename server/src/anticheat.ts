import { randomInt } from 'node:crypto';
import type { ChatMessage } from '@tide/shared';
import { db, now } from './db.ts';

export const STRIKE_LIMIT = 5;
export const SPEED_CAP = { browser: 150, native: 250, image: Infinity } as const; // tok/s above this is not a real model
export const SPEED_MIN_TOKENS = 20;

export const stripThink = (s: string) => s.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();

/** Cheap sanity check that the output looks like language and not filler. */
export function coherent(text: string): boolean {
  const t = stripThink(text);
  if (!t) return false;
  const repl = (t.match(/�/g) ?? []).length;
  if (repl > 5 && repl / t.length > 0.05) return false;
  if (t.length >= 100) {
    const counts = new Map<string, number>();
    for (const c of t) counts.set(c, (counts.get(c) ?? 0) + 1);
    if (Math.max(...counts.values()) / t.length > 0.6) return false;
  }
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length >= 30 && new Set(words).size / words.length < 0.15) return false;
  return true;
}

// ---------- canaries: prove a node is really running a model ----------
export interface Canary { messages: ChatMessage[]; nonce: string; sum: number }

const TEMPLATES = [
  (a: number, b: number, n: string) => `What is ${a} + ${b}? Reply with the number, then the code word ${n}.`,
  (a: number, b: number, n: string) => `Quick check: add ${a} and ${b}. After the answer, repeat this word exactly: ${n}`,
  (a: number, b: number, n: string) => `Compute ${a} plus ${b} and also echo the token "${n}".`,
  (a: number, b: number, n: string) => `Please give the sum of ${a} and ${b}, followed by the word ${n}.`,
  (a: number, b: number, n: string) => `${a} + ${b} = ? Then write ${n} on its own.`,
  (a: number, b: number, n: string) => `I need two things: the result of ${a}+${b}, and the word ${n} repeated back.`,
];

export function makeCanary(): Canary {
  const a = randomInt(10, 100), b = randomInt(10, 100);
  const letters = 'abcdefghjkmnpqrstuvwxyz';
  const nonce = Array.from({ length: randomInt(4, 7) }, () => letters[randomInt(letters.length)]).join('').toUpperCase();
  const prompt = TEMPLATES[randomInt(TEMPLATES.length)](a, b, nonce);
  return { messages: [{ role: 'user', content: prompt }], nonce, sum: a + b };
}

export function gradeCanary(c: Canary, response: string): boolean {
  const t = stripThink(response);
  return t.toUpperCase().includes(c.nonce) && new RegExp(`(^|[^0-9])${c.sum}([^0-9]|$)`).test(t);
}

// ---------- persistent reputation ----------
function ensure(userId: string) {
  db.prepare('INSERT OR IGNORE INTO node_reputation(user_id, updated_at) VALUES (?, ?)').run(userId, now());
}

export function isBanned(userId: string): boolean {
  return !!(db.prepare('SELECT banned FROM node_reputation WHERE user_id = ?').get(userId) as { banned: number } | undefined)?.banned;
}

export function ban(userId: string, reason: string) {
  ensure(userId);
  db.prepare('UPDATE node_reputation SET banned = 1, ban_reason = ?, updated_at = ? WHERE user_id = ?').run(reason, now(), userId);
}

/** Add a strike; returns true if the account is now banned. */
export function strike(userId: string, reason: string): boolean {
  ensure(userId);
  db.prepare('UPDATE node_reputation SET strikes = strikes + 1, updated_at = ? WHERE user_id = ?').run(now(), userId);
  const s = (db.prepare('SELECT strikes FROM node_reputation WHERE user_id = ?').get(userId) as { strikes: number }).strikes;
  if (s >= STRIKE_LIMIT) { ban(userId, `strikes: ${reason}`); return true; }
  return false;
}

/** Record a canary outcome; returns true if the account got banned. */
export function recordCanary(userId: string, nodeId: string, result: 'pass' | 'fail' | 'neutral'): boolean {
  db.prepare('INSERT INTO canary_results(user_id, node_id, passed, created_at) VALUES (?, ?, ?, ?)').run(
    userId, nodeId, result === 'pass' ? 1 : result === 'fail' ? 0 : -1, now(),
  );
  ensure(userId);
  if (result === 'pass') {
    db.prepare('UPDATE node_reputation SET strikes = MAX(0, strikes - 1), updated_at = ? WHERE user_id = ?').run(now(), userId);
    return false;
  }
  if (result !== 'fail') return false;
  const last = (db.prepare('SELECT passed FROM canary_results WHERE user_id = ? AND passed >= 0 ORDER BY id DESC LIMIT 20').all(userId) as { passed: number }[]).map((r) => r.passed);
  const threeInRow = last.length >= 3 && last.slice(0, 3).every((p) => p === 0);
  const failRatio = last.filter((p) => p === 0).length / last.length;
  if (threeInRow || (last.length >= 8 && failRatio > 0.4)) { ban(userId, 'canary'); return true; }
  return false;
}
