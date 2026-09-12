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

  test("a day without usage reports zero and keeps every model of the month", () => {
    // Measured: after UTC midnight the report has no bucket for today yet. Built
    // from today's buckets only, the whole tokens/models block fell out of the
    // snapshot — the counters kept yesterday's numbers under a name that says
    // "today", and the orphan sweep deleted the model channels every night.
    const snapshot = parseOpenAiReports(
      [
        {
          start_time: Date.UTC(2026, 7, 24) / 1000,
          results: [{ input_tokens: 500, output_tokens: 100, model: "gpt-5" }],
        },
      ],
      [{ start_time: Date.UTC(2026, 7, 24) / 1000, results: [{ amount: { value: 1, currency: "usd" } }] }],
      NOW,
    );
    expect(snapshot.tokens).toEqual({ inputToday: 0, outputToday: 0, perModel: [{ model: "gpt-5", tokens: 0 }] });
    expect(snapshot.costs?.today).toBe(0);
  });

  test("the model list comes from the MONTH, the number from today", () => {
    const snapshot = parseOpenAiReports(
      [
        {
          start_time: Date.UTC(2026, 7, 10) / 1000,
          results: [{ input_tokens: 900, output_tokens: 100, model: "gpt-5-mini" }],
        },
        {
          start_time: Date.UTC(2026, 7, 25) / 1000,
          results: [{ input_tokens: 300, output_tokens: 200, model: "gpt-5" }],
        },
      ],
      [],
      NOW,
    );
    expect(snapshot.tokens?.inputToday).toBe(300);
    expect(snapshot.tokens?.perModel).toEqual([
      { model: "gpt-5-mini", tokens: 0 },
      { model: "gpt-5", tokens: 500 },
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
      // CENTS — that is what the cost report sends (see the unit test below).
      [
        { starting_at: "2026-08-25T00:00:00Z", results: [{ amount: "55.00" }] },
        { starting_at: "2026-08-10T00:00:00Z", results: [{ amount: "145.00" }] },
      ],
      NOW,
    );
    expect(snapshot.costs).toMatchObject({ today: 0.55, month: 2, currency: "USD" });
    expect(snapshot.tokens).toEqual({ inputToday: 800, outputToday: 150 });
  });

  test("the cost report counts in CENTS — the provider's own worked example", () => {
    // Admin API reference, cost report response schema: `amount` is the "cost
    // amount in lowest currency units (e.g. cents) as a decimal string. For
    // example, "123.45" in "USD" represents $1.23." Read as dollars, every cost
    // figure of an Anthropic organisation account was a hundred times too high —
    // and `total.costs.*` summed it that way.
    const snapshot = parseAnthropicReports(
      [],
      [{ starting_at: "2026-08-25T00:00:00Z", results: [{ amount: "123.45" }] }],
      NOW,
    );
    expect(snapshot.costs?.today).toBe(1.23);
    expect(snapshot.costs?.month).toBe(1.23);
  });

  test("the projection is built from the converted sum, not from the cents", () => {
    // 31 days in August, day 25 of the month: 1000 cents = $10 so far.
    const snapshot = parseAnthropicReports(
      [],
      [{ starting_at: "2026-08-10T00:00:00Z", results: [{ amount: "1000" }] }],
      NOW,
    );
    expect(snapshot.costs?.month).toBe(10);
    expect(snapshot.costs?.projectedMonth).toBe(12.4);
  });

  test("a day without usage still reports zero tokens", () => {
    const snapshot = parseAnthropicReports(
      [
        {
          starting_at: "2026-08-24T00:00:00Z",
          results: [{ uncached_input_tokens: 800, output_tokens: 150 }],
        },
      ],
      [],
      NOW,
    );
    expect(snapshot.tokens).toEqual({ inputToday: 0, outputToday: 0 });
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
