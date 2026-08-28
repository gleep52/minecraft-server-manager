'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app');
const db = require('../src/db');
const auth = require('../src/services/auth');
const wizard = require('../src/services/wizard');

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
    assert.equal((await app.req('GET', '/wizard-transcripts', { cookie })).status, 403);
  }
  assert.equal((await app.req('GET', `/api/servers/${serverId}/wizard`, { cookie: adminCookie })).status, 200);
  assert.equal((await app.req('GET', '/wizard-transcripts', { cookie: adminCookie })).status, 200);

  const adminPage = await app.req('GET', `/servers/${serverId}/integrations`, { cookie: adminCookie });
  const operatorPage = await app.req('GET', `/servers/${serverId}/integrations`, { cookie: operatorCookie });
  assert.match(adminPage.text, /Wizard chatbot/);
  assert.doesNotMatch(operatorPage.text, /Wizard chatbot/);
});

test('per-server config encrypts the API key and defaults retention to seven days', async () => {
  const initial = await app.req('GET', `/api/servers/${serverId}/wizard`, { cookie: adminCookie });
  assert.equal(initial.json.wizard.retentionDays, 7);
  assert.equal(initial.json.wizard.invocationName, 'wizard');

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
