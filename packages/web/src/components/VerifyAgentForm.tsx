import React, { useState, useCallback } from 'react';
import { useAgentAuth } from '../hooks/useAgentAuth';
import { bytesToBase64 } from '../lib/crypto';
import { signMessage } from '../lib/crypto';
import { API_BASE } from '../api/client';

/** Canonical JSON — sorted keys, compact separators, deterministic for signatures. */
function canonicalJsonStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJsonStringify).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJsonStringify((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

interface StructuredReport {
  capability_match: number;
  tool_honesty: boolean;
  safety_issues: boolean;
  unauthorized_actions: boolean;
  consistent_behavior: boolean;
  excessive_resources: boolean;
}

interface VerifyAgentFormProps {
  targetId: string;
}

type VerifyResult = 'pass' | 'fail' | 'timeout';

export default function VerifyAgentForm({ targetId }: VerifyAgentFormProps): React.ReactElement {
  const { keypair, createAuthHeaders } = useAgentAuth();

  // Form state
  const [result, setResult] = useState<VerifyResult>('pass');
  const [coherenceScore, setCoherenceScore] = useState(0.85);
  const [notes, setNotes] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [structured, setStructured] = useState<StructuredReport>({
    capability_match: 0.85,
    tool_honesty: true,
    safety_issues: false,
    unauthorized_actions: false,
    consistent_behavior: true,
    excessive_resources: false,
  });

  // Submit state
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{ ok: true; verification_id: string; target_reputation_delta: number } | { ok: false; error: string } | null>(null);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!keypair) return;
      setSubmitting(true);
      setSubmitResult(null);

      try {
        const assignment_id = crypto.randomUUID();
        const nonce = crypto.randomUUID();

        // Build the signed payload — includes structured_report so it's covered
        // by the agent's Ed25519 signature (M4: inner signature coverage).
        // Field order must match what the server reconstructs for verification.
        const signedFields: Record<string, unknown> = {
          assignment_id,
          target_id: targetId,
          result,
          nonce,
        };
        if (coherenceScore !== undefined && coherenceScore !== null) signedFields.coherence_score = coherenceScore;
        if (notes) signedFields.notes = notes;
        signedFields.response_time_ms = 0;
        if (structured) signedFields.structured_report = structured;
        const reportData = canonicalJsonStringify(signedFields);

        // Sign the report data
        const reportBytes = new TextEncoder().encode(reportData);
        const sigBytes = await signMessage(keypair.private_key_hex, reportBytes);
        const signature = bytesToBase64(sigBytes);

        // Full body
        const body = JSON.stringify({
          assignment_id,
          target_id: targetId,
          result,
          response_time_ms: 0,
          coherence_score: coherenceScore,
          notes: notes || undefined,
          signature,
          nonce,
          structured_report: structured,
        });

        const path = '/v1/verify/submit';
        const headers = await createAuthHeaders('POST', path, body);

        const res = await fetch(`${API_BASE}${path}`, {
          method: 'POST',
          headers,
          body,
        });

        const json = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          setSubmitResult({ ok: false, error: (json.message as string) || `HTTP ${res.status}` });
        } else {
          setSubmitResult({
            ok: true,
            verification_id: json.verification_id as string,
            target_reputation_delta: json.target_reputation_delta as number,
          });
        }
      } catch (err) {
        setSubmitResult({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' });
      } finally {
        setSubmitting(false);
      }
    },
    [keypair, targetId, result, coherenceScore, notes, structured, createAuthHeaders]
  );

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-sans)',
    fontSize: 14,
    padding: '8px 12px',
    width: '100%',
    outline: 'none',
    transition: 'border-color 150ms ease',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 13,
    color: 'var(--text-secondary)',
    display: 'block',
    marginBottom: 6,
    fontWeight: 500,
  };

  if (submitResult?.ok) {
    const delta = submitResult.target_reputation_delta;
    return (
      <div
        style={{
          background: 'rgba(34,197,94,0.07)',
          border: '1px solid rgba(34,197,94,0.25)',
          borderRadius: 8,
          padding: 24,
          marginTop: 32,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span style={{ color: 'var(--status-active)', fontSize: 18 }}>✓</span>
          <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Verification submitted</span>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>
          ID: <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--hash)' }}>{submitResult.verification_id}</code>
        </p>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          Target reputation delta:{' '}
          <span style={{ color: delta >= 0 ? 'var(--status-active)' : 'var(--status-suspended)', fontFamily: 'var(--font-mono)' }}>
            {delta >= 0 ? '+' : ''}{delta.toFixed(3)}
          </span>
        </p>
        <button
          onClick={() => setSubmitResult(null)}
          style={{
            marginTop: 16,
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 6,
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            fontSize: 13,
            padding: '6px 14px',
          }}
        >
          Submit another
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 24,
        marginTop: 32,
      }}
    >
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 20, color: 'var(--text-primary)' }}>
        Verify this agent
        <span
          style={{
            fontSize: 12,
            fontWeight: 400,
            color: 'var(--text-tertiary)',
            marginLeft: 10,
            fontFamily: 'var(--font-mono)',
          }}
        >
          as {keypair?.agent_id.slice(0, 16)}…
        </span>
      </h2>

      <form onSubmit={handleSubmit}>
        {/* Result */}
        <div style={{ marginBottom: 20 }}>
          <label style={labelStyle}>Result *</label>
          <div style={{ display: 'flex', gap: 12 }}>
            {(['pass', 'fail', 'timeout'] as VerifyResult[]).map(r => (
              <label
                key={r}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  padding: '8px 16px',
                  borderRadius: 6,
                  border: `1px solid ${result === r ? 'var(--accent)' : 'var(--border)'}`,
                  background: result === r ? 'var(--accent-muted)' : 'var(--bg-tertiary)',
                  fontSize: 14,
                  color: result === r
                    ? 'var(--accent-hover)'
                    : r === 'pass'
                      ? 'var(--status-active)'
                      : r === 'fail'
                        ? 'var(--status-suspended)'
                        : 'var(--status-pending)',
                  transition: 'all 150ms ease',
                }}
              >
                <input
                  type="radio"
                  name="result"
                  value={r}
                  checked={result === r}
                  onChange={() => setResult(r)}
                  style={{ accentColor: 'var(--accent)' }}
                />
                {r.charAt(0).toUpperCase() + r.slice(1)}
              </label>
            ))}
          </div>
        </div>

        {/* Coherence Score */}
        <div style={{ marginBottom: 20 }}>
          <label style={labelStyle}>
            Coherence Score
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)', marginLeft: 8, fontSize: 14 }}>
              {coherenceScore.toFixed(2)}
            </span>
          </label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={coherenceScore}
            onChange={e => setCoherenceScore(parseFloat(e.target.value))}
            style={{ width: '100%', accentColor: 'var(--accent)' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
            <span>0 — incoherent</span>
            <span>1 — fully coherent</span>
          </div>
        </div>

        {/* Notes */}
        <div style={{ marginBottom: 20 }}>
          <label style={labelStyle}>
            Notes
            <span style={{ fontWeight: 400, color: 'var(--text-tertiary)', marginLeft: 8 }}>
              ({notes.length}/2000)
            </span>
          </label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value.slice(0, 2000))}
            placeholder="Optional notes about the verification…"
            rows={3}
            style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }}
          />
        </div>

        {/* Advanced / Structured Report */}
        <div style={{ marginBottom: 20 }}>
          <button
            type="button"
            onClick={() => setShowAdvanced(v => !v)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: 13,
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span style={{ fontSize: 10, transition: 'transform 150ms ease', transform: showAdvanced ? 'rotate(90deg)' : 'none' }}>▶</span>
            Advanced (structured report)
          </button>

          {showAdvanced && (
            <div
              style={{
                marginTop: 16,
                padding: 16,
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border)',
                borderRadius: 6,
              }}
            >
              {/* Capability Match */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ ...labelStyle, marginBottom: 4 }}>
                  Capability Match
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)', marginLeft: 8, fontSize: 14 }}>
                    {structured.capability_match.toFixed(2)}
                  </span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={structured.capability_match}
                  onChange={e => setStructured(s => ({ ...s, capability_match: parseFloat(e.target.value) }))}
                  style={{ width: '100%', accentColor: 'var(--accent)' }}
                />
              </div>

              {/* Checkboxes */}
              {(
                [
                  { key: 'tool_honesty', label: 'Tool Honesty', desc: 'Agent used only declared tools' },
                  { key: 'safety_issues', label: 'Safety Issues', desc: 'Agent exhibited unsafe behavior' },
                  { key: 'unauthorized_actions', label: 'Unauthorized Actions', desc: 'Agent performed actions outside scope' },
                  { key: 'consistent_behavior', label: 'Consistent Behavior', desc: 'Agent behaved consistently across calls' },
                  { key: 'excessive_resources', label: 'Excessive Resources', desc: 'Agent consumed excessive resources' },
                ] as { key: keyof StructuredReport; label: string; desc: string }[]
              ).filter(({ key }) => typeof structured[key] === 'boolean').map(({ key, label, desc }) => (
                <label
                  key={key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    cursor: 'pointer',
                    padding: '6px 0',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={structured[key] as boolean}
                    onChange={e => setStructured(s => ({ ...s, [key]: e.target.checked }))}
                    style={{ accentColor: 'var(--accent)', width: 15, height: 15 }}
                  />
                  <div>
                    <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>{label}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{desc}</div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Error */}
        {submitResult && !submitResult.ok && (
          <div
            style={{
              marginBottom: 16,
              padding: '10px 14px',
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: 6,
              fontSize: 13,
              color: '#ef4444',
            }}
          >
            Error: {submitResult.error}
          </div>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={submitting}
          style={{
            background: submitting ? 'rgba(99,102,241,0.5)' : 'var(--accent)',
            border: 'none',
            borderRadius: 6,
            color: '#fff',
            cursor: submitting ? 'not-allowed' : 'pointer',
            fontSize: 14,
            fontWeight: 600,
            padding: '10px 24px',
            transition: 'background 150ms ease',
          }}
          onMouseEnter={e => { if (!submitting) (e.currentTarget as HTMLButtonElement).style.background = 'var(--accent-hover)'; }}
          onMouseLeave={e => { if (!submitting) (e.currentTarget as HTMLButtonElement).style.background = 'var(--accent)'; }}
        >
          {submitting ? 'Submitting…' : 'Submit Verification'}
        </button>
      </form>
    </div>
  );
}
