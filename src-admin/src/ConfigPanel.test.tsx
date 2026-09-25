import { CircularProgress } from "@mui/material";

import ConfigPanel from "./ConfigPanel";

/**
 * The card against the REAL `ConfigGeneric` of `@iobroker/json-config`, under jsdom.
 * It is instantiated, not mounted: each test drives the one method whose decision it
 * pins, and `setState` applies the update at once so the result can be read back.
 */
interface Internals {
  state: Record<string, unknown>;
  props: Record<string, unknown>;
  unmounted: boolean;
  setState: (update: unknown, done?: () => void) => void;
  componentDidUpdate(previous: Record<string, unknown>): void;
  refreshSignIn(): Promise<void>;
  syncSubscriptions(): Promise<void>;
  scheduleSignInPoll(): void;
  ask(command: string, provider: string, value?: string): Promise<unknown>;
  run(command: string, provider: string, value?: string): Promise<void>;
  copy(key: string, text: string): Promise<void>;
  renderReason(provider: string, credentialId: string): unknown;
  renderCredentials(): { type: unknown };
}

const CLAUDE_ROW = { name: "Claude", provider: "claude-sub", credentialId: "", warnThreshold: 80 };

function makePanel(props: Record<string, unknown> = {}): { panel: Internals; updates: unknown[] } {
  const instance = new ConfigPanel({
    schema: {},
    attr: "accounts",
    data: { accounts: [CLAUDE_ROW] },
    alive: true,
    changed: false,
    oContext: { socket: {}, adapterName: "ai-usage", instance: 0 },
    ...props,
  } as never);
  const panel = instance as unknown as Internals;
  const updates: unknown[] = [];
  panel.setState = (update, done) => {
    updates.push(update);
    const next =
      typeof update === "function"
        ? (update as (s: unknown, p: unknown) => Record<string, unknown>)(panel.state, panel.props)
        : (update as Record<string, unknown>);
    panel.state = { ...panel.state, ...next };
    done?.();
  };
  return { panel, updates };
}

describe("the settings card", () => {
  test("coming alive asks the sign-in status at once, not on the next beat", () => {
    const { panel } = makePanel();
    const refresh = vi.fn(() => Promise.resolve());
    panel.refreshSignIn = refresh;
    panel.syncSubscriptions = vi.fn(() => Promise.resolve());
    panel.scheduleSignInPoll = vi.fn();
    panel.componentDidUpdate({ ...panel.props, alive: false });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("a row without a reason shows no reason line", () => {
    const { panel } = makePanel();
    panel.state = { ...panel.state, serviceState: {} };
    expect(panel.renderReason("openrouter", "system.credentials.or")).toBeNull();
  });

  test("a status answer that arrives after the card is gone changes nothing", async () => {
    const { panel, updates } = makePanel();
    panel.ask = vi.fn(() => Promise.resolve({ status: "signed-in" }));
    panel.unmounted = true;
    await panel.refreshSignIn();
    expect(panel.ask).toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test("an action answered after the card is gone writes nothing more than its start", async () => {
    const { panel, updates } = makePanel();
    panel.ask = vi.fn(() => {
      panel.unmounted = true;
      return Promise.resolve({ status: "signed-out" });
    });
    panel.scheduleSignInPoll = vi.fn();
    await panel.run("signOut", "claude-sub");
    expect(updates).toEqual([{ busy: "claude-sub" }]);
  });

  test("on plain http:// the copy takes the fallback, never the clipboard API", async () => {
    const { panel } = makePanel();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    await panel.copy("code", "ABCD-1234");
    expect(writeText).not.toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect((panel.state.copied as Record<string, string>).code).toBe("ok");
  });

  test("while the key storage is still being read, a spinner stands in its place", () => {
    const { panel } = makePanel();
    panel.state = { ...panel.state, credentialsLoaded: false, credentialsFailed: false, credentials: [] };
    expect(panel.renderCredentials().type).toBe(CircularProgress);
  });
});
