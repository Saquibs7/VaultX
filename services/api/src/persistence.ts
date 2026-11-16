import { MongoClient, type Collection, type Db, type Document } from 'mongodb';

import { decryptIssuerPrivateKey, encryptIssuerPrivateKey } from './auth.js';
import type { Credential, Institution, Issuer } from './types.js';

export type EncryptedDocument = { ciphertext: string; nonce: string; keyId: string };
type StoredDocument = Document & { _id: string };

export type PersistedState = {
  institutions: Institution[];
  issuers: Issuer[];
  credentials: Credential[];
  encryptedDocuments: Array<{ credentialId: string; value: EncryptedDocument }>;
};

export interface PersistenceStore {
  readonly storageMode: 'mongodb' | 'process-memory';
  load(): Promise<PersistedState>;
  saveInstitution(value: Institution): Promise<void>;
  saveIssuer(value: Issuer): Promise<void>;
  saveCredential(value: Credential): Promise<void>;
  saveEncryptedDocument(credentialId: string, value: EncryptedDocument): Promise<void>;
  close(): Promise<void>;
}

class MemoryPersistence implements PersistenceStore {
  readonly storageMode = 'process-memory' as const;

  async load(): Promise<PersistedState> {
    return { institutions: [], issuers: [], credentials: [], encryptedDocuments: [] };
  }

  async saveInstitution(_value: Institution) {}
  async saveIssuer(_value: Issuer) {}
  async saveCredential(_value: Credential) {}
  async saveEncryptedDocument(_credentialId: string, _value: EncryptedDocument) {}
  async close() {}
}

class MongoPersistence implements PersistenceStore {
  readonly storageMode = 'mongodb' as const;
  private readonly client: MongoClient;
  private readonly database: Db;
  private readonly institutions: Collection<StoredDocument>;
  private readonly issuers: Collection<StoredDocument>;
  private readonly credentials: Collection<StoredDocument>;
  private readonly documents: Collection<StoredDocument>;

  private constructor(client: MongoClient, database: Db) {
    this.client = client;
    this.database = database;
    this.institutions = database.collection<StoredDocument>('institutions');
    this.issuers = database.collection<StoredDocument>('issuers');
    this.credentials = database.collection<StoredDocument>('credentials');
    this.documents = database.collection<StoredDocument>('encryptedDocuments');
  }

  static async connect(uri: string): Promise<MongoPersistence> {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
    await client.connect();
    const database = client.db();
    const persistence = new MongoPersistence(client, database);
    await Promise.all([
      persistence.institutions.createIndex({ name: 1 }),
      persistence.issuers.createIndex({ email: 1 }, { unique: true }),
      persistence.issuers.createIndex({ institutionId: 1 }),
      persistence.credentials.createIndex({ institutionId: 1, createdAt: -1 }),
      persistence.credentials.createIndex({ lifecycleStatus: 1, anchorState: 1 }),
    ]);
    return persistence;
  }

  async load(): Promise<PersistedState> {
    const [institutions, storedIssuers, credentials, encryptedDocuments] = await Promise.all([
      this.institutions.find({}, { projection: { _id: 0 } }).toArray(),
      this.issuers.find({}, { projection: { _id: 0 } }).toArray(),
      this.credentials.find({}, { projection: { _id: 0 } }).toArray(),
      this.documents.find({}, { projection: { _id: 0 } }).toArray(),
    ]);
    const issuers: Issuer[] = [];
    for (const stored of storedIssuers) {
      const issuer = stored as unknown as Issuer;
      const privateKeyPem = decryptIssuerPrivateKey(issuer.privateKeyPem);
      issuers.push({ ...issuer, privateKeyPem });
      if (privateKeyPem === issuer.privateKeyPem) {
        await this.saveIssuer({ ...issuer, privateKeyPem });
      }
    }
    return {
      institutions: institutions as unknown as Institution[],
      issuers,
      credentials: credentials as unknown as Credential[],
      encryptedDocuments: encryptedDocuments.map((entry) => ({
        credentialId: String(entry.credentialId),
        value: {
          ciphertext: String(entry.ciphertext),
          nonce: String(entry.nonce),
          keyId: String(entry.keyId),
        },
      })),
    };
  }

  async saveInstitution(value: Institution) {
    await this.replace(this.institutions, value.id, value);
  }

  async saveIssuer(value: Issuer) {
    await this.replace(this.issuers, value.id, {
      ...value,
      privateKeyPem: encryptIssuerPrivateKey(value.privateKeyPem),
    });
  }

  async saveCredential(value: Credential) {
    await this.replace(this.credentials, value.id, value);
  }

  async saveEncryptedDocument(credentialId: string, value: EncryptedDocument) {
    await this.replace(this.documents, credentialId, { credentialId, ...value });
  }

  async close() {
    await this.client.close();
  }

  private async replace(collection: Collection<StoredDocument>, id: string, value: object) {
    await collection.replaceOne({ _id: id }, { _id: id, ...value }, { upsert: true });
  }
}

export async function createPersistenceStore(uri?: string): Promise<PersistenceStore> {
  if (!uri) return new MemoryPersistence();
  return MongoPersistence.connect(uri);
}
