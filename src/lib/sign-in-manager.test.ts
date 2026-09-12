import type { PostOptions } from "./http";
import type { TokenSet, TokenStore } from "./provider";
import { SignInManager, type SignInDeps } from "./sign-in-manager";
import { SIGN_IN_FLOWS } from "./sign-in";

/**
 * A token store that lives in a variable — the adapter owns the real file.
 *
 * @param initial what the store already holds
 * @returns the store, with its content readable for assertions
 */
function memoryStore(initial: TokenSet | null = null): TokenStore & { value: TokenSet | null } {
  const store = {
    value: initial,
    load: (): Promise<TokenSet | null> => Promise.resolve(store.value),
    save: (tokens: TokenSet): Promise<void> => {
      store.value = tokens;
      return Promise.resolve();
    },
    clear: (): Promise<void> => {
      store.value = null;
      return Promise.resolve();
    },
  };
  return store;
}

interface Harness {
  deps: SignInDeps;
  stores: Map<string, ReturnType<typeof memoryStore>>;
  posts: { url: string; body: unknown; options?: PostOptions }[];
  /** What the next POST answers; a function is called instead and throws. */
  answers: unknown[];
  signedIn: string[];
  logs: string[];
  clock: { now: number };
  /** Run every armed interval once and let the promises settle. */
  tick(): Promise<void>;
  intervals(): number;
}

function makeHarness(): Harness {
  const stores = new Map<string, ReturnType<typeof memoryStore>>();
  const posts: { url: string; body: unknown; options?: PostOptions }[] = [];
  const answers: unknown[] = [];
  const signedIn: string[] = [];
  const logs: string[] = [];
  const timers: (() => void)[] = [];
  const clock = { now: 1_000_000 };
  const post = (url: string, body: Record<string, unknown>, options?: PostOptions): Promise<unknown> => {
    posts.push({ url, body, options });
    const next = answers.shift();
    if (typeof next === "function") {
      (next as () => never)();
    }
    return Promise.resolve(next ?? {});
  };
  const deps: SignInDeps = {
    store: provider => {
      let store = stores.get(provider);
      if (!store) {
        store = memoryStore();
        stores.set(provider, store);
      }
      return store;
    },
    postJson: post,
    postForm: (url, form, options) => post(url, form, options),
    now: () => clock.now,
    schedule: cb => {
      timers.push(cb);
      return cb;
    },
    cancel: handle => {
      const index = timers.indexOf(handle as () => void);
      if (index >= 0) {
        timers.splice(index, 1);
      }
    },
    log: { info: m => void logs.push(m), debug: m => void logs.push(m) },
    onSignedIn: provider => void signedIn.push(provider),
  };
  return {
    deps,
    stores,
    posts,
    answers,
    signedIn,
    logs,
    clock,
    intervals: () => timers.length,
    tick: async () => {
      for (const cb of [...timers]) {
        cb();
      }
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

describe("which providers sign in", () => {
  test("only the three subscriptions, never a key account", () => {
    // Straight at the table the adapter itself reads (`main.ts` → providerFrom).
    // This used to go through a static helper on the manager that no production
    // code ever called — a green test about a path the adapter does not take.
    expect(Object.keys(SIGN_IN_FLOWS).sort()).toEqual(["chatgpt-sub", "claude-sub", "gemini-sub"]);
    expect(SIGN_IN_FLOWS.openrouter).toBeUndefined();
    expect(SIGN_IN_FLOWS.nonsense).toBeUndefined();
  });
});

describe("the paste flows", () => {
  test("Claude hands out a link and takes the code back", async () => {
    const h = makeHarness();
    const manager = new SignInManager(h.deps);
    const started = await manager.start("claude-sub");
    expect(started).toMatchObject({ status: "awaiting-paste", flow: "paste-code" });
    expect((started as { url: string }).url).toContain("claude.ai/oauth/authorize");

    h.answers.push({ access_token: "at", refresh_token: "rt", expires_in: 600 });
    expect(await manager.submit("claude-sub", " the-code ")).toEqual({ status: "signed-in" });
    expect(h.stores.get("claude-sub")?.value).toMatchObject({ accessToken: "at", refreshToken: "rt" });
    // The account is queried at once — waiting a full interval after a successful
    // sign-in reads as "it did not work".
    expect(h.signedIn).toEqual(["claude-sub"]);
  });

  test("Google takes the whole browser address, and only from this attempt", async () => {
    const h = makeHarness();
    const manager = new SignInManager(h.deps);
    const started = (await manager.start("gemini-sub")) as { url: string; flow: string };
    expect(started.flow).toBe("paste-url");
    const state = new URL(started.url).searchParams.get("state") as string;

    const wrong = await manager.submit("gemini-sub", "http://localhost:51121/oauth-callback?code=c&state=other");
    expect(wrong).toMatchObject({ status: "failed" });

    h.answers.push({ access_token: "at", refresh_token: "rt", expires_in: 600 });
    const right = await manager.submit("gemini-sub", `http://localhost:51121/oauth-callback?code=c&state=${state}`);
    expect(right).toEqual({ status: "signed-in" });
  });

  test("the token exchange marks a 400 as a rejected grant, nothing else does", async () => {
    const h = makeHarness();
    const manager = new SignInManager(h.deps);
    await manager.start("claude-sub");
    h.answers.push({ access_token: "at", refresh_token: "rt", expires_in: 600 });
    await manager.submit("claude-sub", "code");
    expect(h.posts.at(-1)?.options).toMatchObject({ authOn400: true });
  });

  test("a rejected code leaves the attempt open, so the user can paste again", async () => {
    const h = makeHarness();
    const manager = new SignInManager(h.deps);
    const started = (await manager.start("claude-sub")) as { url: string };
    h.answers.push(() => {
      throw new Error("invalid_grant");
    });
    expect(await manager.submit("claude-sub", "wrong")).toMatchObject({ status: "failed" });
    // The link is still the same one — restarting would invalidate the code the
    // user is about to paste.
    expect(await manager.state("claude-sub")).toMatchObject({ status: "awaiting-paste", url: started.url });
  });

  test("submitting without a started sign-in is refused", async () => {
    const manager = new SignInManager(makeHarness().deps);
    expect(await manager.submit("claude-sub", "code")).toMatchObject({ status: "failed" });
  });

  test("nothing pasted is its own answer, not a provider error", async () => {
    const manager = new SignInManager(makeHarness().deps);
    await manager.start("claude-sub");
    expect(await manager.submit("claude-sub", "   ")).toMatchObject({ status: "failed", reason: "Nothing pasted" });
  });

  test("a paste after the window closed says so instead of failing later", async () => {
    const h = makeHarness();
    const manager = new SignInManager(h.deps);
    await manager.start("claude-sub");
    h.clock.now += 16 * 60_000;
    const state = await manager.submit("claude-sub", "code");
    expect(state).toMatchObject({ status: "failed" });
    expect((state as { reason: string }).reason).toContain("expired");
    // The stale attempt is gone, so the next status is the sign-in screen again.
    expect(await manager.state("claude-sub")).toEqual({ status: "signed-out" });
  });
});

describe("the device-code flow", () => {
  test("the code is shown, the confirmation is awaited, the tokens are stored", async () => {
    const h = makeHarness();
    const manager = new SignInManager(h.deps);
    h.answers.push({ device_auth_id: "d-1", user_code: "ABCD-1234", interval: "5" });
    const started = await manager.start("chatgpt-sub");
    expect(started).toMatchObject({ status: "awaiting-device", userCode: "ABCD-1234" });
    expect(h.intervals()).toBe(1);

    // Not confirmed yet: the endpoint answers with nothing usable.
    h.answers.push({});
    await h.tick();
    expect(await h.deps.store("chatgpt-sub").load()).toBeNull();

    h.answers.push({ authorization_code: "c", code_verifier: "v" });
    h.answers.push({ access_token: "at", refresh_token: "rt" });
    await h.tick();
    expect(h.stores.get("chatgpt-sub")?.value).toMatchObject({ accessToken: "at" });
    expect(h.signedIn).toEqual(["chatgpt-sub"]);
    // The poller is gone the moment it succeeded.
    expect(h.intervals()).toBe(0);
  });

  test("two ticks never overlap — the server advises 5 s and a request may take 15", async () => {
    const h = makeHarness();
    const manager = new SignInManager(h.deps);
    h.answers.push({ device_auth_id: "d-1", user_code: "C", interval: "5" });
    await manager.start("chatgpt-sub");
    const before = h.posts.length;

    let release = (): void => undefined;
    const blocked = new Promise<unknown>(resolve => {
      release = () => resolve({});
    });
    h.deps.postJson = () => blocked;
    await h.tick();
    await h.tick();
    await h.tick();
    release();
    await new Promise(resolve => setImmediate(resolve));
    // Three ticks, ONE request in flight.
    expect(h.posts.length).toBe(before);
  });

  test("an expired code stops the poller and says what to do", async () => {
    const h = makeHarness();
    const manager = new SignInManager(h.deps);
    h.answers.push({ device_auth_id: "d-1", user_code: "C", interval: "5" });
    await manager.start("chatgpt-sub");
    h.clock.now += 16 * 60_000;
    await h.tick();
    expect(h.intervals()).toBe(0);
    const state = await manager.state("chatgpt-sub");
    expect(state).toMatchObject({ status: "failed" });
    expect((state as { reason: string }).reason).toContain("expired");
  });

  test("stopAll cancels a running poller — for unload", async () => {
    const h = makeHarness();
    const manager = new SignInManager(h.deps);
    h.answers.push({ device_auth_id: "d-1", user_code: "C", interval: "5" });
    await manager.start("chatgpt-sub");
    manager.stopAll();
    expect(h.intervals()).toBe(0);
  });
});

describe("what the settings page is told", () => {
  test("stored tokens mean signed in, and beat a remembered failure", async () => {
    const h = makeHarness();
    const manager = new SignInManager(h.deps);
    h.answers.push(() => {
      throw new Error("boom");
    });
    // A start that could not even fetch a device code is remembered and shown…
    expect(await manager.start("chatgpt-sub")).toMatchObject({ status: "failed" });
    expect(await manager.state("chatgpt-sub")).toMatchObject({ status: "failed" });

    await h.deps.store("chatgpt-sub").save({ accessToken: "a", refreshToken: "r", expiresAt: 0 });
    // Working tokens win — showing the sign-in screen to a signed-in user was the
    // bug krobi found on 2026-09-01.
    expect(await manager.state("chatgpt-sub")).toEqual({ status: "signed-in" });
    // …and the stale failure is dropped, so it cannot resurface later.
    expect(await manager.state("chatgpt-sub")).toEqual({ status: "signed-in" });
  });

  test("a REJECTED sign-in is not 'signed in', even with the file still there", async () => {
    const h = makeHarness();
    const manager = new SignInManager(h.deps);
    await h.deps.store("claude-sub").save({ accessToken: "a", refreshToken: "r", expiresAt: 0 });
    expect(await manager.state("claude-sub")).toEqual({ status: "signed-in" });

    manager.setRejected("claude-sub", true);
    const state = await manager.state("claude-sub");
    expect(state).toMatchObject({ status: "failed" });
    expect((state as { reason: string }).reason).toContain("sign in again");
    // The file stays: a provider hiccup must not sign the user out behind their back.
    expect(h.stores.get("claude-sub")?.value).not.toBeNull();

    manager.setRejected("claude-sub", false);
    expect(await manager.state("claude-sub")).toEqual({ status: "signed-in" });
  });

  test("starting, finishing or signing out clears a rejection", async () => {
    const h = makeHarness();
    const manager = new SignInManager(h.deps);
    await h.deps.store("claude-sub").save({ accessToken: "a", refreshToken: "r", expiresAt: 0 });

    manager.setRejected("claude-sub", true);
    await manager.start("claude-sub");
    h.answers.push({ access_token: "at", refresh_token: "rt", expires_in: 60 });
    await manager.submit("claude-sub", "code");
    expect(await manager.state("claude-sub")).toEqual({ status: "signed-in" });

    manager.setRejected("claude-sub", true);
    await manager.signOut("claude-sub");
    expect(await manager.state("claude-sub")).toEqual({ status: "signed-out" });
  });

  test("signing out forgets the tokens", async () => {
    const h = makeHarness();
    const manager = new SignInManager(h.deps);
    await h.deps.store("claude-sub").save({ accessToken: "a", refreshToken: "r", expiresAt: 0 });
    expect(await manager.signOut("claude-sub")).toEqual({ status: "signed-out" });
    expect(h.stores.get("claude-sub")?.value).toBeNull();
  });

  test("a running paste attempt is reported back, so a reopened page keeps its link", async () => {
    const h = makeHarness();
    const manager = new SignInManager(h.deps);
    const started = (await manager.start("claude-sub")) as { url: string };
    expect(await manager.state("claude-sub")).toMatchObject({ status: "awaiting-paste", url: started.url });
  });
});
