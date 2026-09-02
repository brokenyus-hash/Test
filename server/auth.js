// Accounts: scrypt password hashing, cookie sessions, login rate limiting, express middleware.
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import * as db from "./db.js";

const COOKIE = "tavern_session";
const SESSION_TTL = 30 * 24 * 3600 * 1000; // 30 days
const attempts = new Map(); // ip -> { n, until }

export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: scryptSync(password, salt, 64).toString("hex") };
}
export function verifyPassword(password, salt, hash) {
  const h = Buffer.from(scryptSync(password, salt, 64).toString("hex"), "hex");
  const stored = Buffer.from(hash, "hex");
  return h.length === stored.length && timingSafeEqual(h, stored);
}
const tokenHash = (t) => createHash("sha256").update(t).digest("hex");

export function validUsername(u) { return typeof u === "string" && /^[a-z0-9_.-]{2,32}$/i.test(u); }
export function validPassword(p) { return typeof p === "string" && p.length >= 6 && p.length <= 200; }

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isSecure(req) {
  return req.secure || (req.headers["x-forwarded-proto"] || "").split(",")[0] === "https";
}

export function issueSession(res, req, userId) {
  const token = randomBytes(32).toString("hex");
  db.sessions.create(tokenHash(token), userId, SESSION_TTL);
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${isSecure(req) ? "; Secure" : ""}`);
}
export function clearSession(res, req) {
  const t = parseCookies(req)[COOKIE];
  if (t) db.sessions.remove(tokenHash(t));
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Populates req.user when a valid session cookie is present. */
export function sessionMiddleware(req, res, next) {
  const t = parseCookies(req)[COOKIE];
  req.user = t ? db.sessions.userFor(tokenHash(t)) : null;
  next();
}
/** 401 for API calls without a user. */
export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Please sign in.", code: "unauthenticated" });
  next();
}

/** Simple per-IP throttle for login/register: 10 attempts per 5 minutes. */
export function throttle(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "?";
  const nowT = Date.now();
  const a = attempts.get(ip) || { n: 0, until: nowT + 5 * 60 * 1000 };
  if (a.until < nowT) { a.n = 0; a.until = nowT + 5 * 60 * 1000; }
  a.n += 1;
  attempts.set(ip, a);
  if (a.n > 10) return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  next();
}

export const publicUser = (u) => (u ? { id: u.id, username: u.username, is_admin: u.is_admin, created_at: u.created_at } : null);
export const signupAllowed = () => (process.env.ALLOW_SIGNUP || "true").toLowerCase() !== "false" || db.users.count() === 0;
