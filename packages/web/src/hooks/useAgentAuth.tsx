import React, { createContext, useContext, useState, useCallback } from 'react';
import { signMessage, sha256Hex, bytesToBase64 } from '../lib/crypto';

export interface AgentKeyPair {
  agent_id: string;
  public_key_b58: string;
  private_key_hex: string;
}

export interface AgentAuth {
  keypair: AgentKeyPair | null;
  loadKeypair: (file: File) => Promise<void>;
  clearKeypair: () => void;
  isAuthenticated: boolean;
  createAuthHeaders: (
    method: string,
    path: string,
    body: string
  ) => Promise<{
    Authorization: string;
    'X-Timestamp': string;
    'Content-Type': string;
  }>;
}

const AgentAuthContext = createContext<AgentAuth | null>(null);

export function AgentAuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  // Keypair is ONLY held in React state — never persisted to localStorage/sessionStorage
  const [keypair, setKeypair] = useState<AgentKeyPair | null>(null);

  const loadKeypair = useCallback(async (file: File): Promise<void> => {
    const text = await file.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('File is not valid JSON');
    }

    const kp = data as Record<string, unknown>;
    if (
      typeof kp.agent_id !== 'string' ||
      typeof kp.public_key_b58 !== 'string' ||
      typeof kp.private_key_hex !== 'string'
    ) {
      throw new Error('Keypair file must contain agent_id, public_key_b58, and private_key_hex');
    }

    setKeypair({
      agent_id: kp.agent_id,
      public_key_b58: kp.public_key_b58,
      private_key_hex: kp.private_key_hex,
    });
  }, []);

  const clearKeypair = useCallback(() => {
    setKeypair(null);
  }, []);

  const createAuthHeaders = useCallback(
    async (method: string, path: string, body: string) => {
      if (!keypair) throw new Error('Not authenticated — load a keypair first');

      const timestamp = String(Math.floor(Date.now() / 1000));
      const bodyHash = await sha256Hex(body);
      const message = `${method}:${path}:${timestamp}:${bodyHash}`;
      const messageBytes = new TextEncoder().encode(message);
      const sigBytes = await signMessage(keypair.private_key_hex, messageBytes);
      const sigBase64 = bytesToBase64(sigBytes);

      return {
        Authorization: `AgentSig ${keypair.public_key_b58}:${sigBase64}`,
        'X-Timestamp': timestamp,
        'Content-Type': 'application/json',
      };
    },
    [keypair]
  );

  const value: AgentAuth = {
    keypair,
    loadKeypair,
    clearKeypair,
    isAuthenticated: keypair !== null,
    createAuthHeaders,
  };

  return <AgentAuthContext.Provider value={value}>{children}</AgentAuthContext.Provider>;
}

export function useAgentAuth(): AgentAuth {
  const ctx = useContext(AgentAuthContext);
  if (!ctx) throw new Error('useAgentAuth must be used within AgentAuthProvider');
  return ctx;
}
