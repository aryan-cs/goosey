import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UserProfileLink, userProfileHref } from "./user-profile-link";

describe("UserProfileLink", () => {
  it("uses the canonical encoded profile route", () => {
    expect(userProfileHref("goose/name")).toBe("/users/goose%2Fname");
    expect(renderToStaticMarkup(<UserProfileLink username="goose/name">@goose/name</UserProfileLink>)).toContain('href="/users/goose%2Fname"');
  });
});
