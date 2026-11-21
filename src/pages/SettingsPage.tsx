import React, { useEffect, useState } from 'react';
import { Save, Trash2, ShieldAlert, Loader2, LogOut } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useKnowledge } from '../context/KnowledgeContext';
import { workspaceService } from '../core/services/KnowledgeWorkspaceService';
import { ConfirmDialog } from '../components/ToastNotification';

export const SettingsPage: React.FC = () => {
  const { firebaseUser, profile, updateUserProfile, deleteAccountAndData, logout } = useAuth();
  const { notes, mindMaps, quizAttempts, conversations, activities, notify } = useKnowledge();

  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [profileImage, setProfileImage] = useState('');
  const [saving, setSaving] = useState(false);

  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmDeleteAccountOpen, setConfirmDeleteAccountOpen] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);

  useEffect(() => {
    if (profile) {
      setName(profile.name);
      setBio(profile.bio);
      setProfileImage(profile.profileImage);
    }
  }, [profile]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      notify('Display name cannot be empty.', 'error');
      return;
    }
    setSaving(true);
    try {
      await updateUserProfile({ name, bio, profileImage });
      notify('Profile updated successfully.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to update profile.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleClearHistory = async () => {
    if (!firebaseUser) return;
    setClearing(true);
    try {
      const count = await workspaceService.clearActivityHistory(firebaseUser.uid);
      setConfirmClearOpen(false);
      notify(`Cleared ${count} history records.`, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to clear history.', 'error');
    } finally {
      setClearing(false);
    }
  };

  const handleDeleteAccount = async () => {
    setDeletingAccount(true);
    try {
      await deleteAccountAndData();
      setConfirmDeleteAccountOpen(false);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Account deletion failed.', 'error');
      setDeletingAccount(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Profile Settings */}
      <form
        onSubmit={handleSaveProfile}
        className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-6 space-y-5"
      >
        <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-800/80">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-50">User Profile</h2>
            <p className="text-xs text-slate-400">
              Manage your MindMesh workspace identity ({profile?.email || firebaseUser?.email}).
            </p>
          </div>
          <button
            type="button"
            onClick={() => void logout()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign Out
          </button>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label htmlFor="settings-name" className="block text-xs font-medium text-slate-300">
              Full Name
            </label>
            <input
              id="settings-name"
              type="text"
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3.5 py-2.5 text-sm bg-[#0b1120] border border-slate-800 focus:border-indigo-500 focus:outline-none rounded-lg text-slate-100"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="settings-email" className="block text-xs font-medium text-slate-300">
              Email Address
            </label>
            <input
              id="settings-email"
              type="email"
              disabled
              value={profile?.email || firebaseUser?.email || ''}
              className="w-full px-3.5 py-2.5 text-sm bg-[#0b1120]/60 border border-slate-800 rounded-lg text-slate-500 cursor-not-allowed"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="settings-bio" className="block text-xs font-medium text-slate-300">
            Study Focus / Bio
          </label>
          <textarea
            id="settings-bio"
            rows={3}
            maxLength={500}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="e.g., Computer Science undergraduate focusing on OOP, Algorithms, and Machine Learning"
            className="w-full px-3.5 py-2.5 text-sm bg-[#0b1120] border border-slate-800 focus:border-indigo-500 focus:outline-none rounded-lg text-slate-100 placeholder:text-slate-500"
          />
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {saving ? 'Saving...' : 'Save Profile'}
          </button>
        </div>
      </form>

      {/* Workspace Data Summary */}
      <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-6 space-y-4">
        <h3 className="font-display text-base font-semibold text-slate-100">
          Stored Repository Summary
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 text-center">
          {[
            { label: 'Notes', value: notes.length },
            { label: 'Mind Maps', value: mindMaps.length },
            { label: 'Quizzes', value: quizAttempts.length },
            { label: 'AI Chats', value: conversations.length },
            { label: 'Activities', value: activities.length },
          ].map((stat) => (
            <div key={stat.label} className="p-3.5 rounded-lg bg-[#0b1120] border border-slate-800">
              <p className="font-mono text-xl font-semibold text-slate-100 tabular-nums">
                {stat.value}
              </p>
              <p className="text-xs text-slate-500 mt-0.5">{stat.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Data Privacy & Danger Zone */}
      <div className="bg-[#0f172a] border border-rose-500/25 rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2 text-rose-300">
          <ShieldAlert className="w-4 h-4" />
          <h3 className="font-display text-base font-semibold">Data & Account Management</h3>
        </div>

        <div className="divide-y divide-slate-800/80">
          <div className="py-3.5 first:pt-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-slate-200">Clear Activity History</p>
              <p className="text-xs text-slate-400">
                Permanently remove all activity log records while keeping your notes, quizzes, and mind maps.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setConfirmClearOpen(true)}
              className="px-3.5 py-2 text-xs font-medium text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/25 rounded-lg transition-colors whitespace-nowrap shrink-0 self-start sm:self-center"
            >
              Clear History
            </button>
          </div>

          <div className="py-3.5 last:pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-slate-200">Delete Account and All Data</p>
              <p className="text-xs text-slate-400">
                Permanently delete your account, all notes, revision snapshots, graph nodes, quizzes, mind maps, and conversations from Firestore.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setConfirmDeleteAccountOpen(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-rose-600 hover:bg-rose-500 rounded-lg transition-colors whitespace-nowrap shrink-0 self-start sm:self-center"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete Account
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmClearOpen}
        title="Clear activity history?"
        description="All chronological activity log items will be permanently removed from Firestore."
        confirmLabel="Clear History"
        danger
        loading={clearing}
        onConfirm={() => void handleClearHistory()}
        onCancel={() => setConfirmClearOpen(false)}
      />

      <ConfirmDialog
        open={confirmDeleteAccountOpen}
        title="Permanently delete your MindMesh account?"
        description="This action cannot be undone. Every note, mind map, quiz attempt, AI conversation, graph node, and history entry in your workspace will be erased permanently."
        confirmLabel="Delete Everything"
        danger
        loading={deletingAccount}
        onConfirm={() => void handleDeleteAccount()}
        onCancel={() => setConfirmDeleteAccountOpen(false)}
      />
    </div>
  );
};
