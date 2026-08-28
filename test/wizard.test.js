'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app');
const db = require('../src/db');
const auth = require('../src/services/auth');
const wizard = require('../src/services/wizard');
const wizardPowers = require('../src/services/wizardPowers');

let adminCookie;
let operatorCookie;
let viewerCookie;
const serverId = 'srv_wizard01';

async function login(username, password, role) {
  auth.createUser({ username, password, role }, { actor: 'test' });
  const r = await app.req('POST', '/login', { body: { username, password } });
  return (r.setCookie || []).map((c) => c.split(';')[0]).join('; ');
}

test.before(async () => {
  await app.start();
  adminCookie = await app.adminCookie();
  operatorCookie = await login('wizardop', 'operatorpass123', 'operator');
  viewerCookie = await login('wizardviewer', 'viewerpass123', 'viewer');
  app.seedServer(serverId);
});

test.after(async () => {
  await app.stop();
});

test('wizard configuration and transcripts are admin-only', async () => {
  for (const cookie of [viewerCookie, operatorCookie]) {
    assert.equal((await app.req('GET', `/api/servers/${serverId}/wizard`, { cookie })).status, 403);
    assert.equal((await app.req('GET', `/api/servers/${serverId}/wizard/transcripts`, { cookie })).status, 403);
    assert.equal((await app.req('GET', `/api/servers/${serverId}/wizard/powers/audit`, { cookie })).status, 403);
    assert.equal((await app.req('GET', '/wizard-transcripts', { cookie })).status, 403);
  }
  assert.equal((await app.req('GET', `/api/servers/${serverId}/wizard`, { cookie: adminCookie })).status, 200);
  assert.equal((await app.req('GET', '/wizard-transcripts', { cookie: adminCookie })).status, 200);

  const adminPage = await app.req('GET', `/servers/${serverId}/integrations`, { cookie: adminCookie });
  const operatorPage = await app.req('GET', `/servers/${serverId}/integrations`, { cookie: operatorCookie });
  assert.match(adminPage.text, /Wizard chatbot/);
  assert.match(adminPage.text, /Refresh this server's transcripts/);
  assert.match(adminPage.text, /Refresh power audit/);
  const giftTextarea = /id="ig-wz-gifts">([\s\S]*?)<\/textarea>/.exec(adminPage.text);
  assert.ok(giftTextarea);
  assert.deepEqual(giftTextarea[1].replaceAll('&#10;', '\n').split('\n'), [
    'minecraft:bread',
    'minecraft:torch',
    'minecraft:arrow',
  ]);
  assert.doesNotMatch(operatorPage.text, /Wizard chatbot/);
});

test('per-server config encrypts the API key and defaults retention to seven days', async () => {
  const initial = await app.req('GET', `/api/servers/${serverId}/wizard`, { cookie: adminCookie });
  assert.equal(initial.json.wizard.retentionDays, 7);
  assert.equal(initial.json.wizard.invocationName, 'wizard');
  assert.equal(initial.json.wizard.powersEnabled, false);
  assert.equal(initial.json.wizard.powersDryRun, true);

  const saved = await app.req('POST', `/api/servers/${serverId}/wizard`, {
    cookie: adminCookie,
    body: {
      enabled: true,
      baseUrl: 'http://192.168.1.50:11434',
      model: 'llama3.2:latest',
      invocationName: 'bubba',
      apiKey: 'not-plaintext-in-db',
      systemPrompt: 'You are the test wizard.',
      retentionDays: 14,
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.wizard.hasApiKey, true);
  assert.equal(Object.hasOwn(saved.json.wizard, 'apiKey'), false);
  const stored = db.get('SELECT * FROM wizard_configs WHERE server_id = ?', serverId);
  assert.notEqual(stored.api_key_cipher, 'not-plaintext-in-db');
  assert.equal(stored.invocation_name, 'bubba');
  assert.equal(wizard.getConfig(serverId, { includeSecret: true }).apiKey, 'not-plaintext-in-db');
});

test('power configuration is per-server, bounded, and admin-only', async () => {
  const saved = await app.req('POST', `/api/servers/${serverId}/wizard`, {
    cookie: adminCookie,
    body: {
      enabled: true,
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen:test',
      invocationName: 'bubba',
      systemPrompt: 'Test wizard',
      retentionDays: 7,
      powersEnabled: true,
      powersDryRun: true,
      powerTesters: ['Gleep52'],
      powerFlags: { heal: true, feed: true, spawn: true, time: false, weather: true, gift: true },
      giftItems: ['minecraft:bread', 'minecraft:torch'],
      giftMaxCount: 8,
      powerCooldownSec: 45,
    },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.wizard.powerTesters, ['Gleep52']);
  assert.deepEqual(saved.json.wizard.giftItems, ['minecraft:bread', 'minecraft:torch']);
  assert.equal(saved.json.wizard.giftMaxCount, 8);
  assert.equal(saved.json.wizard.powerFlags.time, false);

  const excessive = await app.req('POST', `/api/servers/${serverId}/wizard`, {
    cookie: adminCookie,
    body: {
      enabled: false,
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen:test',
      systemPrompt: 'Test',
      retentionDays: 7,
      giftMaxCount: 17,
    },
  });
  assert.equal(excessive.status, 400);
});

test('power tools can only affect the caller and reject injected arguments', () => {
  const cfg = wizard.getConfig(serverId);
  const tools = wizardPowers.toolsFor(cfg, 'Gleep52');
  assert.ok(tools.length > 0);
  assert.equal(wizardPowers.toolsFor(cfg, 'SomeoneElse').length, 0);
  const serialized = JSON.stringify(tools);
  assert.doesNotMatch(serialized, /target|selector|command|rcon/i);

  const gift = wizardPowers.parseToolCall(
    {
      tool_calls: [
        {
          id: 'call-1',
          function: { name: 'give_self', arguments: '{"item":"minecraft:bread","count":2}' },
        },
      ],
    },
    cfg,
    'Gleep52'
  );
  assert.deepEqual(gift.args, { item: 'minecraft:bread', count: 2 });
  const duplicate = wizardPowers.parseToolCall(
    {
      tool_calls: [
        { function: { name: 'give_self', arguments: '{"item":"minecraft:bread","count":2}' } },
        { function: { name: 'give_self', arguments: { item: 'minecraft:bread', count: 2 } } },
      ],
    },
    cfg,
    'Gleep52'
  );
  assert.deepEqual(duplicate.args, { item: 'minecraft:bread', count: 2 });
  assert.throws(
    () =>
      wizardPowers.parseToolCall(
        {
          tool_calls: [
            { function: { name: 'heal_self', arguments: '{}' } },
            { function: { name: 'give_self', arguments: '{"item":"minecraft:bread","count":1}' } },
          ],
        },
        cfg,
        'Gleep52'
      ),
    /more than one different power/
  );
  assert.throws(
    () =>
      wizardPowers.parseToolCall(
        {
          tool_calls: [
            {
              function: {
                name: 'give_self',
                arguments: '{"item":"minecraft:bread","count":2,"target":"NotTheCaller"}',
              },
            },
          ],
        },
        cfg,
        'Gleep52'
      ),
    /outside the allowlist/
  );
});

test('eligible model requests receive only structured tools and unsupported models fall back to chat', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (requests.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'tools are not supported' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Only conversation.' } }] }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  };
  try {
    const result = await wizard.completionMessage(serverId, 'Gleep52', 'Can you help?', { allowPowers: true });
    assert.equal(result.message.content, 'Only conversation.');
    assert.ok(requests[0].tools.length > 0);
    assert.equal(Object.hasOwn(requests[1], 'tools'), false);
    assert.match(requests[1].messages[0].content, /No gameplay tools are available/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('dry-run powers write a complete audit event without executing RCON', async () => {
  const cfg = wizard.getConfig(serverId);
  await assert.rejects(
    wizardPowers.execute(serverId, 'Gleep52', { name: 'set_time', args: { value: 'day' } }, cfg),
    /disabled or unavailable/
  );
  const result = await wizardPowers.execute(serverId, 'Gleep52', { name: 'heal_self', args: {} }, cfg);
  assert.equal(result.dryRun, true);
  const immediateSecondDryRun = await wizardPowers.execute(serverId, 'Gleep52', { name: 'heal_self', args: {} }, cfg);
  assert.equal(immediateSecondDryRun.dryRun, true);
  const audit = wizardPowers.listAudit(serverId, 10);
  assert.match(audit[0].summary, /Dry run: Gleep52 would restore full health/);
  assert.equal(audit[0].details.power, 'heal_self');
  assert.equal(audit[0].details.dryRun, true);
});

test('model discovery supports OpenAI-compatible model lists and free-text trigger parsing', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    assert.equal(String(url), 'http://127.0.0.1:11434/v1/models');
    return new Response(JSON.stringify({ data: [{ id: 'qwen:test' }, { id: 'llama:test' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    assert.deepEqual(await wizard.listModels(serverId, { baseUrl: 'http://127.0.0.1:11434', apiKey: '' }), [
      'llama:test',
      'qwen:test',
    ]);
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(wizard.TRIGGER_RE.test('ordinary player chat'), false);
  assert.equal(wizard.TRIGGER_RE.test('@wizard what mysteries await?'), true);
  assert.equal(wizard.invocationPattern('bubba').test('@wizard what mysteries await?'), false);
  assert.equal(wizard.invocationPattern('bubba').test('@BUBBA what mysteries await?'), true);
  assert.equal(wizard.assistantLabel('bubba'), 'Bubba');
});

test('conversational replies unwrap story envelopes and never end mid-word', () => {
  assert.equal(
    wizard.cleanReply('{"name":"tell_a_story","parameters":{"story":"Finley found a pearl and swam home."}}'),
    'Finley found a pearl and swam home.'
  );
  const long = wizard.cleanReply('Finley crossed the bright reef. '.repeat(30));
  assert.ok(long.length <= 350);
  assert.match(long, /\. …$/);
  assert.throws(() => wizard.cleanReply('{"name":"tell_a_story","parameters":{"length":300}}'), /tool-shaped response/);
});

test('invocation names reject ambiguous or unsafe values', async () => {
  for (const invocationName of ['two words', '@wizard', '9lives', 'wizard!']) {
    const res = await app.req('POST', `/api/servers/${serverId}/wizard`, {
      cookie: adminCookie,
      body: {
        enabled: false,
        baseUrl: 'http://127.0.0.1:11434',
        model: 'qwen:test',
        invocationName,
        systemPrompt: 'Test',
        retentionDays: 7,
      },
    });
    assert.equal(res.status, 400, invocationName);
  }
});

test('retention pruning preserves recent rows and removes expired rows', () => {
  wizard.saveConfig(serverId, {
    enabled: false,
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen:test',
    systemPrompt: 'Test',
    retentionDays: 7,
  });
  db.run(
    "INSERT INTO wizard_transcripts (server_id, server_name, player, role, content, created_at) VALUES (?, 'Test', 'Alex', 'user', 'old', datetime('now', '-8 days'))",
    serverId
  );
  db.run(
    "INSERT INTO wizard_transcripts (server_id, server_name, player, role, content) VALUES (?, 'Test', 'Alex', 'assistant', 'recent')",
    serverId
  );
  wizard.pruneTranscripts(serverId);
  const rows = wizard.listTranscripts({ serverId });
  assert.equal(
    rows.some((r) => r.content === 'old'),
    false
  );
  assert.equal(
    rows.some((r) => r.content === 'recent'),
    true
  );
  assert.equal(rows.find((r) => r.content === 'recent').speaker, 'Bubba');
});

test('transcripts remain available after the server is soft-deleted', () => {
  db.run("UPDATE servers SET deleted_at = datetime('now') WHERE id = ?", serverId);
  const rows = wizard.listTranscripts({ serverId });
  assert.equal(
    rows.some((r) => r.content === 'recent'),
    true
  );
  db.run('UPDATE servers SET deleted_at = NULL WHERE id = ?', serverId);
});

test('link-local metadata endpoints are rejected while LAN endpoints are accepted', () => {
  assert.throws(() => wizard.normalizeBaseUrl('http://169.254.169.254/latest'), /not allowed/);
  assert.equal(wizard.normalizeBaseUrl('http://10.0.0.25:11434/'), 'http://10.0.0.25:11434');
});
