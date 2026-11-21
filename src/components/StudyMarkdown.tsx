import React, { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Check, Copy, Globe2 } from 'lucide-react';

interface StudyMarkdownProps {
  content: string;
  compact?: boolean;
}

/**
 * Normalizes LaTeX delimiters (\( ... \) and \[ ... \]) to remark-math compatible
 * $...$ and $$...$$ syntax while leaving fenced and inline code blocks untouched.
 */
function normalizeMathDelimiters(markdown: string): string {
  if (!markdown) return '';

  // Split by fenced code blocks so we never mutate code snippets
  const segments = markdown.split(/(```[\s\S]*?```)/g);
  return segments
    .map((segment, index) => {
      if (index % 2 === 1) return segment; // fenced code block

      // Preserve inline code spans while converting LaTeX delimiters outside them
      const inlineParts = segment.split(/(`[^`\n]+`)/g);
      return inlineParts
        .map((part, pIdx) => {
          if (pIdx % 2 === 1) return part; // inline code
          return part
            .replace(/\\\[([\s\S]*?)\\\]/g, (_match, expr: string) => `\n$$\n${expr.trim()}\n$$\n`)
            .replace(/\\\((.+?)\\\)/g, (_match, expr: string) => `$${expr.trim()}$`);
        })
        .join('');
    })
    .join('');
}

interface SplitKnowledgeSections {
  groundedMarkdown: string;
  externalMarkdown: string | null;
}

const EXTERNAL_SECTION_REGEX =
  /^\s{0,3}#{1,4}\s+(?:additional\s+general\s+knowledge(?:\s*\([^)]*\))?|general\s+knowledge(?:\s*\([^)]*\))?|beyond\s+your\s+saved\s+notes(?:\s*\([^)]*\))?|external\s+(?:ai\s+)?knowledge(?:\s*\([^)]*\))?)\s*$/im;

/**
 * Separates any explicitly marked "Additional General Knowledge (Beyond Your Saved Notes)"
 * section so the UI can visually distinguish external context from note-grounded content.
 */
function splitExternalKnowledgeSection(markdown: string): SplitKnowledgeSections {
  const match = EXTERNAL_SECTION_REGEX.exec(markdown);
  if (!match || match.index === undefined) {
    return { groundedMarkdown: markdown.trim(), externalMarkdown: null };
  }

  const groundedMarkdown = markdown.slice(0, match.index).replace(/\n+---\s*$/, '').trim();
  const afterHeading = markdown.slice(match.index + match[0].length).trim();

  if (!afterHeading) {
    return { groundedMarkdown, externalMarkdown: null };
  }

  return {
    groundedMarkdown,
    externalMarkdown: afterHeading,
  };
}

const CodeBlock: React.FC<{ language?: string; code: string }> = ({ language, code }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(code).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      });
    }
  };

  return (
    <div className="my-3.5 rounded-lg border border-slate-800 bg-[#060a14] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-slate-900/80 border-b border-slate-800/80 text-[11px] text-slate-400">
        <span className="font-mono uppercase tracking-wider">{language || 'code'}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 text-slate-400 hover:text-slate-100 transition-colors"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-emerald-400" />
              <span className="text-emerald-300">Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="p-3.5 overflow-x-auto text-xs font-mono leading-relaxed text-slate-200">
        <code>{code}</code>
      </pre>
    </div>
  );
};

function buildMarkdownComponents(compact: boolean): Components {
  return {
    h1: ({ children }) => (
      <h1
        className={`font-display font-semibold text-slate-50 tracking-tight ${
          compact ? 'text-base mt-4 mb-2' : 'text-lg mt-5 mb-2.5'
        } first:mt-0 pb-1.5 border-b border-slate-800/90`}
      >
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2
        className={`font-display font-semibold text-slate-100 tracking-tight ${
          compact ? 'text-[15px] mt-4 mb-2' : 'text-base mt-5 mb-2.5'
        } first:mt-0 pb-1 border-b border-slate-800/70`}
      >
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3
        className={`font-display font-semibold text-indigo-200 ${
          compact ? 'text-sm mt-3.5 mb-1.5' : 'text-[15px] mt-4 mb-2'
        } first:mt-0`}
      >
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 className="font-display text-sm font-semibold text-slate-200 mt-3 mb-1.5 first:mt-0">
        {children}
      </h4>
    ),
    p: ({ children }) => (
      <p className="text-sm text-slate-200 leading-relaxed mb-3 last:mb-0 break-words">
        {children}
      </p>
    ),
    strong: ({ children }) => <strong className="font-semibold text-slate-50">{children}</strong>,
    em: ({ children }) => <em className="italic text-slate-200">{children}</em>,
    ul: ({ children }) => (
      <ul className="list-disc pl-5 space-y-1.5 mb-3 last:mb-0 text-sm text-slate-200 marker:text-indigo-400">
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="list-decimal pl-5 space-y-1.5 mb-3 last:mb-0 text-sm text-slate-200 marker:text-indigo-300 marker:font-medium">
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="leading-relaxed pl-0.5 [&>p]:mb-1.5 [&>p:last-child]:mb-0">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="my-3 border-l-2 border-indigo-500/70 bg-indigo-500/8 px-3.5 py-2.5 rounded-r-lg text-sm text-slate-300 italic [&>p]:mb-1.5 [&>p:last-child]:mb-0">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="my-4 border-slate-800/90" />,
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2"
      >
        {children}
      </a>
    ),
    table: ({ children }) => (
      <div className="my-3.5 w-full overflow-x-auto rounded-lg border border-slate-700/80 bg-[#080d1a]/80">
        <table className="min-w-full border-collapse text-left text-xs sm:text-[13px] leading-snug">
          {children}
        </table>
      </div>
    ),
    thead: ({ children }) => (
      <thead className="bg-slate-800/85 border-b border-slate-700/90 text-slate-100">
        {children}
      </thead>
    ),
    tbody: ({ children }) => <tbody className="divide-y divide-slate-800/80">{children}</tbody>,
    tr: ({ children }) => (
      <tr className="even:bg-slate-900/45 hover:bg-indigo-500/5 transition-colors">{children}</tr>
    ),
    th: ({ children }) => (
      <th className="px-3.5 py-2.5 font-display font-semibold text-slate-100 whitespace-nowrap border-r border-slate-700/60 last:border-r-0">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="px-3.5 py-2.5 text-slate-200 align-top border-r border-slate-800/70 last:border-r-0 min-w-[120px]">
        {children}
      </td>
    ),
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children, ...props }) => {
      const match = /language-([\w-]+)/.exec(className || '');
      const rawCode = String(children ?? '').replace(/\n$/, '');
      const isBlock = Boolean(match) || rawCode.includes('\n');

      if (isBlock) {
        return <CodeBlock language={match?.[1]} code={rawCode} />;
      }

      return (
        <code
          {...props}
          className="px-1.5 py-0.5 rounded bg-slate-800/95 border border-slate-700/70 text-indigo-200 font-mono text-[12.5px] break-words"
        >
          {children}
        </code>
      );
    },
  };
}

export const StudyMarkdown: React.FC<StudyMarkdownProps> = ({ content, compact = false }) => {
  const { groundedMarkdown, externalMarkdown } = useMemo(() => {
    const normalized = normalizeMathDelimiters(content);
    return splitExternalKnowledgeSection(normalized);
  }, [content]);

  const components = useMemo(() => buildMarkdownComponents(compact), [compact]);

  return (
    <div className="study-markdown min-w-0 max-w-full space-y-3.5">
      {groundedMarkdown && (
        <div className="min-w-0">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={components}
          >
            {groundedMarkdown}
          </ReactMarkdown>
        </div>
      )}

      {externalMarkdown && (
        <div className="rounded-lg border border-sky-500/25 bg-sky-500/6 px-3.5 py-3 space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-sky-300">
            <Globe2 className="w-3.5 h-3.5 shrink-0" />
            <span>Additional General Knowledge · Beyond Your Saved Notes</span>
          </div>
          <div className="min-w-0">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={components}
            >
              {externalMarkdown}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
};
