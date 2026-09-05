import { anthropicApiProvider, parseAnthropicReports } from "./anthropic-api";
import { fetchAllPages, isToday, monthStartIso, monthStartUnix, projectMonth } from "./report-utils";
import { openAiProvider, parseOpenAiReports } from "./openai";

/** 2026-08-25 12:00 UTC. */
const NOW = Date.UTC(2026, 7, 25, 12);

describe("report-utils", () => {
  test("month start in both forms, today matching for unix and ISO, linear projection", () => {
    expect(monthStartUnix(NOW)).toBe(Date.UTC(2026, 7, 1) / 1000);
    expect(monthStartIso(NOW)).toBe("2026-08-01T00:00:00Z");
    expect(isToday(Date.UTC(2026, 7, 25) / 1000, NOW)).toBe(true);
    expect(isToday("2026-08-25T00:00:00Z", NOW)).toBe(true);
    expect(isToday("2026-08-24T00:00:00Z", NOW)).toBe(false);
    expect(isToday(undefined, NOW)).toBe(false);
    // 100 spent in 25 of 31 days → 124 projected.
    expect(projectMonth(100, NOW)).toBe(124);
  });
});

describe("OpenAI reports", () => {
  test("sums month costs, extracts today's costs/tokens and the per-model split", () => {
    const day = (offset: number): number => Date.UTC(2026, 7, 25 - offset) / 1000;
    const snapshot = parseOpenAiReports(
      [
        {
          start_time: day(0),
          results: [
            { input_tokens: 1000, output_tokens: 200, model: "gpt-5-mini" },
            { input_tokens: 500, output_tokens: 100, model: "gpt-5" },
          ],
        },
        { start_time: day(1), results: [{ input_tokens: 9999, output_tokens: 9999, model: "gpt-5" }] },
      ],
      [
        { start_time: day(0), results: [{ amount: { value: 0.8, currency: "usd" } }] },
        { start_time: day(1), results: [{ amount: { value: 1.2, currency: "usd" } }] },
      ],
      NOW,
    );
    expect(snapshot.costs).toMatchObject({ today: 0.8, month: 2, currency: "USD" });
    expect(snapshot.costs?.projectedMonth).toBe(2.48);
    expect(snapshot.tokens).toMatchObject({ inputToday: 1500, outputToday: 300 });
    expect(snapshot.tokens?.perModel).toEqual([
      { model: "gpt-5-mini", tokens: 1200 },
      { model: "gpt-5", tokens: 600 },
    ]);
  });

  test("the provider pages through has_more and sends the admin key", async () => {
    const calls: string[] = [];
    let usageCall = 0;
    const provider = openAiProvider(
      "sk-admin",
      (url, headers) => {
        calls.push(url);
        expect(headers.Authorization).toBe("Bearer sk-admin");
        if (url.includes("/usage/completions")) {
          usageCall++;
          return Promise.resolve(
            usageCall === 1 ? { data: [], has_more: true, next_page: "p2" } : { data: [], has_more: false },
          );
        }
        return Promise.resolve({ data: [] });
      },
      () => NOW,
    );
    await provider.fetch();
    expect(calls.filter(url => url.includes("/usage/completions"))).toHaveLength(2);
    expect(calls[1]).toContain("page=p2");
    expect(calls.some(url => url.includes("/costs?start_time="))).toBe(true);
  });
});

describe("Anthropic reports", () => {
  test("string amounts sum into costs; today's tokens from uncached_input/output", () => {
    const snapshot = parseAnthropicReports(
      [
        {
          starting_at: "2026-08-25T00:00:00Z",
          results: [{ uncached_input_tokens: 800, output_tokens: 150 }],
        },
      ],
      [
        { starting_at: "2026-08-25T00:00:00Z", results: [{ amount: "0.55" }] },
        { starting_at: "2026-08-10T00:00:00Z", results: [{ amount: "1.45" }] },
      ],
      NOW,
    );
    expect(snapshot.costs).toMatchObject({ today: 0.55, month: 2, currency: "USD" });
    expect(snapshot.tokens).toEqual({ inputToday: 800, outputToday: 150 });
  });

  test("the provider sends x-api-key + anthropic-version", async () => {
    const seen: Record<string, string>[] = [];
    const provider = anthropicApiProvider(
      "sk-ant-admin",
      (_url, headers) => {
        seen.push(headers);
        return Promise.resolve({ data: [] });
      },
      () => NOW,
    );
    await provider.fetch();
    expect(seen[0]["x-api-key"]).toBe("sk-ant-admin");
    expect(seen[0]["anthropic-version"]).toBe("2023-06-01");
  });
});

describe("fetchAllPages", () => {
  test("follows has_more/next_page and collects every bucket", async () => {
    const seen: string[] = [];
    const pages: Record<string, unknown> = {
      "/r": { data: [1, 2], has_more: true, next_page: "p2" },
      "/r&page=p2": { data: [3], has_more: false },
    };
    const buckets = await fetchAllPages("/r", {}, url => {
      seen.push(url);
      return Promise.resolve(pages[url]);
    });
    expect(buckets).toEqual([1, 2, 3]);
    expect(seen).toEqual(["/r", "/r&page=p2"]);
  });

  test("a full month of daily buckets fits — the old ceiling of 12 did not", async () => {
    // 31 daily buckets, one per page: the previous limit cut the month off around
    // day 12 and returned the partial sum as if it were complete.
    let page = 0;
    const buckets = await fetchAllPages("/r", {}, () => {
      page++;
      return Promise.resolve({ data: [page], has_more: page < 31, next_page: `p${page + 1}` });
    });
    expect(buckets).toHaveLength(31);
  });

  test("hitting the ceiling is REPORTED, never silently truncated", async () => {
    const truncated: number[] = [];
    const buckets = await fetchAllPages(
      "/r",
      {},
      () => Promise.resolve({ data: [1], has_more: true, next_page: "next" }),
      pages => truncated.push(pages),
    );
    expect(truncated).toEqual([32]);
    expect(buckets).toHaveLength(32);
  });

  test("a complete report never reports truncation", async () => {
    const truncated: number[] = [];
    await fetchAllPages(
      "/r",
      {},
      () => Promise.resolve({ data: [1], has_more: false }),
      pages => truncated.push(pages),
    );
    expect(truncated).toEqual([]);
  });

  test("a page without a usable next_page ends the walk", async () => {
    let calls = 0;
    const buckets = await fetchAllPages("/r", {}, () => {
      calls++;
      return Promise.resolve({ data: [1], has_more: true, next_page: "" });
    });
    expect(calls).toBe(1);
    expect(buckets).toEqual([1]);
  });
});

describe("report providers ask for full pages", () => {
  test("both Anthropic reports carry an explicit limit", async () => {
    // Without it the server picks the page size, which is exactly how a month walks
    // into the page ceiling.
    const urls: string[] = [];
    const provider = anthropicApiProvider(
      "admin-key",
      url => {
        urls.push(url);
        return Promise.resolve({ data: [] });
      },
      () => Date.UTC(2026, 8, 4),
    );
    await provider.fetch();
    expect(urls).toHaveLength(2);
    expect(urls.every(url => url.includes("limit=31"))).toBe(true);
  });

  test("a truncated report reaches the warn callback", async () => {
    const warnings: string[] = [];
    const provider = openAiProvider(
      "admin-key",
      () => Promise.resolve({ data: [], has_more: true, next_page: "n" }),
      () => Date.UTC(2026, 8, 4),
      message => warnings.push(message),
    );
    await provider.fetch();
    expect(warnings).toHaveLength(2); // usage report and cost report
    expect(warnings[0]).toContain("partial");
  });
});
