import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

import { ModerationQueue } from "./moderation-queue";
import { ResolutionQueue } from "./resolution-queue";
import { SuggestionQueue } from "./suggestion-queue";

vi.stubGlobal("React", React);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterAll(() => vi.unstubAllGlobals());

describe("admin account identity links", () => {
  it("links reporters and comment authors", () => {
    const html = renderToStaticMarkup(React.createElement(ModerationQueue, { initialReports: [{
      id: "report-1", reason: "SPAM", details: "Repeated", createdAt: new Date(),
      reporter: { username: "reporter" },
      comment: { body: "Comment", user: { username: "author", displayName: "Author" }, market: { slug: "market", shortTitle: "Market" } },
    }] }));
    expect(html).toContain('href="/users/reporter"');
    expect(html).toContain('href="/users/author"');
  });

  it("links suggestion submitters and resolution proposers", () => {
    const suggestion = renderToStaticMarkup(React.createElement(SuggestionQueue, { initialSuggestions: [{ id: "suggestion-1", title: "Idea", description: "Description", category: "Campus", createdAt: new Date(), user: { username: "submitter", displayName: "Submitter" } }] }));
    const resolution = renderToStaticMarkup(React.createElement(ResolutionQueue, { initialProposals: [{ id: "proposal-1", outcome: "YES", reason: "Resolved", evidence: "Source", proposer: { username: "admin_goose", displayName: "Admin Goose" }, market: { title: "Market", slug: "market", status: "RESOLVING" } }], initialRuns: [], viewerId: "reviewer", proposerIds: { "proposal-1": "proposer" } }));
    expect(suggestion).toContain('href="/users/submitter"');
    expect(resolution).toContain('href="/users/admin_goose"');
  });
});
