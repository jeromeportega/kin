import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import * as fs from "fs";
import * as path from "path";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

describe("toolchain smoke", () => {
  it("renders a trivial component and asserts visible text", () => {
    function Hello() {
      return <p>kin dashboard</p>;
    }
    render(<Hello />);
    expect(screen.getByText("kin dashboard")).toBeInTheDocument();
  });
});

describe("shadcn present", () => {
  it("renders Card without error", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Test card</CardTitle>
        </CardHeader>
        <CardContent>Card body</CardContent>
      </Card>
    );
    expect(screen.getByText("Test card")).toBeInTheDocument();
    expect(screen.getByText("Card body")).toBeInTheDocument();
  });

  it("renders Badge without error", () => {
    render(<Badge>high</Badge>);
    expect(screen.getByText("high")).toBeInTheDocument();
  });
});

describe("env documentation", () => {
  const webRoot = path.resolve(__dirname, "..");

  it("web/.env.example documents all required env vars", () => {
    const envExample = fs.readFileSync(path.join(webRoot, ".env.example"), "utf-8");
    for (const key of [
      "AUTH_SECRET",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "KIN_API_BASE_URL",
      "KIN_DEMO_USER",
    ]) {
      expect(envExample, `${key} missing from .env.example`).toContain(key);
    }
  });

  it("web/.env.local is gitignored", () => {
    const gitignore = fs.readFileSync(path.join(webRoot, ".gitignore"), "utf-8");
    // Next.js default .gitignore uses ".env*" which covers .env.local
    const coversEnvLocal =
      gitignore.includes(".env.local") || gitignore.includes(".env*");
    expect(coversEnvLocal).toBe(true);
  });
});
