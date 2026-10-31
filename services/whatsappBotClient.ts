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

/**
 * Automatically detect current laundry / account ID from local cached profile or custom auth user.
 */
export function getCurrentAccountId(): string {
  try {
    const cached = localStorage.getItem('laundry_cached_profile');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed?.laundry_id) return String(parsed.laundry_id);
      if (parsed?.id) return String(parsed.id);
    }
    const custom = localStorage.getItem('custom_auth_user');
    if (custom) {
      const parsed = JSON.parse(custom);
      if (parsed?.id) return String(parsed.id);
    }
  } catch (e) {}
  return 'default';
}

export async function getWhatsAppBotStatus(accountId?: string): Promise<WhatsAppBotStatus> {
  const actId = accountId || getCurrentAccountId();
  try {
    const res = await fetch(`/api/whatsapp/status?accountId=${encodeURIComponent(actId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err: any) {
    return {
      isConnected: false,
      isConnecting: false,
      qrCodeDataUrl: null,
      userPhone: null,
      userName: null,
      error: err.message || 'تعذر الاتصال بالسيرفر',
      lastConnectedAt: null,
      accountId: actId,
    };
  }
}

export async function connectWhatsAppBot(force = false, accountId?: string): Promise<WhatsAppBotStatus> {
  const actId = accountId || getCurrentAccountId();
  try {
    const res = await fetch('/api/whatsapp/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force, accountId: actId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err: any) {
    return {
      isConnected: false,
      isConnecting: false,
      qrCodeDataUrl: null,
      userPhone: null,
      userName: null,
      error: err.message || 'تعذر بدء الاتصال',
      lastConnectedAt: null,
      accountId: actId,
    };
  }
}

export async function resetWhatsAppBot(accountId?: string): Promise<WhatsAppBotStatus> {
  return connectWhatsAppBot(true, accountId);
}

export async function disconnectWhatsAppBot(accountId?: string): Promise<WhatsAppBotStatus> {
  const actId = accountId || getCurrentAccountId();
  try {
    const res = await fetch('/api/whatsapp/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: actId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err: any) {
    return {
      isConnected: false,
      isConnecting: false,
      qrCodeDataUrl: null,
      userPhone: null,
      userName: null,
      error: err.message || 'تعذر قطع الاتصال',
      lastConnectedAt: null,
      accountId: actId,
    };
  }
}

export async function sendWhatsAppBotMessage(params: {
  toPhone: string;
  message: string;
  pdfBase64?: string;
  pdfFileName?: string;
  accountId?: string;
}): Promise<{ success: boolean; error?: string; messageId?: string }> {
  const actId = params.accountId || getCurrentAccountId();
  try {
    const res = await fetch('/api/whatsapp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...params,
        accountId: actId,
      }),
    });
    return await res.json();
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'فشل إرسال الرسالة عبر الخادم',
    };
  }
}

export interface WhatsAppDiagnosticsReport {
  timestamp: string;
  accountId?: string;
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
    activeSessionsCount?: number;
    activeAccounts?: string[];
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
  recentLogs: Array<{
    time: string;
    level: "info" | "warn" | "error";
    message: string;
  }>;
}

export async function getWhatsAppDiagnostics(accountId?: string): Promise<WhatsAppDiagnosticsReport | null> {
  const actId = accountId || getCurrentAccountId();
  try {
    const res = await fetch(`/api/whatsapp/debug?accountId=${encodeURIComponent(actId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error("Failed to load WhatsApp diagnostics:", err);
    return null;
  }
}
