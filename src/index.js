import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WhatsAppController } from './whatsapp.js';
import { startScheduler, runJob, tick } from './scheduler.js';
import { addEvent, createJob, deleteJob, getJob, getSettings, listEvents, listJobs, MEDIA_DIR, resetFailedJob, saveSettings, updateJob, listAutoReplies, createAutoReply, updateAutoReply, deleteAutoReply } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3030);
const wa = new WhatsAppController();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, MEDIA_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || 'media');
      cb(null, `${Date.now()}-${randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: 200 * 1024 * 1024 }
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/status', async (_req, res) => {
  res.json({ browser: await wa.status(), settings: await getSettings(), now: new Date().toISOString() });
});

app.get('/api/jobs', async (_req, res) => res.json(await listJobs()));
app.get('/api/events', async (req, res) => res.json(await listEvents(Number(req.query.limit || 250))));

app.get('/api/autoreplies', async (_req, res) => res.json(await listAutoReplies()));

app.post('/api/autoreplies', upload.single('media'), async (req, res) => {
  try {
    const isGlobal = req.body.isGlobal === 'true' || req.body.isGlobal === true || req.body.isGlobal === 'on';
    const keywords = isGlobal ? [] : parseRecipients(req.body.keywords);
    
    if (!isGlobal && !keywords.length) {
      return res.status(400).json({ error: 'Agregá al menos una palabra clave o marcá como "respuesta global".' });
    }
    if (!req.body.responseText && !req.file) {
      return res.status(400).json({ error: 'Agregá texto de respuesta o adjunto.' });
    }
    
    const rule = await createAutoReply({
      keywords,
      matchMode: req.body.matchMode || 'contains',
      responseText: req.body.responseText || '',
      enabled: req.body.enabled !== 'false',
      isGlobal,
      media: req.file ? {
        originalName: req.file.originalname,
        filename: req.file.filename,
        mimetype: req.file.mimetype,
        size: req.file.size,
        path: req.file.path
      } : null
    });
    res.json(rule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/autoreplies/:id', async (req, res) => {
  const rule = await updateAutoReply(req.params.id, req.body || {});
  if (!rule) return res.status(404).json({ error: 'Regla no encontrada.' });
  res.json(rule);
});

app.delete('/api/autoreplies/:id', async (req, res) => res.json({ ok: await deleteAutoReply(req.params.id) }));

app.get('/api/settings', async (_req, res) => res.json(await getSettings()));
app.put('/api/settings', async (req, res) => {
  const patch = {};
  for (const key of ['leadMinutes', 'schedulerTickSeconds', 'minRecipientDelayMs', 'maxRecipientDelayMs', 'maxAttempts', 'keepBrowserOpen', 'closeBrowserWhenIdle', 'autoResponderEnabled', 'autoResponderPollSeconds']) {
    if (key in req.body) patch[key] = req.body[key];
  }
  res.json(await saveSettings(patch));
});

app.post('/api/jobs', upload.single('media'), async (req, res) => {
  try {
    const recipients = parseRecipients(req.body.recipients);
    if (!recipients.length) return res.status(400).json({ error: 'Agregá al menos un contacto o grupo.' });
    if (!req.body.message && !req.file) return res.status(400).json({ error: 'Agregá mensaje o multimedia.' });
    const scheduledAt = req.body.scheduledAt;
    if (!scheduledAt || Number.isNaN(new Date(scheduledAt).getTime())) return res.status(400).json({ error: 'Fecha/hora inválida.' });

    const job = await createJob({
      recipients,
      message: req.body.message || '',
      scheduledAt,
      media: req.file ? {
        originalName: req.file.originalname,
        filename: req.file.filename,
        mimetype: req.file.mimetype,
        size: req.file.size,
        path: req.file.path
      } : null
    });
    await tick(wa);
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/jobs/:id/send-now', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job no encontrado.' });
  await updateJob(job.id, { status: 'pending', nextRunAt: new Date().toISOString() });
  runJob(wa, job.id, true).catch(err => addEvent('job.fatal', err.message, { jobId: job.id }));
  res.json({ ok: true });
});

app.post('/api/jobs/:id/retry', async (req, res) => {
  const job = await resetFailedJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job no encontrado.' });
  await tick(wa);
  res.json(job);
});

app.post('/api/jobs/:id/cancel', async (req, res) => {
  const job = await updateJob(req.params.id, { status: 'canceled', completedAt: new Date().toISOString() });
  if (!job) return res.status(404).json({ error: 'Job no encontrado.' });
  await addEvent('job.canceled', 'Job cancelado.', { jobId: job.id });
  res.json(job);
});

app.delete('/api/jobs/:id', async (req, res) => res.json({ ok: await deleteJob(req.params.id) }));

app.post('/api/browser/open', async (_req, res) => {
  try { await wa.ensureBrowser('manual'); res.json(await wa.status()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/browser/close', async (_req, res) => {
  try { await wa.closeBrowser(); res.json(await wa.status()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/test-open', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Indicá un contacto o grupo.' });
    await wa.openChatByName(name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function parseRecipients(value) {
  return String(value || '')
    .split(/[\n,;]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);
}

app.listen(port, async () => {
  await addEvent('app.started', `Servidor iniciado en http://localhost:${port}`);
  await startScheduler(wa);
  console.log(`WA Scheduler Pro v2.1: http://localhost:${port}`);
});
