# MindMesh — AI-Powered Personal Knowledge Management & Intelligent Learning System

MindMesh is a full-stack personal knowledge ecosystem that enables learners to store, organize, visualize, semantically search, recall, connect, and test their personal knowledge from one unified Cloud Firestore repository.

Built as an Object-Oriented Programming (OOP) full-stack project, MindMesh cleanly separates its TypeScript OOP domain models, interfaces, repositories, exception hierarchy, and polymorphic feature services from its React presentation layer and server-side Gemini API endpoints.

---

## Core Features

All seven modules operate over the **same central personal knowledge repository** in Cloud Firestore:

1. **Brain Graph — Visual Knowledge Network**: Interactive React Flow graph that represents every saved note as a node and automatically computes weighted relationships from Gemini semantic embeddings, shared tags, subjects, and lexical overlap. Supports zooming, panning, dragging (with saved coordinates), subject filters, neighbor highlighting, and two-node comparison.
2. **AI Study Assistant**: Multi-turn study chatbot grounded strictly in the user's saved notes. Supports Ask, Simplify, Summarize, and Examples modes, cites clickable source notes, transparently notifies when saved notes lack sufficient coverage, saves useful snippets, and persists separate conversation threads.
3. **Automatic Mind Map Generator**: Converts one or multiple selected notes into an interactive hierarchical mind map via Gemini. Users can edit node titles/descriptions, add child branches, reparent or drag nodes, delete subtrees, persist/reopen mind maps in Firestore, and export as PNG images.
4. **Semantic Knowledge Search**: Hybrid natural-language search combining Gemini `gemini-embedding-2` cosine similarity with keyword scoring. Surfaces conceptually related notes even when exact search words are absent, with subject/tag/date filters and persistent recent search history.
5. **Adaptive Quiz Generator**: Generates multiple-choice and short-answer quizzes from selected notes or subjects across Easy, Medium, and Hard tiers. Grades responses with AI explanations, saves immutable attempts, tracks per-subject performance, recommends weak topics for revision, and automatically adjusts recommended difficulty based on recent scores.
6. **Memory Revival Engine**: Detects the topic currently being studied and scans older saved notes for semantically related prerequisites. Displays "Revived Memories" with AI-generated relevance explanations, direct note opening, bookmarking, and dismissal (preventing repeated irrelevant suggestions).
7. **Explain My Connection**: Connects directly to Brain Graph. Users pick any two concept nodes (or jump straight from Brain Graph) to run a Breadth-First Search (BFS) shortest-path trace, view intermediate bridge concepts, read a note-grounded explanation with practical real-world examples, inspect source notes, and save explanations.

Additional platform capabilities:
- **Smart Note Capture (Image-to-Notes)**: Upload up to 6 images (JPG, JPEG, PNG, WebP) or capture photos via mobile camera (`capture="environment"`) of handwritten, printed, classroom, or textbook notes. Extracts headings, lists, equations, code snippets, and structure via server-side Gemini multimodal vision, flags unclear text with `[unclear]` warnings instead of hallucinating, optionally auto-generates title/summary/subject/tags, lets users review and edit side-by-side against the original photo, optionally retains compressed source images privately in `noteAttachments`, and automatically indexes saved notes into all seven MindMesh modules.
- **Notes CRUD & Revision Snapshots**: Create, edit, preview, filter, sort, and delete notes with markdown formatting helpers and automatic immutable `NoteVersions` snapshots before each edit.
- **Chronological Learning History**: Records notes, captured notes, AI chats, searches, quizzes, mind maps, memory revivals, and connection explanations across sessions with one-click reopen and history clearing.
- **Authentication & Privacy**: Firebase Authentication (Google Sign-In plus Email/Password registration, login, and password reset when enabled in Firebase Console), profile management, and full account + data deletion.

---

## Technology Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Lucide React, `@xyflow/react` (React Flow), `html-to-image`
- **Backend**: Node.js, Express, TypeScript (`tsx` in development, native `node server.ts` in production)
- **AI**: Google `@google/genai` SDK (`gemini-4-hydrogen` for structured reasoning & chat, `gemini-embedding-2` with 256-dim vectors for semantic similarity), executed strictly server-side
- **Database & Auth**: Firebase Authentication + Cloud Firestore with hardened per-user Security Rules (`firestore.rules`)

---

## Folder Structure

```text
/
├── server.ts                                    # Express server + server-side Gemini API endpoints + Vite middleware
├── firebase-applet-config.json                  # Provisioned Firebase client configuration
├── firebase-blueprint.json                      # Firestore entity & collection schema blueprint
├── firestore.rules                              # Deployed zero-trust per-user Firestore security rules
├── security_spec.md                             # Security invariants & adversarial test specification
├── eslint.config.mjs                            # Security rules ESLint configuration
└── src/
    ├── firebase/
    │   ├── config.ts                            # Firebase initialization & startup connection check
    │   └── errors.ts                            # Structured FirestoreErrorInfo & handleFirestoreError
    ├── core/
    │   ├── exceptions/MindMeshExceptions.ts     # Domain OOP exception hierarchy
    │   ├── interfaces/CoreInterfaces.ts         # Repository, Searchable, Explainable, Generatable, AIProvider
    │   ├── models/
    │   │   ├── User.ts                          # User class (Encapsulation + Aggregation) & DTOs
    │   │   ├── Note.ts                          # Note & NoteVersion classes + similarity math
    │   │   ├── NoteAttachment.ts                # NoteAttachment class for private retained capture images
    │   │   ├── Subject.ts                       # Subject grouping & color resolution class
    │   │   ├── KnowledgeGraph.ts                # KnowledgeGraph, GraphNode, GraphEdge (Composition + BFS)
    │   │   ├── MindMap.ts                       # MindMap & MindMapNode (Composition + tree layout/mutations)
    │   │   └── Quiz.ts                          # Quiz, Question, QuizAttempt (Composition + adaptive engine)
    │   ├── providers/ServerAIProvider.ts        # Implements AIProvider via /api/ai/*
    │   ├── repositories/FirestoreRepositories.ts # Implements Repository<T> for all 11 collections
    │   └── services/
    │       ├── BaseFeatureService.ts            # Abstract superclass for all feature services
    │       ├── BrainGraphService.ts             # Feature 1
    │       ├── StudyAssistantService.ts         # Feature 2
    │       ├── MindMapService.ts                # Feature 3
    │       ├── SemanticSearchService.ts         # Feature 4
    │       ├── QuizGeneratorService.ts          # Feature 5
    │       ├── MemoryRevivalService.ts          # Feature 6
    │       ├── ConnectionExplanationService.ts  # Feature 7
    │       ├── SmartNoteCaptureService.ts       # Smart Note Capture (Image-to-Notes) vision service
    │       └── KnowledgeWorkspaceService.ts     # Central coordinator uniting CRUD & all feature services
    ├── context/
    │   ├── AuthContext.tsx                      # Firebase Auth state & account actions
    │   └── KnowledgeContext.tsx                 # Real-time Firestore subscriptions for central repository
    ├── components/
    │   ├── AuthScreen.tsx                       # Login, registration, password reset, verification
    │   ├── ErrorBoundary.tsx                    # React error boundary
    │   ├── Sidebar.tsx                          # Collapsible 11-item navigation sidebar
    │   ├── SmartNoteCaptureModal.tsx            # Multi-image upload, camera capture & side-by-side review modal
    │   ├── TopBar.tsx                           # Contextual workspace header
    │   └── ToastNotification.tsx                # Toasts & accessible ConfirmDialog modal
    └── pages/
        ├── DashboardPage.tsx
        ├── NotesPage.tsx
        ├── BrainGraphPage.tsx
        ├── StudyAssistantPage.tsx
        ├── MindMapPage.tsx
        ├── SemanticSearchPage.tsx
        ├── AdaptiveQuizPage.tsx
        ├── MemoryRevivalPage.tsx
        ├── ExplainConnectionPage.tsx
        ├── HistoryPage.tsx
        └── SettingsPage.tsx
```

---

## Database Structure (Cloud Firestore)

Every collection enforces `userId == request.auth.uid` isolation, strict schema validation, immutable timestamps (`request.time`), and strict key allowlists in `firestore.rules`:

| Collection | Key Fields | Notes |
| --- | --- | --- |
| `users/{userId}` | `userId`, `name`, `email`, `profileImage`, `bio`, `createdAt`, `updatedAt` | Owner-only `get`/write; `list` disabled for PII protection |
| `notes/{noteId}` | `noteId`, `userId`, `title`, `content`, `subject`, `tags`, `embedding`, `createdAt`, `updatedAt` | Central knowledge repository with 256-dim semantic vectors |
| `noteVersions/{versionId}` | `versionId`, `userId`, `noteId`, `title`, `previousContent`, `subject`, `updatedAt` | Immutable pre-edit snapshots verifying parent note ownership |
| `noteAttachments/{attachmentId}` | `attachmentId`, `userId`, `noteId`, `fileName`, `mimeType`, `dataUrl`, `sizeBytes`, `createdAt` | Private retained source images linked to parent note ownership |
| `mindMaps/{mindMapId}` | `mindMapId`, `userId`, `title`, `nodes`, `connections`, `sourceNoteIds`, `createdAt`, `updatedAt` | Saved editable mind maps |
| `knowledgeGraph/{graphNodeId}` | `graphNodeId`, `userId`, `noteId`, `concept`, `subject`, `positionX`, `positionY`, `relationships`, `updatedAt` | Persisted Brain Graph node positions & weighted edges |
| `quizAttempts/{attemptId}` | `attemptId`, `userId`, `subject`, `noteIds`, `questions`, `answers`, `score`, `totalQuestions`, `difficulty`, `weakTopics`, `completedAt` | Immutable graded quiz records |
| `aiConversations/{conversationId}` | `conversationId`, `userId`, `title`, `messages`, `savedSnippets`, `createdAt`, `updatedAt` | Persistent Study Assistant threads & bookmarked answers |
| `activityHistory/{activityId}` | `activityId`, `userId`, `activityType`, `title`, `description`, `entityId`, `timestamp` | Immutable chronological learning activity log |
| `revivedStates/{stateId}` | `stateId`, `userId`, `sourceNoteId`, `revivedNoteId`, `status`, `reason`, `updatedAt` | Dismissed or bookmarked Memory Revival states |
| `savedExplanations/{explanationId}` | `explanationId`, `userId`, `sourceNodeId`, `targetNodeId`, `sourceTitle`, `targetTitle`, `intermediateConcepts`, `explanation`, `examples`, `sourceNoteIds`, `createdAt` | Immutable saved Brain Graph connection explanations |

---

## Object-Oriented Programming (OOP) Concepts Demonstrated

1. **Classes & Objects**: `User`, `Note`, `NoteVersion`, `NoteAttachment`, `Subject`, `Quiz`, `Question`, `QuizAttempt`, `MindMap`, `MindMapNode`, `KnowledgeGraph`, `GraphNode`, `GraphEdge`.
2. **Encapsulation**: Domain classes guard internal state using `private` fields (e.g., `_title`, `_content`, `_embedding`, `_nodes`, `_dataUrl`) and expose validated getters and mutator methods enforcing blueprint constraints.
3. **Abstraction**: Interfaces (`Repository<T>`, `Searchable<T, R>`, `Explainable<T, R>`, `Generatable<T, R>`, `AIProvider`) and abstract classes (`BaseFeatureService<TInput, TOutput>`, `BaseFirestoreRepository<T>`) hide persistence and API details.
4. **Inheritance**: All feature services (`BrainGraphService`, `StudyAssistantService`, `MindMapService`, `SemanticSearchService`, `QuizGeneratorService`, `MemoryRevivalService`, `ConnectionExplanationService`, `SmartNoteCaptureService`) inherit shared AI provider dependency injection, activity logging, and user validation from `BaseFeatureService`.
5. **Polymorphism**: Each feature service overrides `execute(context, input)` and `getServiceName()` with distinct behavior while being uniformly accessible through `BaseFeatureService` in `KnowledgeWorkspaceService.getRegisteredServices()`, and `ServerAIProvider` can be swapped for any `AIProvider` implementation.
6. **Composition**: `KnowledgeGraph` owns `GraphNode` & `GraphEdge` objects; `MindMap` owns `MindMapNode` objects; `Quiz` owns `Question` objects.
7. **Aggregation**: `User` aggregates independently persisted `Note`, `QuizAttempt`, and `MindMap` collections to compute workspace analytics.
8. **Exception Handling**: Custom hierarchy inheriting from `MindMeshException` (`ValidationException`, `NoteNotFoundException`, `DatabaseException`, `AIServiceException`, `AuthenticationException`, `QuizSubmissionException`, `EmptySearchException`, `ImageCaptureException`).

---

## Firebase Setup Instructions

Firebase Authentication and Cloud Firestore are provisioned via `firebase-applet-config.json` and secured by `firestore.rules`.

- **Google Sign-In** is ready out of the box.
- **Email/Password Authentication (Optional)**: If you also want Email/Password sign-up and login in addition to Google Sign-In, open the [Firebase Console](https://console.firebase.google.com/), select your project, go to **Authentication → Sign-in method**, and enable **Email/Password**.

> **Security Rules Notice**: Generated Firestore security rules in `firestore.rules` enforce verified-user ownership, strict key allowlists, and size bounds across all collections. Always review and tailor rules to your deployment requirements before sharing an application broadly.

---

## Gemini API Setup Instructions

All Gemini API calls execute exclusively inside `server.ts` using `@google/genai` and `process.env.GEMINI_API_KEY`.

- In AI Studio, configure `GEMINI_API_KEY` under **Settings → Secrets**.
- Locally, copy `.env.example` to `.env` and set `GEMINI_API_KEY="your_api_key"`.

---

## Steps to Run Locally

```bash
# 1. Install dependencies
npm install

# 2. Run development server (Express API + Vite frontend on port 3000)
npm run dev

# 3. Type-check and build for production
npm run lint
npm run build

# 4. Run production server
npm start
```
