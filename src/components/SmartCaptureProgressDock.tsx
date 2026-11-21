import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  ImagePlus,
  Loader2,
  X,
  XCircle,
} from 'lucide-react';
import { useKnowledge } from '../context/KnowledgeContext';
import { useSmartCapture } from '../context/SmartCaptureContext';

/**
 * Non-blocking floating background task dock shown whenever Smart Note Capture
 * is actively processing or has preserved results while the user is browsing
 * other notes or MindMesh modules. Never covers or freezes the viewport.
 */
export const SmartCaptureProgressDock: React.FC = () => {
  const { activePage, toasts } = useKnowledge();
  const {
    panelOpen,
    openCapturePanel,
    resetCaptureSession,
    step,
    images,
    isRunningAnyJob,
    progressPercent,
    overallStatusText,
    overallStatusTone,
    completedCount,
    processingCount,
    failedCount,
    cancelExtraction,
  } = useSmartCapture();

  const isViewingCapturePanel = panelOpen && activePage === 'notes';
  const hasPreservedWork = images.length > 0 && (step === 'extracting' || step === 'review' || completedCount > 0 || failedCount > 0);
  const shouldShow = !isViewingCapturePanel && (isRunningAnyJob || hasPreservedWork);

  if (!shouldShow) return null;

  const totalPages = images.length;

  return (
    <div
      className={`fixed right-5 z-40 w-[min(22rem,calc(100vw-2.5rem))] bg-[#0f172a] border border-slate-700/90 rounded-xl shadow-2xl p-4 space-y-3 transition-all duration-200 ${
        toasts.length > 0 ? 'bottom-24' : 'bottom-5'
      }`}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start justify-between gap-2.5">
        <div className="flex items-center gap-2 min-w-0">
          {isRunningAnyJob ? (
            <Loader2 className="w-4 h-4 text-indigo-400 animate-spin shrink-0" />
          ) : overallStatusTone === 'error' ? (
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
          ) : overallStatusTone === 'partial' ? (
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          )}

          <div className="min-w-0">
            <p className="text-xs font-semibold text-slate-100 truncate">
              {isRunningAnyJob
                ? 'Smart Note Capture'
                : completedCount > 0
                  ? 'Extracted Notes Ready'
                  : 'Smart Note Capture'}
            </p>
            <p className="text-[11px] text-slate-400 truncate">{overallStatusText}</p>
          </div>
        </div>

        {!isRunningAnyJob && (
          <button
            type="button"
            onClick={resetCaptureSession}
            aria-label="Discard and close capture dock"
            className="p-1 text-slate-400 hover:text-slate-200 rounded"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Progress Bar */}
      {isRunningAnyJob && (
        <div className="space-y-1">
          <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-indigo-500 transition-all duration-300 ease-out"
              style={{ width: `${Math.max(5, Math.min(100, progressPercent))}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-400">
            <span>
              {completedCount}/{totalPages} done
              {processingCount > 0 ? ` · ${processingCount} running` : ''}
              {failedCount > 0 ? ` · ${failedCount} failed` : ''}
            </span>
            <span>{progressPercent}%</span>
          </div>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex items-center justify-end gap-2">
        {isRunningAnyJob && (
          <button
            type="button"
            onClick={() => cancelExtraction(false)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-rose-300 bg-rose-500/12 hover:bg-rose-500/22 border border-rose-500/30 rounded-lg transition-colors"
          >
            <XCircle className="w-3.5 h-3.5" />
            Cancel All
          </button>
        )}

        <button
          type="button"
          onClick={openCapturePanel}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors"
        >
          {!isRunningAnyJob && completedCount > 0 ? (
            <>
              <ImagePlus className="w-3.5 h-3.5" />
              Review & Save
            </>
          ) : (
            <>
              <ExternalLink className="w-3.5 h-3.5" />
              Open
            </>
          )}
        </button>
      </div>
    </div>
  );
};
