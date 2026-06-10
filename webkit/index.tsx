// Webkit context: runs inside embedded Steam web views (store, community).
// It injects a follow "bell" on a game's STORE page
// (store.steampowered.com/app/<appid>) so the user can follow / unfollow that
// game's news without leaving the Steam client — the desktop twin of the
// browser extension's store bell.
//
// Why here (not the SharedJSContext frontend): this context's `document` IS the
// embedded store page, so DOM injection happens directly. Backend calls go
// through the SAME Lua proxy the rest of the plugin uses (`fetch_backend`):
// running in the store page's JS context, a direct `fetch` would be subject to
// Steam's page CSP (connect-src) and CORS — the Lua proxy (server-side http.get)
// sidesteps both. The proxy is GET-only, so unfollow uses the backend's GET
// alias (/api/web/unfollow/:id/:appId), follow uses GET /follow, and the state
// read uses GET /follow-state. All three are public-by-SteamID (no secret).

import { callable } from '@steambrew/webkit';

const BELL_ID = 'game-news-follow-bell';
const APP_ID_FROM_PATH = /\/app\/(\d+)/;
const SVG_NS = 'http://www.w3.org/2000/svg';
const HEADER_IMG = (appId: string): string =>
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;

// Shared Lua callables (same backend as the frontend): SteamID from
// loginusers.vdf, the http.get proxy, and a log bridge to Millennium → Logs.
const getSteamIdRaw = callable<[], string>('get_steam_id');
const fetchBackendRaw = callable<[{ path: string }], string>('fetch_backend');
const relayLogRaw = callable<[{ msg: string }], string>('relay_log');

function wlog(msg: string): void {
  void relayLogRaw({ msg: '[webkit] ' + msg }).catch((): void => {});
}

interface ProxyResult {
  ok: boolean; // the Lua proxy reached the backend
  status?: number; // the HTTP status it got back
  body?: string;
  error?: string;
}

async function backendGet(path: string): Promise<ProxyResult> {
  try {
    return JSON.parse(await fetchBackendRaw({ path })) as ProxyResult;
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// HTTP success = proxy reached the backend AND it returned a 2xx.
function httpOk(r: ProxyResult): boolean {
  return r.ok && typeof r.status === 'number' && r.status >= 200 && r.status < 300;
}

async function resolveSteamId(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await getSteamIdRaw()) as { steamId?: string | null };
    return parsed.steamId ?? null;
  } catch {
    return null;
  }
}

function detectAppId(): string | null {
  const match = window.location.pathname.match(APP_ID_FROM_PATH);
  return match ? match[1] : null;
}

// Steam's "Follow / Following" button on a game's store page — the
// `.queue_control_button.queue_btn_follow` container (it has NO id; verified
// against Valve's own SteamTracking JS and SteamDB's extension), same page DOM
// in the client. Present whether or not you own the game (unlike the wishlist
// button, which disappears once owned). We anchor the bell just before it so it
// sits to its left. Null only when the button isn't in the DOM yet.
function followButtonAnchor(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.queue_control_button.queue_btn_follow');
}

// ── Backend ops (all via the Lua GET proxy) ─────────────────────────────────

async function fetchIsFollowed(steamId: string, appId: string): Promise<boolean> {
  const r = await backendGet(`/web/follow-state/${steamId}/${appId}`);
  if (!r.ok || !r.body) {
    return false;
  }
  try {
    return Boolean((JSON.parse(r.body) as { followed?: boolean }).followed);
  } catch {
    return false;
  }
}

async function requestFollow(
  steamId: string,
  appId: string,
  name?: string,
  logoUrl?: string,
): Promise<boolean> {
  const params = new URLSearchParams({ steamId, appId });
  if (name) {
    params.set('name', name);
  }
  if (logoUrl) {
    params.set('logoUrl', logoUrl);
  }
  const path = `/web/follow?${params.toString()}`;

  let r = await backendGet(path);
  // 404 = account not provisioned yet → provision (idempotent) then retry once.
  if (r.ok && r.status === 404) {
    await backendGet(`/web/register/${steamId}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    r = await backendGet(path);
  }
  return httpOk(r);
}

async function requestUnfollow(steamId: string, appId: string): Promise<boolean> {
  return httpOk(await backendGet(`/web/unfollow/${steamId}/${appId}`));
}

// ── Bell UI (plain DOM — no React; mirrors the extension's bell) ─────────────

function makeBellIcon(followed: boolean): SVGSVGElement {
  const color = followed ? '#a4d007' : '#c7d5e0'; // Steam green when followed
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', followed ? color : 'none');
  svg.setAttribute('stroke', color);
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const bow = document.createElementNS(SVG_NS, 'path');
  bow.setAttribute('d', 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9');
  const clapper = document.createElementNS(SVG_NS, 'path');
  clapper.setAttribute('d', 'M13.73 21a2 2 0 0 1-3.46 0');
  svg.appendChild(bow);
  svg.appendChild(clapper);
  return svg;
}

function setBellState(bell: HTMLElement, followed: boolean): void {
  bell.setAttribute('data-followed', followed ? 'true' : 'false');
  bell.setAttribute('aria-pressed', followed ? 'true' : 'false');
  bell.title = followed
    ? 'Ne plus suivre les news de ce jeu'
    : 'Suivre les news de ce jeu';
  bell.setAttribute(
    'aria-label',
    followed ? 'Ne plus suivre ce jeu' : 'Suivre ce jeu',
  );
  bell.replaceChildren(makeBellIcon(followed));
}

function buildBell(steamId: string, appId: string): HTMLButtonElement {
  const bell = document.createElement('button');
  bell.id = BELL_ID;
  bell.type = 'button';
  Object.assign(bell.style, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '34px',
    height: '34px',
    marginRight: '8px',
    verticalAlign: 'middle',
    border: '1px solid rgba(255,255,255,0.18)',
    borderRadius: '4px',
    background: 'rgba(0,0,0,0.25)',
    cursor: 'pointer',
    padding: '0',
    transition: 'opacity 120ms ease',
  });
  setBellState(bell, false);
  bell.addEventListener('click', (event) => {
    event.preventDefault();
    void onBellClick(bell, steamId, appId);
  });
  return bell;
}

// Optimistic toggle: flip immediately, confirm via the proxy, revert on failure.
async function onBellClick(
  bell: HTMLElement,
  steamId: string,
  appId: string,
): Promise<void> {
  if (bell.getAttribute('aria-busy') === 'true') {
    return;
  }
  const next = bell.getAttribute('data-followed') !== 'true';
  setBellState(bell, next);
  bell.setAttribute('aria-busy', 'true');
  bell.style.opacity = '0.6';

  const nameEl = document.querySelector<HTMLElement>(
    '#appHubAppName, .apphub_AppName',
  );
  const name = nameEl?.textContent?.trim() || undefined;

  let ok = false;
  try {
    ok = next
      ? await requestFollow(steamId, appId, name, HEADER_IMG(appId))
      : await requestUnfollow(steamId, appId);
  } catch {
    ok = false;
  }

  bell.removeAttribute('aria-busy');
  bell.style.opacity = '1';
  if (!ok) {
    setBellState(bell, !next); // revert
    wlog('toggle failed for appId=' + appId);
  }
}

function injectBell(steamId: string): void {
  const appId = detectAppId();
  const existing = document.getElementById(BELL_ID);
  if (existing) {
    // SPA nav to another app within the same web view → refresh a stale bell.
    if (existing.getAttribute('data-appid') === appId) {
      return;
    }
    existing.remove();
  }
  if (!appId) {
    return; // not a game page
  }
  const anchor = followButtonAnchor();
  if (!anchor) {
    return; // follow button not in the DOM yet → no bell
  }
  const bell = buildBell(steamId, appId);
  bell.setAttribute('data-appid', appId);
  anchor.insertAdjacentElement('beforebegin', bell);

  // Reflect the current follow state (empty → green if already followed).
  void (async () => {
    setBellState(bell, await fetchIsFollowed(steamId, appId));
  })();
}

export default async function WebkitMain(): Promise<void> {
  // Store game pages only. Community hubs match the same anchor but are out of
  // scope; extend this host check if ever wanted there.
  if (window.location.hostname !== 'store.steampowered.com') {
    return;
  }
  const steamId = await resolveSteamId();
  if (!steamId) {
    wlog('no steamId — bell disabled');
    return;
  }
  // documentElement always exists; the observer re-injects on late/ SPA DOM.
  const observer = new MutationObserver(() => injectBell(steamId));
  observer.observe(document.documentElement, { childList: true, subtree: true });
  injectBell(steamId);
}
