import React, { useState, useEffect } from 'react';
import { 
  CloudOff, 
  Cloud, 
  RefreshCw, 
  CheckCircle, 
  X, 
  Trash2,
  AlertCircle,
  ShieldCheck,
  Power,
  Layers
} from 'lucide-react';
import { 
  isManualOffline, 
  isDeviceOnline, 
  getOfflineSavedInfo, 
  downloadAndSaveDataForOffline, 
  turnOffOfflineMode, 
  clearOfflineCache,
  getOfflineQueue,
  syncOfflineQueue
} from '../services/offlineSyncService';
import { supabase } from '../supabase';
import { Order } from '../types';

interface OfflineModeModalProps {
  isOpen: boolean;
  onClose: () => void;
  laundryId?: string;
  onDataSavedOffline?: (savedOrders: Order[], count: number) => void;
  onReturnOnline?: () => void;
}

export const OfflineModeModal: React.FC<OfflineModeModalProps> = ({
  isOpen,
  onClose,
  laundryId,
  onDataSavedOffline,
  onReturnOnline
}) => {
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [savedInfo, setSavedInfo] = useState(() => getOfflineSavedInfo());
  const [pendingQueueCount, setPendingQueueCount] = useState<number>(() => getOfflineQueue().length);
  const deviceOnline = isDeviceOnline();

  const refreshInfo = () => {
    setSavedInfo(getOfflineSavedInfo());
    setPendingQueueCount(getOfflineQueue().length);
  };

  useEffect(() => {
    if (isOpen) {
      refreshInfo();
      setStatusMessage(null);
      setErrorMessage(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const isCurrentlyOffline = savedInfo.isManualOffline;

  // Action: Switch to Offline Mode
  const handleGoOffline = async () => {
    setIsProcessing(true);
    setErrorMessage(null);
    setStatusMessage('جاري تفعيل وضع عدم الاتصال (الأوفلاين)...');

    try {
      if (deviceOnline) {
        // Backup current cloud state into offline storage without any slicing or limits
        const result = await downloadAndSaveDataForOffline(
          supabase,
          laundryId,
          'all',
          (msg) => setStatusMessage(msg)
        );
        if (result.success) {
          refreshInfo();
          setStatusMessage('تم تفعيل وضع عدم الاتصال (الأوفلاين) بنجاح!');
          if (onDataSavedOffline) {
            onDataSavedOffline(result.orders, result.count);
          }
          setTimeout(() => onClose(), 1200);
        } else {
          setErrorMessage(result.error || 'فشل تفعيل وضع الأوفلاين');
        }
      } else {
        // Device is already physically offline, just enable manual flag
        localStorage.setItem('laundry_manual_offline_mode', 'true');
        window.dispatchEvent(new CustomEvent('manual-offline-changed', { detail: { enabled: true } }));
        refreshInfo();
        setStatusMessage('تم تفعيل وضع عدم الاتصال بنجاح.');
        setTimeout(() => onClose(), 1200);
      }
    } catch (e: any) {
      setErrorMessage(e.message || 'حدث خطأ أثناء تفعيل الأوفلاين');
    } finally {
      setIsProcessing(false);
    }
  };

  // Action: Turn OFF Offline Mode & Return to Online
  const handleTurnOff = async () => {
    setIsProcessing(true);
    setErrorMessage(null);
    setStatusMessage('جاري إيقاف وضع الأوفلاين ومزامنة الفواتير مع السحابة...');

    try {
      const result = await turnOffOfflineMode(supabase, laundryId);
      refreshInfo();

      if (result.syncedCount > 0) {
        setStatusMessage(`تم إيقاف الأوفلاين بنجاح ومزامنة ${result.syncedCount} عملية بدون أي تكرار!`);
      } else {
        setStatusMessage('تم إيقاف وضع عدم الاتصال والعودة للوضع المتصل السحابي بنجاح!');
      }

      if (onReturnOnline) {
        onReturnOnline();
      }

      setTimeout(() => {
        onClose();
      }, 1200);
    } catch (e: any) {
      setErrorMessage(e.message || 'حدث خطأ أثناء إيقاف الأوفلاين والعودة للمتصل');
    } finally {
      setIsProcessing(false);
    }
  };

  // Action: Sync Pending Queue directly
  const handleSyncNow = async () => {
    if (!deviceOnline) {
      setErrorMessage('لا يوجد اتصال بشبكة الإنترنت لإجراء المزامنة حالياً.');
      return;
    }
    setIsProcessing(true);
    setErrorMessage(null);
    setStatusMessage('جاري مزامنة العمليات المعلقة...');
    try {
      const res = await syncOfflineQueue(supabase, laundryId);
      refreshInfo();
      if (res.syncedCount > 0) {
        setStatusMessage(`تمت مزامنة ${res.syncedCount} عملية بنجاح! ✅`);
      } else {
        setStatusMessage('كافة البيانات متزامنة مع السحابة.');
      }
      if (onReturnOnline) onReturnOnline();
    } catch (e: any) {
      setErrorMessage(e.message || 'فشلت المزامنة');
    } finally {
      setIsProcessing(false);
    }
  };

  // Action: Clear Offline Cache
  const handleClearCache = () => {
    if (pendingQueueCount > 0) {
      const confirmClear = window.confirm(`يوجد ${pendingQueueCount} عملية معلقة لم تتم مزامنتها مع السحابة بعد. هل أنت متأكد من رغبتك في مسح الذاكرة المحلية؟`);
      if (!confirmClear) return;
    }
    clearOfflineCache(laundryId);
    refreshInfo();
    setStatusMessage('تم مسح الذاكرة المحلية والعودة للوضع المتصل الافتراضي.');
    if (onReturnOnline) onReturnOnline();
    setTimeout(() => {
      setStatusMessage(null);
    }, 2000);
  };

  return (
    <div 
      id="offline-mode-modal-backdrop"
      className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-[200] flex items-center justify-center p-3 sm:p-4 animate-in fade-in duration-200"
      dir="rtl"
      onClick={onClose}
    >
      <div 
        id="offline-mode-modal-card"
        className="bg-white rounded-[2rem] sm:rounded-[2.5rem] shadow-2xl border border-slate-100 w-full max-w-lg flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="p-5 sm:p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/70">
          <div className="flex items-center gap-3.5">
            <div className={`w-11 h-11 rounded-2xl flex items-center justify-center shadow-inner ${
              isCurrentlyOffline 
                ? 'bg-amber-100 text-amber-700' 
                : 'bg-emerald-100 text-emerald-700'
            }`}>
              {isCurrentlyOffline ? <CloudOff size={22} /> : <Cloud size={22} />}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-black text-slate-900">
                  وضع عدم الاتصال (Offline Mode)
                </h3>
              </div>
              <p className="text-xs text-slate-500 font-bold mt-0.5">
                التحكم بالوضع المتصل المباشر أو وضع الأوفلاين
              </p>
            </div>
          </div>

          <button 
            type="button"
            id="btn-close-offline-modal"
            onClick={onClose}
            className="w-9 h-9 rounded-xl bg-white hover:bg-slate-200/70 text-slate-400 hover:text-slate-700 flex items-center justify-center transition"
            title="إغلاق"
          >
            <X size={18} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 sm:p-6 space-y-5">

          {/* Current Status Box */}
          <div className={`p-4 rounded-2xl border transition-all ${
            isCurrentlyOffline 
              ? 'bg-amber-50/90 border-amber-200 text-amber-950' 
              : 'bg-emerald-50/80 border-emerald-200 text-emerald-950'
          }`}>
            <div className="flex items-center justify-between gap-3 mb-2">
              <span className="text-xs font-black uppercase text-slate-500">حالة النظام الحالية</span>
              <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-black ${
                isCurrentlyOffline 
                  ? 'bg-amber-200 text-amber-900' 
                  : 'bg-emerald-200 text-emerald-900'
              }`}>
                {isCurrentlyOffline ? 'أوفلاين مفعل 🟡' : 'متصل بالسحابة مباشر 🟢'}
              </span>
            </div>

            <p className="text-sm font-black flex items-center gap-2">
              {isCurrentlyOffline ? (
                <>
                  <CloudOff size={18} className="text-amber-600" />
                  وضع الأوفلاين مفعل (العمل محلياً)
                </>
              ) : (
                <>
                  <Cloud size={18} className="text-emerald-600" />
                  الوضع المتصل السحابي المباشر (Online)
                </>
              )}
            </p>

            <p className="text-xs text-slate-600 font-medium mt-1.5 leading-relaxed">
              {isCurrentlyOffline 
                ? 'يعمل النظام حالياً بشكل مستقل بدون الحاجة للإنترنت. سيتم تسجيل كافة الفواتير وحفظها ومزامنتها فور إيقاف الأوفلاين أو عودة الاتصال.' 
                : 'أنت الآن متصل مباشرة بقاعدة البيانات السحابية، وجميع الفواتير والطلبات يتم تحميلها فورياً وكاملة بدون أي قيود أو اقتطاع.'
              }
            </p>

            {pendingQueueCount > 0 && (
              <div className="mt-3 pt-3 border-t border-amber-200/80 flex items-center justify-between text-xs font-black">
                <span className="text-amber-900">يوجد {pendingQueueCount} عملية معلقة بانتظار المزامنة</span>
                {deviceOnline && (
                  <button
                    type="button"
                    onClick={handleSyncNow}
                    disabled={isProcessing}
                    className="px-3 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-[11px] font-black flex items-center gap-1 shadow-xs transition cursor-pointer"
                  >
                    <RefreshCw size={12} className={isProcessing ? 'animate-spin' : ''} />
                    <span>مزامنة الآن</span>
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Feedback Messages */}
          {statusMessage && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-xl text-xs font-bold flex items-center gap-2 animate-in fade-in">
              <CheckCircle size={15} className="text-emerald-600 shrink-0" />
              <span>{statusMessage}</span>
            </div>
          )}

          {errorMessage && (
            <div className="p-3 bg-red-50 border border-red-200 text-red-900 rounded-xl text-xs font-bold flex items-center gap-2 animate-in fade-in">
              <AlertCircle size={15} className="text-red-600 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Guarantee Note */}
          <div className="p-3.5 bg-slate-50 rounded-2xl border border-slate-200/80 text-[11px] text-slate-600 space-y-1">
            <p className="font-black text-slate-800 flex items-center gap-1.5">
              <ShieldCheck size={14} className="text-indigo-600" />
              <span>آلية العمل البسيطة والمباشرة</span>
            </p>
            <p className="leading-relaxed text-slate-500">
              • عندما تكون <strong>متصلاً (Online)</strong>: تُعرض كافة البيانات من السحابة بدون حفظ مسبق أو اقتطاع.
              <br />
              • عندما ينقطع الإنترنت أو تفعّل <strong>الأوفلاين (Offline)</strong>: يواصل النظام العمل وإصدار الفواتير وطباعتها وتخزينها للمزامنة عند الاتصال.
            </p>
          </div>
        </div>

        {/* Modal Footer Actions */}
        <div className="p-4 sm:p-5 border-t border-slate-100 bg-slate-50/80 flex items-center justify-between gap-3">
          <div>
            {isCurrentlyOffline && (
              <button
                type="button"
                onClick={handleClearCache}
                disabled={isProcessing}
                className="text-red-600 hover:text-red-700 text-xs font-bold flex items-center gap-1 cursor-pointer transition"
                title="مسح الذاكرة المحلية والعودة للوضع المتصل"
              >
                <Trash2 size={13} />
                <span>مسح الذاكرة</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              id="btn-cancel-offline-modal"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 text-xs font-bold transition cursor-pointer"
            >
              إغلاق
            </button>

            {isCurrentlyOffline ? (
              <button
                type="button"
                id="btn-turn-off-offline-mode"
                onClick={handleTurnOff}
                disabled={isProcessing}
                className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-xs font-black shadow-md shadow-emerald-200 flex items-center gap-2 transition disabled:opacity-50 cursor-pointer"
              >
                {isProcessing ? (
                  <>
                    <RefreshCw size={14} className="animate-spin" />
                    <span>جاري الإيقاف...</span>
                  </>
                ) : (
                  <>
                    <Power size={14} />
                    <span>العودة للمتصل السحابي (Online)</span>
                  </>
                )}
              </button>
            ) : (
              <button
                type="button"
                id="btn-activate-offline-mode"
                onClick={handleGoOffline}
                disabled={isProcessing}
                className="px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 active:scale-95 text-white text-xs font-black shadow-md shadow-amber-200 flex items-center gap-2 transition disabled:opacity-50 cursor-pointer"
              >
                {isProcessing ? (
                  <>
                    <RefreshCw size={14} className="animate-spin" />
                    <span>جاري التفعيل...</span>
                  </>
                ) : (
                  <>
                    <CloudOff size={14} />
                    <span>تفعيل وضع الأوفلاين (Go Offline)</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
