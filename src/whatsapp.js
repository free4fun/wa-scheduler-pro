import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  addEvent,
  PROFILE_DIR,
  getSettings,
  hasAutoReplySent,
  markAutoReplySent
} from './storage.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

export class WhatsAppController {
  constructor() {
    this.context = null;
    this.page = null;
    this.launching = null;
    this.lastKnownState = 'closed';

    this.autoResponderTimer = null;
    this.autoResponderRunning = false;

    // Autoresponder state.
    // We intentionally ignore unread messages that already existed when the browser opened.
    this.autoResponderBootstrapped = false;
    this.knownUnreadSidebarKeys = new Set();

    this.lastAutoResponderClosedLogAt = 0;
    this.lastAutoResponderScanLogAt = 0;
    this.lastAutoResponderIdleLogAt = 0;
  }

  async status() {
    const browserOpen = !!(
      this.context &&
      this.page &&
      !this.page.isClosed()
    );

    const display = process.env.DISPLAY || '';

    return {
      appRunning: true,
      browserOpen,
      pageOpen: browserOpen,
      state: browserOpen ? this.lastKnownState : 'browser_closed',
      profileDir: PROFILE_DIR,

      runtime: {
        pid: process.pid,
        display,
        mode: display ? 'x11_or_xvfb' : 'no_display',
        isXvfbLikely: /^:\d+/.test(display)
      },

      autoResponder: {
        timerActive: !!this.autoResponderTimer,
        running: this.autoResponderRunning,
        bootstrapped: this.autoResponderBootstrapped,
        knownUnreadCount: this.knownUnreadSidebarKeys.size
      }
    };
  }

  async ensureBrowser(reason = 'manual') {
    if (this.page && !this.page.isClosed()) {
      return this.page;
    }

    if (this.launching) {
      await this.launching;
      return this.page;
    }

    this.launching = (async () => {
      const settings = await getSettings();

      await fs.mkdir(PROFILE_DIR, { recursive: true });

      this.context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,

        viewport: {
          width: settings.browserViewportWidth || 1366,
          height: settings.browserViewportHeight || 768
        },

        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-features=CalculateNativeWinOcclusion',
          '--window-size=1366,768'
        ]
      });

      this.context.on('close', async () => {
        this.context = null;
        this.page = null;
        this.lastKnownState = 'closed';

        this.autoResponderBootstrapped = false;
        this.knownUnreadSidebarKeys = new Set();

        await addEvent(
          'browser.closed',
          'El navegador fue cerrado. Se reabrirá automáticamente si hay un envío próximo o pendiente.'
        );
      });

      const pages = this.context.pages();
      this.page = pages.length ? pages[0] : await this.context.newPage();

      await this.page.goto('https://web.whatsapp.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });

      this.lastKnownState = 'open';

      await addEvent(
        'browser.opened',
        `Navegador iniciado por: ${reason}`
      );
    })();

    try {
      await this.launching;
    } finally {
      this.launching = null;
    }

    return this.page;
  }

  async closeBrowser() {
    if (!this.context) return;

    await this.context.close();

    this.context = null;
    this.page = null;
    this.lastKnownState = 'closed';

    this.autoResponderBootstrapped = false;
    this.knownUnreadSidebarKeys = new Set();
  }

  async ensureLoggedIn(timeoutMs = 90000) {
    const page = await this.ensureBrowser('login-check');

    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const side = page.locator('#side, #pane-side').first();
      const composer = page.locator('footer div[contenteditable="true"][role="textbox"]').last();
      const qr = page.locator('canvas, [data-testid="qrcode"], [aria-label*="QR" i]').first();

      if (await side.count().catch(() => 0)) {
        this.lastKnownState = 'logged_in';
        return true;
      }

      if (await composer.count().catch(() => 0)) {
        this.lastKnownState = 'logged_in';
        return true;
      }

      if (await qr.count().catch(() => 0)) {
        this.lastKnownState = 'qr_required';
      }

      await sleep(1000);
    }

    throw new Error('WhatsApp Web no quedó listo. Si aparece el QR, escanealo y reintentá.');
  }

  async openChatByName(name) {
    const page = await this.ensureBrowser('open-chat');

    await this.ensureLoggedIn(120000);

    const search = await this.findSearchBox(page);

    await search.click({ timeout: 10000 });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');

    try {
      await search.fill(name);
    } catch {
      await page.keyboard.insertText(name);
    }

    await sleep(1200);

    const result = await this.findChatResult(page, name);
    if (!result) {
      throw new Error(`No encontré el contacto o grupo: ${name}`);
    }

    await result.click({ timeout: 15000 });
    await sleep(1200);

    await this.verifyCurrentChat(name);
  }

  async findSearchBox(page) {
    const candidates = [
      page.getByRole('textbox', { name: /search|buscar|busca|start new chat|iniciar/i }).first(),
      page.locator('#side div[contenteditable="true"][role="textbox"]').first(),
      page.locator('#pane-side div[contenteditable="true"][role="textbox"]').first(),
      page.locator('div[aria-label*="Search" i][contenteditable="true"]').first(),
      page.locator('div[aria-label*="Buscar" i][contenteditable="true"]').first(),
      page.locator('div[contenteditable="true"][role="textbox"]').first()
    ];

    for (const locator of candidates) {
      try {
        await locator.waitFor({ state: 'visible', timeout: 3000 });
        return locator;
      } catch {
        // Try next candidate.
      }
    }

    throw new Error('No pude encontrar el buscador lateral de WhatsApp Web.');
  }

  async findChatResult(page, name) {
    const safeText = escapeForTextSelector(name);
    const safeAttr = escapeForCssAttribute(name);

    const candidates = [
      page.locator(`#pane-side span[title="${safeAttr}"]`).first(),
      page.locator(`span[title="${safeAttr}"]`).first(),
      page.getByText(name, { exact: true }).first(),
      page.locator(`#pane-side [role="listitem"]:has-text("${safeText}")`).first(),
      page.locator(`#pane-side [role="row"]:has-text("${safeText}")`).first()
    ];

    for (const candidate of candidates) {
      try {
        await candidate.waitFor({ state: 'visible', timeout: 4000 });

        const row = candidate.locator(
          'xpath=ancestor::*[@role="listitem" or @role="row" or @tabindex][1]'
        );

        if (await row.count().catch(() => 0)) {
          return row.first();
        }

        return candidate;
      } catch {
        // Try next candidate.
      }
    }

    return null;
  }

  async verifyCurrentChat(name) {
    const page = await this.ensureBrowser('verify-chat');

    const safeAttr = escapeForCssAttribute(name);
    const safeText = escapeForTextSelector(name);

    const candidates = [
      page.locator(`header span[title="${safeAttr}"]`).first(),
      page.locator(`header:has-text("${safeText}")`).first(),
      page.getByRole('button', { name: new RegExp(escapeRegExp(name), 'i') }).first()
    ];

    for (const candidate of candidates) {
      try {
        await candidate.waitFor({ state: 'visible', timeout: 7000 });
        return true;
      } catch {
        // Try next candidate.
      }
    }

    throw new Error(`El chat activo no parece ser "${name}". Aborté para evitar enviar al chat incorrecto.`);
  }

  async getCurrentChatName() {
    const page = await this.ensureBrowser('current-chat-name');

    const title = page.locator('header span[title]').first();

    if (await title.count().catch(() => 0)) {
      const value = await title.getAttribute('title').catch(() => '');
      if (value) return value;
    }

    const text = await page.locator('header').innerText({ timeout: 3000 }).catch(() => 'chat');
    return text.split('\n')[0]?.trim() || 'chat';
  }

  async sendText(message) {
    const page = await this.ensureBrowser('send-text');

    if (!message || !String(message).trim()) {
      return;
    }

    await this.waitForChatReady();

    const box = page.locator('footer div[contenteditable="true"][role="textbox"]').last();

    await box.waitFor({ state: 'visible', timeout: 15000 });
    await box.click();

    try {
      await box.fill(String(message));
    } catch {
      await page.keyboard.insertText(String(message));
    }

    await sleep(300);
    await this.clickSend();
  }

  async sendMedia(filePath, caption = '', options = {}) {
    const page = await this.ensureBrowser('send-media');

    const resolvedFilePath = await resolveExistingMediaPath(filePath);

    if (!resolvedFilePath) {
      throw new Error(`No se pudo resolver el archivo adjunto: ${filePath}`);
    }

    const originalName =
    options.originalName ||
    options.name ||
    path.basename(resolvedFilePath);

    const attachmentKind = getAttachmentKind(resolvedFilePath);
    const uploadPayload = await buildUploadPayload(resolvedFilePath, originalName);

    await addEvent(
      'media.prepare',
      `Preparando adjunto ${attachmentKind}: ${uploadPayload.name}`,
      {
        originalPath: filePath,
        resolvedPath: resolvedFilePath,
        originalName,
        uploadName: uploadPayload.name,
        mimeType: uploadPayload.mimeType,
        attachmentKind
      }
    );

    await this.waitForChatReady();

    await this.openAttachmentMenu();

    if (attachmentKind === 'document') {
      await this.uploadDocumentWithFileChooser(uploadPayload);
    } else {
      await this.uploadMediaWithFileChooser(uploadPayload);
    }

    await this.waitForAttachmentPreview(
      resolvedFilePath,
      attachmentKind,
      uploadPayload.name
    );

    if (caption && caption.trim()) {
      await this.clearAttachmentCaptionIfPresent();
    }

    await this.clickAttachmentSendButton();

    await addEvent(
      'media.send_clicked',
      `Click en enviar adjunto: ${uploadPayload.name}`,
      {
        resolvedPath: resolvedFilePath,
        uploadName: uploadPayload.name,
        mimeType: uploadPayload.mimeType,
        attachmentKind
      }
    );

    await page.waitForTimeout(1800);
  }
  async openAttachmentMenu() {
    const page = await this.ensureBrowser('open-attachment-menu');

    const attachButton = page.locator(
      [
        '[aria-label="Attach"]',
        '[aria-label="Adjuntar"]',
        '[title="Attach"]',
        '[title="Adjuntar"]',
        'span[data-icon="plus"]',
        'span[data-icon="clip"]'
      ].join(', ')
    ).first();

    await attachButton.click({ timeout: 10000 });
    await page.waitForTimeout(700);
  }

  async waitForFileChooserFromCandidates(candidates, optionName) {
    const page = await this.ensureBrowser('wait-filechooser');

    let lastError = null;

    for (const candidate of candidates) {
      try {
        if (!(await candidate.count().catch(() => 0))) {
          continue;
        }

        await candidate.waitFor({
          state: 'visible',
          timeout: 1500
        });

        const [fileChooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 5000 }),
                                                candidate.click({ timeout: 5000 })
        ]);

        return fileChooser;
      } catch (err) {
        lastError = err;
      }
    }

    await addEvent(
      'media.filechooser_option_not_found',
      `No pude abrir el selector de archivo desde la opción ${optionName}.`,
      {
        optionName,
        error: lastError?.message || null
      }
    );

    throw new Error(`No pude encontrar o activar la opción de adjunto: ${optionName}`);
  }


  async uploadDocumentWithFileChooser(uploadPayload) {
    const page = await this.ensureBrowser('upload-document');

    await addEvent(
      'media.document_flow',
      `Usando flujo Documento para adjuntar: ${uploadPayload.name}`,
      {
        uploadName: uploadPayload.name,
        mimeType: uploadPayload.mimeType
      }
    );

    const candidates = [
      page.getByText('Documento', { exact: true }).first(),
      page.getByText('Document', { exact: true }).first(),
      page.locator('[aria-label*="Documento"]').first(),
      page.locator('[aria-label*="Document"]').first(),
      page.locator('[title*="Documento"]').first(),
      page.locator('[title*="Document"]').first(),
      page.locator('span').filter({ hasText: /^Documento$/ }).first(),
      page.locator('span').filter({ hasText: /^Document$/ }).first(),
      page.locator('div').filter({ hasText: /^Documento$/ }).first(),
      page.locator('div').filter({ hasText: /^Document$/ }).first()
    ];

    const fileChooser = await this.waitForFileChooserFromCandidates(
      candidates,
      'Documento'
    );

    await fileChooser.setFiles(uploadPayload);

    await addEvent(
      'media.document_selected',
      `PDF/documento seleccionado en file chooser: ${uploadPayload.name}`,
      {
        uploadName: uploadPayload.name,
        mimeType: uploadPayload.mimeType
      }
    );
  }

  async uploadMediaWithFileChooser(uploadPayload) {
    const page = await this.ensureBrowser('upload-media');

    await addEvent(
      'media.media_flow',
      `Usando flujo Foto/Video para adjuntar: ${uploadPayload.name}`,
      {
        uploadName: uploadPayload.name,
        mimeType: uploadPayload.mimeType
      }
    );

    const candidates = [
      page.getByText('Fotos y videos', { exact: true }).first(),
      page.getByText('Photos & videos', { exact: true }).first(),
      page.getByText('Photos and videos', { exact: true }).first(),
      page.getByText('Fotos', { exact: true }).first(),
      page.getByText('Photos', { exact: true }).first(),
      page.locator('[aria-label*="Fotos"]').first(),
      page.locator('[aria-label*="Photos"]').first(),
      page.locator('[aria-label*="Videos"]').first(),
      page.locator('[aria-label*="Vídeos"]').first(),
      page.locator('[title*="Fotos"]').first(),
      page.locator('[title*="Photos"]').first(),
      page.locator('[title*="Videos"]').first(),
      page.locator('[title*="Vídeos"]').first()
    ];

    const fileChooser = await this.waitForFileChooserFromCandidates(
      candidates,
      'Fotos/Videos'
    );

    await fileChooser.setFiles(uploadPayload);

    await addEvent(
      'media.media_selected',
      `Multimedia seleccionada en file chooser: ${uploadPayload.name}`,
      {
        uploadName: uploadPayload.name,
        mimeType: uploadPayload.mimeType
      }
    );
  }
  async clickSend() {
    const page = await this.ensureBrowser('click-send');

    const candidates = [
      page.locator('span[data-icon="send"]').last(),
      page.locator('span[data-icon="wds-ic-send-filled"]').last(),
      page.getByRole('button', { name: /send|enviar/i }).last(),
      page.locator('[aria-label*="Send" i], [aria-label*="Enviar" i]').last()
    ];

    for (const candidate of candidates) {
      try {
        await candidate.click({ timeout: 7000 });
        return;
      } catch {
        // Try next candidate.
      }
    }

    await page.keyboard.press('Enter');
  }

  async sendToRecipient({ name, message, mediaPath, mediaOriginalName }) {
    await this.openChatByName(name);

    if (mediaPath) {
      await this.sendMedia(mediaPath, '', {
        originalName: mediaOriginalName || path.basename(mediaPath)
      });

      if (message?.trim()) {
        await sleep(900);
        await this.sendText(message.trim());
      }
    } else if (message?.trim()) {
      await this.sendText(message.trim());
    }

    const settings = await getSettings();

    await sleep(
      rand(
        settings.minRecipientDelayMs || 2500,
        settings.maxRecipientDelayMs || 7000
      )
    );
  }

  startAutoResponder(getRules) {
    if (this.autoResponderTimer) return;

    this.autoResponderTimer = setInterval(async () => {
      if (this.autoResponderRunning) return;

      this.autoResponderRunning = true;

      try {
        const settings = await getSettings();

        if (!settings.autoResponderEnabled) {
          return;
        }

        const rules = (await getRules()).filter(rule => {
          const mediaPath =
          rule.media?.path ||
          rule.media?.filePath ||
          rule.media?.mediaPath ||
          rule.mediaPath;

          const hasResponse = rule.responseText?.trim() || mediaPath;

          // Global rules don't need keywords
          if (rule.isGlobal) {
            return rule.enabled && hasResponse;
          }

          // Specific rules need keywords
          return (
            rule.enabled &&
            rule.keywords?.length &&
            hasResponse
          );
        });

        if (!rules.length) {
          const now = Date.now();

          if (now - this.lastAutoResponderIdleLogAt > 60000) {
            this.lastAutoResponderIdleLogAt = now;

            await addEvent(
              'autoreply.no_rules',
              'Autorespuesta activada, pero no hay reglas habilitadas con respuesta válida.'
            );
          }

          return;
        }

        const state = await this.status();

        if (!state.browserOpen) {
          const now = Date.now();

          // Throttle: one log per minute, otherwise this floods events.json.
          if (now - this.lastAutoResponderClosedLogAt > 60000) {
            this.lastAutoResponderClosedLogAt = now;

            await addEvent(
              'autoreply.waiting_browser',
              'Autorespuesta activa, pero el navegador está cerrado. No se abre solo para monitorear mensajes.',
              {
                rulesEnabled: rules.length,
                display: state.runtime.display,
                mode: state.runtime.mode
              }
            );
          }

          return;
        }

        await this.ensureLoggedIn(120000);

        if (!this.autoResponderBootstrapped) {
          await this.captureUnreadSidebarBaseline();

          this.autoResponderBootstrapped = true;

          await addEvent(
            'autoreply.baseline_ready',
            'Autorespuesta inicializada. Se ignorarán los mensajes no leídos previos a esta apertura del navegador.',
            {
              rulesEnabled: rules.length
            }
          );

          return;
        }

        const now = Date.now();

        if (now - this.lastAutoResponderScanLogAt > 30000) {
          this.lastAutoResponderScanLogAt = now;

          await addEvent(
            'autoreply.scan_tick',
            'Autorespuesta escaneando nuevos mensajes no leídos desde el panel lateral.',
            {
              rulesEnabled: rules.length,
              knownUnreadCount: this.knownUnreadSidebarKeys.size
            }
          );
        }

        await this.processNewUnreadSidebarMessages(rules);
      } catch (err) {
        await addEvent(
          'autoreply.error',
          err.message,
          {
            stack: err.stack
          }
        );
      } finally {
        this.autoResponderRunning = false;
      }
    }, 5000);
  }

  stopAutoResponder() {
    if (this.autoResponderTimer) {
      clearInterval(this.autoResponderTimer);
    }

    this.autoResponderTimer = null;
  }

  async captureUnreadSidebarBaseline() {
    const page = await this.ensureBrowser('autoreply-baseline');
    const unreadItems = await this.getUnreadSidebarItems(page);

    this.knownUnreadSidebarKeys = new Set(
      unreadItems.map(item => item.key)
    );

    await addEvent(
      'autoreply.baseline_captured',
      `Base inicial de autorespuesta capturada: ${unreadItems.length} chat(s) no leído(s) serán ignorados.`
    );
  }

  async processNewUnreadSidebarMessages(rules) {
    const page = await this.ensureBrowser('autoreply-new-unread');
    const unreadItems = await this.getUnreadSidebarItems(page);

    if (!unreadItems.length) {
      return;
    }

    await addEvent(
      'autoreply.unread_scan_result',
      `Se detectaron ${unreadItems.length} chat(s) no leído(s) en el panel lateral.`,
                   {
                     unreadCount: unreadItems.length,
                     items: unreadItems.map(item => ({
                       chatName: item.chatName,
                       preview: item.preview?.slice(0, 140),
                                                     key: item.key?.slice(0, 180)
                     }))
                   }
    );

    for (const item of unreadItems) {
      if (this.knownUnreadSidebarKeys.has(item.key)) {
        continue;
      }

      this.knownUnreadSidebarKeys.add(item.key);

      const textToMatch = item.preview || item.rawText || '';

      await addEvent(
        'autoreply.new_unread',
        `Nuevo mensaje no leído detectado en ${item.chatName}.`,
        {
          chatName: item.chatName,
          preview: textToMatch.slice(0, 180),
                     rawText: item.rawText?.slice(0, 300)
        }
      );

      if (!textToMatch.trim()) {
        await addEvent(
          'autoreply.empty_preview',
          `Nuevo no leído en ${item.chatName}, pero no hay preview lateral usable.`,
          {
            chatName: item.chatName,
            rawText: item.rawText?.slice(0, 300)
          }
        );

        continue;
      }

      const rule = matchRule(textToMatch, rules);

      if (!rule) {
        await addEvent(
          'autoreply.no_match',
          `Nuevo mensaje no leído en ${item.chatName}, sin coincidencia de regla.`,
          {
            chatName: item.chatName,
            preview: textToMatch.slice(0, 180),
            checkedKeywords: rules.filter(r => !r.isGlobal).flatMap(rule => rule.keywords).slice(0, 50)
          }
        );

        continue;
      }

      const matchType = rule.isGlobal ? 'global' : 'keyword';
      const matchMessage = rule.isGlobal
        ? 'Regla global detectada para autorespuesta'
        : 'Palabra clave detectada para autorespuesta';

      await addEvent(
        'autoreply.keyword_match',
        `${matchMessage} en ${item.chatName}.`,
        {
          chatName: item.chatName,
          ruleId: rule.id,
          matchType,
          matchMode: rule.matchMode || 'contains',
          keywords: rule.isGlobal ? ['<global>'] : rule.keywords,
          preview: textToMatch.slice(0, 180)
        }
      );

      const sentKey = `${item.chatName}|${rule.id}|${item.key}`;

      if (await hasAutoReplySent(sentKey)) {
        await addEvent(
          'autoreply.duplicate_skip',
          `Autorespuesta omitida por duplicado en ${item.chatName}.`,
          {
            chatName: item.chatName,
            ruleId: rule.id,
            sentKey
          }
        );

        continue;
      }

      await this.openUnreadSidebarItem(item);

      if (rule.media?.path) {
        const autoReplyMediaPath =
        rule.media?.path ||
        rule.media?.filePath ||
        rule.media?.mediaPath ||
        rule.mediaPath ||
        null;

        if (autoReplyMediaPath) {
          await addEvent(
            'autoreply.media_start',
            `Enviando adjunto de autorespuesta a ${item.chatName}.`,
            {
              chatName: item.chatName,
              mediaPath: autoReplyMediaPath,
              ruleMedia: rule.media || null
            }
          );

          await this.sendMedia(autoReplyMediaPath, '', {
            originalName:
            rule.media?.originalName ||
            rule.media?.name ||
            rule.originalName ||
            path.basename(autoReplyMediaPath)
          });

          await addEvent(
            'autoreply.media_sent',
            `Adjunto de autorespuesta enviado a ${item.chatName}.`,
            {
              chatName: item.chatName,
              mediaPath: autoReplyMediaPath
            }
          );

          if (rule.responseText?.trim()) {
            await sleep(900);

            await addEvent(
              'autoreply.text_after_media_start',
              `Enviando texto posterior al adjunto a ${item.chatName}.`,
              {
                chatName: item.chatName,
                textPreview: rule.responseText.trim().slice(0, 180)
              }
            );

            await this.sendText(rule.responseText.trim());
          }
        } else if (rule.responseText?.trim()) {
          await addEvent(
            'autoreply.text_start',
            `Enviando texto de autorespuesta a ${item.chatName}.`,
            {
              chatName: item.chatName,
              textPreview: rule.responseText.trim().slice(0, 180)
            }
          );

          await this.sendText(rule.responseText.trim());
        } else {
          await addEvent(
            'autoreply.empty_response',
            `La regla ${rule.id} no tiene texto ni adjunto válido.`,
            {
              ruleId: rule.id,
              chatName: item.chatName,
              ruleMedia: rule.media || null
            }
          );

          continue;
        }

      } else if (rule.responseText?.trim()) {
        await addEvent(
          'autoreply.text_start',
          `Enviando texto de autorespuesta a ${item.chatName}.`,
          {
            chatName: item.chatName,
            textPreview: rule.responseText.trim().slice(0, 180)
          }
        );

        await this.sendText(rule.responseText.trim());
      } else {
        await addEvent(
          'autoreply.empty_response',
          `La regla ${rule.id} no tiene texto ni adjunto válido.`,
          {
            ruleId: rule.id,
            chatName: item.chatName
          }
        );

        continue;
      }

      await markAutoReplySent(sentKey, {
        chatName: item.chatName,
        ruleId: rule.id,
        sample: textToMatch.slice(0, 180)
      });

      await addEvent(
        'autoreply.sent',
        `Autorespuesta enviada a ${item.chatName}.`,
        {
          chatName: item.chatName,
          ruleId: rule.id
        }
      );

      await sleep(1200);
    }
  }

  async getUnreadSidebarItems(page) {
    return await page.evaluate(() => {
      const pane = document.querySelector('#pane-side');
      if (!pane) return [];

      const rows = Array.from(
        pane.querySelectorAll('[role="listitem"], [role="row"]')
      );

      const cleanLine = value => String(value || '').replace(/\s+/g, ' ').trim();

      const hasUnreadMarker = row => {
        const text = (row.innerText || '').toLowerCase();

        const aria = Array.from(row.querySelectorAll('[aria-label]'))
        .map(el => el.getAttribute('aria-label') || '')
        .join(' ')
        .toLowerCase();

        const title = Array.from(row.querySelectorAll('[title]'))
        .map(el => el.getAttribute('title') || '')
        .join(' ')
        .toLowerCase();

        const combined = `${text} ${aria} ${title}`;

        const hasExplicitUnreadText =
        combined.includes('unread') ||
        combined.includes('no leído') ||
        combined.includes('no leido') ||
        combined.includes('mensaje no leído') ||
        combined.includes('mensajes no leídos') ||
        combined.includes('mensaje no leido') ||
        combined.includes('mensajes no leidos');

        if (hasExplicitUnreadText) return true;

        const badgeCandidates = Array.from(row.querySelectorAll('span, div'))
        .filter(el => {
          const value = cleanLine(el.textContent || '');
          if (!/^\d{1,3}$/.test(value)) return false;

          const rect = el.getBoundingClientRect();
          if (!rect.width || !rect.height) return false;

          // Unread badges are usually small numeric pills on the right side.
          return rect.width <= 40 && rect.height <= 40;
        });

        return badgeCandidates.length > 0;
      };

      return rows
      .map((row, domIndex) => {
        if (!hasUnreadMarker(row)) return null;

        const titleEl = row.querySelector('span[title]');

        const chatName = cleanLine(
          titleEl?.getAttribute('title') ||
          row.querySelector('[title]')?.getAttribute('title') ||
          ''
        );

        const rawText = cleanLine(row.innerText || '');

        const lines = (row.innerText || '')
        .split('\n')
        .map(cleanLine)
        .filter(Boolean);

        const previewLines = lines.filter(line => {
          if (!line) return false;
          if (chatName && line === chatName) return false;

          if (/^\d{1,2}:\d{2}$/.test(line)) return false;
          if (/^(ayer|yesterday|hoy|today)$/i.test(line)) return false;
          if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(line)) return false;

          // Unread badge count.
          if (/^\d{1,3}$/.test(line)) return false;

          if (/^(typing|escribiendo|grabando audio)/i.test(line)) return false;

          return true;
        });

        const preview = cleanLine(previewLines.join(' '));

        if (!chatName && !rawText) return null;

        const key = `${chatName || 'unknown'}|${rawText}`;

        return {
          domIndex,
          chatName: chatName || 'chat',
          preview,
          rawText,
          key
        };
      })
      .filter(Boolean);
    });
  }

  async openUnreadSidebarItem(item) {
    const page = await this.ensureBrowser('autoreply-open-unread');

    const rows = page.locator('#pane-side [role="listitem"], #pane-side [role="row"]');
    const row = rows.nth(item.domIndex);

    await row.click({ timeout: 7000 });
    await sleep(900);

    try {
      await this.verifyCurrentChat(item.chatName);
    } catch {
      await addEvent(
        'autoreply.verify_warning',
        `No pude verificar con exactitud el chat abierto para ${item.chatName}.`,
        { chatName: item.chatName }
      );
    }
  }

  async waitForChatReady() {
    const page = await this.ensureBrowser('wait-chat-ready');

    await page.waitForFunction(() => {
      const editableBoxes = Array.from(
        document.querySelectorAll('[contenteditable="true"][role="textbox"]')
      );

      return editableBoxes.some(el => {
        const label = (
          el.getAttribute('aria-label') ||
          el.getAttribute('data-tab') ||
          ''
        ).toLowerCase();

        const text = (el.innerText || '').trim();

        return (
          label.includes('message') ||
          label.includes('mensaje') ||
          text.length === 0
        );
      });
    }, { timeout: 15000 });
  }

  async waitForAttachmentPreview(filePath = '', attachmentKind = 'media', uploadName = '') {
    const page = await this.ensureBrowser('wait-attachment-preview');

    const fileName = uploadName || path.basename(filePath || '');

    await page.waitForFunction(
      ({ fileName, attachmentKind }) => {
        const bodyText = document.body.innerText || '';
        const lowerBody = bodyText.toLowerCase();
        const lowerFileName = String(fileName || '').toLowerCase();

        const hasSendIcon =
        document.querySelector('span[data-icon="send"]') ||
        document.querySelector('span[data-icon="wds-ic-send-filled"]') ||
        document.querySelector('[aria-label="Send"]') ||
        document.querySelector('[aria-label="Enviar"]');

        const hasMediaPreview =
        document.querySelector('img[src^="blob:"]') ||
        document.querySelector('video[src^="blob:"]') ||
        document.querySelector('canvas');

        const hasFileName =
        lowerFileName &&
        lowerBody.includes(lowerFileName);

        const hasDocumentLikeText =
        lowerBody.includes('.pdf') ||
        lowerBody.includes('document') ||
        lowerBody.includes('documento') ||
        lowerBody.includes('archivo');

        const hasCaptionOrComposerText =
        lowerBody.includes('add a caption') ||
        lowerBody.includes('añade un comentario') ||
        lowerBody.includes('escribe un mensaje') ||
        lowerBody.includes('type a message');

        if (attachmentKind === 'media') {
          return Boolean(
            hasSendIcon &&
            (hasMediaPreview || hasFileName || hasCaptionOrComposerText)
          );
        }

        return Boolean(
          hasSendIcon &&
          (hasFileName || hasDocumentLikeText || hasCaptionOrComposerText)
        );
      },
      {
        fileName,
        attachmentKind
      },
      {
        timeout: 30000
      }
    );
  }

  async clearAttachmentCaptionIfPresent() {
    const page = await this.ensureBrowser('clear-attachment-caption');

    const boxes = page.locator('[contenteditable="true"][role="textbox"]');
    const count = await boxes.count();

    for (let i = 0; i < count; i++) {
      const box = boxes.nth(i);
      const aria = ((await box.getAttribute('aria-label')) || '').toLowerCase();

      if (
        aria.includes('caption') ||
        aria.includes('comentario') ||
        aria.includes('mensaje')
      ) {
        try {
          await box.click({ timeout: 1000 });
          await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
          await page.keyboard.press('Backspace');
        } catch {
          // Ignore: some WhatsApp builds do not expose a caption box.
        }
      }
    }
  }


  async clickAttachmentSendButton() {
    const page = await this.ensureBrowser('click-attachment-send');

    const sendCandidates = [
      'span[data-icon="send"]',
      'span[data-icon="wds-ic-send-filled"]',
      '[aria-label="Send"]',
      '[aria-label="Enviar"]'
    ];

    for (const selector of sendCandidates) {
      const candidate = page.locator(selector).last();

      try {
        await candidate.click({ timeout: 3000 });
        await page.waitForTimeout(500);
        return;
      } catch {
        // Try next candidate.
      }
    }

    await page.keyboard.press('Enter');
  }
}

function getAttachmentKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  const imageExts = new Set([
    '.jpg',
    '.jpeg',
    '.png',
    '.webp',
    '.gif',
    '.bmp'
  ]);

  const videoExts = new Set([
    '.mp4',
    '.mov',
    '.m4v',
    '.webm',
    '.avi',
    '.mkv'
  ]);

  if (imageExts.has(ext)) return 'media';
  if (videoExts.has(ext)) return 'media';

  return 'document';
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  const map = {
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
    '.rar': 'application/vnd.rar',
    '.7z': 'application/x-7z-compressed',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm'
  };

  return map[ext] || 'application/octet-stream';
}

function sanitizeUploadName(name, fallbackPath) {
  const fallback = path.basename(fallbackPath || 'archivo');

  const raw = String(name || fallback)
  .replace(/[\/\\]/g, '-')
  .replace(/\s+/g, ' ')
  .trim();

  return raw || fallback;
}

async function buildUploadPayload(filePath, originalName = '') {
  const buffer = await fs.readFile(filePath);

  return {
    name: sanitizeUploadName(originalName, filePath),
    mimeType: getMimeType(filePath),
    buffer
  };
}

async function resolveExistingMediaPath(filePath) {
  if (!filePath) return null;

  const candidates = [];

  if (path.isAbsolute(filePath)) {
    candidates.push(filePath);
  } else {
    candidates.push(path.resolve(process.cwd(), filePath));
    candidates.push(path.resolve(process.cwd(), 'data', filePath));
    candidates.push(path.resolve(process.cwd(), 'data', 'media', filePath));
    candidates.push(path.resolve(process.cwd(), 'media', filePath));
  }

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

function matchRule(text, rules) {
  const source = normalize(text);

  // First try to match specific keyword rules
  const specificMatch = rules.find(rule =>
    !rule.isGlobal &&
    rule.keywords.some(keyword => {
      const normalizedKeyword = normalize(keyword);

      if (!normalizedKeyword) return false;

      if (rule.matchMode === 'exact') {
        return source === normalizedKeyword;
      }

      if (rule.matchMode === 'word') {
        return new RegExp(
          `(^|\\s)${escapeRegExp(normalizedKeyword)}(\\s|$)`,
                          'i'
        ).test(source);
      }

      return source.includes(normalizedKeyword);
    })
  );

  if (specificMatch) return specificMatch;

  // If no specific match, try to find a global rule
  return rules.find(rule => rule.isGlobal && rule.enabled);
}

function normalize(value) {
  return String(value || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeForCssAttribute(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeForTextSelector(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
