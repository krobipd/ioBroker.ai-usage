import { FetchError } from "./provider";
import { getJson, postForm, postJson } from "./http";

/**
 * `http.ts` is the ONLY module that calls the global `fetch` directly — every other
 * module takes an injected seam. That is why it needs `vi.stubGlobal` instead of a
 * fake: there is nothing to inject.
 *
 * What is pinned here is the backbone of the whole status model (design decisions 11
 * and 21): which HTTP outcome becomes which of the four failure classes. `auth` and
 * `rate-limit` mean the service ANSWERED, `service` means it answered with a fault of
 * its own, `network` means it was never reached — and only that split lets the adapter
 * say whether the AI service is down or this host has no connection.
 */

/**
 * A stubbed `fetch` that answers with one canned response.
 *
 * A REAL `Response`, not an object carrying `json()`/`text()`: those two are the
 * only members a hand-built fake used to have, and `http.ts` reads the body as a
 * STREAM to keep it under a size cap. A fake without `body` cannot exercise that
 * path at all — it would have reported the cap as covered while never reaching it.
 *
 * @param status the HTTP status to answer with
 * @param body the JSON body to answer with
 * @returns the mock function, so a test can inspect the call
 */
function respondWith(status: number, body: unknown = {}): ReturnType<typeof vi.fn> {
  return respondWithText(status, JSON.stringify(body));
}

/**
 * A stubbed `fetch` answering with a raw text body — for the non-JSON cases.
 *
 * @param status the HTTP status to answer with
 * @param text the exact body bytes
 * @returns the mock function, so a test can inspect the call
 */
function respondWithText(status: number, text: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(text, { status })));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * A stubbed `fetch` whose body fails while it is being read.
 *
 * @param status the HTTP status to answer with
 * @returns the mock function
 */
function respondWithBrokenBody(status: number): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("stream already consumed"));
          },
        }),
        { status },
      ),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * The message of a rejected call.
 *
 * @param call the call to run
 * @returns the FetchError message, or "resolved"
 */
async function messageOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return "resolved";
}

/**
 * The failure class of a rejected call.
 *
 * @param call the call to run
 * @returns the FetchError kind
 */
async function kindOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (e) {
    if (e instanceof FetchError) {
      return e.kind;
    }
    return `not-a-FetchError: ${String(e)}`;
  }
  return "resolved";
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("failure classification", () => {
  test("401 and 403 are auth failures — the service answered and said no", async () => {
    for (const status of [401, 403]) {
      respondWith(status);
      expect(await kindOf(() => getJson("https://example.invalid/x", {}))).toBe("auth");
    }
  });

  test("429 is a rate limit — the values stay valid, the account stays green", async () => {
    respondWith(429);
    expect(await kindOf(() => getJson("https://example.invalid/x", {}))).toBe("rate-limit");
  });

  test("5xx is a service fault, not a missing connection", async () => {
    // It ANSWERED. Reporting this as `network` would hide a real outage behind three
    // tolerated attempts (0.10.0 fix).
    for (const status of [500, 502, 503]) {
      respondWith(status);
      expect(await kindOf(() => getJson("https://example.invalid/x", {}))).toBe("service");
    }
  });

  test("an unexpected non-ok status is a service fault too", async () => {
    respondWith(418);
    expect(await kindOf(() => getJson("https://example.invalid/x", {}))).toBe("service");
  });

  test("a body that is not JSON is a service fault", async () => {
    respondWithText(200, "<html>not json at all</html>");
    expect(await kindOf(() => getJson("https://example.invalid/x", {}))).toBe("service");
  });

  test("a thrown fetch is the only network failure", async () => {
    // Refused connection, DNS failure, timeout — we never reached anyone.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
    );
    expect(await kindOf(() => getJson("https://example.invalid/x", {}))).toBe("network");
  });

  test("the network error carries the original reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("getaddrinfo ENOTFOUND"))),
    );
    await expect(getJson("https://example.invalid/x", {})).rejects.toThrow("getaddrinfo ENOTFOUND");
  });
});

describe("the 400 asymmetry between GET and the token POSTs", () => {
  test("a 400 on GET is a service fault", async () => {
    // Nothing is being redeemed here — a 400 means the service disliked our request.
    respondWith(400);
    expect(await kindOf(() => getJson("https://example.invalid/x", {}))).toBe("service");
  });

  test("a 400 is an auth failure where the CALLER says so — that is how OAuth rejects a dead grant", async () => {
    // Claude/ChatGPT token endpoints answer a spent code or a revoked refresh token
    // with 400. Classifying that as `service` would hide "sign in again" behind
    // "the provider is broken".
    respondWith(400);
    expect(
      await kindOf(() =>
        postJson("https://example.invalid/token", { grant_type: "refresh_token" }, { authOn400: true }),
      ),
    ).toBe("auth");
    respondWith(400);
    expect(await kindOf(() => postForm("https://example.invalid/token", { code: "x" }, { authOn400: true }))).toBe(
      "auth",
    );
  });

  test("…and NOT on every other post", async () => {
    // The rule used to be baked into both helpers, so a 400 anywhere read as a
    // rejected sign-in: the ChatGPT device poll took it for "not confirmed yet"
    // and waited out its whole window, and Google's Code-Assist call gave up on
    // its second host.
    respondWith(400);
    expect(await kindOf(() => postJson("https://example.invalid/deviceauth/token", { device_auth_id: "d" }))).toBe(
      "service",
    );
    respondWith(400);
    expect(await kindOf(() => postForm("https://example.invalid/any", { a: "b" }))).toBe("service");
  });
});

describe("request shape", () => {
  test("every request carries a timeout signal", async () => {
    // Without it a provider that never answers would hold the poll cycle of that
    // account forever — and a stuck account never reports unreachable.
    const fetchMock = respondWith(200, { ok: true });
    await getJson("https://example.invalid/x", { Authorization: "Bearer t" });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("an aborted request is a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }))),
    );
    expect(await kindOf(() => getJson("https://example.invalid/x", {}))).toBe("network");
  });

  test("getJson passes the headers through and parses the body", async () => {
    const fetchMock = respondWith(200, { hello: "world" });
    await expect(getJson("https://example.invalid/x", { Authorization: "Bearer t" })).resolves.toEqual({
      hello: "world",
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: "Bearer t" });
  });

  test("postJson sends a JSON body", async () => {
    const fetchMock = respondWith(200, { access_token: "a" });
    await postJson("https://example.invalid/token", { grant_type: "refresh_token", refresh_token: "r" });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ grant_type: "refresh_token", refresh_token: "r" });
  });

  test("postForm sends a form-encoded body and keeps extra headers", async () => {
    // The two shapes are separate helpers because ChatGPT/Codex needs BOTH — a
    // wrapper that guessed would send the wrong one half the time.
    const fetchMock = respondWith(200, { access_token: "a" });
    await postForm(
      "https://example.invalid/token",
      { code: "c", state: "s" },
      { headers: { originator: "Codex Desktop" } },
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
      originator: "Codex Desktop",
    });
    expect(init.body as string).toBe("code=c&state=s");
  });
});

describe("the provider's own words reach the error text", () => {
  test("a rejected key says WHY, not just HTTP 401", async () => {
    // `info.error` is what a user reads. "HTTP 401" tells them nothing they can act
    // on; OpenRouter, OpenAI and Anthropic all answer with { error: { message } }.
    respondWith(401, { error: { message: "No auth credentials found" } });
    expect(await messageOf(() => getJson("https://x/y", {}))).toBe("HTTP 401 — No auth credentials found");
  });

  test("the status still decides the class — the body only decorates", async () => {
    respondWith(429, { error: { message: "rate limit exceeded" } });
    expect(await kindOf(() => getJson("https://x/y", {}))).toBe("rate-limit");
    respondWith(503, { message: "upstream unavailable" });
    expect(await kindOf(() => getJson("https://x/y", {}))).toBe("service");
    expect(await messageOf(() => getJson("https://x/y", {}))).toBe("HTTP 503 — upstream unavailable");
  });

  test("an unreadable body changes nothing and never throws on its own", async () => {
    // Best effort in the strict sense: a body that is missing, not JSON or shaped
    // differently must leave the bare status standing.
    respondWithBrokenBody(500);
    expect(await messageOf(() => getJson("https://x/y", {}))).toBe("HTTP 500");
    respondWithBrokenBody(500);
    expect(await kindOf(() => getJson("https://x/y", {}))).toBe("service");
  });

  test("an HTML error page from a proxy is noise and stays out", async () => {
    const html = `<html><body>${"x".repeat(500)}</body></html>`;
    respondWithText(502, html);
    expect(await messageOf(() => getJson("https://x/y", {}))).toBe("HTTP 502");
  });

  test("a body past the size cap is refused instead of held in memory", async () => {
    // The request timeout bounds how LONG a body may take, never how BIG it gets.
    // 9 MiB against an 8 MiB cap — one chunk past the limit is enough to prove the
    // counter stops the read; the adapter must not grow with whatever it is sent.
    respondWithText(200, "x".repeat(9 * 1024 * 1024));
    expect(await kindOf(() => getJson("https://x/y", {}))).toBe("service");
    respondWithText(200, "x".repeat(9 * 1024 * 1024));
    expect(await messageOf(() => getJson("https://x/y", {}))).toContain("exceeds");
  });

  test("a body just under the cap still parses", async () => {
    // The neighbouring case, so the cap cannot be "fixed" by refusing everything:
    // a large but legitimate report — a month of buckets — must still come through.
    const padding = "y".repeat(1024 * 1024);
    respondWithText(200, JSON.stringify({ padding }));
    expect(await getJson("https://x/y", {})).toEqual({ padding });
  });
});
