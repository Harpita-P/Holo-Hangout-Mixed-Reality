import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TwitchToken } from './twitch-eventsub.js';

export interface StreamerSettings {
  acceptingJoins: boolean;
  demoEnabled: boolean;
}

export interface StreamerAccount {
  twitchUserId: string;
  login: string;
  worldId: string;
  createdAt: string;
  updatedAt: string;
  token: TwitchToken;
  settings: StreamerSettings;
}

interface SealedValue {
  iv: string;
  tag: string;
  ciphertext: string;
}

interface StoredAccount extends Omit<StreamerAccount, 'token'> {
  token: SealedValue;
}

interface StoredPlatformData {
  version: 1;
  streamers: StoredAccount[];
}

export class PlatformStore {
  private readonly accounts = new Map<string, StreamerAccount>();
  private readonly key: Buffer;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly storagePath: string,
    encryptionSecret: string,
  ) {
    if (encryptionSecret.length < 24) {
      throw new Error('HOLOHANGOUT_TOKEN_KEY must contain at least 24 characters.');
    }
    this.key = createHash('sha256').update(encryptionSecret).digest();
  }

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.storagePath, 'utf8')) as StoredPlatformData;
      if (data.version !== 1 || !Array.isArray(data.streamers)) {
        throw new Error('Unsupported HoloHangout platform data format.');
      }
      for (const stored of data.streamers) {
        const token = JSON.parse(this.open(stored.token)) as TwitchToken;
        this.accounts.set(stored.twitchUserId, { ...stored, token });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  list(): StreamerAccount[] {
    return [...this.accounts.values()].map(cloneAccount);
  }

  get(twitchUserId: string): StreamerAccount | null {
    const account = this.accounts.get(twitchUserId);
    return account == null ? null : cloneAccount(account);
  }

  findByWorld(worldId: string): StreamerAccount | null {
    const account = [...this.accounts.values()].find((candidate) => candidate.worldId === worldId);
    return account == null ? null : cloneAccount(account);
  }

  async save(account: StreamerAccount): Promise<void> {
    this.accounts.set(account.twitchUserId, cloneAccount(account));
    const write = this.writeQueue.then(() => this.persist());
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  private async persist(): Promise<void> {
    const payload: StoredPlatformData = {
      version: 1,
      streamers: [...this.accounts.values()].map(({ token, ...account }) => ({
        ...account,
        token: this.seal(JSON.stringify(token)),
      })),
    };
    await mkdir(dirname(this.storagePath), { recursive: true });
    const temporaryPath = `${this.storagePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.storagePath);
  }

  private seal(value: string): SealedValue {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    };
  }

  private open(value: SealedValue): string {
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}

function cloneAccount(account: StreamerAccount): StreamerAccount {
  return {
    ...account,
    token: { ...account.token },
    settings: { ...account.settings },
  };
}
