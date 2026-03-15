import React, { useState } from 'react';
import { api } from '../api/client';

// ─── Types ───────────────────────────────────────────────────────────────────

interface McpPlaygroundProps {
  agentId: string;
  contactEndpoint: string;
}

interface ProbeResponse {
  ok: boolean;
  response_time_ms?: number;
  status_code?: number;
  body?: unknown;
  error?: string;
  message?: string;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string; [key: string]: unknown }>;
    required?: string[];
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractTools(response: ProbeResponse): McpTool[] | null {
  if (!response.ok || !response.body) return null;
  const body = response.body as Record<string, unknown>;
  const result = body.result as Record<string, unknown> | undefined;
  if (!result) return null;
  const tools = result.tools;
  if (!Array.isArray(tools)) return null;
  return tools as McpTool[];
}

function isToolsListResponse(method: string, response: ProbeResponse): boolean {
  return method === 'tools/list' && response.ok === true;
}

// Very lightweight JSON syntax highlighter — wraps strings, numbers, booleans, null, keys
function syntaxHighlight(json: string): string {
  return json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^"\\])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        let cls = 'json-number';
        if (/^"/.test(match)) {
          cls = /:$/.test(match) ? 'json-key' : 'json-string';
        } else if (/true|false/.test(match)) {
          cls = 'json-boolean';
        } else if (/null/.test(match)) {
          cls = 'json-null';
        }
        return `<span class="${cls}">${match}</span>`;
      }
    );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ToolCard({ tool }: { tool: McpTool }) {
  const props = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const propEntries = Object.entries(props);

  return (
    <div style={{
      background: 'var(--bg-tertiary)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      padding: '12px 16px',
      marginBottom: 8,
    }}>
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 14,
        color: 'var(--accent)',
        fontWeight: 600,
        marginBottom: 4,
      }}>
        {tool.name}
      </div>
      {tool.description && (
        <div style={{
          fontSize: 13,
          color: 'var(--text-secondary)',
          marginBottom: propEntries.length > 0 ? 10 : 0,
          lineHeight: 1.5,
        }}>
          {tool.description}
        </div>
      )}
      {propEntries.length > 0 && (
        <table style={{
          width: '100%',
          fontSize: 12,
          borderCollapse: 'collapse',
          fontFamily: 'var(--font-mono)',
        }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', color: 'var(--text-tertiary)', paddingBottom: 4, fontWeight: 500, paddingRight: 12 }}>param</th>
              <th style={{ textAlign: 'left', color: 'var(--text-tertiary)', paddingBottom: 4, fontWeight: 500, paddingRight: 12 }}>type</th>
              <th style={{ textAlign: 'left', color: 'var(--text-tertiary)', paddingBottom: 4, fontWeight: 500 }}>description</th>
            </tr>
          </thead>
          <tbody>
            {propEntries.map(([name, schema]) => (
              <tr key={name}>
                <td style={{ paddingRight: 12, paddingTop: 2, color: 'var(--text-primary)', verticalAlign: 'top' }}>
                  {name}{required.has(name) && <span style={{ color: 'var(--status-suspended)', marginLeft: 2 }}>*</span>}
                </td>
                <td style={{ paddingRight: 12, paddingTop: 2, color: 'var(--text-tertiary)', verticalAlign: 'top' }}>
                  {schema.type ?? '—'}
                </td>
                <td style={{ paddingTop: 2, color: 'var(--text-secondary)', verticalAlign: 'top', fontFamily: 'inherit', fontSize: 12 }}>
                  {schema.description ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function McpPlayground({ agentId, contactEndpoint }: McpPlaygroundProps) {
  const [expanded, setExpanded] = useState(false);
  const [method, setMethod] = useState('tools/list');
  const [paramsText, setParamsText] = useState('{}');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<ProbeResponse | null>(null);
  const [paramsError, setParamsError] = useState<string | null>(null);

  function handleQuickAction(m: string, defaultParams = '{}') {
    setMethod(m);
    setParamsText(defaultParams);
    setResponse(null);
    setParamsError(null);
  }

  async function handleSend() {
    // Validate params JSON
    let parsedParams: Record<string, unknown> = {};
    try {
      const raw = paramsText.trim();
      if (raw && raw !== '{}') {
        parsedParams = JSON.parse(raw);
      }
    } catch {
      setParamsError('Invalid JSON in params');
      return;
    }
    setParamsError(null);
    setLoading(true);
    setResponse(null);

    try {
      const result = await api.probeAgent(agentId, method, parsedParams);
      setResponse(result);
    } catch (err) {
      setResponse({
        ok: false,
        error: 'client_error',
        message: err instanceof Error ? err.message : 'Request failed',
      });
    } finally {
      setLoading(false);
    }
  }

  const tools = response && isToolsListResponse(method, response) ? extractTools(response) : null;

  return (
    <div style={{ marginBottom: 32 }}>
      {/* CSS for syntax highlighting */}
      <style>{`
        .json-key    { color: var(--accent); }
        .json-string { color: var(--status-active); }
        .json-number { color: #f59e0b; }
        .json-boolean{ color: #a78bfa; }
        .json-null   { color: var(--text-tertiary); }
        .mcp-send-btn:hover { opacity: 0.85; }
        .mcp-quick-btn:hover { background: var(--bg-secondary) !important; border-color: var(--accent) !important; }
        .mcp-toggle:hover { background: var(--bg-tertiary) !important; }
      `}</style>

      {/* Collapsible header */}
      <button
        className="mcp-toggle"
        onClick={() => setExpanded(e => !e)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: expanded ? '8px 8px 0 0' : 8,
          padding: '14px 20px',
          cursor: 'pointer',
          color: 'var(--text-primary)',
          transition: 'background 150ms ease',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 16, lineHeight: 1 }}>▶</span>
          <span style={{ fontSize: 15, fontWeight: 600 }}>MCP Playground</span>
          <span style={{
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-tertiary)',
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '2px 7px',
          }}>
            {contactEndpoint.replace(/^https?:\/\//, '').split('/')[0]}
          </span>
        </div>
        <span style={{
          fontSize: 12,
          color: 'var(--text-tertiary)',
          transform: expanded ? 'rotate(180deg)' : 'none',
          transition: 'transform 200ms ease',
          display: 'inline-block',
        }}>▼</span>
      </button>

      {/* Expanded panel */}
      {expanded && (
        <div style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderTop: 'none',
          borderRadius: '0 0 8px 8px',
          padding: '20px',
        }}>
          {/* Quick actions */}
          <div style={{ marginBottom: 16 }}>
            <div style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: 8,
              fontWeight: 500,
            }}>
              Quick Actions
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {[
                { label: 'List Tools', method: 'tools/list', params: '{}' },
                { label: 'List Resources', method: 'resources/list', params: '{}' },
                { label: 'List Prompts', method: 'prompts/list', params: '{}' },
              ].map(({ label, method: m, params }) => (
                <button
                  key={m}
                  className="mcp-quick-btn"
                  onClick={() => handleQuickAction(m, params)}
                  style={{
                    background: method === m ? 'var(--bg-tertiary)' : 'transparent',
                    border: `1px solid ${method === m ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 6,
                    padding: '6px 14px',
                    fontSize: 13,
                    color: method === m ? 'var(--accent)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                    transition: 'all 150ms ease',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Custom request */}
          <div style={{ marginBottom: 16 }}>
            <div style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: 8,
              fontWeight: 500,
            }}>
              Request
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input
                value={method}
                onChange={e => setMethod(e.target.value)}
                placeholder="tools/list"
                style={{
                  background: 'var(--bg-tertiary)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '8px 12px',
                  fontSize: 13,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-primary)',
                  outline: 'none',
                  width: '100%',
                  boxSizing: 'border-box',
                }}
              />
              <textarea
                value={paramsText}
                onChange={e => setParamsText(e.target.value)}
                placeholder='{"name": "my_tool", "arguments": {}}'
                rows={3}
                style={{
                  background: 'var(--bg-tertiary)',
                  border: `1px solid ${paramsError ? 'var(--status-suspended)' : 'var(--border)'}`,
                  borderRadius: 6,
                  padding: '8px 12px',
                  fontSize: 13,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-primary)',
                  resize: 'vertical',
                  outline: 'none',
                  width: '100%',
                  boxSizing: 'border-box',
                }}
              />
              {paramsError && (
                <div style={{ fontSize: 12, color: 'var(--status-suspended)' }}>{paramsError}</div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  className="mcp-send-btn"
                  onClick={handleSend}
                  disabled={loading}
                  style={{
                    background: 'var(--accent)',
                    border: 'none',
                    borderRadius: 6,
                    padding: '8px 20px',
                    fontSize: 13,
                    fontWeight: 600,
                    color: '#000',
                    cursor: loading ? 'not-allowed' : 'pointer',
                    opacity: loading ? 0.6 : 1,
                    transition: 'opacity 150ms ease',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {loading ? (
                    <>
                      <span style={{ display: 'inline-block', width: 10, height: 10, border: '2px solid rgba(0,0,0,0.3)', borderTopColor: '#000', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
                      Sending...
                    </>
                  ) : (
                    'Send ▶'
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* Response area */}
          {response && (
            <div>
              <div style={{
                fontSize: 11,
                color: 'var(--text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                marginBottom: 8,
                fontWeight: 500,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}>
                Response
                {response.response_time_ms !== undefined && (
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    padding: '1px 6px',
                    color: response.ok ? 'var(--status-active)' : 'var(--status-suspended)',
                    textTransform: 'none',
                    letterSpacing: 0,
                  }}>
                    {response.response_time_ms}ms
                  </span>
                )}
                {response.status_code !== undefined && (
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    padding: '1px 6px',
                    color: response.ok ? 'var(--status-active)' : 'var(--status-suspended)',
                    textTransform: 'none',
                    letterSpacing: 0,
                  }}>
                    HTTP {response.status_code}
                  </span>
                )}
                {response.error && (
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    background: 'rgba(239,68,68,0.1)',
                    border: '1px solid rgba(239,68,68,0.3)',
                    borderRadius: 4,
                    padding: '1px 6px',
                    color: '#ef4444',
                    textTransform: 'none',
                    letterSpacing: 0,
                  }}>
                    {response.error}
                  </span>
                )}
              </div>

              {/* Error message */}
              {!response.ok && response.message && (
                <div style={{
                  background: 'rgba(239,68,68,0.06)',
                  border: '1px solid rgba(239,68,68,0.2)',
                  borderRadius: 6,
                  padding: '10px 14px',
                  marginBottom: 12,
                  fontSize: 13,
                  color: '#ef4444',
                }}>
                  {response.error === 'timeout' && '⏱ '}
                  {response.error === 'no_endpoint' && '🔌 '}
                  {response.message}
                </div>
              )}

              {/* Tool cards (tools/list result) */}
              {tools && tools.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    marginBottom: 8,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}>
                    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--status-active)' }}>✓</span>
                    {tools.length} tool{tools.length !== 1 ? 's' : ''} available
                  </div>
                  {tools.map(tool => (
                    <ToolCard key={tool.name} tool={tool} />
                  ))}
                </div>
              )}
              {tools && tools.length === 0 && (
                <div style={{
                  fontSize: 13,
                  color: 'var(--text-tertiary)',
                  padding: '8px 0',
                  marginBottom: 8,
                }}>
                  No tools returned.
                </div>
              )}

              {/* Raw JSON */}
              {response.body !== undefined && (
                <details open={!tools || tools.length === 0} style={{ marginTop: tools && tools.length > 0 ? 8 : 0 }}>
                  <summary style={{
                    fontSize: 12,
                    color: 'var(--text-tertiary)',
                    cursor: 'pointer',
                    marginBottom: 8,
                    userSelect: 'none',
                  }}>
                    Raw JSON
                  </summary>
                  <pre
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: intentional syntax highlight
                    dangerouslySetInnerHTML={{
                      __html: syntaxHighlight(JSON.stringify(response.body, null, 2)),
                    }}
                    style={{
                      background: 'var(--bg-tertiary)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      padding: '12px 16px',
                      fontSize: 12,
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--text-primary)',
                      overflow: 'auto',
                      maxHeight: 400,
                      margin: 0,
                      lineHeight: 1.6,
                    }}
                  />
                </details>
              )}

              {/* Probe-level error (no body) */}
              {response.body === undefined && response.error && (
                <pre style={{
                  background: 'var(--bg-tertiary)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '12px 16px',
                  fontSize: 12,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-secondary)',
                  margin: 0,
                }}>
                  {JSON.stringify({ error: response.error, message: response.message }, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {/* Keyframe for spinner */}
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
