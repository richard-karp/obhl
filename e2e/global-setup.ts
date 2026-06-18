import { execSync } from "child_process";

export default async function globalSetup() {
  console.log("\n[global-setup] Resetting database...");
  execSync("npm run db:reset", { stdio: "inherit", cwd: process.cwd() });

  console.log("[global-setup] Seeding auth users...");
  execSync("npm run seed:users", { stdio: "inherit", cwd: process.cwd() });

  console.log("[global-setup] Ready.\n");
}
