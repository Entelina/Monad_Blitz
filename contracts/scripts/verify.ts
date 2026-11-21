import fs from "fs";
import path from "path";
import "dotenv/config";

async function main() {
  const deploymentPath = path.join(__dirname, "..", "deployments", "monadTestnet.json");
  if (!fs.existsSync(deploymentPath)) {
    throw new Error("Missing deployments/monadTestnet.json. Deploy first.");
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

  const buildInfoDir = path.join(__dirname, "..", "artifacts", "build-info");
  const buildFiles = fs
    .readdirSync(buildInfoDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      name: f,
      mtime: fs.statSync(path.join(buildInfoDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (buildFiles.length === 0) {
    throw new Error("No Hardhat build-info found. Run pnpm compile first.");
  }

  const buildInfo = JSON.parse(
    fs.readFileSync(path.join(buildInfoDir, buildFiles[0].name), "utf8")
  );
  const contractOutput =
    buildInfo.output?.contracts?.["contracts/TaskRailEscrow.sol"]?.["TaskRailEscrow"];
  if (!contractOutput) {
    throw new Error("TaskRailEscrow output not found in latest build-info.");
  }

  const compilerVersion = `v${buildInfo.solcLongVersion}`;
  const payload = {
    chainId: 10143,
    contractAddress: deployment.address,
    contractName: "contracts/TaskRailEscrow.sol:TaskRailEscrow",
    compilerVersion,
    standardJsonInput: buildInfo.input,
    foundryMetadata: JSON.parse(contractOutput.metadata),
  };

  console.log("Verifying on Monadscan / MonadVision / Socialscan via devnads verify API...");
  console.log("  Address:", deployment.address);
  console.log("  Compiler:", compilerVersion);

  const res = await fetch("https://agents.devnads.com/v1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  console.log("HTTP", res.status);
  console.log(text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
