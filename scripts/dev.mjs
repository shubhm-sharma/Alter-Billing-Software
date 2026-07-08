import { spawn } from "node:child_process";

const commands = [
  ["server", "node", ["server/index.js"]],
  ["client", "npx", ["vite", "--host", "0.0.0.0"]],
];

const children = commands.map(([name, command, args]) => {
  const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  child.on("exit", (code) => {
    if (code && !shuttingDown) {
      console.error(`${name} exited with code ${code}`);
      shutdown(code);
    }
  });
  return child;
});

let shuttingDown = false;

function shutdown(code = 0) {
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
