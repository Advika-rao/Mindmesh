import React from 'react';
import {
  LayoutDashboard,
  FileText,
  Network,
  MessageSquareText,
  GitBranch,
  GraduationCap,
  Sparkles,
  Link2,
  History,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
  BrainCircuit,
  X,
} from 'lucide-react';
import { useKnowledge, type AppPage } from '../context/KnowledgeContext';
import { useAuth } from '../context/AuthContext';

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const NAV_ITEMS: Array<{ id: AppPage; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'notes', label: 'My Notes', icon: FileText },
  { id: 'brain-graph', label: 'Brain Graph', icon: Network },
  { id: 'study-assistant', label: 'AI Study Assistant', icon: MessageSquareText },
  { id: 'mind-map', label: 'Mind Map Generator', icon: GitBranch },
  { id: 'adaptive-quiz', label: 'Adaptive Quiz', icon: GraduationCap },
  { id: 'memory-revival', label: 'Memory Revival', icon: Sparkles },
  { id: 'explain-connection', label: 'Explain My Connection', icon: Link2 },
  { id: 'history', label: 'History', icon: History },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export const Sidebar: React.FC<SidebarProps> = ({
  collapsed,
  onToggleCollapse,
  mobileOpen,
  onCloseMobile,
}) => {
  const { activePage, setActivePage, notes } = useKnowledge();
  const { profile, logout } = useAuth();

  const handleSelect = (page: AppPage) => {
    setActivePage(page);
    onCloseMobile();
  };

  const navContent = (
    <div className="flex flex-col h-full bg-[#0b1120] border-r border-slate-800/80 select-none">
      {/* Brand Row */}
      <div className="h-16 px-4 flex items-center justify-between border-b border-slate-800/80 shrink-0">
        <button
          type="button"
          onClick={() => handleSelect('dashboard')}
          className="flex items-center gap-2.5 text-left min-w-0"
        >
          <div className="w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/40 flex items-center justify-center shrink-0">
            <BrainCircuit className="w-4 h-4 text-indigo-400" />
          </div>
          {!collapsed && (
            <span className="font-display text-base font-bold tracking-tight text-slate-50 whitespace-nowrap">
              MindMesh
            </span>
          )}
        </button>

        {/* Desktop collapse toggle */}
        <button
          type="button"
          onClick={onToggleCollapse}
          className="hidden lg:flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800/60 transition-colors"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
        </button>

        {/* Mobile close button */}
        <button
          type="button"
          onClick={onCloseMobile}
          className="lg:hidden flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800/60"
          aria-label="Close navigation menu"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Navigation Links */}
      <nav className="flex-1 overflow-y-auto px-2.5 py-4 space-y-1" aria-label="Primary navigation">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = activePage === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => handleSelect(item.id)}
              title={collapsed ? item.label : undefined}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-indigo-600/18 text-indigo-300'
                  : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/50'
              }`}
            >
              <Icon
                className={`w-4 h-4 shrink-0 ${
                  isActive ? 'text-indigo-400' : 'text-slate-400'
                }`}
              />
              {!collapsed && (
                <span className="truncate flex-1 text-left whitespace-nowrap">{item.label}</span>
              )}
              {!collapsed && item.id === 'notes' && notes.length > 0 && (
                <span className="text-xs font-mono tabular-nums text-slate-500">
                  {notes.length}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Account Footer */}
      <div className="p-3 border-t border-slate-800/80 shrink-0">
        {!collapsed ? (
          <div className="flex items-center justify-between gap-2 px-2 py-1.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-100 truncate">
                {profile?.name || 'Learner'}
              </p>
              <p className="text-xs text-slate-500 truncate">{profile?.email || ''}</p>
            </div>
            <button
              type="button"
              onClick={() => void logout()}
              className="p-2 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-slate-800/70 transition-colors shrink-0"
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void logout()}
            className="w-full flex items-center justify-center p-2.5 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-slate-800/70 transition-colors"
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Sidebar */}
      <aside
        className={`hidden lg:block shrink-0 transition-[width] duration-200 ${
          collapsed ? 'w-[68px]' : 'w-[252px]'
        }`}
      >
        <div className="sticky top-0 h-screen">{navContent}</div>
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/70 backdrop-blur-xs"
            onClick={onCloseMobile}
          />
          <div className="relative w-72 max-w-[82vw] h-full z-10">{navContent}</div>
        </div>
      )}
    </>
  );
};
