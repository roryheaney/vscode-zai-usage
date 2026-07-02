import * as vscode from "vscode";

/**
 * Represents a single usage limit entry returned by the z.ai quota API.
 */
interface ZaiLimit {
  /** The type identifier of the limit (e.g. `"TOKENS_LIMIT"`, `"TIME_LIMIT"`). */
  type: string;
  /**
   * The unit code of the limit window. Observed values from the z.ai contract:
   * - `3` — hours (the rolling 5-hour token window)
   * - `6` — weeks (the rolling weekly token window)
   * Used to disambiguate the two `TOKENS_LIMIT` entries the API returns.
   */
  unit?: number;
  /** Quantity of the window (e.g. `5` for a 5-hour window, `1` for a 1-week window). */
  number?: number;
  /** The current usage as a whole-number percentage (e.g. `8` means 8 %). */
  percentage?: number;
  /** Unix timestamp (ms) at which this limit will reset. */
  nextResetTime?: number;
}

/**
 * The top-level response shape returned by the z.ai quota/limit API endpoint.
 */
interface ZaiApiResponse {
  /** Whether the API call succeeded. `false` indicates an application-level error. */
  success?: boolean;
  /** Application-level error code, present when `success` is `false`. */
  code?: number;
  /** Human-readable error message, present when `success` is `false`. */
  msg?: string;
  /** The payload containing the list of quota limits. */
  data: {
    /** Array of per-type quota limit entries. */
    limits: ZaiLimit[];
  };
}

/**
 * The structure persisted to `globalState` for caching API responses.
 */
interface CacheData {
  /** Schema version used to invalidate stale cache entries across extension updates. */
  version: string;
  /** Unix timestamp (ms) at which the cache entry was written. */
  timestamp: number;
  /** The raw API response that was cached. */
  data: ZaiApiResponse;
}

/**
 * A single token-quota window derived from a {@link ZaiApiResponse} limit entry.
 */
interface QuotaWindow {
  /** Whole-number token usage percentage, as returned by the API (e.g. `8`). */
  percentage: number;
  /** Unix timestamp (ms) of the next reset for this window, or `null` if unknown. */
  nextResetTime: number | null;
}

/**
 * Simplified token-usage statistics derived from a {@link ZaiApiResponse}.
 *
 * z.ai returns two `TOKENS_LIMIT` entries — the rolling 5-hour window (`unit: 3`) and the
 * rolling weekly window (`unit: 6`). Either may be `null` when absent from the response.
 */
interface UsageData {
  /** The rolling 5-hour token window (`TOKENS_LIMIT`, `unit: 3`), or `null` if absent. */
  hourly: QuotaWindow | null;
  /** The rolling weekly token window (`TOKENS_LIMIT`, `unit: 6`), or `null` if absent. */
  weekly: QuotaWindow | null;
}

/**
 * Describes the user's current position relative to the daily z.ai peak window.
 */
interface PeakInfo {
  /** `true` when the current instant falls inside the daily peak window. */
  isInPeak: boolean;
  /** UTC ms timestamp of the next boundary: peak start when off-peak, peak end when on-peak. */
  nextBoundary: number;
}

/** Schema version embedded in every cache entry; increment to bust old caches. */
const CACHE_VERSION = "2.0";
/** Key used to store the cache object in `vscode.ExtensionContext.globalState`. */
const CACHE_KEY = "zaiUsage.cache";
/** Key used to store the API key in `vscode.ExtensionContext.secrets`. */
const API_KEY_SECRET = "zaiUsage.apiKey";
/** The z.ai quota/limit API endpoint. */
const API_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

/**
 * z.ai peak hours are 14:00–18:00 daily in UTC+8 (China Standard Time, which does not
 * observe DST). This is therefore a fixed daily window of 06:00–10:00 UTC. Working in UTC
 * keeps the in/out-of-peak decision unambiguous; only the displayed time is localized.
 */
const PEAK_START_UTC_HOUR = 6;
const PEAK_END_UTC_HOUR = 10;
/** Milliseconds in one day, used to advance a UTC boundary to the following day. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `unit` codes used by the z.ai quota API to distinguish the two `TOKENS_LIMIT` windows.
 * Observed from the documented contract: `3` = the rolling 5-hour window, `6` = weekly.
 */
const UNIT_HOURS = 3;
const UNIT_WEEKS = 6;

/** Peak-status tiers, used to drive both the status bar color and the tooltip dot. */
type PeakTier = "peak" | "imminent" | "approaching" | "off";

/** Status bar highlight colors per peak tier. Pink/orange/red are hardcoded hex because VS
 * Code has no theme tokens for them; each is paired with a foreground that keeps contrast. */
const PEAK_COLORS: Record<PeakTier, { bg?: string; fg?: string }> = {
  peak: { bg: "#C72B2B", fg: "#FFFFFF" }, // red — inside the 3x window
  imminent: { bg: "#FF4D8D", fg: "#1A1A1A" }, // pink — within 30 min of peak
  approaching: { bg: "#C2410C", fg: "#FFFFFF" }, // orange — within 1 h of peak
  off: {}, // default theme colors
};

/** Colored circle emoji shown in the hover tooltip to mirror the status bar tier. */
const PEAK_EMOJI: Record<PeakTier, string> = {
  peak: "🔴",
  imminent: "🩷",
  approaching: "🟠",
  off: "🟢",
};

/**
 * Computes the user's current position relative to the daily z.ai peak window.
 *
 * Peak is a fixed 06:00–10:00 UTC window. The {@link PeakInfo.nextBoundary} is the next
 * transition: the upcoming peak start when currently off-peak, or the upcoming peak end
 * when currently in peak. All comparisons use absolute UTC instants, so the result is
 * independent of the host machine's local timezone.
 *
 * @param now - The reference instant (defaults to the current time).
 * @returns A {@link PeakInfo} describing the peak state and next boundary.
 */
function getPeakInfo(now: Date = new Date()): PeakInfo {
  const nowMs = now.getTime();
  const startOfTodayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const peakStartToday = startOfTodayUtc + PEAK_START_UTC_HOUR * 60 * 60 * 1000;
  const peakEndToday = startOfTodayUtc + PEAK_END_UTC_HOUR * 60 * 60 * 1000;

  let nextBoundary: number;
  if (nowMs < peakStartToday) {
    // Before today's peak: next boundary is peak start today.
    nextBoundary = peakStartToday;
  } else if (nowMs < peakEndToday) {
    // Inside today's peak: next boundary is peak end today.
    nextBoundary = peakEndToday;
  } else {
    // After today's peak: next boundary is peak start tomorrow.
    nextBoundary = peakStartToday + ONE_DAY_MS;
  }

  return {
    isInPeak: nowMs >= peakStartToday && nowMs < peakEndToday,
    nextBoundary,
  };
}

/**
 * Maps the current {@link PeakInfo} to a coarse {@link PeakTier} used for coloring.
 *
 * - `peak` — currently inside the 06:00–10:00 UTC window.
 * - `imminent` — off-peak but within 30 minutes of the next peak start.
 * - `approaching` — off-peak but within 1 hour of the next peak start.
 * - `off` — otherwise.
 *
 * @param peakInfo - The current {@link PeakInfo}.
 * @returns The {@link PeakTier} describing the current urgency.
 */
function getPeakTier(peakInfo: PeakInfo): PeakTier {
  if (peakInfo.isInPeak) {
    return "peak";
  }
  const msUntilPeak = peakInfo.nextBoundary - Date.now();
  if (msUntilPeak <= 30 * 60 * 1000) {
    return "imminent";
  }
  if (msUntilPeak <= 60 * 60 * 1000) {
    return "approaching";
  }
  return "off";
}

/**
 * Activates the extension.
 * @param context - The extension context provided by VSCode.
 */
export function activate(context: vscode.ExtensionContext): void {
  const priority = vscode.workspace
    .getConfiguration("zaiUsage")
    .get<number>("statusBarPriority", 10000);

  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    priority,
  );
  statusBarItem.text = getLabel("...");
  statusBarItem.show();

  let intervalId: ReturnType<typeof setInterval> | undefined;

  /**
   * Returns the polling interval in milliseconds from the workspace configuration.
   * The value is clamped to a minimum of 10 seconds to prevent API flooding.
   *
   * @returns The refresh interval in milliseconds (minimum 10,000 ms).
   */
  function getRefreshInterval(): number {
    const seconds = vscode.workspace
      .getConfiguration("zaiUsage")
      .get<number>("refreshInterval", 60);
    // Clamp to a minimum of 10 seconds to prevent API flooding from invalid config values.
    return Math.max(seconds, 10) * 1000;
  }

  /**
   * Builds the status bar label by prepending the configured prefix to a given suffix.
   * Uses a custom icon when the `useIcon` setting is enabled, otherwise falls back to "z.ai:".
   *
   * @param suffix - The text to append after the prefix (e.g. "75.3% (2h30m)").
   * @returns The fully composed status bar label string.
   */
  function getLabel(suffix: string): string {
    const useIcon = vscode.workspace
      .getConfiguration("zaiUsage")
      .get<boolean>("useIcon", true);
    const prefix = useIcon ? "$(zai-icon)" : "z.ai:";
    return `${prefix} ${suffix}`;
  }

  /**
   * Retrieves the cached API response from the extension's global state.
   * Returns `null` when no cache exists or when the stored cache version does not
   * match the current {@link CACHE_VERSION}.
   *
   * @returns The cached {@link CacheData} object, or `null` if absent or stale.
   */
  function getCache(): CacheData | null {
    const cache = context.globalState.get<CacheData>(CACHE_KEY);
    if (!cache || cache.version !== CACHE_VERSION) {
      return null;
    }
    return cache;
  }

  /**
   * Persists the given API response to the extension's global state as a versioned cache entry.
   * The entry records the current timestamp so that {@link isCacheValid} can later evaluate
   * whether the data is still fresh.
   *
   * @param data - The raw {@link ZaiApiResponse} to store in the cache.
   * @returns `void`
   */
  function setCache(data: ZaiApiResponse): void {
    context.globalState.update(CACHE_KEY, {
      version: CACHE_VERSION,
      timestamp: Date.now(),
      data,
    } satisfies CacheData);
  }

  /**
   * Extracts token-usage statistics from a raw API response.
   * Looks for the `TOKENS_LIMIT` entry inside `data.limits` and maps it to a
   * simplified {@link UsageData} object.
   *
   * @param data - The raw {@link ZaiApiResponse} returned by the z.ai quota API.
   * @returns A {@link UsageData} object containing the usage percentage and next reset
   *   timestamp, or `null` when the expected data structure is absent.
   */
  function extractUsageData(data: ZaiApiResponse): UsageData | null {
    const limits = data.data?.limits;
    if (!Array.isArray(limits)) {
      return null;
    }

    const tokenLimits = limits.filter((l) => l.type === "TOKENS_LIMIT");
    if (tokenLimits.length === 0) {
      return null;
    }

    // z.ai returns two TOKENS_LIMIT entries; disambiguate by `unit` (3 = 5h, 6 = weekly).
    const toWindow = (l: ZaiLimit): QuotaWindow | null => {
      if (l.percentage == null) {
        return null;
      }
      return {
        percentage: l.percentage,
        nextResetTime: l.nextResetTime ?? null,
      };
    };

    const hourly = toWindow(
      tokenLimits.find((l) => l.unit === UNIT_HOURS) ?? tokenLimits[0],
    );
    // Fall back to the second TOKENS_LIMIT entry for weekly when no explicit unit match exists.
    const weeklyCandidate =
      tokenLimits.find((l) => l.unit === UNIT_WEEKS) ?? tokenLimits[1];
    const weekly = weeklyCandidate ? toWindow(weeklyCandidate) : null;

    if (!hourly && !weekly) {
      return null;
    }

    return { hourly, weekly };
  }

  /**
   * Determines whether a cached API response is still valid and can be used
   * without issuing a new network request.
   *
   * A cache is considered invalid when any of the following conditions are met:
   * - The cache object is `null`.
   * - The elapsed time since caching exceeds the configured refresh interval.
   * - The `nextResetTime` stored in the cache is in the past, meaning a usage
   *   reset has already occurred and fresh data is required.
   *
   * @param cache - The {@link CacheData} to validate, or `null`.
   * @returns `true` if the cache is fresh and can be used; `false` otherwise.
   */
  function isCacheValid(cache: CacheData | null): boolean {
    if (!cache) {
      return false;
    }
    if (Date.now() - cache.timestamp >= getRefreshInterval()) {
      return false;
    }
    // If any stored reset time is in the past, invalidate and fetch fresh data.
    const usage = extractUsageData(cache.data);
    const resetTimes = [
      usage?.hourly?.nextResetTime,
      usage?.weekly?.nextResetTime,
    ];
    if (resetTimes.some((t) => t && t <= Date.now())) {
      return false;
    }
    return true;
  }

  /**
   * Formats the time remaining until the next usage quota reset into a short
   * human-readable string. Parts are space-separated for readability.
   *
   * - **≤ 24 h**: hours and minutes only, e.g. `"(2h 30m)"`, `"(45m)"`.
   * - **> 24 h**: days, hours, and minutes, e.g. `"(6d 3h 45m)"`, `"(6d 45m)"`.
   *
   * The day unit is shown once the remaining time strictly exceeds 24 h, so the
   * exact 24-hour boundary renders as `"(24h 0m)"`.
   *
   * Returns an empty string when `nextResetTime` is falsy, non-positive, or
   * already in the past.
   *
   * @param nextResetTime - The Unix timestamp (in milliseconds) of the next reset,
   *   or `null` if unknown.
   * @returns A formatted countdown string like `"(1h 5m)"` or `"(6d 1h 5m)"`, or `""`.
   */
  function formatResetTime(nextResetTime: number | null): string {
    if (!nextResetTime || nextResetTime <= 0) {
      return "";
    }
    const diffMs = nextResetTime - Date.now();
    if (diffMs <= 0) {
      return "";
    }
    const diffSec = Math.floor(diffMs / 1000);
    const diffDays = Math.floor(diffSec / 86400);
    const diffHours = Math.floor((diffSec % 86400) / 3600);
    const diffMins = Math.floor((diffSec % 3600) / 60);
    const parts: string[] = [];
    if (diffDays > 0) {
      parts.push(`${diffDays}d`);
    }
    if (diffHours > 0) {
      parts.push(`${diffHours}h`);
    }
    parts.push(`${diffMins}m`);
    return `(${parts.join(" ")})`;
  }

  /**
   * Builds an inline segment for a single quota window, e.g. `"8% 5h"` or `"92% wk"`
   * (remaining mode), applying the configured display mode.
   *
   * @param window - The {@link QuotaWindow} to render.
   * @param label - Short window tag appended after the percentage (e.g. `"5h"`, `"wk"`).
   * @param isRemaining - When `true`, show remaining (100 − percentage) instead of usage.
   * @returns The formatted segment string.
   */
  function formatWindowInline(
    window: QuotaWindow,
    label: string,
    isRemaining: boolean,
  ): string {
    const value = isRemaining ? 100 - window.percentage : window.percentage;
    return `${value}% ${label}`;
  }

  /**
   * Builds a tooltip line for a quota window with its reset countdown, e.g.
   * `"5h window: 8% — resets in 2h30m"`.
   *
   * @param name - Human-readable window name (e.g. `"5-hour"`, `"Weekly"`).
   * @param window - The {@link QuotaWindow} to describe.
   * @param isRemaining - When `true`, describe remaining rather than usage.
   * @returns The tooltip line, or `""` when the window is absent.
   */
  function windowTooltipLine(
    name: string,
    window: QuotaWindow | null,
    isRemaining: boolean,
  ): string {
    if (!window) {
      return "";
    }
    const value = isRemaining ? 100 - window.percentage : window.percentage;
    const noun = isRemaining ? "remaining" : "used";
    const reset = formatResetTime(window.nextResetTime);
    const resetStr = reset ? ` — resets in ${reset.replace(/[()]/g, "")}` : "";
    return `${name} window: ${value}% ${noun}${resetStr}`;
  }

  /**
   * Formats a UTC ms instant into a short local clock time using the configured timezone.
   *
   * Uses `Intl.DateTimeFormat` with the {@link zaiUsage.timezone} IANA identifier (default
   * `America/Los_Angeles`). The bundled ICU tz database handles DST transitions automatically,
   * so no manual UTC-offset math is required.
   *
   * @param utcInstantMs - The UTC ms timestamp to format.
   * @returns A localized time string such as `"11:00 PM"`.
   */
  function formatLocalTime(utcInstantMs: number): string {
    const timezone = vscode.workspace
      .getConfiguration("zaiUsage")
      .get<string>("timezone", "America/Los_Angeles");
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(utcInstantMs));
  }

  /**
   * Builds the peak line shown in the hover tooltip, prefixed with a colored circle emoji
   * that mirrors the current status bar tier (the only reliable way to convey color inside
   * a VS Code hover, which does not support background colors).
   *
   * @param peakInfo - The current {@link PeakInfo}.
   * @returns A tooltip line such as `"🟠 Peak (3x) starts at 11:00 PM"`.
   */
  function peakTooltipLine(peakInfo: PeakInfo): string {
    const tier = getPeakTier(peakInfo);
    const time = formatLocalTime(peakInfo.nextBoundary);
    const dot = PEAK_EMOJI[tier];
    return peakInfo.isInPeak
      ? `${dot} In peak (3x) — off-peak at ${time}`
      : `${dot} Peak (3x) starts at ${time}`;
  }

  /**
   * Clears any peak-related highlight, restoring the status bar to its default theme colors.
   */
  function clearPeakColor(): void {
    statusBarItem.backgroundColor = undefined;
    statusBarItem.color = undefined;
  }

  /**
   * Highlights the status bar by peak tier, drawing attention to the 3x window.
   *
   * - **Red** when inside peak.
   * - **Pink** within 30 minutes of peak start.
   * - **Orange** within 1 hour of peak start.
   * - Default theme colors otherwise.
   *
   * Pink/orange/red use hardcoded hex (VS Code has no theme tokens for them); each pairs
   * with a foreground chosen for legible contrast.
   *
   * @param peakInfo - The current {@link PeakInfo}.
   */
  function applyPeakColor(peakInfo: PeakInfo): void {
    const tier = getPeakTier(peakInfo);
    const colors = PEAK_COLORS[tier];
    if (!colors.bg) {
      clearPeakColor();
      return;
    }
    // @types/vscode types backgroundColor as ThemeColor-only, but the runtime accepts hex
    // strings; pink/orange/red have no matching theme color, so the cast is required.
    statusBarItem.backgroundColor = colors.bg as unknown as vscode.ThemeColor;
    statusBarItem.color = colors.fg;
  }

  /**
   * Calls the z.ai quota API with the provided API key and returns the parsed response.
   *
   * Returns `null` on any of the following failure conditions:
   * - A non-2xx HTTP status code is received.
   * - The HTTP 200 response payload contains `success: false` (the API may return
   *   authentication errors with a 200 status, so the payload must be inspected).
   * - A network or parsing error is thrown.
   *
   * @param apiKey - The Bearer token used to authenticate the API request.
   * @returns A promise that resolves to the {@link ZaiApiResponse}, or `null` on failure.
   */
  async function fetchFromApi(apiKey: string): Promise<ZaiApiResponse | null> {
    try {
      const response = await fetch(API_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!response.ok) {
        console.error(
          "[z.ai Usage] API HTTP error:",
          response.status,
          await response.text(),
        );
        return null;
      }

      const data: ZaiApiResponse = await response.json();

      // The API may return an authentication error within a 200 response — always inspect the payload.
      if (data.success === false) {
        console.error("[z.ai Usage] API error response:", data.code, data.msg);
        return null;
      }

      return data;
    } catch (error) {
      console.error("[z.ai Usage] Error:", error);
      return null;
    }
  }

  /**
   * Orchestrates the full usage-data retrieval flow: secret lookup → cache check →
   * optional API call → stale-cache fallback.
   *
   * Resolution order:
   * 1. If no API key is stored, returns `noApiKey: true` immediately.
   * 2. If a valid cache entry exists, returns the cached data without an API call.
   * 3. Calls the API; on success, writes the response to the cache and returns it.
   * 4. On API failure, falls back to the expired cache if one is available.
   * 5. Returns `usage: null` when all sources are unavailable.
   *
   * @returns A promise resolving to an object with:
   *   - `usage` — The parsed {@link UsageData}, or `null` when unavailable.
   *   - `apiCalled` — `true` when a live API request was made successfully.
   *   - `noApiKey` — `true` when no API key is stored in the secret store.
   */
  async function fetchUsage(): Promise<{
    usage: UsageData | null;
    apiCalled: boolean;
    noApiKey: boolean;
  }> {
    const apiKey = await context.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      return { usage: null, apiCalled: false, noApiKey: true };
    }

    const cache = getCache();

    if (cache && isCacheValid(cache)) {
      return {
        usage: extractUsageData(cache.data),
        apiCalled: false,
        noApiKey: false,
      };
    }

    const apiData = await fetchFromApi(apiKey);

    if (apiData) {
      setCache(apiData);
      return {
        usage: extractUsageData(apiData),
        apiCalled: true,
        noApiKey: false,
      };
    }

    // Fall back to the expired cache when the API call fails.
    if (cache) {
      return {
        usage: extractUsageData(cache.data),
        apiCalled: false,
        noApiKey: false,
      };
    }

    return { usage: null, apiCalled: false, noApiKey: false };
  }

  /**
   * Starts (or restarts) the polling interval that periodically calls
   * {@link updateStatusBar}.
   *
   * If a previous interval is already running it is cleared before a new one
   * is created, ensuring that configuration changes (e.g. `refreshInterval`)
   * take effect immediately without spawning duplicate timers.
   *
   * @returns `void`
   */
  function startInterval(): void {
    if (intervalId !== undefined) {
      clearInterval(intervalId);
    }
    intervalId = setInterval(updateStatusBar, getRefreshInterval());
  }

  /**
   * Configures the status bar item to reflect the "no API key" state.
   *
   * Sets the item's label to "Set API Key" and attaches the `zaiUsage.setApiKey`
   * command so that clicking the item opens the API key input prompt.
   *
   * @returns `void`
   */
  function applyNoApiKeyState(): void {
    statusBarItem.command = "zaiUsage.setApiKey";
    statusBarItem.text = getLabel("Set API Key");
    statusBarItem.tooltip = "Click to set your z.ai API key";
  }

  /**
   * Fetches the latest usage data and updates the status bar item accordingly.
   *
   * Possible outcomes:
   * - **No API key**: delegates to {@link applyNoApiKeyState} to prompt the user.
   * - **Fetch failure**: displays a dash and an error tooltip.
   * - **Success**: renders the 5-hour and weekly quota windows inline (e.g. `8% 5h · 15% wk`),
   *   applies the peak-tier background color, and shows a tooltip with per-window reset
   *   countdowns, a colored peak line, and the configured refresh interval.
   *
   * After a successful live API call ({@link fetchUsage} returns `apiCalled: true`),
   * the polling interval is restarted via {@link startInterval} so that the next
   * refresh is scheduled relative to the moment fresh data was obtained.
   *
   * @returns A promise that resolves once the status bar has been updated.
   */
  async function updateStatusBar(): Promise<void> {
    const { usage, apiCalled, noApiKey } = await fetchUsage();

    if (noApiKey) {
      applyNoApiKeyState();
      clearPeakColor();
    } else if (usage === null) {
      statusBarItem.command = "zaiUsage.updateStatusBar";
      statusBarItem.text = getLabel("-");
      statusBarItem.tooltip =
        "Unable to fetch z.ai usage data (click to refresh)";
      clearPeakColor();
    } else {
      statusBarItem.command = "zaiUsage.updateStatusBar";
      const refreshSec = getRefreshInterval() / 1000;
      const peakInfo = getPeakInfo();

      // Get display mode setting (default: "usage")
      const displayMode = vscode.workspace
        .getConfiguration("zaiUsage")
        .get<string>("displayMode", "usage");
      const isRemaining = displayMode === "remaining";

      // Inline: both quota windows labeled, no peak text (color signals peak urgency).
      const segments: string[] = [];
      if (usage.hourly) {
        segments.push(formatWindowInline(usage.hourly, "5h", isRemaining));
      }
      if (usage.weekly) {
        segments.push(formatWindowInline(usage.weekly, "wk", isRemaining));
      }
      statusBarItem.text = getLabel(segments.join(" · ") || "-");

      // Highlight the status bar by peak tier (red in peak, pink ≤30m, orange ≤1h).
      applyPeakColor(peakInfo);

      // Build tooltip: per-window detail + colored peak line + refresh note.
      const lines = [
        windowTooltipLine("5-hour", usage.hourly, isRemaining),
        windowTooltipLine("Weekly", usage.weekly, isRemaining),
        peakTooltipLine(peakInfo),
        `auto-refreshes every ${refreshSec}s. click to refresh immediately`,
      ].filter(Boolean);
      statusBarItem.tooltip = lines.join("\n");
    }

    if (apiCalled) {
      startInterval();
    }
  }

  /**
   * Handles the `zaiUsage.setApiKey` command.
   *
   * Prompts the user for a Bearer token, verifies it against the z.ai API,
   * and — on success — persists it to the secret store and refreshes the status bar.
   * On verification failure the stored key and cache are both cleared.
   */
  const setApiKeyCmd = vscode.commands.registerCommand(
    "zaiUsage.setApiKey",
    async () => {
      const apiKey = await vscode.window.showInputBox({
        prompt: "Enter your z.ai API key",
        placeHolder: "Bearer token...",
        password: true,
        ignoreFocusOut: true,
      });

      if (!apiKey) {
        return;
      }

      statusBarItem.text = getLabel("$(loading~spin) Verifying...");
      const result = await fetchFromApi(apiKey);

      if (result === null) {
        await context.secrets.delete(API_KEY_SECRET);
        await context.globalState.update(CACHE_KEY, undefined);
        vscode.window.showErrorMessage(
          "z.ai Usage: Failed to verify API key. Please check the key and try again.",
        );
        await updateStatusBar();
        return;
      }

      await context.secrets.store(API_KEY_SECRET, apiKey);
      setCache(result);
      vscode.window.showInformationMessage(
        "z.ai Usage: API key saved successfully.",
      );
      await updateStatusBar();
      startInterval();
    },
  );

  /**
   * Handles the `zaiUsage.clearApiKey` command.
   *
   * Removes the stored API key from the secret store, clears the usage cache,
   * and transitions the status bar to the "no API key" state.
   */
  const clearApiKeyCmd = vscode.commands.registerCommand(
    "zaiUsage.clearApiKey",
    async () => {
      await context.secrets.delete(API_KEY_SECRET);
      await context.globalState.update(CACHE_KEY, undefined);
      applyNoApiKeyState();
      vscode.window.showInformationMessage("z.ai Usage: API key cleared.");
    },
  );

  /**
   * Handles the `zaiUsage.updateStatusBar` command.
   *
   * Manually refreshes the status bar by calling {@link updateStatusBar}.
   * This command can be bound to the status bar item or triggered via command palette.
   *
   * Shows a loading indicator for at least 400ms to prevent flickering.
   */
  const updateStatusBarCmd = vscode.commands.registerCommand(
    "zaiUsage.updateStatusBar",
    async () => {
      statusBarItem.text = "$(loading~spin) Refreshing...";
      // Wait at least 400ms to prevent flickering
      await new Promise((resolve) => setTimeout(resolve, 400));
      await updateStatusBar();
    },
  );

  updateStatusBar();
  startInterval();

  context.subscriptions.push(
    statusBarItem,
    setApiKeyCmd,
    clearApiKeyCmd,
    updateStatusBarCmd,
    /**
     * Listens for workspace configuration changes and re-applies them immediately.
     *
     * When `zaiUsage.refreshInterval`, `zaiUsage.useIcon`, `zaiUsage.displayMode`, or
     * `zaiUsage.timezone` changes, the status bar is refreshed and the polling interval is
     * restarted so the new settings take effect without requiring a window reload.
     *
     * When `zaiUsage.statusBarPriority` changes, the user is notified that a window
     * reload is required for the new priority to take effect, because the priority is
     * set at status bar item creation time and cannot be changed at runtime.
     */
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("zaiUsage.refreshInterval") ||
        e.affectsConfiguration("zaiUsage.useIcon") ||
        e.affectsConfiguration("zaiUsage.displayMode") ||
        e.affectsConfiguration("zaiUsage.timezone")
      ) {
        updateStatusBar();
        startInterval();
      }
      if (e.affectsConfiguration("zaiUsage.statusBarPriority")) {
        void (async () => {
          const selection = await vscode.window.showInformationMessage(
            "z.ai Usage: Status bar priority changed. Reload the window to apply.",
            "Reload Window",
          );
          if (selection === "Reload Window") {
            await vscode.commands.executeCommand(
              "workbench.action.reloadWindow",
            );
          }
        })();
      }
    }),
    {
      dispose: () => {
        if (intervalId !== undefined) clearInterval(intervalId);
      },
    },
  );
}

/**
 * Deactivates the extension.
 * Called when VSCode is shutting down or the extension is disabled.
 */
export function deactivate(): void {}
