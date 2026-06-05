import {
  callable,
  definePlugin,
  DialogButton,
  Field,
  IconsModule,
  Navigation,
  routerHook,
  toaster,
} from '@steambrew/client';

// Fires a native Steam toast. Logs NotificationStore readiness + outcome to the
// Lua log so we can diagnose why a toast may not render.
function sendTestToast(): void {
  const hasStore =
    typeof (window as { NotificationStore?: unknown }).NotificationStore !==
    'undefined';
  navLog('sendTestToast: NotificationStore present=' + hasStore);
  try {
    toaster.toast({
      title: 'Game News',
      body: 'Notification de test — ça marche ! 🎮',
      duration: 10000,
      critical: true,
      showToast: true,
      playSound: true,
      showNewIndicator: true,
      onClick: () => navLog('test toast clicked'),
    });
    navLog('sendTestToast: toaster.toast returned OK');
  } catch (error) {
    navLog('sendTestToast: toaster.toast threw ' + String(error));
  }
}

// Fetches the real latest news for a game and toasts it — simulates exactly
// what the 5-min poll does when a fresh news drops. Used for on-demand testing.
const SIMULATE_APP_ID = '3768760'; // 007 First Light
const SIMULATE_GAME_NAME = '007 First Light';

// Pulls 007's item straight from the feed (real gameLogoUrl + news), so the
// simulated toast is identical to what the poll produces.
function simulateNewsToast(): void {
  navLog('simulateNewsToast: fetching feed to find ' + SIMULATE_APP_ID);
  void getSteamId().then((payload) => {
    if (!payload.steamId) {
      navLog('simulateNewsToast: no steamId');
      return;
    }
    void fetchBackend({
      path: `/news/feed-by-steamid/${payload.steamId}?limit=200`,
    })
      .then((result) => {
        if (!result.ok || result.status !== 200 || !result.body) {
          navLog('simulateNewsToast: fetch failed ' + (result.error ?? result.status));
          return;
        }
        const data = JSON.parse(result.body) as { items?: FeedItem[] };
        const item = (data.items ?? []).find(
          (it) => String(it.appId) === SIMULATE_APP_ID,
        );
        if (!item) {
          navLog('simulateNewsToast: 007 not found in feed');
          return;
        }
        const url =
          item.news.url ||
          `https://store.steampowered.com/news/app/${SIMULATE_APP_ID}`;
        toaster.toast({
          title: 'News',
          body: item.gameName || SIMULATE_GAME_NAME,
          subtext: item.news.title,
          logo: gameLogoNode(item.gameLogoUrl),
          // null (not undefined) bypasses the toaster's default `new Date()`
          // and the Toast component skips a falsy timestamp → no time shown.
          timestamp: null as unknown as Date,
          duration: 10000,
          showToast: true,
          playSound: true,
          onClick: () => openNewsUrl(url),
        });
        navLog('simulateNewsToast: toasted "' + item.news.title + '"');
      })
      .catch((err: unknown) => navLog('simulateNewsToast: ' + String(err)));
  });
}

// Toasts a follow-prompt for the first unfollowed wishlist game — tests the
// "nouveau jeu détecté → clic pour suivre" flow end to end (click → /web/follow).
function simulateFollowPrompt(): void {
  navLog('simulateFollowPrompt: fetching profile');
  void getSteamId().then((payload) => {
    if (!payload.steamId) {
      return;
    }
    const steamId = payload.steamId;
    void fetchBackend({ path: `/web/profile/${steamId}` })
      .then((res) => {
        if (!res.ok || res.status !== 200 || !res.body) {
          navLog('simulateFollowPrompt: profile fetch failed');
          return;
        }
        const profile = JSON.parse(res.body) as {
          followedGames: Array<{ appId: string }>;
          wishlist: Array<{ appId: string; name: string; header_image: string }>;
        };
        const followed = new Set(
          profile.followedGames.map((g) => String(g.appId)),
        );
        const target = profile.wishlist.find(
          (g) => !followed.has(String(g.appId)),
        );
        if (!target) {
          navLog('simulateFollowPrompt: no unfollowed wishlist game');
          return;
        }
        showFollowPromptToast(
          steamId,
          String(target.appId),
          target.name,
          target.header_image,
        );
        navLog('simulateFollowPrompt: toasted ' + target.name);
      })
      .catch((err: unknown) => navLog('simulateFollowPrompt: ' + String(err)));
  });
}

// Steam injects React as window.SP_REACT; the tsconfig jsxFactory points to it.
declare global {
  interface Window {
    SP_REACT: typeof import('react');
  }
}
const { useState, useEffect } = window.SP_REACT;

// Builds the toast logo node from the feed's gameLogoUrl (SteamGridDB icon —
// the same asset the app uses). Returns undefined when there's no usable URL
// so the toast simply renders without a broken image. createElement avoids
// JSX intrinsic-element typing here.
function gameLogoNode(logoUrl?: string | null) {
  if (!logoUrl) {
    return undefined;
  }
  return window.SP_REACT.createElement('img', {
    src: logoUrl,
    style: {
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      borderRadius: '3px',
    },
  });
}

// ── Backend bridge ─────────────────────────────────────────────────────────
// Frontend fetch() is blocked by the Steam Client CSP for non-Steam origins,
// so all HTTP goes through the plugin's Lua backend (see backend/main.lua).
// Lua returns JSON strings (tables don't reliably survive the IPC bridge),
// which we parse here.

interface BackendProxyResult {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
}

const fetchBackendRaw = callable<[{ path: string }], string>('fetch_backend');
const getSteamIdRaw = callable<[], string>('get_steam_id');
const relayLogRaw = callable<[{ msg: string }], string>('relay_log');
const getPairSecretRaw = callable<[], string>('get_pair_secret');

// Per-install pairing secret (privacy). The Lua backend generates/persists it and
// adds it as the X-GN-Secret header on every fetch_backend call (so the plugin's
// own reads pass the gated endpoints). We also need it here to inject into the
// feed iframe URL (#gn_secret=…) so the embedded SPA authenticates the same way.
let cachedPairSecret: string | null = null;
async function getPairSecret(): Promise<string> {
  if (cachedPairSecret) {
    return cachedPairSecret;
  }
  try {
    const raw = await getPairSecretRaw();
    const parsed = JSON.parse(raw) as { secret?: string };
    cachedPairSecret = parsed.secret ?? '';
  } catch {
    cachedPairSecret = '';
  }
  return cachedPairSecret;
}

// Verbose nav/styling diagnostics. Off for store releases; flip to true to
// surface the full injection/styling/render trace in the Lua log when debugging.
const NAV_DEBUG = false;

// Always-on operational log (boot, pairing, polling, errors) → Lua log.
function ilog(msg: string): void {
  console.log('[GameNews][nav]', msg);
  void relayLogRaw({ msg }).catch((): void => {});
}

// Verbose log, gated behind NAV_DEBUG. The HTTP calls themselves are already
// logged by the Lua proxy, so this only carries DOM/styling noise.
function navLog(msg: string): void {
  if (NAV_DEBUG) {
    ilog(msg);
  }
}

interface SteamIdPayload {
  steamId: string | null;
  source: string;
}

async function fetchBackend(args: { path: string }): Promise<BackendProxyResult> {
  const raw = await fetchBackendRaw(args);
  try {
    return JSON.parse(raw) as BackendProxyResult;
  } catch (error) {
    return {
      ok: false,
      error: `invalid JSON from Lua: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function getSteamId(): Promise<SteamIdPayload> {
  try {
    const raw = await getSteamIdRaw();
    return JSON.parse(raw) as SteamIdPayload;
  } catch {
    return { steamId: null, source: 'parse-error' };
  }
}

// Follows a game via the backend. Uses GET (query params) because the Lua
// proxy only does http.get reliably — http.request crashed Millennium's
// native layer. The /api/web/follow endpoint accepts both GET and POST.
function followViaBackend(
  steamId: string,
  appId: string,
  name: string,
  logoUrl: string,
): void {
  const q =
    `?steamId=${encodeURIComponent(steamId)}` +
    `&appId=${encodeURIComponent(appId)}` +
    `&name=${encodeURIComponent(name)}` +
    `&logoUrl=${encodeURIComponent(logoUrl)}`;
  void fetchBackend({ path: `/web/follow${q}` }).then((res) => {
    navLog('follow result: ' + (res.ok ? `HTTP ${res.status}` : (res.error ?? '?')));
  });
}

// Shows a "nouveau jeu détecté → clic pour suivre" toast. On click: follow the
// game, dismiss this toast, and show a confirmation toast (visual feedback).
function showFollowPromptToast(
  steamId: string,
  appId: string,
  name: string,
  logoUrl: string,
): void {
  let handle: { dismiss: () => void } | undefined;
  handle = toaster.toast({
    title: 'Nouveau jeu détecté',
    body: name,
    subtext: 'Cliquez pour suivre ce jeu',
    logo: gameLogoNode(logoUrl),
    timestamp: null as unknown as Date,
    duration: 12000,
    showToast: true,
    playSound: true,
    onClick: () => {
      navLog('follow prompt clicked: ' + appId);
      followViaBackend(steamId, appId, name, logoUrl);
      handle?.dismiss();
      toaster.toast({
        title: 'Jeu suivi ✓',
        body: name,
        subtext: 'Ajouté à tes jeux suivis',
        logo: gameLogoNode(logoUrl),
        timestamp: null as unknown as Date,
        duration: 5000,
        showToast: true,
        playSound: false,
      });
    },
  });
}

// ── Hooks ──────────────────────────────────────────────────────────────────

interface VersionPayload {
  latestVersion?: string;
  minSupportedVersion?: string;
  updateUrl?: string;
}

type BackendState =
  | { status: 'loading' }
  | { status: 'ok'; data: VersionPayload }
  | { status: 'error'; error: string };

function useBackendVersion(): BackendState {
  const [state, setState] = useState<BackendState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result: BackendProxyResult = await fetchBackend({
        path: '/version',
      }).catch((err: unknown): BackendProxyResult => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }));

      if (cancelled) return;

      if (!result.ok) {
        setState({ status: 'error', error: result.error ?? 'unknown error' });
        return;
      }
      if (result.status !== 200) {
        setState({ status: 'error', error: `HTTP ${result.status}` });
        return;
      }
      try {
        const data = JSON.parse(result.body ?? '{}') as VersionPayload;
        setState({ status: 'ok', data });
      } catch (parseError) {
        setState({
          status: 'error',
          error: parseError instanceof Error ? parseError.message : 'invalid JSON',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

// Reads the SteamID from the Lua backend, which parses Steam's own
// `config/loginusers.vdf` — instant and reliable, no user navigation needed.
function useSteamId(): SteamIdPayload {
  const [state, setState] = useState<SteamIdPayload>({
    steamId: null,
    source: 'loading',
  });

  useEffect(() => {
    let cancelled = false;
    void getSteamId().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

// ── UI ─────────────────────────────────────────────────────────────────────

function maskSteamId(steamId: string): string {
  if (steamId.length <= 6) return steamId;
  return `${steamId.slice(0, 3)}***${steamId.slice(-2)}`;
}

function GameNewsPanel() {
  const backend = useBackendVersion();
  const steam = useSteamId();

  return (
    <>
      <Field
        label="Game News — Spike v0.2"
        description="Native Millennium panel. Reads SteamID from Steam's loginusers.vdf, proxies HTTP through the Lua backend."
        bottomSeparator="standard"
        focusable
      />

      <Field
        label="Backend connectivity"
        description={
          backend.status === 'loading'
            ? 'Pinging gamenews.up.railway.app via Lua proxy …'
            : backend.status === 'error'
              ? `Unreachable — ${backend.error}`
              : `latest=${backend.data.latestVersion ?? '?'}  min=${backend.data.minSupportedVersion ?? '?'}`
        }
        bottomSeparator="standard"
        focusable
      />

      <Field
        label="Steam account detection"
        description={
          steam.steamId
            ? `Detected SteamID: ${maskSteamId(steam.steamId)} (source: ${steam.source})`
            : `No SteamID yet — source=${steam.source}. Check Millennium → Logs for [GameNews] entries.`
        }
        bottomSeparator="standard"
        focusable
      />

      <Field
        label="Test notification"
        description="Toast générique (texte fixe) pour vérifier l'affichage."
        bottomSeparator="standard"
        focusable
      >
        <DialogButton onClick={sendTestToast}>Envoyer une notif test</DialogButton>
      </Field>

      <Field
        label="Simuler une vraie news"
        description="Récupère la dernière news de 007 First Light et la toaste comme le ferait le polling."
        bottomSeparator="standard"
        focusable
      >
        <DialogButton onClick={simulateNewsToast}>Simuler news 007</DialogButton>
      </Field>

      <Field
        label="Simuler un prompt de suivi"
        description="Toast 'nouveau jeu détecté' pour un jeu wishlist non suivi — clic = le suivre."
        bottomSeparator="none"
        focusable
      >
        <DialogButton onClick={simulateFollowPrompt}>Simuler prompt suivi</DialogButton>
      </Field>
    </>
  );
}

// `IconsModule` is resolved at runtime from Steam's internal module map; its
// shape is `any`, so picking an icon that doesn't exist crashes the panel
// (React error #130). `Settings` is the canonical icon used in the official
// PluginTemplate, the safest pick.
const PluginIcon = IconsModule?.Settings ? <IconsModule.Settings /> : <></>;

// ── Header NEWS button injection ───────────────────────────────────────────
// Adds a "NEWS" entry to Steam's top navigation (next to MAGASIN / LIBRARY /
// COMMUNITY). On click, navigates the main window to our web feed via
// MainWindowBrowserManager.ShowURL — the same API Steam Librarian (52K
// installs) uses to open full-page URLs inside the client.

const NEWS_BUTTON_ID = 'game-news-nav-button';
const MAIN_WINDOW_NAME = 'SP Desktop_uid0';
const FEED_ORIGIN = 'https://gamenews.up.railway.app';
const FEED_URL_BASE = FEED_ORIGIN + '/feed/';
// Internal SteamUI route owned by the plugin. The feed renders here, full-page,
// as a route in Steam's own React router — NOT in MainWindowBrowserManager's
// shared browser. That's the whole point: the native store/community/profile
// tabs keep their own browser slots untouched, so they can never show News.
const FEED_ROUTE = '/gamenews';

// Steam's top tabs, FR + EN (the only two we ship copy for right now).
const TAB_LABELS = new Set([
  'MAGASIN',
  'STORE',
  'BIBLIOTHÈQUE',
  'LIBRARY',
  'COMMUNAUTÉ',
  'COMMUNITY',
]);

// Active-tab styling. Steam drives the blue text + underline on native tabs via
// its own router, which our injected button isn't part of — so we reproduce the
// active look ourselves. We read the real inactive/accent colours from the live
// tabs at runtime (no hardcoded Steam CSS class names → resilient to updates),
// falling back to the Steam accent only if detection fails.
const STEAM_ACCENT_FALLBACK = 'rgb(26, 159, 255)';
// True while the main window is showing our feed (NEWS is the active tab).
let feedActive = false;
// Last detected accent colour, kept so it survives once we de-accent the tab.
let cachedAccent: string | null = null;
// Steam's "active tab" class name(s), detected at runtime: the extra class(es) a
// blue-highlighted normal tab has on top of NEWS's own base classes. Cached so
// it survives once we strip it. Anchored to the base classes (below) so the
// hover state (white) and the differently-structured profile tab can't pollute.
let activeTabClasses: string[] = [];
// NEWS's base classes (the cloned tab's classes, sans active state) — captured
// at injection and used as the canonical "inactive normal tab" to diff against.
let newsBaseClasses: string[] = [];
// Class(es) Steam adds on hover (white text). Accumulated when a hovered tab is
// seen, then excluded from the active-class diff so NEWS never gets hover style.
const hoverTabClasses = new Set<string>();

declare const g_PopupManager: {
  GetExistingPopup: (name: string) => { m_strName: string; m_popup: Window } | undefined;
  AddPopupCreatedCallback: (
    cb: (popup: { m_strName: string; m_popup: Window } | undefined) => void,
  ) => void;
} | undefined;

declare const SteamClient:
  | { URL?: { ExecuteSteamURL?: (url: string) => void } }
  | undefined;

// Full-page route component: renders the web feed inside Steam in an <iframe>.
// The SteamUI document is served from https://steamloopback.host, so the feed's
// backend explicitly allows that origin via CSP frame-ancestors (see backend/
// src/routes/feedPage.js). The iframe lives entirely inside this plugin-owned
// route — it never touches MainWindowBrowserManager's shared browser, so the
// native store/community/profile tabs keep their own slots and can never show
// News. (Steam's CEF doesn't honour a raw <webview> tag from injected React.)
function GameNewsFeedRoute() {
  const steam = useSteamId();
  // Pass this install's pairing secret to the embedded SPA via the URL hash so
  // its gated reads authenticate (the page is then private). Warmed at boot, so
  // usually already cached; otherwise fetched on mount (one reload at worst).
  const [secret, setSecret] = useState<string>(cachedPairSecret ?? '');
  useEffect(() => {
    if (!secret) {
      void getPairSecret().then((s) => {
        if (s) {
          setSecret(s);
        }
      });
    }
  }, [secret]);
  const url = steam.steamId
    ? FEED_URL_BASE + steam.steamId + (secret ? '#gn_secret=' + encodeURIComponent(secret) : '')
    : null;
  navLog(
    'GameNewsFeedRoute render: steamId=' +
      (steam.steamId ?? 'none') +
      ' source=' +
      steam.source +
      ' parentOrigin=' +
      (typeof window !== 'undefined' ? window.location.origin : '?'),
  );

  const container = (children: import('react').ReactNode) =>
    window.SP_REACT.createElement(
      'div',
      {
        style: {
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          background: '#1b2838',
        },
      },
      children,
    );

  if (!url) {
    return container(
      window.SP_REACT.createElement(
        'div',
        { style: { color: '#dcdedf', padding: '24px', fontSize: '14px' } },
        'Game News — chargement du compte Steam…',
      ),
    );
  }

  return container(
    window.SP_REACT.createElement('iframe', {
      src: url,
      style: { width: '100%', height: '100%', border: 'none', display: 'block' },
      onLoad: () => navLog('GameNewsFeedRoute: iframe load OK ' + url),
      onError: () => navLog('GameNewsFeedRoute: iframe error ' + url),
    }),
  );
}

// Open the feed by navigating Steam's own router to our internal /gamenews route.
// This deliberately does NOT use MainWindowBrowserManager.ShowURL (which loaded
// the page into the shared store-slot browser and broke store/community/profile
// nav) nor steam://openurl (which spawned an external Chrome window). A plugin-
// owned route lives outside the native tabs' browser slots, so they stay intact.
function openFeed(steamId: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (typeof Navigation !== 'undefined' && typeof Navigation?.Navigate === 'function') {
      Navigation.Navigate(FEED_ROUTE);
      navLog('openFeed: Navigation.Navigate ' + FEED_ROUTE);
      return;
    }
    navLog('openFeed: Navigation.Navigate unavailable, falling back to steam://openurl');
  } catch (e) {
    navLog('openFeed Navigation.Navigate error: ' + String(e));
  }
  // Last-resort fallback (only if the router API is missing): external open.
  const url = FEED_URL_BASE + steamId;
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (typeof SteamClient !== 'undefined' && SteamClient?.URL?.ExecuteSteamURL) {
      SteamClient.URL.ExecuteSteamURL('steam://openurl/' + url);
      navLog('openFeed: steam://openurl fallback ' + url);
      return;
    }
  } catch (e) {
    navLog('openFeed ExecuteSteamURL error: ' + String(e));
  }
}

// Opens a news article (a real steamcommunity / steampowered URL) in Steam's
// NATIVE web browser via the router, exactly like clicking a link in the client
// — it lands in the matching native tab (Communauté for community URLs) instead
// of loading inside our feed iframe ("Steam in Steam"). Unlike the feed itself
// (an external railway.app page that hangs the history callback), these are
// genuine Steam web pages, so native navigation behaves normally. Called when
// the feed iframe postMessages a click up to us. Falls back to an external open.
function openArticleNative(url: string): void {
  // We're leaving the feed, so NEWS is no longer the active view.
  feedActive = false;
  // NavigateToSteamWeb opens the article in-client (good) but clobbers the
  // currently-active web tab's remembered URL in MainWindowBrowserManager
  // .m_lastActiveTabURLs with the article URL. If "store" was the last active
  // tab, clicking Magasin later re-opens the news (same for the profile tab).
  // Fix: snapshot that per-tab URL memory, navigate, then restore every slot
  // EXCEPT "community" (which legitimately now holds the article). m_rootTabURLs
  // is untouched by the nav, so we leave it alone.
  const mwbm = (
    window as unknown as {
      MainWindowBrowserManager?: { m_lastActiveTabURLs?: Record<string, string> };
    }
  ).MainWindowBrowserManager;
  const prevTabURLs =
    mwbm && mwbm.m_lastActiveTabURLs ? { ...mwbm.m_lastActiveTabURLs } : null;
  try {
    if (
      typeof Navigation !== 'undefined' &&
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      typeof Navigation?.NavigateToSteamWeb === 'function'
    ) {
      Navigation.NavigateToSteamWeb(url);
      ilog('openArticleNative: NavigateToSteamWeb ' + url);
      if (prevTabURLs && mwbm) {
        const restoreSlots = (): void => {
          const cur = mwbm.m_lastActiveTabURLs;
          if (!cur) {
            return;
          }
          for (const key of Object.keys(prevTabURLs)) {
            if (key !== 'community') {
              cur[key] = prevTabURLs[key];
            }
          }
        };
        // The clobber settles as the article loads; re-apply a few times to
        // win any late re-sync.
        [400, 1000, 1800, 2800].forEach((d) =>
          window.setTimeout(restoreSlots, d),
        );
      }
      return;
    }
    ilog('openArticleNative: NavigateToSteamWeb unavailable, falling back');
  } catch (e) {
    ilog('openArticleNative NavigateToSteamWeb error: ' + String(e));
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (typeof SteamClient !== 'undefined' && SteamClient?.URL?.ExecuteSteamURL) {
      SteamClient.URL.ExecuteSteamURL('steam://openurl/' + url);
      navLog('openArticleNative: steam://openurl fallback ' + url);
    }
  } catch (e) {
    navLog('openArticleNative fallback error: ' + String(e));
  }
}

// Polls for a Steam global that may not exist yet at plugin-load time
// (g_PopupManager / MainWindowBrowserManager appear a few seconds in).
function waitForGlobal<T>(
  getter: () => T | undefined,
  label: string,
  timeoutMs = 25000,
  intervalMs = 500,
): Promise<T | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = (): void => {
      let value: T | undefined;
      try {
        value = getter();
      } catch {
        value = undefined;
      }
      if (value !== undefined && value !== null) {
        resolve(value);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        navLog(label + ' never appeared after ' + timeoutMs + 'ms');
        resolve(null);
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

function isVisible(el: HTMLElement): boolean {
  return el.offsetParent !== null && el.getClientRects().length > 0;
}

function countTabLabelsInside(container: HTMLElement): number {
  const found = new Set<string>();
  container.querySelectorAll<HTMLElement>('a, span, div').forEach((c) => {
    const t = (c.textContent ?? '').trim().toUpperCase();
    if (TAB_LABELS.has(t)) {
      found.add(t);
    }
  });
  return found.size;
}

// Find the REAL top nav bar: the closest ancestor that contains at least two
// distinct, visible tab labels (MAGASIN + BIBLIOTHÈQUE + …). This avoids
// hidden duplicates and the store webview's collapsed header, which never
// hold all the desktop-chrome tabs together.
function findTabBar(doc: Document): HTMLElement | null {
  const leafMatches: HTMLElement[] = [];
  doc.querySelectorAll<HTMLElement>('a, span, div').forEach((el) => {
    const text = (el.textContent ?? '').trim().toUpperCase();
    if (TAB_LABELS.has(text) && isVisible(el)) {
      leafMatches.push(el);
    }
  });
  if (leafMatches.length === 0) {
    return null;
  }

  for (const leaf of leafMatches) {
    let ancestor: HTMLElement | null = leaf.parentElement;
    for (let depth = 0; ancestor && depth < 5; depth += 1) {
      if (countTabLabelsInside(ancestor) >= 2) {
        return ancestor;
      }
      ancestor = ancestor.parentElement;
    }
  }
  return null;
}

// Locate an actual tab leaf (an element whose exact text is a tab label) so we
// can clone its styling and insert our button as a sibling in the same row.
function findSampleTab(tabBar: HTMLElement): HTMLElement | null {
  let sample: HTMLElement | null = null;
  tabBar.querySelectorAll<HTMLElement>('a, span, div').forEach((c) => {
    if (sample) {
      return;
    }
    const t = (c.textContent ?? '').trim().toUpperCase();
    if (TAB_LABELS.has(t)) {
      sample = c;
    }
  });
  return sample;
}

function readColor(win: Window, el: HTMLElement): string {
  return win.getComputedStyle(el).color;
}

// True only for Steam's blue active accent (e.g. rgb(26,159,255)). Rejects the
// hover white (rgb(255,255,255)), the inactive grey (rgb(220,222,223)) and the
// dimmed profile grey (rgb(150,150,150)) — all of which have no blue dominance.
function isAccentColor(color: string): boolean {
  const m = color.match(/\d+/g);
  if (!m || m.length < 3) {
    return false;
  }
  const r = Number(m[0]);
  const g = Number(m[1]);
  const b = Number(m[2]);
  return b - r > 60 && b - g > 40;
}

// True for Steam's hover white (~rgb(255,255,255)): all channels near max.
function isHoverColor(color: string): boolean {
  const m = color.match(/\d+/g);
  if (!m || m.length < 3) {
    return false;
  }
  return Number(m[0]) > 245 && Number(m[1]) > 245 && Number(m[2]) > 245;
}

// Sets the label on the deepest single-child wrapper, leaving the tab's nested
// structure (and its ::after underline) intact — unlike root.textContent which
// would wipe the children.
function setButtonLabel(root: HTMLElement, label: string): void {
  let leaf = root;
  while (leaf.children.length === 1) {
    leaf = leaf.children[0] as HTMLElement;
  }
  if (leaf.children.length === 0) {
    leaf.textContent = label;
  } else {
    root.textContent = label;
  }
}

// Re-asserts the NEWS button styling and, while the feed is open, neutralises
// the native tab Steam still keeps highlighted. Cheap and idempotent: called on
// inject, on click, and on each mutation while the feed is active. All reads are
// from live computed styles, all writes are reversible inline overrides.
// `reason` only drives logging (mutation refreshes stay silent to avoid flood).
function refreshNavStyles(doc: Document, reason: string): void {
  const verbose = reason !== 'mutation';
  // NB: do NOT use `instanceof HTMLElement` — the element lives in the Steam
  // window's realm, not the plugin's, so cross-realm instanceof is always false.
  const button = doc.getElementById(NEWS_BUTTON_ID) as HTMLElement | null;
  const win = doc.defaultView;
  if (!button || !win) {
    if (verbose) {
      navLog(
        `refreshNavStyles[${reason}] ABORT button=${button ? 'yes' : 'no'} win=${win ? 'yes' : 'no'}`,
      );
    }
    return;
  }
  const row = button.parentElement;
  if (!row) {
    if (verbose) {
      navLog(`refreshNavStyles[${reason}] ABORT no row (button has no parent)`);
    }
    return;
  }

  // Innermost text-bearing leaves in the tab row, excluding our own button.
  const leaves: HTMLElement[] = [];
  row.querySelectorAll<HTMLElement>('a, span, div').forEach((el) => {
    if (el === button || button.contains(el) || el.contains(button)) {
      return;
    }
    const txt = (el.textContent ?? '').trim();
    if (txt.length === 0 || txt.length > 24 || el.querySelector('a, span, div')) {
      return;
    }
    leaves.push(el);
  });

  if (verbose) {
    const detail = leaves
      .map((el) => `"${(el.textContent ?? '').trim()}"=${readColor(win, el)}`)
      .join(' | ');
    navLog(
      `refreshNavStyles[${reason}] feedActive=${feedActive} rowTag=${row.tagName} leaves=${leaves.length} :: ${detail}`,
    );
  }

  if (leaves.length === 0) {
    button.style.setProperty('color', '#ffffff', 'important');
    if (verbose) {
      navLog(`refreshNavStyles[${reason}] no leaves → forced NEWS white`);
    }
    return;
  }

  // Inactive colour = the majority colour across the tabs.
  const counts = new Map<string, number>();
  leaves.forEach((el) => {
    const c = readColor(win, el);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  });
  let inactiveColor = '#ffffff';
  let best = -1;
  counts.forEach((n, c) => {
    if (n > best) {
      best = n;
      inactiveColor = c;
    }
  });

  // The active marker lives on the TAB element (the leaf's parent, = the level
  // we clone for NEWS), not on the text leaf. Detect the live active tab ROBUSTLY:
  //   - its leaf colour must be the blue accent (isAccentColor) → excludes the
  //     hover white and the dimmed-grey profile tab,
  //   - its tab must share ALL of NEWS's base classes → only normal tabs of the
  //     same structure (ignores the differently-built profile tab).
  // This prevents hover/profile noise from corrupting the cached accent/class.
  const tabOf = (leaf: HTMLElement): HTMLElement | null => leaf.parentElement;
  const baseSet = new Set(newsBaseClasses);
  const hasAllBase = (tab: HTMLElement): boolean =>
    newsBaseClasses.length > 0 && newsBaseClasses.every((c) => tab.classList.contains(c));

  let activeTab: HTMLElement | null = null;
  leaves.forEach((leaf) => {
    const tab = tabOf(leaf);
    if (!tab || tab === button || !hasAllBase(tab)) {
      return;
    }
    const color = readColor(win, leaf);
    // Remember the hover class(es) seen on a white-hovered tab, so we can exclude
    // them from the active class (a tab that is active AND hovered carries both).
    if (isHoverColor(color)) {
      Array.from(tab.classList).forEach((c) => {
        if (!baseSet.has(c)) {
          hoverTabClasses.add(c);
        }
      });
    }
    if (isAccentColor(color)) {
      cachedAccent = color;
      activeTab = tab;
    }
  });
  const accent = cachedAccent ?? STEAM_ACCENT_FALLBACK;

  // Active class(es) = what the active tab has beyond NEWS's base classes AND the
  // known hover classes (here `_1gqEjB5…`, never the `_3rgV8…` hover marker). So
  // NEWS only ever gets the real active styling, never the hover style.
  if (activeTab) {
    const extra = Array.from((activeTab as HTMLElement).classList).filter(
      (c) => !baseSet.has(c) && !hoverTabClasses.has(c),
    );
    if (extra.length > 0) {
      activeTabClasses = extra;
    }
  }
  const haveClass = activeTabClasses.length > 0;

  // NEWS itself: toggle Steam's own active class on the button (which is a tab
  // clone). That alone reproduces the exact blue text + underline. We keep no
  // inline colour: a pure class toggle renders identically to a native tab.
  if (haveClass) {
    if (feedActive) {
      button.classList.add(...activeTabClasses);
    } else {
      button.classList.remove(...activeTabClasses);
    }
  }

  if (verbose) {
    navLog(
      `refreshNavStyles[${reason}] inactive=${inactiveColor} accent=${accent} ` +
        `activeClass="${activeTabClasses.join('.')}" feedActive=${feedActive} ` +
        `newsHasClass=${haveClass ? button.classList.contains(activeTabClasses[0]) : 'n/a'}`,
    );
  }

  // Voie 1: we no longer touch the native tabs. NEWS just owns its own active
  // class; Steam keeps managing the native highlight. This stops the fight with
  // Steam's router (no hover re-highlight, no stale/double highlight, no
  // interference) — the trade-off is the originating tab may stay highlighted
  // alongside NEWS while the feed is shown.
}

function injectNewsButton(doc: Document, steamId: string): boolean {
  if (doc.getElementById(NEWS_BUTTON_ID)) {
    return true;
  }
  const tabBar = findTabBar(doc);
  if (!tabBar) {
    return false;
  }

  const sampleTab = findSampleTab(tabBar);
  navLog(
    `injectNewsButton: tabBar=${tabBar.tagName}.${tabBar.className} ` +
      `sampleTab=${sampleTab ? `${sampleTab.tagName}.${sampleTab.className} text="${(sampleTab.textContent ?? '').trim()}"` : 'NONE'}`,
  );
  const button = sampleTab
    ? (sampleTab.cloneNode(true) as HTMLElement)
    : doc.createElement('a');

  button.id = NEWS_BUTTON_ID;
  // Capture the cloned tab's base classes (sans active state) as the canonical
  // "inactive normal tab" reference for active-class detection.
  newsBaseClasses = Array.from(button.classList);
  // Rename only the innermost text element, preserving the tab's inner wrapper
  // (e.g. the DIV that carries the active-state ::after underline). Replacing
  // button.textContent would nuke that wrapper and the underline with it.
  setButtonLabel(button, 'NEWS');
  button.removeAttribute('href');
  button.style.cursor = 'pointer';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    feedActive = true;
    navLog('NEWS clicked → feedActive=true, opening feed');
    openFeed(steamId);
    refreshNavStyles(doc, 'click');
  });

  // Insert in the same row as the real tabs (sibling of a tab leaf), else
  // fall back to appending to the resolved tab-bar container.
  const row = sampleTab?.parentElement ?? tabBar;
  row.appendChild(button);
  navLog(
    `injectNewsButton: appended into row=${row.tagName}.${row.className} ` +
      `clonedClass="${button.className}" childCount=${button.childElementCount}`,
  );
  refreshNavStyles(doc, 'inject');
  return true;
}

// React reconciliation removes raw DOM nodes it doesn't own, so a one-shot
// injection gets wiped on the next nav re-render. We keep a permanent
// observer and re-inject whenever the button goes missing. The per-mutation
// cost is just a getElementById; the expensive find+inject only runs when the
// button is actually absent, and our own appendChild is idempotent (the guard
// short-circuits) so it can't loop.
function watchAndInject(win: Window, steamId: string): void {
  const doc = win.document;
  let reinjectCount = 0;

  const tryInject = (): void => {
    if (doc.getElementById(NEWS_BUTTON_ID)) {
      // Button is present; while the feed is open, re-assert the active styling
      // (Steam re-paints its own active tab on every nav re-render).
      if (feedActive) {
        refreshNavStyles(doc, 'mutation');
      }
      return;
    }
    if (injectNewsButton(doc, steamId)) {
      reinjectCount += 1;
      if (reinjectCount === 1 || reinjectCount % 25 === 0) {
        navLog('NEWS button injected (count=' + reinjectCount + ')');
      }
    }
  };

  // Clicking any native tab in the same row means the user navigated away from
  // the feed → drop the NEWS active state and restore the native highlight.
  const docFlagged = doc as Document & { __gnNavClickBound?: boolean };
  if (!docFlagged.__gnNavClickBound) {
    docFlagged.__gnNavClickBound = true;
    doc.addEventListener(
      'click',
      (event) => {
        if (!feedActive) {
          return;
        }
        const target = event.target as Node | null;
        // Cross-realm: avoid instanceof; getElementById gives a usable Element.
        const button = doc.getElementById(NEWS_BUTTON_ID) as HTMLElement | null;
        if (!target || !button) {
          return;
        }
        if (button === target || button.contains(target)) {
          return; // NEWS click is handled by its own listener
        }
        const row = button.parentElement;
        if (row && row.contains(target)) {
          // The feed now opens in a separate browser, so we NEVER touch Steam's
          // tabs — they navigate natively. We only drop the NEWS active styling.
          feedActive = false;
          refreshNavStyles(doc, 'native-click');
        }
      },
      true,
    );
  }

  // The feed iframe asks us (its parent window) to open article links natively,
  // so a clicked news opens in Steam's real Communauté/Store tab instead of
  // nesting a Steam page inside the iframe. Bound once on the main window (the
  // iframe's actual parent), origin-checked to the feed.
  const winFlagged = win as Window & { __gnMsgBound?: boolean };
  if (!winFlagged.__gnMsgBound) {
    winFlagged.__gnMsgBound = true;
    win.addEventListener('message', (event: MessageEvent) => {
      if (event.origin !== FEED_ORIGIN) {
        return;
      }
      const data = event.data as { type?: string; url?: string } | null;
      if (data?.type !== 'gamenews-open-url' || typeof data.url !== 'string') {
        return;
      }
      navLog('feed → open url natively: ' + data.url);
      openArticleNative(data.url);
      refreshNavStyles(doc, 'native-open');
    });
  }

  tryInject();

  const ObserverCtor = (win as Window & { MutationObserver: typeof MutationObserver })
    .MutationObserver;
  const observer = new ObserverCtor(() => tryInject());
  observer.observe(doc.body, { childList: true, subtree: true });
  navLog('persistent observer attached');
}

async function initHeaderInjection(): Promise<void> {
  navLog('initHeaderInjection start');

  const payload = await getSteamId();
  if (!payload.steamId) {
    navLog('no steamId, skipping header injection');
    return;
  }
  const steamId = payload.steamId;
  navLog('steamId resolved, waiting for g_PopupManager');

  const popupMgr = await waitForGlobal(
    () => (typeof g_PopupManager !== 'undefined' ? g_PopupManager : undefined),
    'g_PopupManager',
  );
  if (!popupMgr) {
    return;
  }
  navLog('g_PopupManager ready');

  const existing = popupMgr.GetExistingPopup(MAIN_WINDOW_NAME);
  if (existing) {
    navLog('main window already exists, injecting');
    watchAndInject(existing.m_popup, steamId);
  } else {
    navLog('main window not yet created, registering callback');
  }
  popupMgr.AddPopupCreatedCallback((popup) => {
    if (popup?.m_strName === MAIN_WINDOW_NAME) {
      navLog('main window created via callback, injecting');
      watchAndInject(popup.m_popup, steamId);
    }
  });
}

// ── News polling → native toasts ───────────────────────────────────────────
// While Steam is open, poll the feed and toast genuinely new items. First ever
// run seeds the seen-set silently so we don't spam existing news.

const NEWS_SEEN_KEY = 'gamenews_seen_news_ids';
const NEWS_POLL_INTERVAL_MS = 5 * 60 * 1000;
const NEWS_MAX_TOASTS_PER_POLL = 5;
const NEWS_MAX_SEEN = 500;
// The follow-prompt "already prompted" set must remember the WHOLE library, not
// a recent window: with the old 500 cap, a >500-game library overflowed the set,
// so the overflow games were perpetually re-seen as "new" and re-prompted every
// poll (notification spam). AppIds are tiny strings — a large cap is cheap and
// covers any realistic Steam library.
const PROMPTED_MAX = 20000;

interface FeedItem {
  appId: string | number;
  gameName: string;
  gameLogoUrl: string | null;
  news: { id: string; title: string; url: string };
}

function loadSeenNews(): Set<string> {
  try {
    const raw = localStorage.getItem(NEWS_SEEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveSeenNews(seen: Set<string>): void {
  try {
    localStorage.setItem(
      NEWS_SEEN_KEY,
      JSON.stringify(Array.from(seen).slice(-NEWS_MAX_SEEN)),
    );
  } catch {
    /* ignore quota / unavailable */
  }
}

function openNewsUrl(url: string): void {
  // Open a news article in Steam's in-client browser (separate view), same as
  // the feed — never hijack the main-window tabs.
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (typeof SteamClient !== 'undefined' && SteamClient?.URL?.ExecuteSteamURL) {
      SteamClient.URL.ExecuteSteamURL('steam://openurl/' + url);
      return;
    }
  } catch {
    /* fall through to window.open */
  }
  try {
    window.open(url, '_blank');
  } catch {
    /* ignore */
  }
}

// Steam Desktop toast gate (separate from the mobile FCM gate). Defaults to ON
// when unknown so a transient error doesn't silently drop notifications.
async function isSteamNotifEnabled(steamId: string): Promise<boolean> {
  const res = await fetchBackend({ path: `/web/settings/${steamId}` }).catch(
    (): BackendProxyResult => ({ ok: false }),
  );
  if (res.ok && res.status === 200 && res.body) {
    try {
      const s = JSON.parse(res.body) as { steamNotifications?: boolean };
      return s.steamNotifications !== false;
    } catch {
      /* fall through to default */
    }
  }
  return true;
}

async function pollNewsOnce(steamId: string): Promise<void> {
  const result = await fetchBackend({
    path: `/news/feed-by-steamid/${steamId}`,
  }).catch((): BackendProxyResult => ({ ok: false, error: 'fetch failed' }));

  if (!result.ok || result.status !== 200 || !result.body) {
    return;
  }
  let items: FeedItem[] = [];
  try {
    const data = JSON.parse(result.body) as { items?: FeedItem[] };
    items = Array.isArray(data.items) ? data.items : [];
  } catch {
    return;
  }

  const seen = loadSeenNews();

  if (seen.size === 0) {
    items.forEach((it) => seen.add(String(it.news.id)));
    saveSeenNews(seen);
    navLog(`news poll: seeded ${items.length} existing items (no toast)`);
    return;
  }

  const fresh = items.filter((it) => !seen.has(String(it.news.id)));

  // Even when toasts are off we still mark fresh items as seen, so re-enabling
  // the toggle later doesn't flood the user with everything accumulated since.
  const enabled = await isSteamNotifEnabled(steamId);
  ilog(
    `news poll: ${items.length} items, ${fresh.length} new, steamNotif=${enabled}`,
  );

  if (enabled) {
    fresh.slice(0, NEWS_MAX_TOASTS_PER_POLL).forEach((it) => {
      const url =
        it.news.url ||
        (it.appId ? `https://store.steampowered.com/news/app/${it.appId}` : '');
      toaster.toast({
        title: 'News',
        body: it.gameName,
        subtext: it.news.title,
        logo: gameLogoNode(it.gameLogoUrl),
        timestamp: null as unknown as Date, // hide the time (see simulate toast)
        duration: 10000,
        showToast: true,
        playSound: true,
        onClick: url ? () => openNewsUrl(url) : undefined,
      });
    });
  }

  fresh.forEach((it) => seen.add(String(it.news.id)));
  saveSeenNews(seen);
}

// ── Follow-prompt polling → clickable toasts ───────────────────────────────
// Detects newly-detected, not-yet-followed games (library/family + wishlist)
// when the matching follow mode is "prompt", and toasts a "click to follow"
// notification. First run seeds silently (no flood of the existing backlog).

const PROMPTED_KEY = 'gamenews_prompted_ids';

interface ProfileLite {
  followedGames: Array<{ appId: string }>;
  wishlist: Array<{ appId: string; name: string; header_image: string }>;
  account: { libraryFollowMode: string; wishlistFollowMode: string };
}
interface LibraryLite {
  appId: string;
  name: string;
  header_image: string;
}
interface PromptCandidate {
  appId: string;
  name: string;
  logoUrl: string;
}

function loadPrompted(): Set<string> {
  try {
    const raw = localStorage.getItem(PROMPTED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function savePrompted(seen: Set<string>): void {
  try {
    localStorage.setItem(
      PROMPTED_KEY,
      JSON.stringify(Array.from(seen).slice(-PROMPTED_MAX)),
    );
  } catch {
    /* ignore */
  }
}

async function pollFollowPrompts(steamId: string): Promise<void> {
  const profRes = await fetchBackend({ path: `/web/profile/${steamId}` }).catch(
    (): BackendProxyResult => ({ ok: false }),
  );
  if (!profRes.ok || profRes.status !== 200 || !profRes.body) {
    return;
  }
  let profile: ProfileLite;
  try {
    profile = JSON.parse(profRes.body) as ProfileLite;
  } catch {
    return;
  }

  const libRes = await fetchBackend({ path: `/web/library/${steamId}` }).catch(
    (): BackendProxyResult => ({ ok: false }),
  );
  let library: LibraryLite[] = [];
  if (libRes.ok && libRes.status === 200 && libRes.body) {
    try {
      library = JSON.parse(libRes.body) as LibraryLite[];
    } catch {
      /* keep empty */
    }
  }

  const followed = new Set(profile.followedGames.map((g) => String(g.appId)));
  const candidates: PromptCandidate[] = [];
  const addCandidate = (appId: string, name: string, logoUrl: string) => {
    if (!followed.has(appId) && !candidates.some((c) => c.appId === appId)) {
      candidates.push({ appId, name, logoUrl });
    }
  };
  if (profile.account.libraryFollowMode === 'prompt') {
    library.forEach((g) => addCandidate(String(g.appId), g.name, g.header_image));
  }
  if (profile.account.wishlistFollowMode === 'prompt') {
    profile.wishlist.forEach((g) =>
      addCandidate(String(g.appId), g.name, g.header_image),
    );
  }

  const prompted = loadPrompted();
  if (prompted.size === 0) {
    candidates.forEach((c) => prompted.add(c.appId));
    savePrompted(prompted);
    navLog(`follow prompts: seeded ${candidates.length} candidates (no toast)`);
    return;
  }

  const fresh = candidates.filter((c) => !prompted.has(c.appId));
  const enabled = await isSteamNotifEnabled(steamId);
  ilog(
    `follow prompts: ${candidates.length} candidates, ${fresh.length} new, steamNotif=${enabled}`,
  );

  if (enabled) {
    fresh.slice(0, NEWS_MAX_TOASTS_PER_POLL).forEach((c) => {
      showFollowPromptToast(steamId, c.appId, c.name, c.logoUrl);
    });
  }

  fresh.forEach((c) => prompted.add(c.appId));
  savePrompted(prompted);
}

const HEARTBEAT_INTERVAL_MS = 90 * 1000;

// Tells the backend "Steam Desktop is open right now". Powers the presence-
// based dedup: when the user enabled preferSteamWhenOpen, the mobile FCM push
// is skipped while these heartbeats are fresh.
function sendHeartbeat(steamId: string): void {
  void fetchBackend({ path: `/web/heartbeat/${steamId}` }).then((res) => {
    if (!res.ok || res.status !== 200) {
      navLog('heartbeat failed: ' + (res.error ?? res.status));
    }
  });
}

// Provisions the user's Game News account on first launch (idempotent). This is
// what makes the feed non-empty for a brand-new install: the backend creates the
// account and syncs the Steam library. No login screen — being inside the
// signed-in Steam client is the identity proof (same trust as the other /web
// calls). The backend replies 202 right away; the sync continues server-side, so
// this returns fast. Re-issued every boot, so a transient failure self-heals.
async function ensureRegistered(steamId: string): Promise<void> {
  const res = await fetchBackend({ path: `/web/register/${steamId}` }).catch(
    (): BackendProxyResult => ({ ok: false, error: 'fetch failed' }),
  );
  const ok =
    res.ok &&
    typeof res.status === 'number' &&
    res.status >= 200 &&
    res.status < 300;
  ilog(
    'ensureRegistered: ' +
      (ok ? `ok (${res.status})` : `failed (${res.error ?? res.status})`),
  );
}

// Registers this install's pairing secret on the backend (TOFU). The secret is
// sent automatically as a ?secret= query param by the Lua proxy (Millennium drops
// custom http.get headers). After this, the gated reads (profile/library/news)
// require the secret → the feed page is no longer publicly viewable with just the
// SteamID URL. Idempotent, runs each boot.
async function ensurePaired(steamId: string): Promise<void> {
  await getPairSecret(); // warm the cache for the iframe injection
  const res = await fetchBackend({ path: `/web/pair?steamId=${steamId}` }).catch(
    (): BackendProxyResult => ({ ok: false, error: 'fetch failed' }),
  );
  ilog(
    'ensurePaired: ' +
      (res.ok && res.status === 200 ? 'ok' : `failed (${res.error ?? res.status})`),
  );
}

function startNewsPolling(): void {
  void getSteamId().then(async (payload) => {
    if (!payload.steamId) {
      navLog('news poll: no steamId, skipping');
      return;
    }
    const steamId = payload.steamId;

    // Create the account before anything reads it (idempotent; no-op for
    // returning users). Awaited so the first reads don't race a missing user.
    await ensureRegistered(steamId);
    // Register this install's pairing secret so the gated reads accept us (and
    // the feed page stops being publicly viewable). Before the first poll.
    await ensurePaired(steamId);

    // Heartbeat immediately + every 90s (independent of the 5-min news poll
    // so presence stays fresh within the backend's 4-min window).
    sendHeartbeat(steamId);
    window.setInterval(() => sendHeartbeat(steamId), HEARTBEAT_INTERVAL_MS);

    window.setTimeout(() => {
      void pollNewsOnce(steamId);
      void pollFollowPrompts(steamId);
    }, 8000);
    window.setInterval(() => {
      void pollNewsOnce(steamId);
      void pollFollowPrompts(steamId);
    }, NEWS_POLL_INTERVAL_MS);
  });
}

// Registers the plugin-owned /gamenews route once at load. Logs the runtime
// presence of both APIs this approach depends on (router hook + Navigation) so a
// missing/renamed symbol in a future Steam build is diagnosable from the Lua log.
function registerFeedRoute(): void {
  const hasRouterHook =
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    typeof routerHook !== 'undefined' && typeof routerHook?.addRoute === 'function';
  const hasNavigation =
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    typeof Navigation !== 'undefined' && typeof Navigation?.Navigate === 'function';
  navLog(
    `registerFeedRoute: routerHook.addRoute=${hasRouterHook} Navigation.Navigate=${hasNavigation}`,
  );
  if (!hasRouterHook) {
    navLog('registerFeedRoute: routerHook unavailable — feed route NOT registered');
    return;
  }
  try {
    routerHook.addRoute(FEED_ROUTE, GameNewsFeedRoute);
    navLog('registerFeedRoute: route ' + FEED_ROUTE + ' registered');
  } catch (e) {
    navLog('registerFeedRoute: addRoute threw ' + String(e));
  }
}

export default definePlugin(() => {
  registerFeedRoute();
  initHeaderInjection();
  startNewsPolling();
  return {
    title: 'Game News',
    icon: PluginIcon,
    content: <GameNewsPanel />,
  };
});
