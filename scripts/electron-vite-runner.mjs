import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.execPath;
const electronViteBin = resolve(root, "node_modules", "electron-vite", "bin", "electron-vite.js");
const env = { ...process.env };

delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(executable, [electronViteBin, ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: "inherit",
  windowsHide: false,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
