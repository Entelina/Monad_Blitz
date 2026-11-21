import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
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
    throw new Error("No Hardhat build-info found. Run hardhat compile first.");
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

  const tmpFile = path.join(os.tmpdir(), `taskrail-verify-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(payload), "utf8");

  console.log("Verifying on Monadscan / MonadVision / Socialscan via devnads verify API...");
  console.log("  Address :", deployment.address);
  console.log("  Compiler:", compilerVersion);

  try {
    const out = execFileSync(
      "curl.exe",
      [
        "-sS",
        "--max-time",
        "60",
        "-w",
        "\nHTTP_CODE=%{http_code}",
        "-X",
        "POST",
        "https://agents.devnads.com/v1/verify",
        "-H",
        "Content-Type: application/json",
        "--data-binary",
        `@${tmpFile}`,
      ],
      { encoding: "utf8" }
    );
    console.log(out);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
