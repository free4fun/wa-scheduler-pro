import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const root = process.cwd();
export const DATA_DIR = path.join(root, 'data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const PROFILE_DIR = path.join(DATA_DIR, 'browser-profile');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const AUTOREPLIES_FILE = path.join(DATA_DIR, 'autoreplies.json');
const AUTOREPLY_SENT_FILE = path.join(DATA_DIR, 'autoreply-sent.json');

async function ensureFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  await fs.mkdir(PROFILE_DIR, { recursive: true });
  await ensureJson(JOBS_FILE, []);
  await ensureJson(EVENTS_FILE, []);
  await ensureJson(AUTOREPLIES_FILE, []);
  await ensureJson(AUTOREPLY_SENT_FILE, []);
  await ensureJson(SETTINGS_FILE, {
    leadMinutes: 1,
    schedulerTickSeconds: 10,

    minRecipientDelayMs: 2500,
    maxRecipientDelayMs: 7000,
    maxAttempts: 2,

    keepBrowserOpen: false,
    closeBrowserWhenIdle: true,

    autoResponderEnabled: false,
    autoResponderPollSeconds: 5,
    autoResponderOnlyWhenBrowserOpen: true,
    autoResponderIgnoreExistingUnread: true,

    browserMode: 'virtual',
    browserViewportWidth: 1366,
    browserViewportHeight: 768
  });
}

async function ensureJson(file, fallback) {
  try { await fs.access(file); } catch { await atomicWrite(file, fallback); }
}

async function readJson(file, fallback) {
  await ensureFiles();
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function atomicWrite(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

export async function getSettings() { return readJson(SETTINGS_FILE, {}); }
export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await atomicWrite(SETTINGS_FILE, next);
  return next;
}

export async function listJobs() { return readJson(JOBS_FILE, []); }
export async function getJob(id) { return (await listJobs()).find(j => j.id === id) || null; }
export async function saveJobs(jobs) { await atomicWrite(JOBS_FILE, jobs); }

export async function createJob(input) {
  const now = new Date().toISOString();
  const job = {
    id: randomUUID(),
    recipients: input.recipients,
    message: input.message || '',
    media: input.media || null,
    scheduledAt: input.scheduledAt,
    timezone: input.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
    status: 'pending',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    nextRunAt: input.scheduledAt,
    results: input.recipients.map(name => ({ name, status: 'pending', sentAt: null, error: null }))
  };
  const jobs = await listJobs();
  jobs.unshift(job);
  await saveJobs(jobs);
  await addEvent('job.created', `Job creado con ${job.recipients.length} destinatario(s).`, { jobId: job.id });
  return job;
}

export async function updateJob(id, patch) {
  const jobs = await listJobs();
  const idx = jobs.findIndex(j => j.id === id);
  if (idx === -1) return null;
  jobs[idx] = { ...jobs[idx], ...patch, updatedAt: new Date().toISOString() };
  await saveJobs(jobs);
  return jobs[idx];
}

export async function deleteJob(id) {
  const jobs = await listJobs();
  const next = jobs.filter(j => j.id !== id);
  await saveJobs(next);
  await addEvent('job.deleted', 'Job eliminado.', { jobId: id });
  return jobs.length !== next.length;
}

export async function addEvent(type, message, meta = {}) {
  const events = await readJson(EVENTS_FILE, []);
  const event = { id: randomUUID(), at: new Date().toISOString(), type, message, meta };
  events.unshift(event);
  await atomicWrite(EVENTS_FILE, events.slice(0, 2000));
  return event;
}

export async function listEvents(limit = 250) {
  return (await readJson(EVENTS_FILE, [])).slice(0, limit);
}

export async function resetFailedJob(id) {
  const job = await getJob(id);
  if (!job) return null;
  return updateJob(id, {
    status: 'pending',
    attempts: 0,
    startedAt: null,
    completedAt: null,
    nextRunAt: new Date().toISOString(),
    results: job.results.map(r => r.status === 'sent' ? r : { ...r, status: 'pending', error: null })
  });
}

await ensureFiles();


export async function listAutoReplies() { return readJson(AUTOREPLIES_FILE, []); }
export async function createAutoReply(input) {
  const now = new Date().toISOString();
  const rule = {
    id: randomUUID(),
    keywords: Array.isArray(input.keywords) ? input.keywords.map(k => String(k).trim()).filter(Boolean) : [],
    matchMode: input.matchMode || 'contains',
    responseText: input.responseText || '',
    media: input.media || null,
    enabled: input.enabled !== false,
    isGlobal: input.isGlobal === true,
    createdAt: now,
    updatedAt: now
  };
  const rules = await listAutoReplies();
  rules.unshift(rule);
  await atomicWrite(AUTOREPLIES_FILE, rules);
  const description = rule.isGlobal
    ? 'Regla de autorespuesta global creada.'
    : `Regla de autorespuesta creada con ${rule.keywords.length} palabra(s).`;
  await addEvent('autoreply.created', description, { ruleId: rule.id });
  return rule;
}
export async function updateAutoReply(id, patch) {
  const rules = await listAutoReplies();
  const idx = rules.findIndex(r => r.id === id);
  if (idx === -1) return null;
  rules[idx] = { ...rules[idx], ...patch, updatedAt: new Date().toISOString() };
  await atomicWrite(AUTOREPLIES_FILE, rules);
  return rules[idx];
}
export async function deleteAutoReply(id) {
  const rules = await listAutoReplies();
  const next = rules.filter(r => r.id !== id);
  await atomicWrite(AUTOREPLIES_FILE, next);
  await addEvent('autoreply.deleted', 'Regla de autorespuesta eliminada.', { ruleId: id });
  return rules.length !== next.length;
}
export async function hasAutoReplySent(key) {
  const sent = await readJson(AUTOREPLY_SENT_FILE, []);
  return sent.some(x => x.key === key);
}
export async function markAutoReplySent(key, meta = {}) {
  const sent = await readJson(AUTOREPLY_SENT_FILE, []);
  const row = { key, at: new Date().toISOString(), ...meta };
  sent.unshift(row);
  await atomicWrite(AUTOREPLY_SENT_FILE, sent.slice(0, 2000));
  return row;
}
