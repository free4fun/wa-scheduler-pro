import { addEvent, getSettings, listJobs, updateJob, listAutoReplies } from './storage.js';

const running = new Set();
let timer = null;
let lastIdleCloseAt = 0;

export async function recoverInterruptedJobs() {
  const jobs = await listJobs();
  for (const job of jobs) {
    if (job.status === 'running') {
      await updateJob(job.id, { status: 'pending', nextRunAt: new Date().toISOString() });
      await addEvent('job.recovered', 'Job que quedó en ejecución fue recuperado como pendiente.', { jobId: job.id });
    }
  }
}

export async function startScheduler(wa) {
  if (timer) clearInterval(timer);
  await recoverInterruptedJobs();
  wa.startAutoResponder(listAutoReplies);
  await tick(wa);
  const settings = await getSettings();
  timer = setInterval(() => tick(wa).catch(err => addEvent('scheduler.error', err.message)), (settings.schedulerTickSeconds || 10) * 1000);
}

export async function tick(wa) {
  const now = Date.now();
  const settings = await getSettings();
  const leadMs = (settings.leadMinutes ?? 1) * 60 * 1000;
  const jobs = await listJobs();

  const relevant = jobs.filter(j => ['pending', 'failed_retry'].includes(j.status));

  for (const job of relevant) {
    const due = new Date(job.nextRunAt || job.scheduledAt).getTime();
    if (Number.isNaN(due)) continue;

    if (due - now <= leadMs && due > now) {
      const st = await wa.status();
      if (!st.browserOpen) {
        await addEvent('browser.preopen', `Abriendo navegador ${settings.leadMinutes ?? 1} minuto(s) antes del envío.`, { jobId: job.id });
        await wa.ensureBrowser('scheduled-preopen');
      }
    }

    if (due <= now && !running.has(job.id)) {
      runJob(wa, job.id).catch(err => addEvent('job.fatal', err.message, { jobId: job.id }));
    }
  }

  await maybeCloseIdleBrowser(wa, jobs, settings);
}

export async function maybeCloseIdleBrowser(wa, jobs = null, settings = null) {
  settings ||= await getSettings();
  if (settings.keepBrowserOpen || !settings.closeBrowserWhenIdle || settings.autoResponderEnabled) return;
  const st = await wa.status();
  if (!st.browserOpen) return;
  const now = Date.now();
  if (now - lastIdleCloseAt < 20_000) return;
  jobs ||= await listJobs();
  const hasRunning = jobs.some(j => j.status === 'running') || running.size > 0;
  if (hasRunning) return;
  const hasJobWithinNextMinute = jobs.some(j => {
    if (!['pending', 'failed_retry'].includes(j.status)) return false;
    const due = new Date(j.nextRunAt || j.scheduledAt).getTime();
    return !Number.isNaN(due) && due - now <= 60_000;
  });
  if (!hasJobWithinNextMinute) {
    lastIdleCloseAt = now;
    await addEvent('browser.idle_close', 'Cerrando navegador: no hay mensajes agendados para el próximo minuto.');
    await wa.closeBrowser();
  }
}

export async function runJob(wa, jobId, force = false) {
  if (running.has(jobId)) return;
  running.add(jobId);

  try {
    let jobs = await listJobs();
    let job = jobs.find(j => j.id === jobId);
    if (!job) throw new Error('Job no encontrado.');
    if (!force && !['pending', 'failed_retry'].includes(job.status)) return;

    const settings = await getSettings();
    const maxAttempts = settings.maxAttempts || 2;
    await updateJob(job.id, {
      status: 'running',
      attempts: (job.attempts || 0) + 1,
      startedAt: new Date().toISOString()
    });
    await addEvent('job.started', 'Ejecutando job.', { jobId: job.id });

    for (const recipient of job.recipients) {
      job = await refresh(job.id);
      const current = job.results.find(r => r.name === recipient);
      if (current?.status === 'sent') continue;

      try {
        await updateRecipient(job.id, recipient, { status: 'running', error: null });
        await addEvent('recipient.started', `Enviando a ${recipient}.`, { jobId: job.id, recipient });
        await wa.sendToRecipient({
          name: recipient,
          message: job.message,
          mediaPath: job.media?.path || null
        });
        await updateRecipient(job.id, recipient, { status: 'sent', sentAt: new Date().toISOString(), error: null });
        await addEvent('recipient.sent', `Mensaje enviado a ${recipient}.`, { jobId: job.id, recipient });
      } catch (err) {
        await updateRecipient(job.id, recipient, { status: 'failed', error: err.message });
        await addEvent('recipient.failed', `Falló envío a ${recipient}: ${err.message}`, { jobId: job.id, recipient });
      }
    }

    job = await refresh(job.id);
    const failed = job.results.filter(r => r.status !== 'sent');
    if (failed.length === 0) {
      await updateJob(job.id, { status: 'completed', completedAt: new Date().toISOString() });
      await addEvent('job.completed', 'Job completado.', { jobId: job.id });
    } else if ((job.attempts || 1) < maxAttempts) {
      const nextRunAt = new Date(Date.now() + 60_000).toISOString();
      await updateJob(job.id, { status: 'failed_retry', nextRunAt });
      await addEvent('job.retry_scheduled', 'Job con fallos. Reintento automático en 1 minuto.', { jobId: job.id, failed: failed.map(f => f.name) });
    } else {
      await updateJob(job.id, { status: 'failed', completedAt: new Date().toISOString() });
      await addEvent('job.failed', 'Job finalizado con errores.', { jobId: job.id, failed: failed.map(f => f.name) });
    }
  } finally {
    running.delete(jobId);
    await maybeCloseIdleBrowser(wa).catch(err => addEvent('browser.idle_close_failed', err.message));
  }
}

async function refresh(jobId) {
  return (await listJobs()).find(j => j.id === jobId);
}

async function updateRecipient(jobId, recipientName, patch) {
  const job = await refresh(jobId);
  const results = job.results.map(r => r.name === recipientName ? { ...r, ...patch } : r);
  await updateJob(jobId, { results });
}
