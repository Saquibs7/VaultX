export type Institution = {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PENDING' | 'SUSPENDED';
  createdAt: string;
};

export type Issuer = {
  id: string;
  institutionId: string;
  name: string;
  email: string;
  passwordHash: string;
  role: 'ISSUER' | 'ADMIN';
  publicKeyPem: string;
  privateKeyPem: string;
  keyId: string;
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: string;
};

export type Credential = {
  id: string;
  issuerId: string;
  institutionId: string;
  holderReference: string;
  documentDigest: string;
  documentStorageReference: string;
  documentEncryptionMetadata: {
    algorithm: string;
    keyId: string;
    nonce: string;
  };
  issuerSignature: string;
  issuerKeyId: string;
  schemaVersion: number;
  credentialVersion: number;
  issuedAt: string;
  deadlineAt: string;
  lifecycleStatus: 'DRAFT' | 'PENDING_ANCHOR' | 'ANCHORED' | 'REVOKED' | 'SUPERSEDED' | 'REJECTED';
  anchorState?: 'QUEUED' | 'CLAIMED' | 'ANCHORED' | 'FAILED';
  anchorBatchId?: string;
  anchorRoot?: string;
  anchorProof?: string[];
  anchorTransactionHash?: string;
  anchorBlockNumber?: string;
  anchorClaimedAt?: string;
  anchorWorkerId?: string;
  lastAnchorError?: string;
  revocationState?: 'NOT_REQUIRED' | 'QUEUED' | 'CLAIMED' | 'CONFIRMED';
  revocationTransactionHash?: string;
  revocationBlockNumber?: string;
  revocationClaimedAt?: string;
  revocationWorkerId?: string;
  createdAt: string;
  updatedAt: string;
};
