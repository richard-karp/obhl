import type { Page } from "@playwright/test";

export type Role = "Manager" | "Scorekeeper" | "Captain";

export async function signInAs(page: Page, role: Role) {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  await page.waitForURL("/dashboard");
}

export async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("/login");
}
