import fs from 'fs/promises';
import path from 'path';
import { config } from './config';

export type Scheme = 'iam' | 'custom';

export interface BucketPerm {
  prefixes: string[];   // allowed prefixes; empty => whole bucket
  access: 'r' | 'rw';
}

export interface UserPerm {
  buckets: Record<string, BucketPerm>;
}

export type CustomPermissions = Record<string, UserPerm>;

const schemeFile = () => path.join(config.dataDir, 'scheme.json');
const permsFile = () => path.join(config.dataDir, 'custom-permissions.json');

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const buf = await fs.readFile(file, 'utf8');
    return JSON.parse(buf) as T;
  } catch (e: any) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

export async function getScheme(): Promise<Scheme> {
  const { scheme } = await readJson<{ scheme: Scheme }>(schemeFile(), { scheme: 'iam' });
  return scheme === 'custom' ? 'custom' : 'iam';
}

export async function setScheme(scheme: Scheme): Promise<void> {
  await writeJsonAtomic(schemeFile(), { scheme });
}

export async function getCustomPermissions(): Promise<CustomPermissions> {
  return readJson<CustomPermissions>(permsFile(), {});
}

export async function setCustomPermissions(perms: CustomPermissions): Promise<void> {
  await writeJsonAtomic(permsFile(), perms);
}

export function permForUser(all: CustomPermissions, username: string): UserPerm {
  return all[username] ?? { buckets: {} };
}

export function keyAllowedByPerm(perm: BucketPerm, key: string): boolean {
  if (perm.prefixes.length === 0) return true;
  return perm.prefixes.some(p => key.startsWith(p));
}

export function canWriteByPerm(perm: BucketPerm, key: string): boolean {
  return perm.access === 'rw' && keyAllowedByPerm(perm, key);
}
