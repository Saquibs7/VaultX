const { ethers } = require('hardhat');
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const [deployer] = await ethers.getSigners();
  const registry = await ethers.deployContract('MerkleBatchRegistry');
  await registry.waitForDeployment();
  const contractAddress = await registry.getAddress();
  const network = await ethers.provider.getNetwork();
  const deploymentPath = process.env.DEPLOYMENT_FILE ?? path.resolve('deployments/registry.json');
  await fs.mkdir(path.dirname(deploymentPath), { recursive: true });
  await fs.writeFile(deploymentPath, `${JSON.stringify({
    contractName: 'MerkleBatchRegistry',
    address: contractAddress,
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
  }, null, 2)}\n`);

  console.log('MerkleBatchRegistry deployed by:', deployer.address);
  console.log('Contract address:', contractAddress);
  console.log('Deployment manifest:', deploymentPath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
