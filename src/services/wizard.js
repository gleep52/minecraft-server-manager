// @ts-nocheck -- OpenAI-compatible response shapes vary between local servers.
'use strict';

const net = require('node:net');
const dns = require('node:dns').promises;
const db = require('../db');
const secrets = require('./secrets');
const chat = require('./chat');
const httpError = require('../utils/httpError');
const { PLAYER_NAME_RE } = require('../utils/playerName');

const DEFAULT_PROMPT =
  'You are an ancient, playful wizard who lives inside this Minecraft world. ' +
  'Address players by name when natural. Keep every response under 350 characters. ' +
  'You may converse, tell stories, tease gently, and offer Minecraft advice. ' +
  'You cannot perform gameplay actions yet, so never claim that you gave an item, teleported someone, or changed the world.';
const INVOCATION_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const MAX_REPLY = 400;
const HISTORY_MESSAGES = 20;
const REQUEST_TIMEOUT_MS = 30_000;
const inflight = new Set();
const cooldowns = new Map();

function normalizeInvocationName(raw) {
  const name = String(raw || 'wizard').trim();
  if (!INVOCATION_NAME_RE.test(name)) {
    throw httpError(
      400,
      'The invocation name must start with a letter and use only letters, numbers, _ or - (32 characters max)'
    );
  }
  return name;
}

function invocationPattern(name = 'wizard') {
  const escaped = normalizeInvocationName(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^@${escaped}(?:\\s+([\\s\\S]*))?$`, 'i');
}

function assistantLabel(name = 'wizard') {
  const normalized = normalizeInvocationName(name);
  return normalized[0].toUpperCase() + normalized.slice(1);
}

const TRIGGER_RE = invocationPattern('wizard');

function row(serverId) {
  return db.get('SELECT * FROM wizard_configs WHERE server_id = ?', serverId);
}

function getConfig(serverId, { includeSecret = false } = {}) {
  const r = row(serverId);
  const key = r && r.api_key_cipher ? secrets.tryDecrypt(r.api_key_cipher) : null;
  return {
    enabled: Boolean(r && r.enabled),
    baseUrl: (r && r.base_url) || 'http://127.0.0.1:11434',
    model: (r && r.model) || '',
    invocationName: (r && r.invocation_name) || 'wizard',
    systemPrompt: (r && r.system_prompt) || DEFAULT_PROMPT,
    retentionDays: r ? r.retention_days : 7,
    hasApiKey: Boolean(key),
    ...(includeSecret ? { apiKey: key || '' } : {}),
  };
}

function normalizeBaseUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw httpError(400, 'Enter a valid LLM URL, such as http://192.168.1.50:11434');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw httpError(400, 'The LLM URL must use http or https');
  if (u.username || u.password) throw httpError(400, 'Put credentials in the API key field, not in the URL');
  if (u.search || u.hash) throw httpError(400, 'The LLM base URL cannot contain a query string or fragment');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 0 || (a === 169 && b === 254) || a >= 224) {
      throw httpError(400, 'Link-local, unspecified, multicast, and reserved LLM addresses are not allowed');
    }
  } else if (net.isIPv6(host)) {
    const h = host.toLowerCase();
    if (h === '::' || h.startsWith('fe80') || h.startsWith('ff')) {
      throw httpError(400, 'Link-local, unspecified, and multicast LLM addresses are not allowed');
    }
  }
  u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString().replace(/\/$/, '');
}

function openAiBase(baseUrl) {
  return /\/v1$/i.test(baseUrl) ? baseUrl : `${baseUrl}/v1`;
}

function saveConfig(serverId, input, _options = {}) {
  const previous = row(serverId);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const model = String(input.model || '').trim();
  const invocationName = normalizeInvocationName(input.invocationName ?? previous?.invocation_name ?? 'wizard');
  if (input.enabled && !model) throw httpError(400, 'Choose or enter a model before enabling the wizard');
  const retentionDays = Math.max(0, Math.min(3650, Math.trunc(Number(input.retentionDays))));
  const prompt = String(input.systemPrompt || '').trim() || DEFAULT_PROMPT;
  let cipher = previous ? previous.api_key_cipher : null;
  if (input.clearApiKey) cipher = null;
  else if (typeof input.apiKey === 'string' && input.apiKey.trim()) cipher = secrets.encrypt(input.apiKey.trim());
  db.run(
    `INSERT INTO wizard_configs
       (server_id, enabled, base_url, model, api_key_cipher, system_prompt, retention_days, invocation_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(server_id) DO UPDATE SET
       enabled = excluded.enabled, base_url = excluded.base_url, model = excluded.model,
       api_key_cipher = excluded.api_key_cipher, system_prompt = excluded.system_prompt,
       retention_days = excluded.retention_days, invocation_name = excluded.invocation_name,
       updated_at = datetime('now')`,
    serverId,
    input.enabled ? 1 : 0,
    baseUrl,
    model,
    cipher,
    prompt,
    retentionDays,
    invocationName
  );
  pruneTranscripts(serverId);
  return getConfig(serverId);
}

function authHeaders(cfg) {
  return cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
}

function blockedAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || (a === 169 && b === 254) || a >= 224;
  }
  if (net.isIPv6(address)) {
    const h = address.toLowerCase();
    return h === '::' || h.startsWith('fe80') || h.startsWith('ff');
  }
  return true;
}

async function assertAllowedEndpoint(rawUrl) {
  const u = new URL(rawUrl);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addresses = [host];
  if (!net.isIP(host)) {
    try {
      addresses = (await dns.lookup(host, { all: true })).map((r) => r.address);
    } catch {
      throw httpError(502, `Could not resolve LLM host ${host}`);
    }
  }
  if (!addresses.length || addresses.some(blockedAddress)) {
    throw httpError(400, 'The LLM host resolves to a link-local, unspecified, multicast, or reserved address');
  }
}

async function fetchJson(url, options = {}) {
  await assertAllowedEndpoint(url);
  let res;
  try {
    res = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw httpError(502, `Could not reach the LLM server: ${err.message}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body?.error?.message || body?.error || body?.message || `HTTP ${res.status}`;
    throw httpError(502, `LLM server rejected the request: ${String(detail).slice(0, 300)}`);
  }
  return body;
}

async function listModels(serverId, override = {}) {
  const cfg = { ...getConfig(serverId, { includeSecret: true }), ...override };
  cfg.baseUrl = normalizeBaseUrl(cfg.baseUrl);
  const headers = { Accept: 'application/json', ...authHeaders(cfg) };
  try {
    const body = await fetchJson(`${openAiBase(cfg.baseUrl)}/models`, { headers });
    const names = Array.isArray(body?.data) ? body.data.map((m) => m.id).filter(Boolean) : [];
    if (names.length) return [...new Set(names)].sort();
  } catch {
    // Ollama's native model-list endpoint is the compatibility fallback.
  }
  const body = await fetchJson(`${cfg.baseUrl.replace(/\/v1$/i, '')}/api/tags`, { headers });
  return [...new Set((body?.models || []).map((m) => m.name || m.model).filter(Boolean))].sort();
}

async function complete(serverId, player, prompt, { persist = true, override = {} } = {}) {
  const cfg = { ...getConfig(serverId, { includeSecret: true }), ...override };
  if (!cfg.model) throw httpError(409, 'The wizard has no model configured');
  const history = persist && cfg.retentionDays > 0 ? recentConversation(serverId, player) : [];
  const body = await fetchJson(`${openAiBase(normalizeBaseUrl(cfg.baseUrl))}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders(cfg) },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.8,
      max_tokens: 180,
      stream: false,
      messages: [
        { role: 'system', content: cfg.systemPrompt },
        ...history.map((m) => ({ role: m.role, content: m.role === 'user' ? `${m.player}: ${m.content}` : m.content })),
        { role: 'user', content: `${player}: ${prompt}` },
      ],
    }),
  });
  const raw = body?.choices?.[0]?.message?.content;
  if (typeof raw !== 'string' || !raw.trim()) throw httpError(502, 'The LLM returned an empty response');
  return raw
    .replace(/[\r\n\x00-\x1f\x7f]+/g, ' ')
    .trim()
    .slice(0, MAX_REPLY);
}

async function testConnection(serverId, override) {
  return complete(serverId, 'Admin', 'Reply with exactly: The wizard is ready.', {
    persist: false,
    override,
  });
}

function insertTranscript(serverId, player, role, content) {
  const cfg = getConfig(serverId);
  if (cfg.retentionDays <= 0) return;
  const server = db.get('SELECT display_name FROM servers WHERE id = ?', serverId);
  db.run(
    'INSERT INTO wizard_transcripts (server_id, server_name, player, role, content) VALUES (?, ?, ?, ?, ?)',
    serverId,
    (server && server.display_name) || serverId,
    player,
    role,
    String(content).slice(0, 4000)
  );
}

function recentConversation(serverId, player) {
  return db
    .all(
      `SELECT player, role, content FROM wizard_transcripts
       WHERE server_id = ? AND player = ? AND role IN ('user','assistant')
       ORDER BY id DESC LIMIT ?`,
      serverId,
      player,
      HISTORY_MESSAGES
    )
    .reverse();
}

function listTranscripts({ serverId = null, limit = 250 } = {}) {
  const n = Math.max(1, Math.min(2000, Math.trunc(Number(limit)) || 250));
  const rows = serverId
    ? db.all(
        `SELECT t.*, COALESCE(c.invocation_name, 'wizard') AS invocation_name
         FROM wizard_transcripts t LEFT JOIN wizard_configs c ON c.server_id = t.server_id
         WHERE t.server_id = ? ORDER BY t.id DESC LIMIT ?`,
        serverId,
        n
      )
    : db.all(
        `SELECT t.*, COALESCE(c.invocation_name, 'wizard') AS invocation_name
         FROM wizard_transcripts t LEFT JOIN wizard_configs c ON c.server_id = t.server_id
         ORDER BY t.id DESC LIMIT ?`,
        n
      );
  return rows.map((r) => {
    const bot = assistantLabel(r.invocation_name);
    return {
      ...r,
      speaker: r.role === 'user' ? r.player : r.role === 'assistant' ? bot : `${bot} error`,
    };
  });
}

function clearTranscripts(serverId = null) {
  return serverId
    ? db.run('DELETE FROM wizard_transcripts WHERE server_id = ?', serverId)
    : db.run('DELETE FROM wizard_transcripts');
}

function pruneTranscripts(serverId = null) {
  if (serverId) {
    const cfg = getConfig(serverId);
    if (cfg.retentionDays === 0) return db.run('DELETE FROM wizard_transcripts WHERE server_id = ?', serverId);
    return db.run(
      "DELETE FROM wizard_transcripts WHERE server_id = ? AND created_at < datetime('now', ?)",
      serverId,
      `-${cfg.retentionDays} days`
    );
  }
  return db.run(`DELETE FROM wizard_transcripts
    WHERE EXISTS (
      SELECT 1 FROM wizard_configs c
      WHERE c.server_id = wizard_transcripts.server_id
        AND (c.retention_days = 0 OR wizard_transcripts.created_at < datetime('now', '-' || c.retention_days || ' days'))
    )`);
}

async function handleChat(serverId, player, message) {
  const cfg = getConfig(serverId);
  if (!cfg.enabled || !PLAYER_NAME_RE.test(String(player))) return false;
  const match = invocationPattern(cfg.invocationName).exec(String(message || '').trim());
  if (!match) return false;
  const label = assistantLabel(cfg.invocationName);
  const prompt = (match[1] || `Greetings, ${label}.`).trim().slice(0, 1000);
  const key = `${serverId}:${String(player).toLowerCase()}`;
  if (inflight.has(key)) return true;
  const last = cooldowns.get(key) || 0;
  if (Date.now() - last < 3000) return true;
  inflight.add(key);
  cooldowns.set(key, Date.now());
  let exchangeRecorded = false;
  try {
    const reply = await complete(serverId, player, prompt);
    insertTranscript(serverId, player, 'user', prompt);
    insertTranscript(serverId, player, 'assistant', reply);
    exchangeRecorded = true;
    await chat.sendChat(serverId, {
      actor: cfg.invocationName,
      target: '@a',
      text: `[${label}] ${reply}`,
      color: 'light_purple',
      italic: true,
    });
    return true;
  } catch (err) {
    // If delivery failed after a successful completion, the exchange is already
    // retained; do not duplicate the player's line while recording the failure.
    if (!exchangeRecorded) insertTranscript(serverId, player, 'user', prompt);
    insertTranscript(serverId, player, 'error', String(err.message || err));
    console.warn(`[wizard] ${serverId}/${player}: ${err.message}`);
    await chat
      .sendChat(serverId, {
        actor: cfg.invocationName,
        target: player,
        text: `[${label}] The veil is cloudy just now. Ask me again shortly.`,
        color: 'dark_purple',
        italic: true,
      })
      .catch(() => {});
    return true;
  } finally {
    inflight.delete(key);
  }
}

module.exports = {
  DEFAULT_PROMPT,
  TRIGGER_RE,
  INVOCATION_NAME_RE,
  normalizeInvocationName,
  invocationPattern,
  assistantLabel,
  getConfig,
  saveConfig,
  listModels,
  complete,
  testConnection,
  handleChat,
  listTranscripts,
  clearTranscripts,
  pruneTranscripts,
  normalizeBaseUrl,
};
