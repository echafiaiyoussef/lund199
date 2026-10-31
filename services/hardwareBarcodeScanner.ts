import { Order } from '../types';
import { supabase } from '../supabase';

// Play high quality audio beep for barcode/QR scanner feedback
export const playScannerBeep = (type: 'success' | 'error' = 'success') => {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();

    if (type === 'success') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1400, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.13);
    } else {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(300, ctx.currentTime);
      osc.frequency.setValueAtTime(200, ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
    }
  } catch (e) {
    console.warn("Scanner Web Audio feedback failed:", e);
  }
};

// Normalize Arabic/Persian digits to standard Western digits
export const normalizeArabicDigits = (str: string): string => {
  if (!str) return '';
  return str
    .replace(/[٠-٩]/g, d => '0123456789'['٠١٢٣٤٥٦٧٨٩'.indexOf(d)])
    .replace(/[۰-۹]/g, d => '0123456789'['۰۱۲۳۴۵۶۷۸۹'.indexOf(d)]);
};

// Match order from scanned code (single order number, invoice QR text, or product tag)
// Searches both local in-memory orders and the ENTIRE Supabase database
export const matchOrderFromScannedCode = async (
  rawScannedText: string,
  orders: Order[],
  laundryId?: string
): Promise<Order | null> => {
  const { findOrderAcrossAllDatabase } = await import('./orderDatabaseLookup');
  return await findOrderAcrossAllDatabase(rawScannedText, {
    inMemoryOrders: orders,
    laundryId
  });
};

// Global Hardware Barcode & QR Scanner Listener (Keyboard Wedge)
export interface HardwareScannerListenerOptions {
  onScan: (scannedText: string) => void;
  minChars?: number;
  maxKeyIntervalMs?: number;
}

export const setupHardwareBarcodeScannerListener = (options: HardwareScannerListenerOptions) => {
  const { onScan, minChars = 3, maxKeyIntervalMs = 65 } = options;

  let buffer = '';
  let lastKeyTime = 0;
  let timer: any = null;
  let rapidKeystrokeCount = 0;

  const resetBuffer = () => {
    buffer = '';
    rapidKeystrokeCount = 0;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const processBuffer = (targetElement?: EventTarget | null) => {
    const scanned = buffer.trim();
    const count = rapidKeystrokeCount;
    resetBuffer();

    // Check if the burst had scanner-like characteristics
    if (scanned.length >= minChars && count >= 2) {
      // If an input was active and polluted by the scanner gun, clean it up
      if (targetElement && (targetElement as HTMLElement).tagName) {
        const el = targetElement as HTMLInputElement | HTMLTextAreaElement;
        if (el && typeof el.value === 'string' && el.value.endsWith(scanned)) {
          el.value = el.value.slice(0, -scanned.length);
        }
      }
      onScan(scanned);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    // Ignore meta/ctrl/alt combinations (e.g. Ctrl+C, Alt+Tab)
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }

    const now = Date.now();
    const diff = now - lastKeyTime;
    lastKeyTime = now;

    // Check if key is Enter (hardware scanner terminator)
    if (e.key === 'Enter' || e.keyCode === 13) {
      if (buffer.length >= minChars && rapidKeystrokeCount >= 2) {
        // Prevent form submission / default enter action if it was a hardware scanner burst
        e.preventDefault();
        e.stopPropagation();
        processBuffer(e.target);
        return;
      }
      resetBuffer();
      return;
    }

    // Only process printable single characters
    if (e.key.length !== 1) {
      return;
    }

    if (diff <= maxKeyIntervalMs) {
      rapidKeystrokeCount++;
      buffer += e.key;
    } else {
      // If delay was longer than scanner speed, reset to new potential scan
      buffer = e.key;
      rapidKeystrokeCount = 1;
    }

    // Fallback timer: in case the scanner doesn't send Enter or sends Tab
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (buffer.length >= minChars && rapidKeystrokeCount >= 3) {
        processBuffer(e.target);
      } else {
        resetBuffer();
      }
    }, 120);
  };

  window.addEventListener('keydown', handleKeyDown, true);

  return () => {
    window.removeEventListener('keydown', handleKeyDown, true);
    if (timer) clearTimeout(timer);
  };
};
