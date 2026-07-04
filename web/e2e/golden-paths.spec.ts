import { test, expect } from "@playwright/test"

// Unauthenticated golden paths — the app serving correctly, the auth being
// configured, and the guarded routes redirecting. This exact set would have
// caught the framework-preset 404s and the AUTH_URL auth-500s from rollout.
test.describe("golden paths (unauthenticated)", () => {
  test("the sign-in page renders", async ({ page }) => {
    await page.goto("/signin")
    await expect(page.getByRole("heading", { name: /sign in to kin/i })).toBeVisible()
    await expect(page.getByRole("button", { name: /sign in with google/i })).toBeVisible()
  })

  test("/dashboard redirects an unauthenticated user to /signin", async ({ page }) => {
    await page.goto("/dashboard")
    await expect(page).toHaveURL(/\/signin/)
  })

  test("/finance redirects an unauthenticated user to /signin", async ({ page }) => {
    await page.goto("/finance")
    await expect(page).toHaveURL(/\/signin/)
  })

  test("the home page routes toward sign-in", async ({ page }) => {
    await page.goto("/")
    await expect(page).toHaveURL(/\/(signin|dashboard)/)
  })

  test("the auth providers endpoint is configured with Google", async ({ request }) => {
    const res = await request.get("/api/auth/providers")
    expect(res.status()).toBe(200)
    expect(await res.json()).toHaveProperty("google")
  })
})
