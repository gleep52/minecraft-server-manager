// @ts-nocheck -- OpenAI-compatible tool-call payloads vary between providers.
'use strict';

const fsp = require('node:fs/promises');
const nbt = require('prismarine-nbt');
const httpError = require('../utils/httpError');
const { PLAYER_NAME_RE } = require('../utils/playerName');
const { dataPath } = require('../storage/pathGuard');
const { execCapture, inspectStatus } = require('../docker/containers');
const { cleanText } = require('../utils/ansi');
const { recordEvent, listEvents } = require('../events');
const servers = require('./servers');
const worlds = require('./worlds');
const players = require('./players');
const inventory = require('./inventory');
const worldControls = require('./worldControls');

const POWER_KEYS = ['heal', 'feed', 'spawn', 'time', 'weather', 'gift'];
const DEFAULT_FLAGS = Object.freeze(Object.fromEntries(POWER_KEYS.map((key) => [key, true])));
const DEFAULT_GIFTS = Object.freeze(['minecraft:bread', 'minecraft:torch', 'minecraft:arrow']);
const ITEM_RE = /^[a-z0-9_.-]+:[a-z0-9_/.-]+$/;
const cooldowns = new Map();

function uniqueStrings(value) {
  const seen = new Set();
  const result = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const item = String(raw || '').trim();
    const key = item.toLowerCase();
    if (item && !seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function normalizeTesters(value) {
  const names = uniqueStrings(value);
  if (names.length > 50) throw httpError(400, 'At most 50 Wizard power testers may be configured');
  if (names.some((name) => !PLAYER_NAME_RE.test(name))) {
    throw httpError(400, 'Power testers must be valid Minecraft player names');
  }
  return names;
}

function normalizeGiftItems(value) {
  const items = uniqueStrings(value).map((item) => item.toLowerCase());
  if (items.length > 100) throw httpError(400, 'At most 100 gift items may be configured');
  if (items.some((item) => !ITEM_RE.test(item))) {
    throw httpError(400, 'Gift items must be namespaced Minecraft item IDs, such as minecraft:bread');
  }
  return items;
}

function normalizeFlags(value = {}) {
  return Object.fromEntries(POWER_KEYS.map((key) => [key, value[key] !== false]));
}

function isTester(cfg, player) {
  const wanted = String(player || '').toLowerCase();
  return cfg.powerTesters.some((name) => name.toLowerCase() === wanted);
}

function toolsFor(cfg, player) {
  if (!cfg.powersEnabled || !isTester(cfg, player)) return [];
  const tools = [];
  const add = (name, description, properties = {}, required = []) =>
    tools.push({
      type: 'function',
      function: {
        name,
        description,
        parameters: { type: 'object', properties, required, additionalProperties: false },
      },
    });
  if (cfg.powerFlags.heal) add('heal_self', 'Restore the requesting player to full health.');
  if (cfg.powerFlags.feed) add('feed_self', 'Restore the requesting player to full hunger and saturation.');
  if (cfg.powerFlags.spawn) add('teleport_self_to_spawn', 'Safely teleport the requesting player to world spawn.');
  if (cfg.powerFlags.time)
    add(
      'set_time',
      'Set this server world time.',
      { value: { type: 'string', enum: ['day', 'noon', 'night', 'midnight'] } },
      ['value']
    );
  if (cfg.powerFlags.weather)
    add('set_weather', 'Set this server weather.', { value: { type: 'string', enum: ['clear', 'rain', 'thunder'] } }, [
      'value',
    ]);
  if (cfg.powerFlags.gift && cfg.giftItems.length)
    add(
      'give_self',
      'Give an allowlisted item to the requesting player.',
      {
        item: { type: 'string', enum: cfg.giftItems },
        count: { type: 'integer', minimum: 1, maximum: cfg.giftMaxCount },
      },
      ['item', 'count']
    );
  return tools;
}

function parseToolCall(message, cfg, player) {
  const calls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (!calls.length) return null;
  if (calls.length > 1) {
    const parsed = calls.map((call) => parseToolCall({ tool_calls: [call] }, cfg, player));
    const signatures = new Set(parsed.map((request) => JSON.stringify([request.name, request.args])));
    if (signatures.size === 1) return parsed[0];
    throw httpError(400, 'The Wizard requested more than one different power at once');
  }
  const call = calls[0];
  const name = String(call?.function?.name || '');
  const allowed = new Set(toolsFor(cfg, player).map((tool) => tool.function.name));
  if (!allowed.has(name)) throw httpError(403, 'The Wizard requested a disabled or unavailable power');
  let args;
  try {
    args =
      typeof call.function.arguments === 'string'
        ? JSON.parse(call.function.arguments || '{}')
        : call.function.arguments || {};
  } catch {
    throw httpError(400, 'The Wizard returned invalid power arguments');
  }
  if (!args || Array.isArray(args) || typeof args !== 'object')
    throw httpError(400, 'The Wizard returned invalid power arguments');
  const keys = Object.keys(args);
  if (['heal_self', 'feed_self', 'teleport_self_to_spawn'].includes(name)) {
    if (keys.length) throw httpError(400, 'This power does not accept arguments');
  } else if (name === 'set_time') {
    if (keys.length !== 1 || !['day', 'noon', 'night', 'midnight'].includes(args.value)) {
      throw httpError(400, 'The Wizard requested an invalid time');
    }
  } else if (name === 'set_weather') {
    if (keys.length !== 1 || !['clear', 'rain', 'thunder'].includes(args.value)) {
      throw httpError(400, 'The Wizard requested invalid weather');
    }
  } else if (name === 'give_self') {
    const item = String(args.item || '').toLowerCase();
    const count = Number(args.count);
    if (
      keys.some((key) => !['item', 'count'].includes(key)) ||
      keys.length !== 2 ||
      !cfg.giftItems.includes(item) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > cfg.giftMaxCount
    ) {
      throw httpError(400, 'The Wizard requested an item or quantity outside the allowlist');
    }
    args = { item, count };
  }
  return { id: String(call.id || ''), name, args };
}

function describe(request) {
  if (request.name === 'heal_self') return 'restore full health';
  if (request.name === 'feed_self') return 'restore full hunger';
  if (request.name === 'teleport_self_to_spawn') return 'teleport to world spawn';
  if (request.name === 'set_time') return `set the time to ${request.args.value}`;
  if (request.name === 'set_weather') return `set the weather to ${request.args.value}`;
  return `give ${request.args.count} × ${request.args.item}`;
}

function recordRejection(serverId, player, reason, request = null) {
  recordEvent({
    serverId,
    actor: `wizard:${player}`,
    type: 'wizard-power',
    summary: `${player}: Wizard power rejected`,
    details: {
      player,
      power: request?.name || null,
      arguments: request?.args || null,
      succeeded: false,
      rejected: true,
      reason: String(reason || 'Rejected').slice(0, 300),
    },
  });
}

async function assertRunning(serverId) {
  const info = await inspectStatus(serverId).catch(() => null);
  if (!info || !['running', 'unhealthy'].includes(info.status))
    throw httpError(409, 'The Minecraft server is not running');
}

async function fixedRcon(serverId, args, player) {
  await assertRunning(serverId);
  const out = cleanText(await execCapture(serverId, ['rcon-cli', ...args])).trim();
  if (/No player was found|No entity was found/i.test(out)) throw httpError(404, `${player} is not online`);
  if (/Unknown or incomplete command|Incorrect argument|Expected |<--\[HERE\]/i.test(out)) {
    throw httpError(502, `The server rejected the power: ${out.slice(0, 200)}`);
  }
  return out;
}

async function worldSpawn(serverId) {
  const server = servers.getServer(serverId);
  if (!server) throw httpError(404, 'Server not found');
  const file = dataPath('servers', serverId, worlds.activeLevelName(server), 'level.dat');
  try {
    const { parsed } = await nbt.parse(await fsp.readFile(file));
    const data = nbt.simplify(parsed).Data || nbt.simplify(parsed);
    const x = Number(data.SpawnX);
    const z = Number(data.SpawnZ);
    if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error('spawn coordinates are missing');
    return { x, z };
  } catch (err) {
    throw httpError(422, `Could not read world spawn: ${err.message}`);
  }
}

async function execute(serverId, player, request, cfg) {
  if (!cfg.powersEnabled || !isTester(cfg, player))
    throw httpError(403, 'This player is not allowed to use Wizard powers');
  if (!PLAYER_NAME_RE.test(String(player))) throw httpError(400, 'Invalid Minecraft player name');
  try {
    request = parseToolCall(
      { tool_calls: [{ function: { name: request?.name, arguments: request?.args || {} } }] },
      cfg,
      player
    );
  } catch (err) {
    recordRejection(serverId, player, err.message, request);
    throw err;
  }
  const key = `${serverId}:${String(player).toLowerCase()}`;
  const remaining = cfg.powerCooldownSec * 1000 - (Date.now() - (cooldowns.get(key) || 0));
  if (remaining > 0) {
    const err = httpError(429, `Wizard powers are recharging for ${Math.ceil(remaining / 1000)} more seconds`);
    recordRejection(serverId, player, err.message, request);
    throw err;
  }

  const action = describe(request);
  const details = { player, power: request.name, arguments: request.args, dryRun: cfg.powersDryRun };
  if (cfg.powersDryRun) {
    recordEvent({
      serverId,
      actor: `wizard:${player}`,
      type: 'wizard-power',
      summary: `Dry run: ${player} would ${action}`,
      details,
    });
    return { dryRun: true, message: `Dry run only: I would ${action}.` };
  }

  try {
    const actor = `wizard:${player}`;
    if (request.name === 'heal_self') {
      await fixedRcon(serverId, ['effect', 'give', player, 'minecraft:instant_health', '1', '10', 'true'], player);
    } else if (request.name === 'feed_self')
      await fixedRcon(serverId, ['effect', 'give', player, 'minecraft:saturation', '1', '10', 'true'], player);
    else if (request.name === 'teleport_self_to_spawn') {
      const spawn = await worldSpawn(serverId);
      await players.withTeleportSlot(serverId, () =>
        players.tpToCoords(serverId, player, { ...spawn, dimension: 'minecraft:overworld' }, { running: true, actor })
      );
    } else if (request.name === 'set_time')
      await worldControls.runQuick(serverId, `time-${request.args.value}`, { actor });
    else if (request.name === 'set_weather')
      await worldControls.runQuick(serverId, `weather-${request.args.value}`, { actor });
    else if (request.name === 'give_self')
      await inventory.giveItem(serverId, player, request.args.item, request.args.count, { actor });
    cooldowns.set(key, Date.now());
    recordEvent({
      serverId,
      actor,
      type: 'wizard-power',
      summary: `${player}: ${action}`,
      details: { ...details, succeeded: true },
    });
    return { dryRun: false, message: `It is done: I ${action}.` };
  } catch (err) {
    recordEvent({
      serverId,
      actor: `wizard:${player}`,
      type: 'wizard-power',
      summary: `${player}: ${action} failed`,
      details: { ...details, succeeded: false, error: String(err.message || err).slice(0, 300) },
    });
    throw err;
  }
}

function listAudit(serverId, limit = 100) {
  return listEvents({ serverId, type: 'wizard-power', limit: Math.max(1, Math.min(500, Number(limit) || 100)) });
}

module.exports = {
  POWER_KEYS,
  DEFAULT_FLAGS,
  DEFAULT_GIFTS,
  normalizeTesters,
  normalizeGiftItems,
  normalizeFlags,
  isTester,
  toolsFor,
  parseToolCall,
  describe,
  recordRejection,
  execute,
  listAudit,
};
