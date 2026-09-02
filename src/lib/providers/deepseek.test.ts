import { FetchError } from "../provider";
import { deepSeekProvider, parseDeepSeekBalance } from "./deepseek";

describe("parseDeepSeekBalance", () => {
  test("maps the capture-verified balance shape (string amounts)", () => {
    // Real /user/balance response shape from the API docs.
    const snapshot = parseDeepSeekBalance({
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
      ],
    });
    expect(snapshot.available).toBe(true);
    expect(snapshot.credits).toEqual({ remaining: 110, granted: 10, toppedUp: 100, currency: "CNY" });
  });

  test("uses the first currency entry when several are present", () => {
    const snapshot = parseDeepSeekBalance({
      is_available: true,
      balance_infos: [
        { currency: "USD", total_balance: "5.00" },
        { currency: "CNY", total_balance: "9.00" },
      ],
    });
    expect(snapshot.credits?.currency).toBe("USD");
    expect(snapshot.credits?.remaining).toBe(5);
  });

  test("a malformed body is a network error", () => {
    expect(() => parseDeepSeekBalance({})).toThrow(FetchError);
    expect(() => parseDeepSeekBalance(null)).toThrow(FetchError);
  });
});

describe("deepSeekProvider", () => {
  test("calls the balance URL with the bearer key", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const provider = deepSeekProvider("sk-ds", (url, headers) => {
      calls.push({ url, headers });
      return Promise.resolve({ is_available: true, balance_infos: [] });
    });
    await provider.fetch();
    expect(calls[0].url).toBe("https://api.deepseek.com/user/balance");
    expect(calls[0].headers.Authorization).toBe("Bearer sk-ds");
  });
});
