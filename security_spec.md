# MindMesh Firestore Security Specification (Phase 0 TDD)

## 1. Data Invariants
1. **Strict Multi-Tenant Isolation**: Every document across all 11 collections belongs exclusively to one authenticated user (`userId == request.auth.uid`). No user may read, list, update, or delete another user's records. Single-document `get` checks allow `resource == null` (returning not-found with zero data leaked) while strictly requiring `resource.data.userId == request.auth.uid` for any existing document.
2. **PII Isolation**: `/users/{userId}` contains user email and profile data; `list` is globally disabled and `get`/`write` require `request.auth.uid == userId`.
3. **Verified Identity**: All writes require `request.auth != null && request.auth.token.email_verified == true`.
4. **Relational Integrity**: A `NoteVersion`, `KnowledgeGraphNode`, or `NoteAttachment` cannot be created unless the referenced parent `notes/{noteId}` exists and is owned by `request.auth.uid`.
5. **Temporal Integrity**: `createdAt`, `updatedAt`, `completedAt`, and `timestamp` must equal `request.time` on creation/update, and `createdAt`/`userId` are strictly immutable after creation.
6. **Terminal Outcome Locking**: `quizAttempts`, `noteVersions`, `activityHistory`, `savedExplanations`, and `noteAttachments` are immutable after creation (no `update` allowed).
7. **Volumetric & Type Safety**: Every document ID matches `^[a-zA-Z0-9_\-]+$` (<= 128 chars). Every string and array enforces explicit max size bounds and strict field allowlists (`hasAll` + `hasOnly` on create; `affectedKeys().hasOnly(...)` on update).

## 2. The "Dirty Dozen" Adversarial Payloads (All Must Return PERMISSION_DENIED)
1. **Identity Spoofing on Note Create**: Authenticated as `userA`, attempt to create `/notes/note-1` with `userId: "userB"`.
2. **Shadow Field Injection (Ghost Field)**: Attempt to create `/notes/note-2` with all valid fields plus an undeclared `isAdmin: true` field.
3. **Unverified Email Write**: Authenticated with `email_verified: false`, attempt to create `/notes/note-3`.
4. **Cross-User PII Read**: Authenticated as `userA`, attempt `get` on `/users/userB`.
5. **Users Collection Enumeration**: Authenticated as `userA`, attempt `list` on `/users`.
6. **Unfiltered Notes Scrape**: Authenticated as `userA`, attempt `list` on `/notes` without `where('userId', '==', 'userA')` when `userB` has notes.
7. **Timestamp Forgery**: Attempt to create `/notes/note-4` with a client-forged `createdAt` timestamp instead of `serverTimestamp()`.
8. **Immutable Field Tampering**: Attempt to update `/notes/note-1` changing `userId` or `createdAt`.
9. **ID Poisoning**: Attempt to create `/notes/../../etc/passwd` or a 200-char document ID.
10. **Orphaned NoteVersion**: Attempt to create `/noteVersions/ver-1` referencing a non-existent `noteId: "ghost-note"` or a note owned by `userB`.
11. **Terminal State Mutation**: Attempt to `update` a completed `/quizAttempts/quiz-1` to change `score` from 40 to 100.
12. **Denial-of-Wallet Oversized Payload**: Attempt to create `/notes/note-5` with a 100-item `tags` array or 250-char `title` exceeding blueprint limits.
