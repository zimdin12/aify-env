import type { Buffer } from 'node:buffer';

export type CredentialFault = 'CREDENTIAL_MISSING' | 'CREDENTIAL_INVALID' | 'CREDENTIAL_CONFLICT'
  | 'CREDENTIAL_UNREADABLE' | 'CREDENTIAL_INSECURE';

export interface ServiceKeyEntry {
  readonly endpoint: string;
  readonly credentialRef?: string | null;
  readonly keyEnv?: readonly string[];
}

export interface KeyOptions {
  readonly url: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly mode: 'explicit-first' | 'reconcile';
}

export type KeyResult =
  | { readonly state: 'ok'; readonly value: string; readonly source: 'env' | 'file'; readonly detail: string }
  | { readonly state: 'absent' | 'endpoint-refused' | CredentialFault; readonly value: ''; readonly source: ''; readonly detail: string };

export type LocalCredential =
  | { readonly state: 'ok'; readonly value: string; readonly detail: string }
  | { readonly state: CredentialFault; readonly value: ''; readonly detail: string };

export function sameServiceEndpoint(a: string, b: string): boolean;
export function resolveServiceKey(entry: ServiceKeyEntry, options: KeyOptions): Promise<KeyResult>;
export function resolveServiceKeySync(entry: ServiceKeyEntry, options: KeyOptions): KeyResult;
export function credentialRefProblem(ref: unknown): string;
export function decodeCredential(bytes: Buffer): LocalCredential;
export function readStoredCredentialSync(ref: string, options: { readonly home: string }): LocalCredential;
