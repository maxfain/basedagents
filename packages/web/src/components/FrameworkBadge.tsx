import React from 'react';
import type { Agent } from '../data/mockData';

export type Framework =
  | 'openclaw'
  | 'claude-code'
  | 'langchain'
  | 'langgraph'
  | 'crewai'
  | 'autogen'
  | 'openai'
  | 'llamaindex'
  | 'semantic-kernel'
  | 'google-adk'
  | 'n8n'
  | 'dify'
  | 'flowise'
  | 'smolagents'
  | 'pydantic-ai'
  | null;

const TAG_MAP: Record<string, Framework> = {
  openclaw: 'openclaw',
  'claude-code': 'claude-code',
  claude: 'claude-code',
  langchain: 'langchain',
  langgraph: 'langgraph',
  crewai: 'crewai',
  autogen: 'autogen',
  'openai-agents': 'openai',
  openai: 'openai',
  llamaindex: 'llamaindex',
  'llama-index': 'llamaindex',
  'semantic-kernel': 'semantic-kernel',
  'google-adk': 'google-adk',
  'vertex-ai': 'google-adk',
  n8n: 'n8n',
  dify: 'dify',
  flowise: 'flowise',
  smolagents: 'smolagents',
  'pydantic-ai': 'pydantic-ai',
};

export function detectFramework(agent: Pick<Agent, 'tags' | 'skills'>): Framework {
  for (const tag of agent.tags ?? []) {
    const match = TAG_MAP[tag.toLowerCase()];
    if (match) return match;
  }
  if (agent.skills?.some(s => s.registry === 'clawhub')) return 'openclaw';
  return null;
}

// ─── Icon components ───────────────────────────────────────────────────────

function OpenClawIcon({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 20 20" fill="none">
      <ellipse cx="10" cy="13.5" rx="4.5" ry="3" fill="#e8713c" />
      <path d="M8.5 13C7 10 5.5 7.5 7 5.5C8 4 10 4.5 10 6.5C10 8 9 9.5 9.5 11"
        stroke="#e8713c" strokeWidth="2.2" strokeLinecap="round" fill="none" />
      <path d="M11.5 13C13 10 14.5 7.5 13 5.5C12 4 10 4.5 10 6.5C10 8 11 9.5 10.5 11"
        stroke="#e8713c" strokeWidth="2.2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function ClaudeIcon({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 20 20" fill="none">
      <path d="M10 2 L12.5 8.5 L19 10 L12.5 11.5 L10 18 L7.5 11.5 L1 10 L7.5 8.5 Z" fill="#D97757" />
      <path d="M10 5 L11.5 9 L15.5 10 L11.5 11 L10 15 L8.5 11 L4.5 10 L8.5 9 Z" fill="#F0A882" opacity="0.5" />
    </svg>
  );
}

function LangChainIcon({ s }: { s: number }) {
  // Chain links
  return (
    <svg width={s} height={s} viewBox="0 0 20 20" fill="none">
      <rect x="2" y="7" width="7" height="6" rx="3" stroke="#22c55e" strokeWidth="2" fill="none" />
      <rect x="11" y="7" width="7" height="6" rx="3" stroke="#22c55e" strokeWidth="2" fill="none" />
      <line x1="9" y1="10" x2="11" y2="10" stroke="#22c55e" strokeWidth="2" />
    </svg>
  );
}

function LangGraphIcon({ s }: { s: number }) {
  // Graph nodes + edges
  return (
    <svg width={s} height={s} viewBox="0 0 20 20" fill="none">
      <circle cx="4" cy="10" r="2.5" fill="#16a34a" />
      <circle cx="16" cy="5" r="2.5" fill="#16a34a" />
      <circle cx="16" cy="15" r="2.5" fill="#16a34a" />
      <line x1="6" y1="9" x2="14" y2="6" stroke="#16a34a" strokeWidth="1.5" />
      <line x1="6" y1="11" x2="14" y2="14" stroke="#16a34a" strokeWidth="1.5" />
    </svg>
  );
}

function CrewAIIcon({ s }: { s: number }) {
  // Three crew members (dots) in a triangle
  return (
    <svg width={s} height={s} viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="4.5" r="2.5" fill="#f97316" />
      <circle cx="4.5" cy="14.5" r="2.5" fill="#f97316" />
      <circle cx="15.5" cy="14.5" r="2.5" fill="#f97316" />
      <line x1="10" y1="7" x2="5.5" y2="12.5" stroke="#f97316" strokeWidth="1.2" opacity="0.6" />
      <line x1="10" y1="7" x2="14.5" y2="12.5" stroke="#f97316" strokeWidth="1.2" opacity="0.6" />
      <line x1="7" y1="14.5" x2="13" y2="14.5" stroke="#f97316" strokeWidth="1.2" opacity="0.6" />
    </svg>
  );
}

function AutoGenIcon({ s }: { s: number }) {
  // Circular arrows (auto / feedback loop)
  return (
    <svg width={s} height={s} viewBox="0 0 20 20" fill="none">
      <path d="M10 3 A7 7 0 1 1 3.5 14" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" fill="none" />
      <polygon points="3,10.5 3.5,14.5 7,13" fill="#3b82f6" />
    </svg>
  );
}

function OpenAIIcon({ s }: { s: number }) {
  // Simplified OpenAI bloom/swirl (6 petals)
  return (
    <svg width={s} height={s} viewBox="0 0 20 20" fill="none">
      <path
        d="M10 2.5 C11.5 2.5 13 3.5 13.5 5 C15 4.5 16.5 5.5 17 7 C18 8 18 9.5 17.5 10.5
           C18.5 11.5 18.5 13 17.5 14 C17.5 15.5 16 16.5 14.5 16.5 C14 18 12.5 18.5 11 18
           C10 18.5 9 18.5 8 18 C7 18.5 5.5 18 5 16.5 C3.5 16.5 2.5 15 2.5 13.5
           C1.5 12.5 1.5 11 2 10 C1 9 1.5 7.5 2.5 6.5 C2.5 5 4 4 5.5 4
           C6 2.5 7.5 2 9 2.5 Z"
        stroke="#10a37f" strokeWidth="1.6" fill="none"
      />
      <circle cx="10" cy="10" r="2" fill="#10a37f" />
    </svg>
  );
}

function LlamaIndexIcon({ s }: { s: number }) {
  // Simplified llama head silhouette
  return (
    <svg width={s} height={s} viewBox="0 0 20 20" fill="none">
      {/* Body */}
      <ellipse cx="10" cy="13" rx="5" ry="4" fill="#a855f7" />
      {/* Head */}
      <ellipse cx="10" cy="7.5" rx="3.5" ry="3" fill="#a855f7" />
      {/* Neck */}
      <rect x="8" y="9.5" width="4" height="3" fill="#a855f7" />
      {/* Ear */}
      <ellipse cx="8" cy="5" rx="1.2" ry="1.8" fill="#a855f7" />
      <ellipse cx="12" cy="5" rx="1.2" ry="1.8" fill="#a855f7" />
    </svg>
  );
}

function SemanticKernelIcon({ s }: { s: number }) {
  // Kernel spark — stylized SK
  return (
    <svg width={s} height={s} viewBox="0 0 20 20" fill="none">
      <path d="M10 1 L11.8 7.5 L18 6 L13.5 10.5 L17 16.5 L10 13.5 L3 16.5 L6.5 10.5 L2 6 L8.2 7.5 Z"
        fill="#8b5cf6" />
      <circle cx="10" cy="10" r="2" fill="#c4b5fd" />
    </svg>
  );
}

function GoogleADKIcon({ s }: { s: number }) {
  // Google "G" mark with multi-color segments
  return (
    <svg width={s} height={s} viewBox="0 0 20 20" fill="none">
      <path d="M10 3 A7 7 0 0 1 17 10 L13 10 A3 3 0 0 0 10 7 Z" fill="#4285f4" />
      <path d="M17 10 A7 7 0 0 1 10 17 L10 13 A3 3 0 0 0 13 10 Z" fill="#34a853" />
      <path d="M10 17 A7 7 0 0 1 3 10 L7 10 A3 3 0 0 0 10 13 Z" fill="#fbbc05" />
      <path d="M3 10 A7 7 0 0 1 10 3 L10 7 A3 3 0 0 0 7 10 Z" fill="#ea4335" />
      <rect x="10" y="9" width="7" height="2" fill="#4285f4" rx="1" />
    </svg>
  );
}

function N8NIcon({ s }: { s: number }) {
  // Workflow nodes
  return (
    <svg width={s} height={s} viewBox="0 0 20 20" fill="none">
      <rect x="1.5" y="7.5" width="5" height="5" rx="2" fill="#ff6d5a" />
      <rect x="7.5" y="7.5" width="5" height="5" rx="2" fill="#ff6d5a" opacity="0.7" />
      <rect x="13.5" y="7.5" width="5" height="5" rx="2" fill="#ff6d5a" />
      <line x1="6.5" y1="10" x2="7.5" y2="10" stroke="#ff6d5a" strokeWidth="1.5" />
      <line x1="12.5" y1="10" x2="13.5" y2="10" stroke="#ff6d5a" strokeWidth="1.5" />
    </svg>
  );
}

function DifyIcon({ s }: { s: number }) {
  // Stylized "D" / diamond
  return (
    <svg width={s} height={s} viewBox="0 0 20 20" fill="none">
      <path d="M4 10 L10 3 L16 10 L10 17 Z" fill="#6366f1" />
      <path d="M7 10 L10 6.5 L13 10 L10 13.5 Z" fill="#a5b4fc" opacity="0.7" />
    </svg>
  );
}

function FlowiseIcon({ s }: { s: number }) {
  // Flow wave / nodes
  return (
    <svg width={s} height={s} viewBox="0 0 20 20" fill="none">
      <circle cx="4" cy="10" r="2.5" fill="#0ea5e9" />
      <circle cx="10" cy="6" r="2.5" fill="#0ea5e9" />
      <circle cx="16" cy="10" r="2.5" fill="#0ea5e9" />
      <path d="M6.5 10 Q10 10 7.5 6" stroke="#0ea5e9" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      <path d="M12.5 6 Q13 10 13.5 10" stroke="#0ea5e9" strokeWidth="1.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function SmolagentsIcon({ s }: { s: number }) {
  // HuggingFace-style emoji face
  return (
    <svg width={s} height={s} viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="8" fill="#ffd21e" />
      {/* Eyes */}
      <circle cx="7.5" cy="9" r="1.2" fill="#1a1a1a" />
      <circle cx="12.5" cy="9" r="1.2" fill="#1a1a1a" />
      {/* Smile */}
      <path d="M7 13 Q10 15.5 13 13" stroke="#1a1a1a" strokeWidth="1.4" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function PydanticAIIcon({ s }: { s: number }) {
  // Red/rose "P" lettermark
  return (
    <svg width={s} height={s} viewBox="0 0 20 20" fill="none">
      <rect x="4" y="3" width="3" height="14" rx="1.5" fill="#e11d48" />
      <path d="M7 3 Q16 3 16 8 Q16 13 7 13" stroke="#e11d48" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

// ─── Config ───────────────────────────────────────────────────────────────

const FRAMEWORK_CONFIG: Record<
  Exclude<Framework, null>,
  { label: string; Icon: React.FC<{ s: number }>; color: string; bg: string; border: string }
> = {
  openclaw:         { label: 'OpenClaw',        Icon: OpenClawIcon,       color: '#e8713c', bg: 'rgba(232,113,60,0.1)',  border: 'rgba(232,113,60,0.25)' },
  'claude-code':    { label: 'Claude Code',     Icon: ClaudeIcon,         color: '#D97757', bg: 'rgba(217,119,87,0.1)',  border: 'rgba(217,119,87,0.25)' },
  langchain:        { label: 'LangChain',       Icon: LangChainIcon,      color: '#22c55e', bg: 'rgba(34,197,94,0.1)',   border: 'rgba(34,197,94,0.25)' },
  langgraph:        { label: 'LangGraph',       Icon: LangGraphIcon,      color: '#16a34a', bg: 'rgba(22,163,74,0.1)',   border: 'rgba(22,163,74,0.25)' },
  crewai:           { label: 'CrewAI',          Icon: CrewAIIcon,         color: '#f97316', bg: 'rgba(249,115,22,0.1)',  border: 'rgba(249,115,22,0.25)' },
  autogen:          { label: 'AutoGen',         Icon: AutoGenIcon,        color: '#3b82f6', bg: 'rgba(59,130,246,0.1)',  border: 'rgba(59,130,246,0.25)' },
  openai:           { label: 'OpenAI Agents',   Icon: OpenAIIcon,         color: '#10a37f', bg: 'rgba(16,163,127,0.1)', border: 'rgba(16,163,127,0.25)' },
  llamaindex:       { label: 'LlamaIndex',      Icon: LlamaIndexIcon,     color: '#a855f7', bg: 'rgba(168,85,247,0.1)', border: 'rgba(168,85,247,0.25)' },
  'semantic-kernel':{ label: 'Semantic Kernel', Icon: SemanticKernelIcon, color: '#8b5cf6', bg: 'rgba(139,92,246,0.1)', border: 'rgba(139,92,246,0.25)' },
  'google-adk':     { label: 'Google ADK',      Icon: GoogleADKIcon,      color: '#4285f4', bg: 'rgba(66,133,244,0.1)', border: 'rgba(66,133,244,0.25)' },
  n8n:              { label: 'n8n',             Icon: N8NIcon,            color: '#ff6d5a', bg: 'rgba(255,109,90,0.1)', border: 'rgba(255,109,90,0.25)' },
  dify:             { label: 'Dify',            Icon: DifyIcon,           color: '#6366f1', bg: 'rgba(99,102,241,0.1)', border: 'rgba(99,102,241,0.25)' },
  flowise:          { label: 'Flowise',         Icon: FlowiseIcon,        color: '#0ea5e9', bg: 'rgba(14,165,233,0.1)', border: 'rgba(14,165,233,0.25)' },
  smolagents:       { label: 'Smolagents',      Icon: SmolagentsIcon,     color: '#ca8a04', bg: 'rgba(202,138,4,0.1)',  border: 'rgba(202,138,4,0.25)' },
  'pydantic-ai':    { label: 'Pydantic AI',     Icon: PydanticAIIcon,     color: '#e11d48', bg: 'rgba(225,29,72,0.1)',  border: 'rgba(225,29,72,0.25)' },
};

// ─── Component ────────────────────────────────────────────────────────────

interface FrameworkBadgeProps {
  agent: Pick<Agent, 'tags' | 'skills'>;
  variant?: 'icon' | 'pill';
  size?: number;
}

export default function FrameworkBadge({
  agent,
  variant = 'icon',
  size = 18,
}: FrameworkBadgeProps): React.ReactElement | null {
  const framework = detectFramework(agent);
  if (!framework) return null;

  const cfg = FRAMEWORK_CONFIG[framework];

  if (variant === 'icon') {
    return (
      <span
        title={cfg.label}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size + 4,
          height: size + 4,
          borderRadius: '50%',
          background: cfg.bg,
          border: `1px solid ${cfg.border}`,
          flexShrink: 0,
          cursor: 'default',
        }}
      >
        <cfg.Icon s={size - 2} />
      </span>
    );
  }

  return (
    <span
      title={cfg.label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 8px 3px 6px',
        borderRadius: 20,
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
        fontSize: 12,
        fontWeight: 500,
        color: cfg.color,
        flexShrink: 0,
        cursor: 'default',
        whiteSpace: 'nowrap',
      }}
    >
      <cfg.Icon s={13} />
      {cfg.label}
    </span>
  );
}
