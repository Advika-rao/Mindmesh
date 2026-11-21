import React from 'react';
import { Menu, Plus, Presentation } from 'lucide-react';
import { useKnowledge, type AppPage } from '../context/KnowledgeContext';

interface TopBarProps {
  onOpenMobileMenu: () => void;
}

const PAGE_TITLES: Record<AppPage, string> = {
  dashboard: 'Dashboard',
  notes: 'My Notes',
  'brain-graph': 'Brain Graph',
  'study-assistant': 'AI Study Assistant',
  'mind-map': 'Mind Map Generator',
  'adaptive-quiz': 'Adaptive Quiz',
  'memory-revival': 'Memory Revival',
  'explain-connection': 'Explain My Connection',
  history: 'Learning History',
  settings: 'Settings',
};

export const TopBar: React.FC<TopBarProps> = ({ onOpenMobileMenu }) => {
  const { activePage, setActivePage, setActiveNoteId, demoMode, setDemoMode, notify } = useKnowledge();

  const handleNewNote = () => {
    setActiveNoteId(null);
    setActivePage('notes');
  };

  const handleToggleDemoMode = () => {
    const next = !demoMode;
    setDemoMode(next);
    notify(
      next
        ? 'Demo Mode enabled — using cached responses and local synthesis from your saved notes without live API calls.'
        : 'Demo Mode disabled — live Gemini AI enabled with automatic caching and local fallback.',
      'info'
    );
  };

  return (
    <header className="h-16 px-4 sm:px-6 lg:px-8 border-b border-slate-800/80 bg-[#080d1a]/90 backdrop-blur-sm sticky top-0 z-20 flex items-center justify-between gap-4">
      {/* Zone 1: Contextual breadcrumb / page title */}
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          className="lg:hidden p-2 -ml-1 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800/60 transition-colors"
          aria-label="Open navigation menu"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2 text-sm min-w-0">
          <span className="text-slate-500 hidden sm:inline whitespace-nowrap">MindMesh</span>
          <span className="text-slate-700 hidden sm:inline" aria-hidden="true">
            /
          </span>
          <h1 className="font-display text-base font-semibold text-slate-100 truncate">
            {PAGE_TITLES[activePage]}
          </h1>
        </div>
      </div>

      {/* Zone 2: Demo Mode Switch + Primary Action */}
      <div className="flex items-center gap-2.5 shrink-0">
        <button
          type="button"
          onClick={handleToggleDemoMode}
          title={
            demoMode
              ? 'Demo Mode active: runs on cached data and your saved notes without burning Gemini API quota. Click to switch back to Live AI.'
              : 'Enable Presentation Demo Mode to run reliably on cached data and your saved notes without requiring live API calls.'
          }
          className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
            demoMode
              ? 'bg-amber-500/18 border-amber-500/50 text-amber-200 hover:bg-amber-500/25'
              : 'bg-[#0f172a] border-slate-700/80 text-slate-300 hover:text-slate-100 hover:border-slate-600'
          }`}
        >
          <Presentation className="w-3.5 h-3.5 shrink-0" />
          <span>{demoMode ? 'Demo Mode: ON' : 'Demo Mode'}</span>
        </button>

        <button
          type="button"
          onClick={handleNewNote}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" />
          New Note
        </button>
      </div>
    </header>
  );
};
