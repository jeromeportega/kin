import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"

const mockSignOut = vi.hoisted(() => vi.fn())
vi.mock("next-auth/react", () => ({
  signOut: mockSignOut,
}))

import { SignOutButton } from "@/components/SignOutButton"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("SignOutButton", () => {
  it("renders a 'Sign out' button", () => {
    render(<SignOutButton />)
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument()
  })

  it("calls signOut with a redirect back to /signin on click", () => {
    render(<SignOutButton />)
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }))
    expect(mockSignOut).toHaveBeenCalledWith({ callbackUrl: "/signin" })
  })
})
