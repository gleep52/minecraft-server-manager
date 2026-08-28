'use strict';

// Admin-only configuration, diagnostics, and transcript access for the
// per-server conversational wizard.

const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../middleware/asyncHandler');
const { makeJsonErrorHandler } = require('../middleware/jsonErrorHandler');
const servers = require('../../services/servers');
const wizard = require('../../services/wizard');

const router = express.Router({ mergeParams: true });

function mustGet(req) {
  const server = servers.getServer(req.params.id);
  if (!server) {
    const err = new Error('Server not found');
    err.status = 404;
    throw err;
  }
  return server;
}

const connectionSchema = z.object({
  baseUrl: z.string().trim().min(1).max(500),
  apiKey: z.string().max(1000).optional(),
});

router.get('/', (req, res) => {
  const server = mustGet(req);
  res.json({ ok: true, wizard: wizard.getConfig(server.id) });
});

router.post(
  '/',
  asyncHandler((req, res) => {
    const server = mustGet(req);
    const input = z
      .object({
        enabled: z.boolean(),
        baseUrl: z.string().trim().min(1).max(500),
        model: z.string().trim().max(200),
        invocationName: z
          .string()
          .trim()
          .regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/)
          .optional(),
        apiKey: z.string().max(1000).optional(),
        clearApiKey: z.boolean().optional(),
        systemPrompt: z.string().max(12000),
        retentionDays: z.coerce.number().int().min(0).max(3650),
      })
      .parse(req.body);
    res.json({
      ok: true,
      wizard: wizard.saveConfig(server.id, input, { actor: req.user.username }),
    });
  })
);

router.post(
  '/models',
  asyncHandler(async (req, res) => {
    const server = mustGet(req);
    const input = connectionSchema.parse(req.body);
    const stored = wizard.getConfig(server.id, { includeSecret: true });
    const models = await wizard.listModels(server.id, {
      baseUrl: input.baseUrl,
      apiKey: input.apiKey && input.apiKey.trim() ? input.apiKey.trim() : stored.apiKey,
    });
    res.json({ ok: true, models });
  })
);

router.post(
  '/test',
  asyncHandler(async (req, res) => {
    const server = mustGet(req);
    const input = z
      .object({
        baseUrl: z.string().trim().min(1).max(500),
        model: z.string().trim().min(1).max(200),
        apiKey: z.string().max(1000).optional(),
      })
      .parse(req.body);
    const stored = wizard.getConfig(server.id, { includeSecret: true });
    const reply = await wizard.testConnection(server.id, {
      baseUrl: input.baseUrl,
      model: input.model,
      apiKey: input.apiKey && input.apiKey.trim() ? input.apiKey.trim() : stored.apiKey,
    });
    res.json({ ok: true, reply });
  })
);

router.get('/transcripts', (req, res) => {
  const server = mustGet(req);
  const limit = z.coerce.number().int().min(1).max(2000).default(250).parse(req.query.limit);
  res.json({ ok: true, transcripts: wizard.listTranscripts({ serverId: server.id, limit }) });
});

router.delete('/transcripts', (req, res) => {
  const server = mustGet(req);
  const result = wizard.clearTranscripts(server.id);
  res.json({ ok: true, deleted: Number(result.changes) || 0 });
});

router.use(makeJsonErrorHandler('wizard'));

module.exports = router;
