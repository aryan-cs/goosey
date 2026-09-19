import { describe, expect, it } from "vitest";

import {
  parseAndRedactAuditMetadata,
  redactAuditMetadata,
  serializeAuditCsv,
  type AuditExportItem,
} from "./audit-export";

describe("audit metadata redaction", () => {
  it("exports only explicitly safe audit fields and redacts everything else", () => {
    const value = redactAuditMetadata({
      requestHash: "not-exported",
      passwordHash: "never-export",
      outcome: "YES",
      userId: "user_123",
      nested: {
        api_key: "never-export",
        entries: [{ refreshToken: "never-export", leaseToken: "never-export", outcome: "YES" }],
      },
    });

    expect(value).toEqual({
      requestHash: "[REDACTED]",
      passwordHash: "[REDACTED]",
      outcome: "YES",
      userId: "user_123",
      nested: "[REDACTED]",
    });
  });

  it("never falls back to returning malformed raw metadata", () => {
    expect(parseAndRedactAuditMetadata('{"accessToken":"secret"')).toEqual({
      _redacted: "Stored metadata was not valid JSON.",
    });
  });
});

describe("audit CSV serialization", () => {
  it("quotes fields and neutralizes spreadsheet formulas after leading whitespace", () => {
    const item: AuditExportItem = {
      id: "audit_1",
      createdAt: new Date("2026-09-18T12:00:00.000Z"),
      actor: { id: "user_1", username: "admin", displayName: " =HYPERLINK(\"bad\")" },
      action: "MARKET_CREATED",
      entityType: "MARKET",
      entityId: "+SUM(1,1)",
      metadata: { note: "ordinary, quoted context", secret: "[REDACTED]" },
    };

    const csv = serializeAuditCsv([item]);
    expect(csv).toContain('"\' =HYPERLINK(""bad"")"');
    expect(csv).toContain('"\'+SUM(1,1)"');
    expect(csv).toContain('"{""note"":""ordinary, quoted context"",""secret"":""[REDACTED]""}"');
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});
