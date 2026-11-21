import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  public static getDerivedStateFromError(error: Error): State {
    let readable = error.message || 'An unexpected application error occurred.';
    try {
      const parsed = JSON.parse(readable) as { error?: string; operationType?: string; path?: string };
      if (parsed.error) {
        readable = `Database ${parsed.operationType || 'operation'} failed on ${parsed.path || 'record'}: ${parsed.error}`;
      }
    } catch {
      // keep original message
    }
    return { hasError: true, errorMessage: readable };
  }

  public componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('MindMesh ErrorBoundary caught:', error, info);
  }

  public render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#080d1a] text-slate-100 flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-[#10182b] border border-slate-800 rounded-xl p-8 space-y-5">
            <div className="flex items-center gap-3 text-amber-400">
              <AlertTriangle className="w-6 h-6 shrink-0" />
              <h1 className="text-xl font-semibold tracking-tight text-slate-50">
                Something went wrong
              </h1>
            </div>
            <p className="text-sm text-slate-300 leading-relaxed break-words">
              {this.state.errorMessage}
            </p>
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => {
                  this.setState({ hasError: false, errorMessage: '' });
                  window.location.reload();
                }}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <RefreshCw className="w-4 h-4" />
                Reload Workspace
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
