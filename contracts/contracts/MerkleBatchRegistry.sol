// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MerkleBatchRegistry {
    bytes32 public constant LEAF_DOMAIN = keccak256("verified-document-vault/credential-leaf/v1");
    address public immutable owner;

    mapping(uint256 => bytes32) public batchRoots;
    mapping(bytes32 => bool) public revokedCredentials;
    mapping(address => bool) public authorizedAnchors;

    event BatchRegistered(uint256 indexed batchId, bytes32 indexed root, string metadata);
    event CredentialRevoked(bytes32 indexed credentialIdHash, address indexed revoker);
    event AnchorAuthorizationChanged(address indexed anchor, bool allowed);

    constructor() {
        owner = msg.sender;
        authorizedAnchors[msg.sender] = true;
        emit AnchorAuthorizationChanged(msg.sender, true);
    }

    modifier onlyAuthorized() {
        require(msg.sender == owner || authorizedAnchors[msg.sender], "not-authorized");
        _;
    }

    function setAnchorAuthorization(address anchor, bool allowed) external onlyAuthorized {
        authorizedAnchors[anchor] = allowed;
        emit AnchorAuthorizationChanged(anchor, allowed);
    }

    function registerBatch(uint256 batchId, bytes32 root, string calldata metadata) external onlyAuthorized {
        require(batchRoots[batchId] == bytes32(0), "duplicate-batch-id");
        batchRoots[batchId] = root;
        emit BatchRegistered(batchId, root, metadata);
    }

    function revokeCredential(bytes32 credentialIdHash) external onlyAuthorized {
        revokedCredentials[credentialIdHash] = true;
        emit CredentialRevoked(credentialIdHash, msg.sender);
    }

    function isCredentialRevoked(bytes32 credentialIdHash) external view returns (bool) {
        return revokedCredentials[credentialIdHash];
    }
}
