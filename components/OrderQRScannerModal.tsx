import React, { useEffect, useRef, useState, useCallback } from 'react';
import jsQR from 'jsqr';
import { 
  MultiFormatReader, 
  RGBLuminanceSource, 
  BinaryBitmap, 
  HybridBinarizer 
} from '@zxing/library';
import { 
  Camera, 
  X, 
  CheckCircle2, 
  AlertCircle, 
  RefreshCw, 
  Smartphone, 
  QrCode,
  ScanQrCode,
  ScanBarcode, 
  Scan,
  Barcode,
  Send, 
  Volume2, 
  VolumeX, 
  Flashlight,
  ExternalLink,
  RotateCw,
  Search,
  Check,
  MessageSquare,
  ZoomIn,
  ZoomOut,
  Sparkles,
  Bug,
  Copy,
  Terminal,
  FileText,
  AlertTriangle,
  Info,
  CreditCard
} from 'lucide-react';
import { Order, OrderStatus } from '../types';
import { supabase } from '../supabase';
import { normalizeArabicDigits } from '../services/hardwareBarcodeScanner';
import { findOrderAcrossAllDatabase } from '../services/orderDatabaseLookup';

// Interface for live scanner diagnostic debugger
export interface ScanDebugEntry {
  id: string;
  time: string;
  raw: string;
  engine: 'BarcodeDetector' | 'jsQR' | 'ZXing' | 'Manual';
  format?: string;
  status: 'matched' | 'not_found' | 'error' | 'searching';
  matchedOrderNumber?: string;
  details?: string;
}

// ZATCA Saudi E-Invoice TLV Base64 Parser
export function parseZatcaTlv(raw: string): { seller?: string; vatNumber?: string; timestamp?: string; total?: number; vatTotal?: number } | null {
  try {
    const trimmed = raw.trim();
    if (!/^[A-Za-z0-9+/=]+$/.test(trimmed) || trimmed.length < 24) return null;
    
    // Attempt standard Base64 decode
    const binary = atob(trimmed);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    
    let pos = 0;
    const result: { seller?: string; vatNumber?: string; timestamp?: string; total?: number; vatTotal?: number } = {};
    const textDecoder = new TextDecoder('utf-8');
    
    while (pos + 2 <= bytes.length) {
      const tag = bytes[pos];
      const len = bytes[pos + 1];
      if (pos + 2 + len > bytes.length) break;
      const valBytes = bytes.slice(pos + 2, pos + 2 + len);
      const valStr = textDecoder.decode(valBytes);
      
      if (tag === 1) result.seller = valStr;
      else if (tag === 2) result.vatNumber = valStr;
      else if (tag === 3) result.timestamp = valStr;
      else if (tag === 4) {
        const num = parseFloat(valStr.replace(/[^\d.]/g, ''));
        if (!isNaN(num)) result.total = num;
      }
      else if (tag === 5) {
        const num = parseFloat(valStr.replace(/[^\d.]/g, ''));
        if (!isNaN(num)) result.vatTotal = num;
      }
      pos += 2 + len;
    }
    
    if (result.seller || result.total !== undefined) return result;
    return null;
  } catch (e) {
    return null;
  }
}

interface OrderQRScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  orders: Order[];
  onOrderUpdated: (orderId: string, newStatus: OrderStatus, options?: { skipNotification?: boolean }) => Promise<void> | void;
  onOrderPaymentUpdated?: (orderId: string, isPaid: boolean, paymentMethod: Order['payment_method']) => Promise<void> | void;
  laundryName: string;
  onSendWhatsAppNotification?: (order: Order) => Promise<{ success: boolean; error?: string }>;
  isWhatsAppConnected?: boolean;
  onOrderFound?: (order: Order) => void;
  laundryId?: string;
}

export const OrderQRScannerModal: React.FC<OrderQRScannerModalProps> = ({
  isOpen,
  onClose,
  orders,
  onOrderUpdated,
  onOrderPaymentUpdated,
  laundryName,
  onSendWhatsAppNotification,
  isWhatsAppConnected = false,
  onOrderFound,
  laundryId
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // Synchronous execution refs to prevent concurrent frame triggers
  const isProcessingRef = useRef<boolean>(false);
  const isScanningRef = useRef<boolean>(true);
  const lastScannedRef = useRef<{ code: string; timestamp: number } | null>(null);
  const zxingReaderRef = useRef<MultiFormatReader | null>(null);
  const barcodeDetectorRef = useRef<any>(null);
  const isFrameDecodingRef = useRef<boolean>(false);
  const lastScanTimeRef = useRef<number>(0);

  // Touch pinch-to-zoom tracking
  const touchDistanceRef = useRef<number | null>(null);
  const touchZoomStartRef = useRef<number>(1);

  const [hasCamera, setHasCamera] = useState<boolean>(true);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [isScanning, setIsScanning] = useState<boolean>(true);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [manualInput, setManualInput] = useState<string>('');

  // Zoom & Torch States
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [zoomCapabilities, setZoomCapabilities] = useState<{ min: number; max: number; step: number; supported: boolean }>({
    min: 1,
    max: 3,
    step: 0.1,
    supported: false
  });
  const [torchSupported, setTorchSupported] = useState<boolean>(false);
  const [torchOn, setTorchOn] = useState<boolean>(false);
  const [scanSuccessPulse, setScanSuccessPulse] = useState<boolean>(false);

  // Debugger states
  const [showDebugger, setShowDebugger] = useState<boolean>(false);
  const [debugLogs, setDebugLogs] = useState<ScanDebugEntry[]>([]);
  const [lastDecodedDebug, setLastDecodedDebug] = useState<ScanDebugEntry | null>(null);
  const [copiedDebug, setCopiedDebug] = useState<boolean>(false);
  const [testInputDebug, setTestInputDebug] = useState<string>('');

  // Initialize ZXing MultiFormatReader
  if (!zxingReaderRef.current) {
    try {
      zxingReaderRef.current = new MultiFormatReader();
    } catch (e) {
      console.warn("Failed to initialize ZXing MultiFormatReader:", e);
    }
  }

  // Result state
  const [processedOrder, setProcessedOrder] = useState<Order | null>(null);
  const [isUpdatingPayment, setIsUpdatingPayment] = useState<boolean>(false);
  const [paymentUpdateSuccess, setPaymentUpdateSuccess] = useState<string | null>(null);
  const [notificationStatus, setNotificationStatus] = useState<{
    sent: boolean;
    channel: 'silent_bot' | 'whatsapp_link' | 'none' | 'auto_whatsapp' | 'failed';
    message: string;
    waUrl?: string;
  } | null>(null);

  // Play beep sound using Web Audio API
  const playBeep = useCallback(() => {
    if (!soundEnabled) return;
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;
      const ctx = new AudioContextClass();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.14);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
    } catch (e) {
      console.warn("AudioContext beep failed:", e);
    }
  }, [soundEnabled]);

  // Stop camera stream
  const stopCamera = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        try { track.stop(); } catch (e) {}
      });
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  // Start camera stream with autofocus and zoom capabilities detection
  const startCamera = useCallback(async (mode: 'environment' | 'user' = facingMode) => {
    stopCamera();
    setCameraError(null);
    setIsScanning(true);
    setScanSuccessPulse(false);

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("المتصفح لا يدعم الوصول المباشر لكاميرا الجهاز أو يتطلب اتصالاً آمناً (HTTPS).");
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: mode },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            // Continuous autofocus on supported devices
            advanced: [{ focusMode: 'continuous' } as any]
          },
          audio: false
        });
      } catch (err1) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: mode },
              width: { ideal: 1280 },
              height: { ideal: 720 }
            },
            audio: false
          });
        } catch (err2) {
          // Fallback to basic video without specific facingMode constraints
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false
          });
        }
      }

      streamRef.current = stream;

      // Inspect camera capabilities (autofocus, hardware zoom, torch)
      const track = stream.getVideoTracks()[0];
      if (track) {
        try {
          const caps = (track.getCapabilities ? track.getCapabilities() : {}) as any;
          
          // 1. Continuous autofocus
          if (caps.focusMode && Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
            try {
              await track.applyConstraints({
                advanced: [{ focusMode: 'continuous' } as any]
              });
            } catch (focusErr) {}
          }

          // 2. Hardware zoom detection
          if (caps.zoom) {
            const minZ = caps.zoom.min || 1;
            const maxZ = Math.min(caps.zoom.max || 5, 4);
            const stepZ = caps.zoom.step || 0.1;
            setZoomCapabilities({
              min: minZ,
              max: maxZ,
              step: stepZ,
              supported: true
            });
          } else {
            // Software/digital zoom fallback (1x to 3x)
            setZoomCapabilities({
              min: 1,
              max: 3,
              step: 0.1,
              supported: false
            });
          }

          // 3. Torch detection
          if (caps.torch) {
            setTorchSupported(true);
          } else {
            setTorchSupported(false);
          }
        } catch (capsErr) {
          console.warn("Could not inspect camera track capabilities:", capsErr);
        }
      }

      if (videoRef.current) {
        const vid = videoRef.current;
        vid.srcObject = stream;
        vid.setAttribute('playsinline', 'true');
        vid.setAttribute('webkit-playsinline', 'true');
        vid.muted = true;
        vid.onloadedmetadata = () => {
          vid.play().catch(playErr => {
            console.warn("video.play() inside onloadedmetadata failed:", playErr);
          });
        };
        try {
          await vid.play();
        } catch (playErr) {
          console.warn("video.play() immediate call failed (waiting for user interaction or metadata):", playErr);
        }
      }
      setHasCamera(true);
    } catch (err: any) {
      console.warn("Camera start error:", err);
      setHasCamera(false);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setCameraError("تم رفض إذن الكاميرا. يرجى السماح بالوصول للكاميرا من إعدادات المتصفح أو إدخال رقم الفاتورة يدوياً.");
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        setCameraError("لم يتم العثور على كاميرا متصلة بالجهاز. يمكنك كتابة رقم الفاتورة بالأسفل.");
      } else {
        setCameraError(err.message || "تعذر تشغيل الكاميرا حالياً.");
      }
    }
  }, [facingMode, stopCamera]);

  // Apply zoom level (hardware if supported, otherwise digital scale)
  const applyZoom = useCallback(async (level: number) => {
    const minZ = zoomCapabilities.min || 1;
    const maxZ = zoomCapabilities.max || 3;
    const clamped = Math.max(minZ, Math.min(maxZ, Math.round(level * 10) / 10));
    setZoomLevel(clamped);

    const track = streamRef.current?.getVideoTracks()[0];
    if (track && zoomCapabilities.supported) {
      try {
        await track.applyConstraints({
          advanced: [{ zoom: clamped }] as any
        });
      } catch (e) {
        console.warn("Hardware zoom application failed, using digital zoom fallback:", e);
      }
    }
  }, [zoomCapabilities]);

  // Toggle camera flashlight (torch)
  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || !torchSupported) return;
    try {
      const nextTorch = !torchOn;
      await track.applyConstraints({
        advanced: [{ torch: nextTorch }] as any
      });
      setTorchOn(nextTorch);
    } catch (e) {
      console.warn("Torch toggle failed:", e);
    }
  }, [torchOn, torchSupported]);

  // Touch gesture pinch-to-zoom handlers
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      touchDistanceRef.current = Math.hypot(dx, dy);
      touchZoomStartRef.current = zoomLevel;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && touchDistanceRef.current) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const currentDistance = Math.hypot(dx, dy);
      const factor = currentDistance / touchDistanceRef.current;
      applyZoom(touchZoomStartRef.current * factor);
    }
  };

  const handleTouchEnd = () => {
    touchDistanceRef.current = null;
  };

  // Tap camera view to trigger autofocus
  const handleTapToFocus = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      const caps = (track.getCapabilities ? track.getCapabilities() : {}) as any;
      if (caps.focusMode && Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
        await track.applyConstraints({
          advanced: [{ focusMode: 'continuous' } as any]
        });
      }
    } catch (err) {}
  };

  // Extract order from scanned QR text, barcode, or manual input
  // Searches both local in-memory orders and the ENTIRE Supabase database!
  const matchOrder = useCallback(async (scannedText: string): Promise<Order | null> => {
    const raw = normalizeArabicDigits(scannedText || '').trim();
    if (!raw) return null;

    // Check ZATCA Saudi E-Invoice TLV Base64 matching if present
    const zatca = parseZatcaTlv(raw);
    if (zatca && zatca.total !== undefined) {
      const matchingByTotal = orders.filter(o => Math.abs(Number(o.total) - Number(zatca.total)) < 0.05);
      if (matchingByTotal.length === 1) {
        if (onOrderFound) {
          try { onOrderFound(matchingByTotal[0]); } catch (e) {}
        }
        return matchingByTotal[0];
      } else if (matchingByTotal.length > 1) {
        const active = matchingByTotal.find(o => o.status !== 'Ready' && o.status !== 'Delivered');
        const selected = active || matchingByTotal[0];
        if (onOrderFound) {
          try { onOrderFound(selected); } catch (e) {}
        }
        return selected;
      }
    }

    // Call findOrderAcrossAllDatabase: checks in-memory orders first,
    // then safely searches across ALL 2,300+ orders in the Supabase database
    const found = await findOrderAcrossAllDatabase(raw, {
      inMemoryOrders: orders,
      laundryId,
      preferActiveOnly: true
    });

    if (found) {
      if (onOrderFound) {
        try { onOrderFound(found); } catch (e) {}
      }
      return found;
    }

    return null;
  }, [orders, laundryId, onOrderFound]);

  // Handle scanned code
  const handleCodeFound = useCallback(async (code: string, engine: 'BarcodeDetector' | 'jsQR' | 'ZXing' | 'Manual' = 'BarcodeDetector') => {
    const raw = (code || '').trim();
    if (!raw) return;

    // Check ref-based lock immediately to prevent duplicate runs
    if (isProcessingRef.current) return;

    // Check duplicate code cooldown (within 2.5 seconds)
    const now = Date.now();
    if (lastScannedRef.current && lastScannedRef.current.code === raw && (now - lastScannedRef.current.timestamp < 2500)) {
      return;
    }

    // Immediately acquire lock and pause scanner loop
    isProcessingRef.current = true;
    isScanningRef.current = false;
    lastScannedRef.current = { code: raw, timestamp: now };

    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    setIsProcessing(true);
    setIsScanning(false);
    setCameraError(null);

    // Record initial search entry in Debugger
    const debugId = String(Date.now());
    const initialDebugItem: ScanDebugEntry = {
      id: debugId,
      time: new Date().toLocaleTimeString('ar-SA-u-nu-latn'),
      raw: raw,
      engine: engine,
      status: 'searching',
      details: 'جاري البحث عن الفاتورة في النظام...'
    };
    setLastDecodedDebug(initialDebugItem);
    setDebugLogs(prev => [initialDebugItem, ...prev.slice(0, 14)]);

    try {
      const order = await matchOrder(raw);
      if (!order) {
        // Order not found - clear success pulse and report in debugger & UI
        setScanSuccessPulse(false);
        const failItem: ScanDebugEntry = {
          ...initialDebugItem,
          status: 'not_found',
          details: `لم يتم العثور على طلب مطابق للرمز الممسوح (الطول: ${raw.length} حرف)`
        };
        setLastDecodedDebug(failItem);
        setDebugLogs(prev => [failItem, ...prev.filter(l => l.id !== debugId).slice(0, 14)]);

        setCameraError(`⚠️ لم يتم العثور على فاتورة مطابقة لهذا الرمز (${raw.length > 30 ? raw.slice(0, 30) + '...' : raw}).\nيرجى التأكد من توجيه الكاميرا إلى رمز QR أو باركود الطلب الصحيح.`);
        setIsProcessing(false);
        isProcessingRef.current = false;
        
        // Resume scanning automatically after 2.5 seconds
        setTimeout(() => {
          if (!isProcessingRef.current) {
            isScanningRef.current = true;
            setIsScanning(true);
          }
        }, 2500);
        return;
      }

      // Order Found! Trigger success visual feedback, beep and vibration
      playBeep();
      if (navigator.vibrate) {
        try { navigator.vibrate([100, 50, 100]); } catch (e) {}
      }

      // Log success in debugger
      const successItem: ScanDebugEntry = {
        ...initialDebugItem,
        status: 'matched',
        matchedOrderNumber: order.order_number,
        details: `تمت المطابقة بنجاح مع طلب #${order.order_number} (العميل: ${order.customer_name})`
      };
      setLastDecodedDebug(successItem);
      setDebugLogs(prev => [successItem, ...prev.filter(l => l.id !== debugId).slice(0, 14)]);

      // Prepare updated order object immediately
      const updatedOrder: Order = { ...order, status: 'Ready' };

      // Immediately stop camera and transition instantly to result popup (eliminates 1-2s delay / blank screen)
      stopCamera();
      setIsProcessing(false);
      setScanSuccessPulse(false);
      setProcessedOrder(updatedOrder);

      // Construct ready notification message (simple direct notification, no redundant PDF)
      const smartMessage = `مرحباً ${order.customer_name}، نود إعلامكم بأن طلبكم #${order.order_number} جاهز تماماً وبانتظاركم لاستلامه الآن.`;

      const cleanPhone = (order.customer_phone || '').replace(/\D/g, '');
      let finalPhone = cleanPhone;
      if (finalPhone.startsWith('00')) finalPhone = finalPhone.slice(2);
      if (finalPhone.startsWith('05') && finalPhone.length === 10) {
        finalPhone = '966' + finalPhone.slice(1);
      } else if (finalPhone.startsWith('5') && finalPhone.length === 9) {
        finalPhone = '966' + finalPhone;
      } else if ((finalPhone.startsWith('06') || finalPhone.startsWith('07')) && finalPhone.length === 10) {
        finalPhone = '212' + finalPhone.slice(1);
      } else if (finalPhone.startsWith('0')) {
        finalPhone = '966' + finalPhone.slice(1);
      }
      finalPhone = finalPhone.replace(/^0+/, '');
      const waUrl = `https://wa.me/${finalPhone}?text=${encodeURIComponent(smartMessage)}`;

      // Show initial sending status
      setNotificationStatus({
        sent: false,
        channel: 'silent_bot',
        message: 'جاري إرسال إشعار الواتساب التلقائي للعميل... ⏳',
        waUrl
      });

      // Update Order Status in database and send automated WhatsApp notification asynchronously in background
      (async () => {
        try {
          await onOrderUpdated(order.id, 'Ready', { skipNotification: true });
        } catch (updateErr) {
          console.warn("Background order status update error:", updateErr);
        }

        if (onSendWhatsAppNotification) {
          try {
            const res = await onSendWhatsAppNotification(updatedOrder);
            if (res && res.success) {
              setNotificationStatus({
                sent: true,
                channel: 'silent_bot',
                message: 'تم إرسال إشعار الجاهزية للعميل تلقائياً بنجاح! 📲',
                waUrl
              });
            } else {
              setNotificationStatus({
                sent: false,
                channel: 'failed',
                message: res?.error ? `تنبيه الإشعار: ${res.error}` : 'بوت الواتساب غير متصل حالياً لإرسال الرسالة التلقائية.',
                waUrl
              });
            }
          } catch (botErr: any) {
            console.warn("Automated notification callback error:", botErr);
            setNotificationStatus({
              sent: false,
              channel: 'failed',
              message: botErr?.message ? `تنبيه: ${botErr.message}` : 'تعذر إرسال الإشعار التلقائي.',
              waUrl
            });
          }
        }
      })();
    } catch (err: any) {
      console.error("Order QR processing error:", err);
      setCameraError(err.message || "حدث خطأ أثناء معالجة الطلب.");
      isProcessingRef.current = false;
      isScanningRef.current = true;
      setIsScanning(true);
    } finally {
      setIsProcessing(false);
    }
  }, [matchOrder, onOrderUpdated, onSendWhatsAppNotification, laundryName, playBeep]);

  // Keep a stable ref to handleCodeFound to avoid tearing down the scan loop unnecessarily
  const handleCodeFoundRef = useRef(handleCodeFound);
  handleCodeFoundRef.current = handleCodeFound;

  // Multi-tier Video scanning frame loop (BarcodeDetector + jsQR + ZXing MultiFormat)
  useEffect(() => {
    if (!isOpen || !isScanning || processedOrder) return;

    let isSubscribed = true;

    const scanFrame = async () => {
      if (!isSubscribed || !isScanningRef.current || isProcessingRef.current) return;

      const now = performance.now();
      // Throttle scanning to every 40ms (~25 fps) to avoid main-thread saturation and frame jitter
      if (now - lastScanTimeRef.current < 40) {
        if (isSubscribed && isScanningRef.current && !isProcessingRef.current) {
          animFrameRef.current = requestAnimationFrame(scanFrame);
        }
        return;
      }
      lastScanTimeRef.current = now;

      const video = videoRef.current;
      const canvas = canvasRef.current;

      // Check if video is loaded and rendering frames (readyState >= 2 indicates current data available)
      if (video && canvas && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && !isFrameDecodingRef.current) {
        isFrameDecodingRef.current = true;

        try {
          let detectedCode: string | null = null;
          let detectedEngine: 'BarcodeDetector' | 'jsQR' | 'ZXing' = 'BarcodeDetector';

          // 1. Tier 1: Hardware-Accelerated Native BarcodeDetector (Supported on Android Chrome & modern browsers)
          if (typeof (window as any).BarcodeDetector !== 'undefined') {
            try {
              if (!barcodeDetectorRef.current) {
                barcodeDetectorRef.current = new (window as any).BarcodeDetector({
                  formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'data_matrix']
                });
              }
              const detectedList = await barcodeDetectorRef.current.detect(video);
              if (detectedList && detectedList.length > 0 && detectedList[0].rawValue) {
                detectedCode = detectedList[0].rawValue.trim();
                detectedEngine = 'BarcodeDetector';
              }
            } catch (detectorErr) {
              // Graceful fallback to canvas decoding
            }
          }

          // 2. Tier 2: Canvas-based scanning (jsQR + ZXing MultiFormatReader)
          if (!detectedCode) {
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              // Rescale to a reliable scanning dimension (around 640px width) for ultra-fast processing
              const targetWidth = Math.min(640, video.videoWidth);
              const targetHeight = Math.round((targetWidth / video.videoWidth) * video.videoHeight);
              canvas.width = targetWidth;
              canvas.height = targetHeight;

              // If digital zoom is applied without hardware zoom, crop into center so codes are large
              if (!zoomCapabilities.supported && zoomLevel > 1) {
                const cropW = video.videoWidth / zoomLevel;
                const cropH = video.videoHeight / zoomLevel;
                const cropX = (video.videoWidth - cropW) / 2;
                const cropY = (video.videoHeight - cropH) / 2;
                ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, targetWidth, targetHeight);
              } else {
                ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
              }

              // A. jsQR on full frame
              const fullImageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
              const fullQr = jsQR(fullImageData.data, targetWidth, targetHeight, {
                inversionAttempts: 'attemptBoth'
              });
              if (fullQr && fullQr.data && fullQr.data.trim()) {
                detectedCode = fullQr.data.trim();
                detectedEngine = 'jsQR';
              }

              // B. jsQR on Center Reticle Crop (where user centers the paper/tag)
              if (!detectedCode) {
                const centerSize = Math.floor(Math.min(targetWidth, targetHeight) * 0.7);
                const startX = Math.floor((targetWidth - centerSize) / 2);
                const startY = Math.floor((targetHeight - centerSize) / 2);
                if (centerSize > 50) {
                  const centerImageData = ctx.getImageData(startX, startY, centerSize, centerSize);
                  const centerQr = jsQR(centerImageData.data, centerSize, centerSize, {
                    inversionAttempts: 'attemptBoth'
                  });
                  if (centerQr && centerQr.data && centerQr.data.trim()) {
                    detectedCode = centerQr.data.trim();
                    detectedEngine = 'jsQR';
                  }
                }
              }

              // C. ZXing MultiFormatReader for 1D Barcodes (CODE128 from tags, Code39, EAN)
              if (!detectedCode && zxingReaderRef.current) {
                try {
                  const luminanceSource = new RGBLuminanceSource(
                    new Uint8ClampedArray(fullImageData.data),
                    targetWidth,
                    targetHeight
                  );
                  const binaryBitmap = new BinaryBitmap(new HybridBinarizer(luminanceSource));
                  const zxResult = zxingReaderRef.current.decode(binaryBitmap);
                  if (zxResult && zxResult.getText()) {
                    detectedCode = zxResult.getText().trim();
                    detectedEngine = 'ZXing';
                  }
                } catch (zxErr) {
                  // Barcode not found in this frame
                }
              }
            }
          }

          // If a code was found, pass directly to handler
          if (detectedCode && detectedCode.trim()) {
            if (!isProcessingRef.current) {
              if (animFrameRef.current) {
                cancelAnimationFrame(animFrameRef.current);
                animFrameRef.current = null;
              }
              handleCodeFoundRef.current(detectedCode.trim(), detectedEngine);
              return;
            }
          }
        } catch (scanErr) {
          // Ignored - frame decode transient error
        } finally {
          isFrameDecodingRef.current = false;
        }
      }

      if (isSubscribed && isScanningRef.current && !isProcessingRef.current) {
        animFrameRef.current = requestAnimationFrame(scanFrame);
      }
    };

    animFrameRef.current = requestAnimationFrame(scanFrame);

    return () => {
      isSubscribed = false;
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
    };
  }, [isOpen, isScanning, !!processedOrder, zoomLevel, zoomCapabilities.supported]);

  // Handle open/close lifecycle
  useEffect(() => {
    if (isOpen) {
      isProcessingRef.current = false;
      isScanningRef.current = true;
      lastScannedRef.current = null;
      setProcessedOrder(null);
      setNotificationStatus(null);
      setCameraError(null);
      setManualInput('');
      setIsScanning(true);
      setIsProcessing(false);
      startCamera();
    } else {
      isProcessingRef.current = false;
      isScanningRef.current = false;
      stopCamera();
    }
    return () => {
      isProcessingRef.current = false;
      isScanningRef.current = false;
      stopCamera();
    };
  }, [isOpen, startCamera, stopCamera]);

  // Listen for global hardware barcode/QR scanner events
  useEffect(() => {
    if (!isOpen) return;

    const onHardwareScanEvent = (e: any) => {
      if (e.detail?.order) {
        setProcessedOrder(e.detail.order);
        setNotificationStatus({
          sent: true,
          channel: 'silent_bot',
          message: 'تم مسح الرمز وتجهيز الطلب وإرسال رسالة الواتساب تلقائياً! 📲'
        });
        setIsScanning(false);
        setIsProcessing(false);
      } else if (e.detail?.code) {
        handleCodeFound(e.detail.code);
      }
    };

    window.addEventListener('hardware-qr-scanned', onHardwareScanEvent);
    return () => {
      window.removeEventListener('hardware-qr-scanned', onHardwareScanEvent);
    };
  }, [isOpen, handleCodeFound]);

  // Switch between front and rear camera
  const toggleFacingMode = () => {
    const nextMode = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(nextMode);
    startCamera(nextMode);
  };

  // Reset scanner to scan another order
  const handleScanAnother = () => {
    isProcessingRef.current = false;
    isScanningRef.current = true;
    lastScannedRef.current = null;
    setProcessedOrder(null);
    setNotificationStatus(null);
    setCameraError(null);
    setManualInput('');
    setScanSuccessPulse(false);
    setIsScanning(true);
    setIsProcessing(false);
    setIsUpdatingPayment(false);
    setPaymentUpdateSuccess(null);
    startCamera();
  };

  // Quick payment status & method updater with instant database/state sync
  const handlePaymentChange = async (newIsPaid: boolean, newPaymentMethod?: Order['payment_method']) => {
    if (!processedOrder || isUpdatingPayment) return;
    const targetPaymentMethod = newPaymentMethod || processedOrder.payment_method || 'Cash';

    const updated: Order = {
      ...processedOrder,
      is_paid: newIsPaid,
      payment_method: targetPaymentMethod
    };

    setProcessedOrder(updated);
    setIsUpdatingPayment(true);

    // Reconstruct smart message & WhatsApp link (simple direct notification, no redundant PDF)
    const smartMessage = `مرحباً ${updated.customer_name}، نود إعلامكم بأن طلبكم #${updated.order_number} جاهز تماماً وبانتظاركم لاستلامه الآن.`;

    const cleanPhone = (updated.customer_phone || '').replace(/\D/g, '');
    let finalPhone = cleanPhone;
    if (finalPhone.startsWith('00')) finalPhone = finalPhone.slice(2);
    if (finalPhone.startsWith('05') && finalPhone.length === 10) {
      finalPhone = '966' + finalPhone.slice(1);
    } else if (finalPhone.startsWith('5') && finalPhone.length === 9) {
      finalPhone = '966' + finalPhone;
    } else if ((finalPhone.startsWith('06') || finalPhone.startsWith('07')) && finalPhone.length === 10) {
      finalPhone = '212' + finalPhone.slice(1);
    } else if (finalPhone.startsWith('0')) {
      finalPhone = '966' + finalPhone.slice(1);
    }
    finalPhone = finalPhone.replace(/^0+/, '');
    const waUrl = `https://wa.me/${finalPhone}?text=${encodeURIComponent(smartMessage)}`;

    setNotificationStatus(prev => prev ? ({ ...prev, waUrl }) : {
      sent: false,
      channel: 'whatsapp_link',
      message: 'تم تحديث بيانات الفاتورة بنجاح، يمكنك إرسال الواتساب الآن 💬',
      waUrl
    });

    try {
      if (onOrderPaymentUpdated) {
        await onOrderPaymentUpdated(updated.id, newIsPaid, targetPaymentMethod);
      } else {
        await supabase.from('orders').update({
          is_paid: newIsPaid,
          payment_method: targetPaymentMethod,
          updated_at: new Date().toISOString()
        }).eq('id', updated.id);
      }
      setPaymentUpdateSuccess(newIsPaid ? 'تم تسجيل السداد وتحديث الطلب بنجاح! ⚡' : 'تم تعيين الحالة إلى غير مسدد ⚡');
      setTimeout(() => setPaymentUpdateSuccess(null), 3000);
    } catch (err: any) {
      console.warn("Error updating payment in QR scanner modal:", err);
    } finally {
      setIsUpdatingPayment(false);
    }
  };

  // Close on Escape key press
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Manual code submission
  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualInput.trim()) return;
    handleCodeFound(manualInput.trim());
  };

  if (!isOpen) return null;

  return (
    <div 
      className="fixed inset-0 z-[300] bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 overflow-y-auto animate-in fade-in duration-150"
      dir="rtl"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div 
        className="bg-white rounded-3xl shadow-2xl border border-slate-200/90 w-full max-w-sm sm:max-w-md max-h-[92dvh] flex flex-col overflow-hidden my-auto relative animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sticky Header - Always visible with prominent Close button */}
        <div className="bg-gradient-to-r from-indigo-700 via-indigo-800 to-violet-800 px-4 py-3 sm:px-5 sm:py-3.5 text-white flex items-center justify-between shrink-0 shadow-sm z-20">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-white/15 backdrop-blur-md flex items-center justify-center border border-white/20 shadow-inner shrink-0">
              <Scan size={18} strokeWidth={2.4} />
            </div>
            <div>
              <h3 className="text-sm sm:text-base font-black tracking-tight leading-tight">مسح QR / باركود الفاتورة</h3>
              <p className="text-indigo-200 text-[10px] sm:text-xs font-bold leading-tight mt-0.5">
                تحديث فوري إلى (جاهز للاستلام) ⚡
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 rounded-xl bg-white/15 hover:bg-white/25 active:scale-95 text-white flex items-center justify-center transition-all cursor-pointer shrink-0 border border-white/20 touch-manipulation"
            aria-label="إغلاق"
            title="إغلاق النافذة"
          >
            <X size={18} strokeWidth={2.5} />
          </button>
        </div>

        {/* Scrollable Modal Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
          {/* Result State (when order is scanned and updated) */}
          {processedOrder ? (
            <div className="text-center space-y-4 animate-in zoom-in-95 duration-200">
              {/* Success Badge */}
              <div className="w-14 h-14 bg-emerald-100 text-emerald-600 rounded-2xl flex items-center justify-center mx-auto shadow-md shadow-emerald-100">
                <CheckCircle2 size={32} />
              </div>

              <div>
                <span className="px-3 py-0.5 bg-emerald-50 border border-emerald-200 text-emerald-800 text-[11px] font-black rounded-full inline-block mb-1.5">
                  تم التحديث بنجاح: جاهز للاستلام ✅
                </span>
                <h4 className="text-xl font-black text-slate-900">
                  طلب #{processedOrder.order_number}
                </h4>
                <p className="text-xs font-bold text-slate-500 mt-0.5">
                  العميل: <span className="text-slate-900 font-black">{processedOrder.customer_name}</span>
                </p>
              </div>

              {/* Order Info Summary Card */}
              <div className="p-3.5 bg-slate-50 rounded-2xl border border-slate-200 text-right space-y-2 text-xs">
                <div className="flex justify-between items-center font-bold border-b border-slate-200/80 pb-2">
                  <span className="text-slate-400 text-[11px]">رقم الجوال:</span>
                  <span className="text-slate-800 font-mono font-black" dir="ltr">{processedOrder.customer_phone || '-'}</span>
                </div>
                <div className="flex justify-between items-center font-bold border-b border-slate-200/80 pb-2">
                  <span className="text-slate-400 text-[11px]">المبلغ الإجمالي:</span>
                  <span className="text-indigo-600 font-black text-xs sm:text-sm">{processedOrder.total.toFixed(2)} ر.س</span>
                </div>
                <div className="flex justify-between items-center font-bold">
                  <span className="text-slate-400 text-[11px]">حالة السداد:</span>
                  <span className={`font-black ${processedOrder.is_paid ? 'text-emerald-600' : 'text-amber-600'}`}>
                    {processedOrder.is_paid 
                      ? `مدفوعة (${processedOrder.payment_method === 'Cash' ? 'نقدي' : processedOrder.payment_method === 'Card' ? 'شبكة' : processedOrder.payment_method === 'Transfer' ? 'تحويل' : processedOrder.payment_method || 'نقدي'}) ✅` 
                      : 'معلقة / غير مسددة ⏳'}
                  </span>
                </div>
              </div>

              {/* Payment Edit & Quick Selection Section */}
              <div className="p-3.5 bg-gradient-to-br from-indigo-950 via-slate-900 to-indigo-900 text-white rounded-2xl border border-indigo-800/60 shadow-lg text-right space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <div className="w-6 h-6 rounded-lg bg-indigo-500/20 border border-indigo-400/30 flex items-center justify-center text-indigo-300">
                      <CreditCard size={13} />
                    </div>
                    <div>
                      <span className="text-xs font-black text-white block leading-tight">تعديل وسيلة الدفع والسداد</span>
                      <span className="text-[10px] text-indigo-200/80 font-bold block">تحديث فوري للطلب بنقرة واحدة ⚡</span>
                    </div>
                  </div>
                  {isUpdatingPayment ? (
                    <span className="text-[10px] font-black text-amber-300 bg-amber-500/20 border border-amber-400/30 px-2 py-0.5 rounded-full animate-pulse flex items-center gap-1">
                      <RefreshCw size={10} className="animate-spin" /> جاري التحديث...
                    </span>
                  ) : paymentUpdateSuccess ? (
                    <span className="text-[10px] font-black text-emerald-300 bg-emerald-500/20 border border-emerald-400/30 px-2 py-0.5 rounded-full flex items-center gap-1 animate-in fade-in">
                      <Check size={10} /> تم الحفظ ✅
                    </span>
                  ) : null}
                </div>

                {/* 1-Tap Toggle Status & Payment Method Select (User's Exact Select Component) */}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => handlePaymentChange(!processedOrder.is_paid, processedOrder.payment_method)}
                    disabled={isUpdatingPayment}
                    className={`py-2.5 px-3 rounded-xl border font-black text-xs transition-all flex items-center justify-center gap-1.5 cursor-pointer active:scale-95 touch-manipulation shadow-sm ${
                      processedOrder.is_paid
                        ? 'bg-emerald-500 hover:bg-emerald-600 border-emerald-400 text-white shadow-emerald-950/40'
                        : 'bg-white/10 hover:bg-white/15 border-white/20 text-slate-200'
                    }`}
                    title="انقر لتبديل حالة السداد وتحديث الطلب فوراً"
                  >
                    <CheckCircle2 size={14} className={processedOrder.is_paid ? 'text-white' : 'text-slate-400'} />
                    <span>{processedOrder.is_paid ? 'تم السداد ✅' : 'لم يسدد ⏳'}</span>
                  </button>

                  <select
                    className="bg-white/15 border border-white/20 rounded-xl py-2.5 px-3 text-xs font-black text-white outline-none text-right cursor-pointer focus:bg-white/25 transition-all"
                    value={processedOrder.payment_method || 'Cash'}
                    onChange={(e) => {
                      const newMethod = e.target.value as 'Cash' | 'Card' | 'Transfer';
                      handlePaymentChange(true, newMethod);
                    }}
                    disabled={isUpdatingPayment}
                    title="تعديل طريقة الدفع (يتم التحديث فوراً)"
                  >
                    <option value="Cash" className="text-slate-900">نقدي (كاش)</option>
                    <option value="Card" className="text-slate-900">شبكة (مدى/بطاقة)</option>
                    <option value="Transfer" className="text-slate-900">تحويل بنكي</option>
                  </select>
                </div>

                {/* 3 Quick-Tab Pill Buttons: Just tab and update order instantly */}
                <div className="grid grid-cols-3 gap-1.5 pt-1.5 border-t border-white/10">
                  <button
                    type="button"
                    onClick={() => handlePaymentChange(true, 'Cash')}
                    disabled={isUpdatingPayment}
                    className={`py-2 px-1.5 rounded-xl text-xs font-black transition-all flex items-center justify-center gap-1 cursor-pointer active:scale-95 touch-manipulation ${
                      processedOrder.is_paid && processedOrder.payment_method === 'Cash'
                        ? 'bg-emerald-500 text-white shadow-sm ring-2 ring-emerald-300/40'
                        : 'bg-white/10 hover:bg-white/20 text-slate-200 border border-white/10'
                    }`}
                    title="تسديد نقدي فوري"
                  >
                    <span>💵 نقدي</span>
                    {processedOrder.is_paid && processedOrder.payment_method === 'Cash' && <Check size={11} />}
                  </button>

                  <button
                    type="button"
                    onClick={() => handlePaymentChange(true, 'Card')}
                    disabled={isUpdatingPayment}
                    className={`py-2 px-1.5 rounded-xl text-xs font-black transition-all flex items-center justify-center gap-1 cursor-pointer active:scale-95 touch-manipulation ${
                      processedOrder.is_paid && processedOrder.payment_method === 'Card'
                        ? 'bg-emerald-500 text-white shadow-sm ring-2 ring-emerald-300/40'
                        : 'bg-white/10 hover:bg-white/20 text-slate-200 border border-white/10'
                    }`}
                    title="تسديد شبكة فوري"
                  >
                    <span>💳 شبكة</span>
                    {processedOrder.is_paid && processedOrder.payment_method === 'Card' && <Check size={11} />}
                  </button>

                  <button
                    type="button"
                    onClick={() => handlePaymentChange(true, 'Transfer')}
                    disabled={isUpdatingPayment}
                    className={`py-2 px-1.5 rounded-xl text-xs font-black transition-all flex items-center justify-center gap-1 cursor-pointer active:scale-95 touch-manipulation ${
                      processedOrder.is_paid && processedOrder.payment_method === 'Transfer'
                        ? 'bg-emerald-500 text-white shadow-sm ring-2 ring-emerald-300/40'
                        : 'bg-white/10 hover:bg-white/20 text-slate-200 border border-white/10'
                    }`}
                    title="تسديد تحويل بنكي فوري"
                  >
                    <span>🏦 تحويل</span>
                    {processedOrder.is_paid && processedOrder.payment_method === 'Transfer' && <Check size={11} />}
                  </button>
                </div>
              </div>

              {/* WhatsApp Notification Status Card */}
              {notificationStatus && (
                <div
                  className={`p-3 rounded-2xl border text-right space-y-2 animate-in fade-in duration-200 ${
                    notificationStatus.sent
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                      : 'bg-amber-50 border-amber-200 text-amber-900'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <div
                      className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                        notificationStatus.sent ? 'bg-emerald-100 text-emerald-600' : 'bg-amber-100 text-amber-600'
                      }`}
                    >
                      <Send size={14} />
                    </div>
                    <div className="flex-1">
                      <p className="text-[11px] font-black leading-snug">
                        {notificationStatus.message}
                      </p>
                    </div>
                  </div>

                  {!notificationStatus.sent && notificationStatus.waUrl && (
                    <div className="pt-1.5 border-t border-amber-200/60 flex items-center justify-between gap-2">
                      <span className="text-[10px] font-bold text-amber-800">
                        إرسال الإشعار يدوياً:
                      </span>
                      <a
                        href={notificationStatus.waUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[11px] font-black shadow-xs transition-colors shrink-0"
                      >
                        <MessageSquare size={12} />
                        إرسال واتساب 💬
                      </a>
                    </div>
                  )}
                </div>
              )}

              {/* Action Buttons */}
              <div className="grid grid-cols-2 gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={handleScanAnother}
                  className="py-3 px-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-black text-xs shadow-md shadow-indigo-100 flex items-center justify-center gap-1.5 active:scale-95 transition-all cursor-pointer"
                >
                  <Camera size={15} />
                  مسح طلب آخر
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="py-3 px-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-black text-xs active:scale-95 transition-all cursor-pointer"
                >
                  تم الانتهاء
                </button>
              </div>
            </div>
          ) : (
            /* Active Camera Scanner View */
            <div className="space-y-3.5">
              {/* Hardware & Camera Dual Mode Badge */}
              <div className="flex items-center justify-between p-2.5 bg-indigo-50/80 border border-indigo-100 rounded-xl text-xs font-bold text-indigo-950">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                  <span className="text-[11px] text-slate-700 font-bold">الماسح الضوئي والكاميرا جاهزان</span>
                </div>
                <span className="text-[10px] font-black bg-white text-indigo-800 border border-indigo-200 px-2 py-0.5 rounded-md shadow-2xs">
                  مسح فوري ⚡
                </span>
              </div>

              {/* Camera Preview Container with responsive height */}
              <div 
                className="relative rounded-2xl overflow-hidden bg-slate-950 h-52 sm:h-60 flex items-center justify-center border-2 border-slate-900 shadow-inner select-none touch-none shrink-0"
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                onClick={handleTapToFocus}
              >
                {/* Hidden canvas for decoding */}
                <canvas ref={canvasRef} className="hidden" />

                {/* Video feed with hardware/digital zoom scaling */}
                <video
                  ref={videoRef}
                  className="w-full h-full object-cover"
                  autoPlay
                  playsInline
                  muted
                  disablePictureInPicture
                  style={{
                    transform: `scale(${zoomLevel})`,
                    transformOrigin: 'center center',
                    transition: 'transform 0.12s ease-out'
                  }}
                />

                {/* Optical Scanning Overlay */}
                <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center">
                  {/* Scanner Target Box with Corner Guides & Success Pulse */}
                  <div className={`w-40 h-40 sm:w-48 sm:h-48 border-2 rounded-2xl relative overflow-hidden shadow-2xl backdrop-brightness-110 transition-all duration-300 ${
                    scanSuccessPulse 
                      ? 'border-emerald-400 bg-emerald-500/20 shadow-[0_0_30px_#10b981]' 
                      : 'border-indigo-400/60'
                  }`}>
                    {/* Corner Reticles */}
                    <div className={`absolute top-0 right-0 w-5 h-5 border-t-4 border-r-4 rounded-tr-lg transition-colors ${scanSuccessPulse ? 'border-emerald-400' : 'border-indigo-400'}`} />
                    <div className={`absolute top-0 left-0 w-5 h-5 border-t-4 border-l-4 rounded-tl-lg transition-colors ${scanSuccessPulse ? 'border-emerald-400' : 'border-indigo-400'}`} />
                    <div className={`absolute bottom-0 right-0 w-5 h-5 border-b-4 border-r-4 rounded-br-lg transition-colors ${scanSuccessPulse ? 'border-emerald-400' : 'border-indigo-400'}`} />
                    <div className={`absolute bottom-0 left-0 w-5 h-5 border-b-4 border-l-4 rounded-bl-lg transition-colors ${scanSuccessPulse ? 'border-emerald-400' : 'border-indigo-400'}`} />

                    {/* Animated Scanning Laser Line */}
                    {isScanning && !isProcessing && !scanSuccessPulse && (
                      <div className="absolute inset-x-0 h-0.5 bg-gradient-to-r from-transparent via-indigo-400 to-transparent shadow-[0_0_12px_#818cf8] animate-pulse"
                        style={{
                          animation: 'scanLaser 2.2s infinite ease-in-out'
                        }}
                      />
                    )}

                    {/* Center Success Icon Pulse */}
                    {scanSuccessPulse && (
                      <div className="absolute inset-0 flex items-center justify-center animate-in zoom-in-50 duration-200">
                        <div className="p-3 rounded-full bg-emerald-500 text-white shadow-xl shadow-emerald-500/40 animate-bounce">
                          <Check size={28} className="stroke-[3]" />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Guide text */}
                  <div className="mt-2 flex items-center gap-1.5">
                    <span className="px-2.5 py-1 rounded-full bg-slate-900/80 backdrop-blur-md text-white text-[10px] sm:text-[11px] font-black shadow-md border border-white/10">
                      {isProcessing ? 'جاري معالجة الطلب...' : 'وجه الكاميرا نحو رمز QR أو الباركود'}
                    </span>
                  </div>
                </div>

                {/* Camera Top Controls */}
                <div className="absolute top-2.5 left-2.5 right-2.5 flex items-center justify-between pointer-events-auto">
                  <div className="flex items-center gap-1.5">
                    {/* Flashlight / Torch toggle button */}
                    {torchSupported && (
                      <button
                        type="button"
                        onClick={toggleTorch}
                        className={`p-2 rounded-xl backdrop-blur-sm transition-all text-xs flex items-center gap-1 cursor-pointer shadow-md ${
                          torchOn 
                            ? 'bg-amber-500 text-white shadow-amber-500/30 font-black' 
                            : 'bg-slate-900/70 hover:bg-slate-900 text-white'
                        }`}
                        title={torchOn ? 'إطفاء الفلاش' : 'تشغيل الفلاش'}
                      >
                        <Flashlight size={14} className={torchOn ? 'fill-current' : ''} />
                      </button>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={toggleFacingMode}
                    className="px-2.5 py-1.5 rounded-xl bg-slate-900/70 hover:bg-slate-900 text-white backdrop-blur-sm transition-all text-xs flex items-center gap-1.5 cursor-pointer shadow-md"
                    title="تبديل الكاميرا (أمامية / خلفية)"
                  >
                    <RotateCw size={13} />
                    <span className="text-[10px] font-bold">تبديل الكاميرا</span>
                  </button>
                </div>
              </div>

              {/* Error Banner */}
              {cameraError && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-900 text-xs font-bold space-y-2 text-right animate-in fade-in duration-200">
                  <div className="flex items-start gap-2">
                    <AlertCircle size={16} className="text-amber-600 shrink-0 mt-0.5" />
                    <div className="flex-1 whitespace-pre-line leading-relaxed text-[11px]">
                      {cameraError}
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-2 pt-1 border-t border-amber-200/60">
                    <button
                      type="button"
                      onClick={() => {
                        setCameraError(null);
                        isProcessingRef.current = false;
                        isScanningRef.current = true;
                        setIsScanning(true);
                        startCamera();
                      }}
                      className="px-3 py-1.5 bg-slate-900 text-white hover:bg-slate-800 rounded-lg text-[11px] font-black transition-all cursor-pointer flex items-center gap-1"
                    >
                      <span>متابعة المسح 📸</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Manual Input Fallback */}
              <div className="pt-2 border-t border-slate-100">
                <form onSubmit={handleManualSubmit} className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] font-bold text-slate-500">
                    <span>أو أدخل رقم الفاتورة / الطلب يدوياً:</span>
                    <span className="text-[10px] text-indigo-600 font-bold bg-indigo-50 px-2 py-0.5 rounded-md">بحث في كامل قاعدة البيانات ⚡</span>
                  </div>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <QrCode className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" size={15} />
                      <input
                        type="text"
                        placeholder="مثال: 70397 أو ORD-70397 أو #70397"
                        value={manualInput}
                        onChange={e => setManualInput(e.target.value)}
                        className="w-full pr-9 pl-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-indigo-500 focus:bg-white text-xs font-bold font-mono transition-all text-right"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={!manualInput.trim() || isProcessing}
                      className="px-3.5 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-xl text-xs font-black flex items-center gap-1.5 transition-all shrink-0 cursor-pointer shadow-sm active:scale-95"
                    >
                      {isProcessing ? <RefreshCw size={13} className="animate-spin" /> : <Search size={13} />}
                      <span>{isProcessing ? 'جاري البحث...' : 'بحث وتجهيز'}</span>
                    </button>
                  </div>
                </form>
              </div>

              {/* Extra Close Button at bottom for easy mobile tap */}
              <div className="pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 active:scale-95 text-slate-700 rounded-xl font-black text-xs transition-all flex items-center justify-center gap-1.5 cursor-pointer touch-manipulation"
                >
                  <X size={15} />
                  <span>إلغاء وإغلاق الماسح</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Laser Scanning Animation Style */}
      <style>{`
        @keyframes scanLaser {
          0% { top: 8%; }
          50% { top: 88%; }
          100% { top: 8%; }
        }
      `}</style>
    </div>
  );
};
