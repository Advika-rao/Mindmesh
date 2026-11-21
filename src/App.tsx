import React, { useState } from 'react';
import { Loader2, BrainCircuit } from 'lucide-react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { KnowledgeProvider, useKnowledge } from './context/KnowledgeContext';
import { SmartCaptureProvider } from './context/SmartCaptureContext';
import { AuthScreen } from './components/AuthScreen';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { ToastContainer } from './components/ToastNotification';
import { SmartCaptureProgressDock } from './components/SmartCaptureProgressDock';
import { DashboardPage } from './pages/DashboardPage';
import { NotesPage } from './pages/NotesPage';
import { BrainGraphPage } from './pages/BrainGraphPage';
import { StudyAssistantPage } from './pages/StudyAssistantPage';
import { MindMapPage } from './pages/MindMapPage';
import { AdaptiveQuizPage } from './pages/AdaptiveQuizPage';
import { MemoryRevivalPage } from './pages/MemoryRevivalPage';
import { ExplainConnectionPage } from './pages/ExplainConnectionPage';
import { HistoryPage } from './pages/HistoryPage';
import { SettingsPage } from './pages/SettingsPage';

const WorkspaceShell: React.FC = () => {
  const { activePage } = useKnowledge();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const renderPage = () => {
    switch (activePage) {
      case 'dashboard':
        return <DashboardPage />;
      case 'notes':
        return <NotesPage />;
      case 'brain-graph':
        return <BrainGraphPage />;
      case 'study-assistant':
        return <StudyAssistantPage />;
      case 'mind-map':
        return <MindMapPage />;
      case 'adaptive-quiz':
        return <AdaptiveQuizPage />;
      case 'memory-revival':
        return <MemoryRevivalPage />;
      case 'explain-connection':
        return <ExplainConnectionPage />;
      case 'history':
        return <HistoryPage />;
      case 'settings':
        return <SettingsPage />;
      default:
        return <DashboardPage />;
    }
  };

  return (
    <div className="min-h-screen bg-[#080d1a] text-slate-100 flex">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar onOpenMobileMenu={() => setMobileMenuOpen(true)} />
        <main className="flex-1 p-4 sm:p-6 lg:p-8">{renderPage()}</main>
      </div>

      <SmartCaptureProgressDock />
      <ToastContainer />
    </div>
  );
};

const ProtectedAppGate: React.FC = () => {
  const { firebaseUser, emailVerified, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-[#080d1a] flex flex-col items-center justify-center gap-4 text-slate-300">
        <div className="w-11 h-11 rounded-xl bg-indigo-600/20 border border-indigo-500/40 flex items-center justify-center">
          <BrainCircuit className="w-6 h-6 text-indigo-400" />
        </div>
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
          Loading your MindMesh workspace...
        </div>
      </div>
    );
  }

  if (!firebaseUser || !emailVerified) {
    return <AuthScreen />;
  }

  return (
    <KnowledgeProvider>
      <SmartCaptureProvider>
        <WorkspaceShell />
      </SmartCaptureProvider>
    </KnowledgeProvider>
  );
};

export default function App() {
  return (
    <AuthProvider>
      <ProtectedAppGate />
    </AuthProvider>
  );
}
