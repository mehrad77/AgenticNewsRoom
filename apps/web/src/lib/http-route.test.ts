import { describe, expect, it } from "vitest";
import { httpRoute } from "./http-route.ts";
import type { Site } from "./site.ts";

const newsroom = (path: string) =>
  ({ kind: "newsroom", language: "en", direction: "ltr", path }) as unknown as Site;

describe("httpRoute", () => {
  it("names a request by its page, never by its path", () => {
    expect(httpRoute(newsroom("/"), "/")).toBe("/");
    expect(httpRoute(newsroom("/daily/2026-11-02"), "/fa/daily/2026-11-02")).toBe("/:series/:date");
    expect(httpRoute(newsroom("/daily/2026-11-02.json"), "/daily/2026-11-02.json")).toBe(
      "/:series/:date.json",
    );
    expect(httpRoute(newsroom("/podcast/weekly.xml"), "/podcast/weekly.xml")).toBe(
      "/podcast/:series.xml",
    );
    const id = "0b0c6a52-7d8e-4f7a-9d1e-2f3a4b5c6d7e";
    expect(httpRoute(newsroom(`/challenge/${id}`), `/challenge/${id}`)).toBe("/challenge/:id");
    expect(httpRoute(newsroom(`/a/${id}.mp3`), `/a/${id}.mp3`)).toBe("/a/:id.mp3");
    expect(httpRoute(newsroom("/wp-login.php"), "/wp-login.php")).toBe("/*");
    expect(httpRoute({ kind: "desk" } as Site, `/newsrooms/ai/publications/${id}`)).toBe(
      "/desk/newsrooms/:newsroom/publications/:id",
    );
  });
});
