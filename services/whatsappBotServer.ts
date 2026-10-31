import * as BaileysRaw from "@whiskeysockets/baileys";
import type { WASocket, ConnectionState } from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

/**
 * Universal Baileys resolver that guarantees function availability
 * across ESM, CommonJS, and esbuild bundled dist/server.cjs.
 */
export function getBaileys() {
  const b = BaileysRaw as any;
  const makeWASocket =
    (typeof b.makeWASocket === "function" ? b.makeWASocket : null) ||
    (typeof b.default === "function" ? b.default : null) ||
    (typeof b.default?.default === "function" ? b.default.default : null) ||
    (typeof b.default?.makeWASocket === "function" ? b.default.makeWASocket : null) ||
    (typeof b === "function" ? b : null);

  const useMultiFileAuthState =
    (typeof b.useMultiFileAuthState === "function" ? b.useMultiFileAuthState : null) ||
    (typeof b.default?.useMultiFileAuthState === "function" ? b.default.useMultiFileAuthState : null) ||
    (typeof b.default?.default?.useMultiFileAuthState === "function" ? b.default.default.useMultiFileAuthState : null);

  const DisconnectReason =
    b.DisconnectReason ||
    b.default?.DisconnectReason ||
    b.default?.default?.DisconnectReason ||
    { loggedOut: 401, connectionReplaced: 440 };

  const Browsers =
    b.Browsers ||
    b.default?.Browsers ||
    b.default?.default?.Browsers;

  const fetchLatestBaileysVersion =
    b.fetchLatestBaileysVersion ||
    b.default?.fetchLatestBaileysVersion ||
    b.default?.default?.fetchLatestBaileysVersion;

  return { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion };
}

export interface WhatsAppBotStatus {
  isConnected: boolean;
  isConnecting: boolean;
  qrCodeDataUrl: string | null;
  userPhone: string | null;
  userName: string | null;
  error: string | null;
  lastConnectedAt: string | null;
  accountId?: string;
}

export interface WhatsAppBotLogEntry {
  time: string;
  level: "info" | "warn" | "error";
  message: string;
}

const SUPABASE_URL = "https://hoeealjgmfjbojjyodql.supabase.co";
const SUPABASE_KEY = "sb_publishable_Vq7v3naqK8moAXa-L8EwOw_Rpjc55mw";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * Sanitize accountId to ensure safe file paths and database keys.
 */
export function sanitizeAccountId(rawId?: string | null): string {
  if (!rawId || typeof rawId !== "string") return "default";
  const trimmed = rawId.trim();
  if (!trimmed || trimmed === "null" || trimmed === "undefined") return "default";
  const safe = trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
  return safe || "default";
}

function getCloudBackupKey(accountId: string): string {
  const safe = sanitizeAccountId(accountId);
  return safe === "default" ? "whatsapp_bot_session_backup" : `whatsapp_bot_session_backup_${safe}`;
}

function getCloudStatusKey(accountId: string): string {
  const safe = sanitizeAccountId(accountId);
  return safe === "default" ? "whatsapp_bot_status" : `whatsapp_bot_status_${safe}`;
}

const SESSIONS_ROOT_DIR = path.join(process.cwd(), "whatsapp_sessions");

function getSessionDir(accountId: string): string {
  const safe = sanitizeAccountId(accountId);
  return path.join(SESSIONS_ROOT_DIR, safe);
}

function ensureSessionDir(accountId: string) {
  const dir = getSessionDir(accountId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Backward compatibility: If "default" session folder is empty, check legacy "whatsapp_session"
  if (sanitizeAccountId(accountId) === "default") {
    const legacyDir = path.join(process.cwd(), "whatsapp_session");
    try {
      if (fs.existsSync(legacyDir) && (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0)) {
        const legacyFiles = fs.readdirSync(legacyDir);
        if (legacyFiles.length > 0) {
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          for (const f of legacyFiles) {
            const src = path.join(legacyDir, f);
            const dst = path.join(dir, f);
            if (fs.statSync(src).isFile()) {
              fs.copyFileSync(src, dst);
            }
          }
          console.log(`[WhatsApp Bot] Migrated legacy session files to whatsapp_sessions/default/`);
        }
      }
    } catch (migErr) {
      console.warn("[WhatsApp Bot] Legacy session migration warning:", migErr);
    }
  }
}

interface BotInstance {
  accountId: string;
  sock: WASocket | null;
  status: WhatsAppBotStatus;
  isManualDisconnect: boolean;
  reconnectTimer: NodeJS.Timeout | null;
  connectingPromise: Promise<WhatsAppBotStatus> | null;
  saveCloudTimer: NodeJS.Timeout | null;
  reconnectAttempts: number;
  recentSends: Map<string, number>;
  logs: WhatsAppBotLogEntry[];
  lastConnectAttempt: number;
}

const botInstances = new Map<string, BotInstance>();

function getOrCreateBotInstance(rawAccountId?: string | null): BotInstance {
  const accountId = sanitizeAccountId(rawAccountId);
  let instance = botInstances.get(accountId);
  if (!instance) {
    instance = {
      accountId,
      sock: null,
      status: {
        isConnected: false,
        isConnecting: false,
        qrCodeDataUrl: null,
        userPhone: null,
        userName: null,
        error: null,
        lastConnectedAt: null,
        accountId,
      },
      isManualDisconnect: false,
      reconnectTimer: null,
      connectingPromise: null,
      saveCloudTimer: null,
      reconnectAttempts: 0,
      recentSends: new Map<string, number>(),
      logs: [],
      lastConnectAttempt: 0,
    };
    botInstances.set(accountId, instance);
  }
  return instance;
}

export function logBot(accountId: string, level: "info" | "warn" | "error", message: string) {
  const instance = getOrCreateBotInstance(accountId);
  const time = new Date().toLocaleTimeString("ar-SA", { hour12: false });
  instance.logs.unshift({ time, level, message });
  if (instance.logs.length > 60) instance.logs.pop();
  console.log(`[WhatsApp Bot (${instance.accountId}) ${level.toUpperCase()}] ${message}`);
}

export function hasExistingSession(rawAccountId?: string | null): boolean {
  try {
    const accountId = sanitizeAccountId(rawAccountId);
    const sessionDir = getSessionDir(accountId);
    if (fs.existsSync(sessionDir)) {
      const files = fs.readdirSync(sessionDir);
      if (files.some((f) => f.startsWith("creds.json") || f.includes("session"))) {
        return true;
      }
    }
    // Check legacy directory for default account
    if (accountId === "default") {
      const legacyDir = path.join(process.cwd(), "whatsapp_session");
      if (fs.existsSync(legacyDir)) {
        const files = fs.readdirSync(legacyDir);
        return files.some((f) => f.startsWith("creds.json") || f.includes("session"));
      }
    }
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * Backup WhatsApp session credentials from local disk to Supabase settings table for a specific account.
 */
export async function saveSessionToCloud(rawAccountId?: string | null): Promise<boolean> {
  const accountId = sanitizeAccountId(rawAccountId);
  const instance = getOrCreateBotInstance(accountId);
  const sessionDir = getSessionDir(accountId);

  try {
    ensureSessionDir(accountId);
    const fileNames = fs.readdirSync(sessionDir);
    if (!fileNames.includes("creds.json")) {
      return false;
    }

    const files: Record<string, string> = {};
    for (const f of fileNames) {
      const fullPath = path.join(sessionDir, f);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          files[f] = fs.readFileSync(fullPath).toString("base64");
        }
      } catch (readErr) {
        console.warn(`[WhatsApp Bot (${accountId})] Could not read session file ${f}:`, readErr);
      }
    }

    if (!files["creds.json"]) {
      return false;
    }

    const backupKey = getCloudBackupKey(accountId);
    const statusKey = getCloudStatusKey(accountId);

    const { error: sessionError } = await supabase.from("settings").upsert(
      {
        key: backupKey,
        value: {
          accountId,
          files,
          updatedAt: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" }
    );

    if (sessionError) {
      console.error(`[WhatsApp Bot (${accountId})] Failed to backup session to Supabase:`, sessionError);
      return false;
    }

    // Also persist connection metadata in Supabase
    await supabase.from("settings").upsert(
      {
        key: statusKey,
        value: {
          ...instance.status,
          accountId,
          isConnecting: false,
          qrCodeDataUrl: null,
          updatedAt: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" }
    );

    console.log(
      `[WhatsApp Bot (${accountId})] Session backed up to Supabase cloud successfully (${Object.keys(files).length} files, key: ${backupKey}).`
    );
    return true;
  } catch (err: any) {
    console.error(`[WhatsApp Bot (${accountId})] saveSessionToCloud error:`, err);
    return false;
  }
}

function debouncedSaveSessionToCloud(rawAccountId?: string | null) {
  const accountId = sanitizeAccountId(rawAccountId);
  const instance = getOrCreateBotInstance(accountId);
  if (instance.saveCloudTimer) clearTimeout(instance.saveCloudTimer);
  instance.saveCloudTimer = setTimeout(() => {
    saveSessionToCloud(accountId).catch((e) =>
      console.error(`[WhatsApp Bot (${accountId})] Cloud save failed:`, e)
    );
  }, 2000);
}

/**
 * Restore WhatsApp session credentials from Supabase cloud backup to local disk for a specific account.
 */
export async function restoreSessionFromCloud(rawAccountId?: string | null): Promise<boolean> {
  const accountId = sanitizeAccountId(rawAccountId);
  const instance = getOrCreateBotInstance(accountId);
  const sessionDir = getSessionDir(accountId);
  const backupKey = getCloudBackupKey(accountId);
  const statusKey = getCloudStatusKey(accountId);

  try {
    const { data, error } = await supabase
      .from("settings")
      .select("value")
      .eq("key", backupKey)
      .maybeSingle();

    if (error || !data || !data.value || !data.value.files) {
      return false;
    }

    const files = data.value.files;
    if (!files["creds.json"]) {
      return false;
    }

    ensureSessionDir(accountId);
    let writtenCount = 0;
    for (const [fName, b64] of Object.entries(files)) {
      if (typeof b64 === "string") {
        const fullPath = path.join(sessionDir, fName);
        fs.writeFileSync(fullPath, Buffer.from(b64, "base64"));
        writtenCount++;
      }
    }

    // If status backup exists, hydrate basic phone info
    try {
      const { data: statusData } = await supabase
        .from("settings")
        .select("value")
        .eq("key", statusKey)
        .maybeSingle();
      if (statusData && statusData.value) {
        const val = statusData.value;
        if (val.userPhone) instance.status.userPhone = val.userPhone;
        if (val.userName) instance.status.userName = val.userName;
        if (val.lastConnectedAt) instance.status.lastConnectedAt = val.lastConnectedAt;
      }
    } catch (sErr) {}

    console.log(
      `[WhatsApp Bot (${accountId})] Restored session from Supabase cloud (${writtenCount} files from key: ${backupKey}).`
    );
    return true;
  } catch (err) {
    console.error(`[WhatsApp Bot (${accountId})] restoreSessionFromCloud error:`, err);
    return false;
  }
}

export function formatWhatsAppPhone(phone: string): string {
  if (!phone) return "";
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }
  // Saudi local mobile starting with 05 (10 digits) or 5 (9 digits)
  if (digits.startsWith("05") && digits.length === 10) {
    digits = "966" + digits.slice(1);
  } else if (digits.startsWith("5") && digits.length === 9) {
    digits = "966" + digits;
  }
  // Morocco local mobile starting with 06 or 07 (10 digits)
  else if ((digits.startsWith("06") || digits.startsWith("07")) && digits.length === 10) {
    digits = "212" + digits.slice(1);
  }
  digits = digits.replace(/^0+/, "");
  return digits;
}

export function formatToJid(phone: string): string {
  const digits = formatWhatsAppPhone(phone);
  return `${digits}@s.whatsapp.net`;
}

let cachedBaileysVersion: [number, number, number] | null = null;
async function getBaileysVersion(): Promise<[number, number, number]> {
  if (cachedBaileysVersion) return cachedBaileysVersion;
  try {
    const { fetchLatestBaileysVersion } = getBaileys();
    if (typeof fetchLatestBaileysVersion === "function") {
      const res = await fetchLatestBaileysVersion();
      if (res?.version && Array.isArray(res.version) && res.version.length === 3) {
        cachedBaileysVersion = res.version as [number, number, number];
        return cachedBaileysVersion;
      }
    }
  } catch (e) {}
  return [2, 3000, 1043857760];
}

export function getWhatsAppStatus(rawAccountId?: string | null): WhatsAppBotStatus {
  const accountId = sanitizeAccountId(rawAccountId);
  const instance = getOrCreateBotInstance(accountId);
  return { ...instance.status, accountId };
}

export async function connectWhatsAppBot(
  rawAccountId?: string | null,
  forceNewQR = false
): Promise<WhatsAppBotStatus> {
  const accountId = sanitizeAccountId(rawAccountId);
  const instance = getOrCreateBotInstance(accountId);
  const sessionDir = getSessionDir(accountId);

  if (!forceNewQR && instance.sock && instance.status.isConnected) {
    return getWhatsAppStatus(accountId);
  }

  if (!forceNewQR && instance.connectingPromise) {
    return instance.connectingPromise;
  }

  const now = Date.now();
  if (!forceNewQR && now - instance.lastConnectAttempt < 8000) {
    return getWhatsAppStatus(accountId);
  }
  instance.lastConnectAttempt = now;

  // If force requested or clean QR wanted, terminate existing socket and wipe session directory
  if (forceNewQR) {
    console.log(
      `[WhatsApp Bot (${accountId})] Force new QR requested: clearing old session files and restarting socket...`
    );
    instance.isManualDisconnect = true;
    if (instance.reconnectTimer) {
      clearTimeout(instance.reconnectTimer);
      instance.reconnectTimer = null;
    }
    instance.reconnectAttempts = 0;

    if (instance.sock) {
      try {
        instance.sock.ev.removeAllListeners("connection.update");
        instance.sock.ev.removeAllListeners("creds.update");
        instance.sock.end(undefined);
      } catch (e) {}
      instance.sock = null;
    }

    try {
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
      fs.mkdirSync(sessionDir, { recursive: true });
    } catch (e) {
      console.warn(`[WhatsApp Bot (${accountId})] Could not wipe sessionDir:`, e);
    }

    try {
      const backupKey = getCloudBackupKey(accountId);
      const statusKey = getCloudStatusKey(accountId);
      await supabase.from("settings").delete().in("key", [backupKey, statusKey]);
    } catch (e) {}

    instance.status = {
      isConnected: false,
      isConnecting: true,
      qrCodeDataUrl: null,
      userPhone: null,
      userName: null,
      error: null,
      lastConnectedAt: null,
      accountId,
    };
  } else {
    // Normal connect: try to restore cloud backup only if local session doesn't exist
    if (!hasExistingSession(accountId)) {
      try {
        await restoreSessionFromCloud(accountId);
      } catch (e) {}
    }
  }

  instance.isManualDisconnect = false;
  instance.status.isConnecting = true;
  instance.status.error = null;
  instance.status.accountId = accountId;

  instance.connectingPromise = new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (status: WhatsAppBotStatus) => {
      if (!resolved) {
        resolved = true;
        resolve(status);
      }
    };

    (async () => {
      try {
        ensureSessionDir(accountId);
        logBot(accountId, "info", "بدء تجهيز جلسة الواتساب ومحرك Baileys...");

        const { makeWASocket, useMultiFileAuthState, DisconnectReason } = getBaileys();
        if (typeof makeWASocket !== "function") {
          throw new Error(`مكتبة Baileys makeWASocket غير متاحة كدالة (النوع: ${typeof makeWASocket})`);
        }
        if (typeof useMultiFileAuthState !== "function") {
          throw new Error(`مكتبة Baileys useMultiFileAuthState غير متاحة كدالة (النوع: ${typeof useMultiFileAuthState})`);
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const logger = pino({ level: "silent" });

        // If old credentials exist but socket has already failed multiple times, wipe them to force QR
        if (instance.reconnectAttempts >= 3 && !instance.status.isConnected) {
          logBot(accountId, "warn", "تجاوز محاولات الاتصال مع ملفات قديمة. جاري مسح الجلسة لإنشاء رمز QR جديد...");
          try {
            if (fs.existsSync(sessionDir)) {
              fs.rmSync(sessionDir, { recursive: true, force: true });
            }
            fs.mkdirSync(sessionDir, { recursive: true });
          } catch (e) {}
          instance.reconnectAttempts = 0;
        }

        // Close any prior socket before creating new one
        if (instance.sock) {
          try {
            instance.sock.ev.removeAllListeners("connection.update");
            instance.sock.ev.removeAllListeners("creds.update");
            if ((instance.sock as any).ws) {
              try { (instance.sock as any).ws.close(); } catch (e) {}
            }
            instance.sock.end(undefined);
          } catch (e) {}
          instance.sock = null;
          await new Promise((r) => setTimeout(r, 1200));
        }

        const version = await getBaileysVersion();
        const { Browsers } = getBaileys();
        const browserTuple = Browsers?.macOS ? Browsers.macOS("Chrome") : ["Mac OS", "Chrome", "14.4.1"];

        logBot(accountId, "info", `جاري إنشاء اتصال WASocket جديد (الإصدار: ${version.join(".")})...`);
        const newSock = makeWASocket({
          version,
          auth: state,
          logger,
          printQRInTerminal: false,
          browser: browserTuple,
          connectTimeoutMs: 60000,
          defaultQueryTimeoutMs: 60000,
          keepAliveIntervalMs: 30000,
          syncFullHistory: false,
          generateHighQualityLinkPreview: false,
          markOnlineOnConnect: false,
        });
        instance.sock = newSock;

        newSock.ev.on("creds.update", async () => {
          try {
            await saveCreds();
            debouncedSaveSessionToCloud(accountId);
          } catch (e) {
            logBot(accountId, "error", `خطأ أثناء حفظ بيانات الاعتماد: ${e}`);
          }
        });

        newSock.ev.on("connection.update", async (update: Partial<ConnectionState>) => {
          const { connection, lastDisconnect, qr } = update;

          if (qr) {
            try {
              const dataUrl = await QRCode.toDataURL(qr, {
                margin: 2,
                width: 300,
                color: {
                  dark: "#0f172a",
                  light: "#ffffff",
                },
              });
              instance.status.qrCodeDataUrl = dataUrl;
              instance.status.isConnecting = true;
              instance.status.isConnected = false;
              instance.status.error = null;
              logBot(accountId, "info", "تم توليد رمز QR بنجاح، بانتظار مسحه من تطبيق واتساب.");
              safeResolve(getWhatsAppStatus(accountId));
            } catch (qrErr: any) {
              logBot(accountId, "error", `فشل تحويل رمز QR إلى صورة: ${qrErr.message}`);
            }
          }

          if (connection === "open") {
            instance.status.isConnected = true;
            instance.status.isConnecting = false;
            instance.status.qrCodeDataUrl = null;
            instance.status.error = null;
            instance.status.lastConnectedAt = new Date().toISOString();
            instance.reconnectAttempts = 0;
            instance.connectingPromise = null;

            const rawId = newSock?.user?.id || "";
            const phoneOnly = rawId.split(":")[0]?.split("@")[0] || "";
            instance.status.userPhone = phoneOnly ? `+${phoneOnly}` : "متصل";
            instance.status.userName = newSock?.user?.name || "جوال المغسلة";

            logBot(accountId, "info", `تم الاتصال بنجاح برقم: ${instance.status.userPhone} (${instance.status.userName})`);

            // Immediate cloud persistence upon opening connection
            saveSessionToCloud(accountId).catch((err) => {
              logBot(accountId, "warn", `فشل حفظ الجلسة في السحابة: ${err}`);
            });

            safeResolve(getWhatsAppStatus(accountId));
          }

          if (connection === "close") {
            instance.status.isConnected = false;
            instance.connectingPromise = null;
            const err = lastDisconnect?.error as any;
            const statusCode = err?.output?.statusCode || err?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403;
            const isReplaced = statusCode === DisconnectReason.connectionReplaced || statusCode === 440;

            logBot(accountId, "warn", `أُغلق اتصال الواتساب. الرمز: ${statusCode}, خروج: ${isLoggedOut}, استبدال: ${isReplaced}`);

            if (isLoggedOut || instance.isManualDisconnect) {
              instance.status.isConnecting = false;
              instance.status.qrCodeDataUrl = null;
              instance.status.userPhone = null;
              instance.status.userName = null;
              instance.reconnectAttempts = 0;

              try {
                if (fs.existsSync(sessionDir)) {
                  fs.rmSync(sessionDir, { recursive: true, force: true });
                }
              } catch (e) {
                console.error(`[WhatsApp Bot (${accountId})] Failed to remove session dir:`, e);
              }

              try {
                const backupKey = getCloudBackupKey(accountId);
                const statusKey = getCloudStatusKey(accountId);
                await supabase.from("settings").delete().in("key", [backupKey, statusKey]);
              } catch (delErr) {}

              instance.sock = null;
              safeResolve(getWhatsAppStatus(accountId));
            } else if (isReplaced) {
              // Code 440 (connectionReplaced): Another connection or phone took priority.
              // Do NOT delete session files, do NOT reconnect in a tight loop.
              instance.status.isConnecting = false;
              instance.reconnectAttempts = 0;
              instance.sock = null;
              logBot(accountId, "info", "تم تعليق الاتصال مؤقتاً لتجنب التعارض (440). سيتم التوصيل التلقائي عند إرسال رسالة.");
              safeResolve(getWhatsAppStatus(accountId));
            } else {
              instance.reconnectAttempts++;
              if (instance.reconnectAttempts > 8) {
                logBot(accountId, "warn", "تم إيقاف محاولات إعادة الاتصال التلقائية مؤقتاً. الجلسة محفوظة وستعمل عند إرسال رسالة.");
                instance.status.isConnecting = false;
                safeResolve(getWhatsAppStatus(accountId));
                return;
              }

              instance.status.isConnecting = true;
              if (instance.reconnectTimer) clearTimeout(instance.reconnectTimer);
              const delay = Math.min(instance.reconnectAttempts * 3000 + 2000, 20000);
              instance.reconnectTimer = setTimeout(() => {
                if (!instance.isManualDisconnect) {
                  logBot(accountId, "info", `محاولة إعادة الاتصال التلقائي (${instance.reconnectAttempts})...`);
                  connectWhatsAppBot(accountId);
                }
              }, delay);
              safeResolve(getWhatsAppStatus(accountId));
            }
          }
        });

        // Timeout safety: if after 6 seconds neither QR nor connection arrived, resolve current status
        setTimeout(() => {
          safeResolve(getWhatsAppStatus(accountId));
        }, 6000);
      } catch (err: any) {
        logBot(accountId, "error", `فشل بدء جلسة الواتساب: ${err?.message || err}`);
        instance.status.isConnecting = false;
        instance.status.error = err?.message || "فشل بدء جلسة الواتساب";
        safeResolve(getWhatsAppStatus(accountId));
      } finally {
        instance.connectingPromise = null;
      }
    })();
  });

  return instance.connectingPromise;
}

export async function disconnectWhatsAppBot(rawAccountId?: string | null): Promise<WhatsAppBotStatus> {
  const accountId = sanitizeAccountId(rawAccountId);
  const instance = getOrCreateBotInstance(accountId);
  const sessionDir = getSessionDir(accountId);

  instance.isManualDisconnect = true;
  if (instance.reconnectTimer) {
    clearTimeout(instance.reconnectTimer);
    instance.reconnectTimer = null;
  }

  if (instance.sock) {
    try {
      await instance.sock.logout();
    } catch (e) {}
    try {
      instance.sock.end(undefined);
    } catch (e) {}
    instance.sock = null;
  }

  try {
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error(`[WhatsApp Bot (${accountId})] Failed to clean session folder:`, e);
  }

  try {
    const backupKey = getCloudBackupKey(accountId);
    const statusKey = getCloudStatusKey(accountId);
    await supabase.from("settings").delete().in("key", [backupKey, statusKey]);
    console.log(`[WhatsApp Bot (${accountId})] Cleared Supabase cloud session on disconnect.`);
  } catch (e) {
    console.error(`[WhatsApp Bot (${accountId})] Failed to clear Supabase cloud session:`, e);
  }

  instance.status = {
    isConnected: false,
    isConnecting: false,
    qrCodeDataUrl: null,
    userPhone: null,
    userName: null,
    error: null,
    lastConnectedAt: null,
    accountId,
  };

  return getWhatsAppStatus(accountId);
}

export async function sendWhatsAppMessageAndPdf(params: {
  accountId?: string;
  toPhone: string;
  message: string;
  pdfBase64?: string;
  pdfFileName?: string;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const { toPhone, message, pdfBase64, pdfFileName } = params;
  const accountId = sanitizeAccountId(params.accountId);
  const instance = getOrCreateBotInstance(accountId);

  if (!toPhone) {
    return { success: false, error: "رقم هاتف العميل مطلوب" };
  }

  // If not connected yet for this specific account, try auto-connecting from cloud session before failing
  if (!instance.sock || !instance.status.isConnected) {
    if (hasExistingSession(accountId)) {
      try {
        await connectWhatsAppBot(accountId);
      } catch (e) {}
    } else {
      const restored = await restoreSessionFromCloud(accountId);
      if (restored) {
        try {
          await connectWhatsAppBot(accountId);
        } catch (e) {}
      }
    }

    // Give socket up to 5 seconds to complete connection handshake
    let waitLoops = 0;
    while (!instance.status.isConnected && instance.status.isConnecting && waitLoops < 12) {
      await new Promise((r) => setTimeout(r, 400));
      waitLoops++;
    }
  }

  if (!instance.sock || !instance.status.isConnected) {
    return {
      success: false,
      error: `بوت الواتساب للحساب (${accountId}) غير متصل حالياً. يرجى مسح رمز QR لربط جوال المغسلة من الإعدادات.`,
    };
  }

  const cleanPhone = toPhone.replace(/\D/g, "");
  const orderMatch = message.match(/(?:ORD-|\b#)(\w+)/i);
  const dedupKey = `${cleanPhone}_${orderMatch ? orderMatch[1] : message.slice(0, 35)}`;

  try {
    const now = Date.now();
    const lastSendTime = instance.recentSends.get(dedupKey);

    if (lastSendTime && now - lastSendTime < 15000) {
      console.log(
        `[WhatsApp Bot (${accountId})] Prevented duplicate send to ${cleanPhone} (${dedupKey}) within 15s window.`
      );
      return { success: true, messageId: "dedup-cached" };
    }
    instance.recentSends.set(dedupKey, now);

    const jid = formatToJid(toPhone);

    // 1. Send the primary text message
    const sentMsg = await instance.sock.sendMessage(jid, { text: message });

    // 2. If PDF invoice is provided, send the document directly
    if (pdfBase64) {
      try {
        const cleanBase64 = pdfBase64.replace(/^data:[^;]+;base64,/, "");
        const pdfBuffer = Buffer.from(cleanBase64, "base64");

        const fileName = pdfFileName || "فاتورة_الطلب.pdf";
        await instance.sock.sendMessage(jid, {
          document: pdfBuffer,
          mimetype: "application/pdf",
          fileName: fileName,
          caption: "📄 نسخة الفاتورة الرسمية بصيغة PDF",
        });
      } catch (pdfSendErr: any) {
        console.error(`[WhatsApp Bot (${accountId})] Error sending PDF attachment:`, pdfSendErr);
      }
    }

    return { success: true, messageId: sentMsg?.key?.id || undefined };
  } catch (err: any) {
    instance.recentSends.delete(dedupKey);
    console.error(`[WhatsApp Bot (${accountId})] Send message error:`, err);
    return {
      success: false,
      error: err?.message || "حدث خطأ أثناء إرسال رسالة الواتساب للعميل.",
    };
  }
}

/**
 * Initialize all accounts on startup (both local and cloud-backed sessions)
 */
export async function initWhatsAppBot() {
  try {
    const discoveredAccounts = new Set<string>();

    // 1. Check local session directories
    if (fs.existsSync(SESSIONS_ROOT_DIR)) {
      const dirs = fs.readdirSync(SESSIONS_ROOT_DIR);
      for (const d of dirs) {
        if (hasExistingSession(d)) {
          discoveredAccounts.add(d);
        }
      }
    }

    // Check legacy default
    if (hasExistingSession("default")) {
      discoveredAccounts.add("default");
    }

    // 2. Discover accounts from Supabase cloud backups
    try {
      const { data } = await supabase
        .from("settings")
        .select("key")
        .like("key", "whatsapp_bot_session_backup%");

      if (data && Array.isArray(data)) {
        for (const item of data) {
          const key = item.key as string;
          if (key === "whatsapp_bot_session_backup") {
            discoveredAccounts.add("default");
          } else if (key.startsWith("whatsapp_bot_session_backup_")) {
            const accId = key.replace("whatsapp_bot_session_backup_", "");
            if (accId) discoveredAccounts.add(accId);
          }
        }
      }
    } catch (dbErr) {
      console.warn("[WhatsApp Bot] Could not discover cloud backups:", dbErr);
    }

    console.log(`[WhatsApp Bot] Discovered ${discoveredAccounts.size} account session(s):`, Array.from(discoveredAccounts));

    // 3. Connect each account with a staggered delay to prevent socket storm
    let delay = 0;
    for (const accId of discoveredAccounts) {
      setTimeout(async () => {
        try {
          let hasLocal = hasExistingSession(accId);
          if (!hasLocal) {
            console.log(`[WhatsApp Bot (${accId})] Checking Supabase cloud backup...`);
            hasLocal = await restoreSessionFromCloud(accId);
          }
          if (hasLocal) {
            console.log(`[WhatsApp Bot (${accId})] Found session, connecting...`);
            connectWhatsAppBot(accId).catch((err) =>
              console.error(`[WhatsApp Bot (${accId})] Auto-connect failed:`, err)
            );
          }
        } catch (accErr) {
          console.error(`[WhatsApp Bot (${accId})] Error initializing account:`, accErr);
        }
      }, delay);
      delay += 3000;
    }
  } catch (e) {
    console.error("[WhatsApp Bot] Master initialization error:", e);
  }
}

export interface WhatsAppDiagnosticsReport {
  timestamp: string;
  accountId: string;
  status: WhatsAppBotStatus;
  baileys: {
    isMakeWASocketFunction: boolean;
    isUseAuthStateFunction: boolean;
    hasDisconnectReason: boolean;
  };
  system: {
    nodeVersion: string;
    platform: string;
    arch: string;
    uptimeSeconds: number;
    memoryMb: number;
    pid: number;
    activeSessionsCount: number;
    activeAccounts: string[];
  };
  session: {
    directory: string;
    exists: boolean;
    filesCount: number;
    files: string[];
    hasCreds: boolean;
    reconnectAttempts: number;
  };
  cloudBackup: {
    found: boolean;
    updatedAt: string | null;
  };
  recentLogs: WhatsAppBotLogEntry[];
}

export async function getWhatsAppDiagnostics(rawAccountId?: string | null): Promise<WhatsAppDiagnosticsReport> {
  const accountId = sanitizeAccountId(rawAccountId);
  const instance = getOrCreateBotInstance(accountId);
  const sessionDir = getSessionDir(accountId);
  const baileys = getBaileys();
  const sessionExists = fs.existsSync(sessionDir);
  let sessionFiles: string[] = [];
  try {
    if (sessionExists) sessionFiles = fs.readdirSync(sessionDir);
  } catch (e: any) {
    sessionFiles = [`خطأ في قراءة المجلد: ${e.message}`];
  }

  let cloudBackupFound = false;
  let cloudBackupDate: string | null = null;
  try {
    const backupKey = getCloudBackupKey(accountId);
    const { data } = await supabase
      .from("settings")
      .select("value, updated_at")
      .eq("key", backupKey)
      .maybeSingle();
    if (data?.value?.files?.["creds.json"]) {
      cloudBackupFound = true;
      cloudBackupDate = data.updated_at;
    }
  } catch (e) {}

  const activeAccounts = Array.from(botInstances.keys());

  return {
    timestamp: new Date().toISOString(),
    accountId,
    status: getWhatsAppStatus(accountId),
    baileys: {
      isMakeWASocketFunction: typeof baileys.makeWASocket === "function",
      isUseAuthStateFunction: typeof baileys.useMultiFileAuthState === "function",
      hasDisconnectReason: typeof baileys.DisconnectReason === "object" && baileys.DisconnectReason !== null,
    },
    system: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptimeSeconds: Math.floor(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      pid: process.pid,
      activeSessionsCount: activeAccounts.length,
      activeAccounts,
    },
    session: {
      directory: sessionDir,
      exists: sessionExists,
      filesCount: sessionFiles.length,
      files: sessionFiles.slice(0, 20),
      hasCreds: sessionFiles.includes("creds.json"),
      reconnectAttempts: instance.reconnectAttempts,
    },
    cloudBackup: {
      found: cloudBackupFound,
      updatedAt: cloudBackupDate,
    },
    recentLogs: instance.logs.slice(0, 30),
  };
}
