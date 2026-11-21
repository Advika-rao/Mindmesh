import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import {
  createUserWithEmailAndPassword,
  deleteUser,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User as FirebaseUser,
} from 'firebase/auth';
import { auth, googleProvider } from '../firebase/config';
import { workspaceService } from '../core/services/KnowledgeWorkspaceService';
import type { UserProfileDTO } from '../core/models/User';
import { AuthenticationException } from '../core/exceptions/MindMeshExceptions';

interface AuthContextValue {
  firebaseUser: FirebaseUser | null;
  profile: UserProfileDTO | null;
  loading: boolean;
  emailVerified: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  registerWithEmail: (name: string, email: string, password: string) => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  resendVerificationEmail: () => Promise<void>;
  refreshAuthState: () => Promise<void>;
  logout: () => Promise<void>;
  updateUserProfile: (updates: { name: string; bio: string; profileImage: string }) => Promise<void>;
  deleteAccountAndData: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function mapAuthError(error: unknown): string {
  const code = (error as { code?: string })?.code || '';
  switch (code) {
    case 'auth/popup-closed-by-user':
      return 'Sign-in window was closed before completing authentication.';
    case 'auth/operation-not-allowed':
      return 'Email/Password sign-in is not yet enabled in the Firebase Console for this project. Use Google Sign-In, or enable Email/Password under Firebase Console → Authentication → Sign-in method.';
    case 'auth/email-already-in-use':
      return 'An account with this email already exists. Try signing in instead.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Invalid email or password. Please check your credentials and try again.';
    case 'auth/weak-password':
      return 'Password should be at least 6 characters long.';
    case 'auth/invalid-email':
      return 'Please enter a valid email address.';
    case 'auth/requires-recent-login':
      return 'For security, please sign out and sign back in before deleting your account.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a few moments before trying again.';
    default:
      return error instanceof Error ? error.message : 'Authentication failed. Please try again.';
  }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [emailVerifiedState, setEmailVerifiedState] = useState(false);
  const [profile, setProfile] = useState<UserProfileDTO | null>(null);
  const [loading, setLoading] = useState(true);

  const ensureUserProfile = useCallback(async (user: FirebaseUser): Promise<UserProfileDTO | null> => {
    try {
      const existing = await workspaceService.userRepo.getById(user.uid);
      if (existing) {
        setProfile(existing);
        return existing;
      }
      if (!user.emailVerified) {
        const fallback: UserProfileDTO = {
          userId: user.uid,
          name: user.displayName || user.email?.split('@')[0] || 'Learner',
          email: user.email || '',
          profileImage: user.photoURL || '',
          bio: '',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        setProfile(fallback);
        return fallback;
      }
      const newProfile = {
        userId: user.uid,
        name: user.displayName || user.email?.split('@')[0] || 'Learner',
        email: user.email || '',
        profileImage: user.photoURL || '',
        bio: '',
      };
      await workspaceService.userRepo.createProfile(newProfile);
      const created: UserProfileDTO = {
        ...newProfile,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      setProfile(created);
      return created;
    } catch (err) {
      console.error('Failed to sync user profile:', err);
      return null;
    }
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      setEmailVerifiedState(Boolean(user?.emailVerified));
      if (user) {
        await ensureUserProfile(user);
      } else {
        setProfile(null);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, [ensureUserProfile]);

  const signInWithGoogle = async (): Promise<void> => {
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      if (cred.user) {
        await ensureUserProfile(cred.user);
      }
    } catch (err) {
      throw new AuthenticationException(mapAuthError(err));
    }
  };

  const signInWithEmail = async (email: string, password: string): Promise<void> => {
    try {
      const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
      if (cred.user) {
        await ensureUserProfile(cred.user);
      }
    } catch (err) {
      throw new AuthenticationException(mapAuthError(err));
    }
  };

  const registerWithEmail = async (name: string, email: string, password: string): Promise<void> => {
    try {
      const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
      if (cred.user) {
        await updateProfile(cred.user, { displayName: name.trim() });
        await sendEmailVerification(cred.user);
        await ensureUserProfile(cred.user);
      }
    } catch (err) {
      throw new AuthenticationException(mapAuthError(err));
    }
  };

  const requestPasswordReset = async (email: string): Promise<void> => {
    try {
      await sendPasswordResetEmail(auth, email.trim());
    } catch (err) {
      throw new AuthenticationException(mapAuthError(err));
    }
  };

  const resendVerificationEmail = async (): Promise<void> => {
    if (!auth.currentUser) return;
    try {
      await sendEmailVerification(auth.currentUser);
    } catch (err) {
      throw new AuthenticationException(mapAuthError(err));
    }
  };

  const refreshAuthState = async (): Promise<void> => {
    if (!auth.currentUser) return;
    await auth.currentUser.reload();
    await auth.currentUser.getIdToken(true);
    setFirebaseUser(auth.currentUser);
    setEmailVerifiedState(Boolean(auth.currentUser.emailVerified));
    await ensureUserProfile(auth.currentUser);
  };

  const logout = async (): Promise<void> => {
    await signOut(auth);
    setProfile(null);
  };

  const updateUserProfile = async (updates: {
    name: string;
    bio: string;
    profileImage: string;
  }): Promise<void> => {
    if (!auth.currentUser) throw new AuthenticationException('You must be signed in.');
    await workspaceService.userRepo.updateProfile(auth.currentUser.uid, updates);
    await updateProfile(auth.currentUser, {
      displayName: updates.name.trim(),
      photoURL: updates.profileImage.trim() || null,
    });
    setProfile((prev) =>
      prev
        ? {
            ...prev,
            name: updates.name.trim(),
            bio: updates.bio.trim(),
            profileImage: updates.profileImage.trim(),
            updatedAt: new Date(),
          }
        : prev
    );
  };

  const deleteAccountAndData = async (): Promise<void> => {
    const current = auth.currentUser;
    if (!current) throw new AuthenticationException('You must be signed in.');
    try {
      await workspaceService.deleteAllUserData(current.uid);
      await deleteUser(current);
      setProfile(null);
      setFirebaseUser(null);
    } catch (err) {
      throw new AuthenticationException(mapAuthError(err));
    }
  };

  return (
    <AuthContext.Provider
      value={{
        firebaseUser,
        profile,
        loading,
        emailVerified: emailVerifiedState || Boolean(firebaseUser?.emailVerified),
        signInWithGoogle,
        signInWithEmail,
        registerWithEmail,
        requestPasswordReset,
        resendVerificationEmail,
        refreshAuthState,
        logout,
        updateUserProfile,
        deleteAccountAndData,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
