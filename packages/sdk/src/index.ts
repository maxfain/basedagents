/**
 * Agent Registry SDK
 *
 * Provides utilities for agents to:
 * - Generate Ed25519 keypairs
 * - Solve proof-of-work challenges
 * - Register with the Agent Registry
 * - Sign requests (AgentSig auth)
 * - Submit verification reports
 * - Search for other agents
 */

import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

export { ed, sha256, bytesToHex };

// ─── Types ───

export interface AgentKeypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface AgentProfile {
  name: string;
  description: string;
  capabilities: string[];
  protocols: string[];
  offers?: string[];
  needs?: string[];
  homepage?: string;
  contact_endpoint?: string;
}

export interface RegistryConfig {
  baseUrl: string;
}

// ─── Keypair Generation ───

/**
 * Generate a new Ed25519 keypair for an agent.
 */
export async function generateKeypair(): Promise<AgentKeypair> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { publicKey, privateKey };
}

// ─── Proof-of-Work ───

/**
 * Solve the proof-of-work challenge.
 * Finds a nonce such that sha256(publicKey || nonce) has `difficulty` leading zero bits.
 */
export function solveProofOfWork(
  _publicKey: Uint8Array,
  _difficulty: number
): { nonce: string; hash: string } {
  // TODO: Implement — backend agent
  throw new Error('Not implemented');
}

// ─── Registry Client ───

/**
 * Client for interacting with the Agent Registry API.
 */
export class RegistryClient {
  private baseUrl: string;

  constructor(config: RegistryConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
  }

  /**
   * Initiate registration — get a challenge from the registry.
   */
  async registerInit(_publicKey: Uint8Array): Promise<unknown> {
    // TODO: Implement — backend agent
    throw new Error('Not implemented');
  }

  /**
   * Complete registration — submit PoW, signed challenge, and profile.
   */
  async registerComplete(
    _challengeId: string,
    _keypair: AgentKeypair,
    _nonce: string,
    _profile: AgentProfile
  ): Promise<unknown> {
    // TODO: Implement — backend agent
    throw new Error('Not implemented');
  }

  /**
   * Get an agent's profile by ID.
   */
  async getAgent(_agentId: string): Promise<unknown> {
    // TODO: Implement — backend agent
    throw new Error('Not implemented');
  }

  /**
   * Search for agents by capabilities, protocols, etc.
   */
  async searchAgents(_query: Record<string, string>): Promise<unknown> {
    // TODO: Implement — backend agent
    throw new Error('Not implemented');
  }

  /**
   * Sign a request using AgentSig auth scheme.
   */
  async signRequest(
    _keypair: AgentKeypair,
    _method: string,
    _path: string,
    _body?: string
  ): Promise<string> {
    // TODO: Implement — backend agent
    throw new Error('Not implemented');
  }
}
