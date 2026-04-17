import { SignatureV4 } from '@aws-sdk/signature-v4';
import { HttpRequest } from '@aws-sdk/protocol-http';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { Sha256 } from '@aws-crypto/sha256-js';
import { config } from './config';

/**
 * Minimal AWS4-signed HTTP client for OpenSearch. Uses the default credential
 * chain (so on EC2 it picks up the instance role automatically). The instance
 * role is what's been added to the UAT domain's access policy + mapped as a
 * backend role with read/write on the poc-csd-* index pattern.
 *
 * We don't use @opensearch-project/opensearch because its AWS signer helper
 * adds a dependency tree we don't need for ~3 endpoints.
 */
const signer = new SignatureV4({
  service: 'es',
  region: config.region,
  credentials: fromNodeProviderChain(),
  sha256: Sha256 as any,
});

interface OsCallOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';
  path: string;          // e.g. /poc-csd-objects/_search
  body?: unknown;
  query?: Record<string, string>;
}

export interface OsResponse<T = unknown> {
  status: number;
  body: T;
}

export async function osCall<T = unknown>(opts: OsCallOptions): Promise<OsResponse<T>> {
  const host = config.opensearchEndpoint.replace(/^https?:\/\//, '');
  const bodyStr = opts.body != null ? JSON.stringify(opts.body) : undefined;

  const request = new HttpRequest({
    method: opts.method,
    protocol: 'https:',
    hostname: host,
    path: opts.path,
    headers: {
      host,
      ...(bodyStr ? { 'content-type': 'application/json' } : {}),
    },
    query: opts.query,
    body: bodyStr,
  });

  const signed = await signer.sign(request);

  const url = new URL(`https://${host}${opts.path}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
  }

  const res = await fetch(url, {
    method: signed.method,
    headers: signed.headers as Record<string, string>,
    body: signed.body as string | undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = text ? JSON.parse(text) : {}; } catch { /* leave as text */ }
  return { status: res.status, body: parsed as T };
}

export function indexName(): string { return config.opensearchIndex; }
