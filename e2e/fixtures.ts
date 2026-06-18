import { test as base, type Page } from "@playwright/test";

export type Role = "Manager" | "Scorekeeper" | "Captain";

async function signInAs(page: Page, role: Role) {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  await page.waitForURL("/dashboard");
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("/login");
}

type Fixtures = {
  signedInAs: (role: Role) => Promise<void>;
  signOut: () => Promise<void>;
};

export const test = base.extend<Fixtures>({
  signedInAs: async ({ page }, use) => {
    await use((role: Role) => signInAs(page, role));
  },
  signOut: async ({ page }, use) => {
    await use(() => signOut(page));
  },
});

export { expect } from "@playwright/test";
