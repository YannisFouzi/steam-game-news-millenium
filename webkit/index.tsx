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
const PLUS_ID = 'game-news-follow-plus';
const CONTROLS_ID = 'game-news-follow-controls';
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

// Le MutationObserver appelle injectBell des centaines de fois par page : on ne
// logge l'état d'injection QUE quand il change (one-shot par état). Sans ça,
// soit on spamme le log Lua, soit on est aveugles — on a été aveugles.
let lastInjectState = '';
function logInjectState(state: string): void {
  if (state === lastInjectState) {
    return;
  }
  lastInjectState = state;
  wlog(state);
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

// The action row on a game's store page that holds Steam's queue buttons
// (wishlist / follow / ignore / share). The exact button MIX varies per game
// and account state — Follow is missing on some pages, share on others, the
// wishlist button disappears once you own the game — so the bell anchors on
// the CONTAINER, never on a sibling button (anchoring on wishlist then Follow
// both broke when that button happened to be absent).
// Primary: #queueActionsCtn (Valve's id for the row). Fallback: derive the row
// from whatever .queue_control_button is present (Ignore is always rendered).
function actionsContainer(): HTMLElement | null {
  const ctn = document.querySelector<HTMLElement>('#queueActionsCtn');
  if (ctn) {
    return ctn;
  }
  const anyBtn = document.querySelector<HTMLElement>('.queue_control_button');
  return anyBtn ? anyBtn.parentElement : null;
}

// ── Backend ops (all via the Lua GET proxy) ─────────────────────────────────

interface FollowState {
  followed: boolean;
  notified: boolean; // notifications on (notified ⊆ followed)
}

async function fetchFollowState(
  steamId: string,
  appId: string,
): Promise<FollowState> {
  const r = await backendGet(`/web/follow-state/${steamId}/${appId}`);
  if (!r.ok || !r.body) {
    return { followed: false, notified: false };
  }
  try {
    const data = JSON.parse(r.body) as {
      followed?: boolean;
      notifications?: boolean;
    };
    const followed = Boolean(data.followed);
    return { followed, notified: followed && data.notifications !== false };
  } catch {
    return { followed: false, notified: false };
  }
}

async function requestFollow(
  steamId: string,
  appId: string,
  notifications: boolean,
  name?: string,
  logoUrl?: string,
): Promise<boolean> {
  const params = new URLSearchParams({ steamId, appId });
  params.set('notifications', notifications ? 'true' : 'false');
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

// Toggle notifications without unfollowing — GET alias of the PUT endpoint (the
// Lua proxy is GET-only).
async function requestSetNotifications(
  steamId: string,
  appId: string,
  enabled: boolean,
): Promise<boolean> {
  return httpOk(
    await backendGet(
      `/web/follow-notifications/${steamId}/${appId}?enabled=${
        enabled ? 'true' : 'false'
      }`,
    ),
  );
}

// ── Bell UI (plain DOM — no React; mirrors the extension's bell) ─────────────

const ICON_GREEN = '#a4d007'; // Steam green when active
const ICON_IDLE = '#c7d5e0';

function strokePath(d: string): SVGPathElement {
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  return p;
}

// Bell, Steam-green when notifications are ON.
function makeBellIcon(notified: boolean): SVGSVGElement {
  const color = notified ? ICON_GREEN : ICON_IDLE;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', notified ? color : 'none');
  svg.setAttribute('stroke', color);
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.appendChild(strokePath('M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9'));
  svg.appendChild(strokePath('M13.73 21a2 2 0 0 1-3.46 0'));
  return svg;
}

// "+" when not followed, checkmark when followed. Green once followed.
function makePlusIcon(followed: boolean): SVGSVGElement {
  const color = followed ? ICON_GREEN : ICON_IDLE;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', color);
  svg.setAttribute('stroke-width', '2.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.appendChild(strokePath(followed ? 'M20 6L9 17l-5-5' : 'M12 5v14M5 12h14'));
  return svg;
}

function styleControlButton(btn: HTMLButtonElement): void {
  Object.assign(btn.style, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '34px',
    height: '34px',
    verticalAlign: 'middle',
    border: '1px solid rgba(255,255,255,0.18)',
    borderRadius: '4px',
    background: 'rgba(0,0,0,0.25)',
    cursor: 'pointer',
    padding: '0',
    transition: 'opacity 120ms ease',
  });
}

// data-followed / data-notified on the container drive both icons.
function setControlsState(
  container: HTMLElement,
  followed: boolean,
  notified: boolean,
): void {
  container.setAttribute('data-followed', followed ? 'true' : 'false');
  container.setAttribute('data-notified', notified ? 'true' : 'false');
  const plus = container.querySelector<HTMLElement>('#' + PLUS_ID);
  const bell = container.querySelector<HTMLElement>('#' + BELL_ID);
  if (plus) {
    plus.setAttribute('aria-pressed', followed ? 'true' : 'false');
    plus.title = followed
      ? 'Ne plus suivre ce jeu'
      : 'Suivre ce jeu (sans notifications)';
    plus.setAttribute('aria-label', plus.title);
    plus.replaceChildren(makePlusIcon(followed));
  }
  if (bell) {
    bell.setAttribute('aria-pressed', notified ? 'true' : 'false');
    bell.title = notified
      ? 'Couper les notifications'
      : 'Activer les notifications';
    bell.setAttribute('aria-label', bell.title);
    bell.replaceChildren(makeBellIcon(notified));
  }
}

function setControlsBusy(container: HTMLElement, busy: boolean): void {
  container.setAttribute('aria-busy', busy ? 'true' : 'false');
  container.style.opacity = busy ? '0.6' : '1';
  container.style.pointerEvents = busy ? 'none' : '';
}

function gameName(): string | undefined {
  const nameEl = document.querySelector<HTMLElement>(
    '#appHubAppName, .apphub_AppName',
  );
  return nameEl?.textContent?.trim() || undefined;
}

// Optimistic mutation: apply target state, run the request, revert on failure.
async function runControls(
  container: HTMLElement,
  target: { followed: boolean; notified: boolean },
  action: () => Promise<boolean>,
): Promise<void> {
  if (container.getAttribute('aria-busy') === 'true') {
    return;
  }
  const prevFollowed = container.getAttribute('data-followed') === 'true';
  const prevNotified = container.getAttribute('data-notified') === 'true';
  setControlsState(container, target.followed, target.notified);
  setControlsBusy(container, true);
  let ok = false;
  try {
    ok = await action();
  } catch {
    ok = false;
  }
  setControlsBusy(container, false);
  if (!ok) {
    setControlsState(container, prevFollowed, prevNotified); // revert
    wlog('toggle failed for appId=' + (container.getAttribute('data-appid') || '?'));
  }
}

// [+] : not followed → silent follow ; followed → unfollow.
function onPlusClick(container: HTMLElement, steamId: string, appId: string): void {
  const followed = container.getAttribute('data-followed') === 'true';
  if (followed) {
    void runControls(container, { followed: false, notified: false }, () =>
      requestUnfollow(steamId, appId),
    );
    return;
  }
  void runControls(container, { followed: true, notified: false }, () =>
    requestFollow(steamId, appId, false, gameName(), HEADER_IMG(appId)),
  );
}

// bell : not followed → follow + notify ; followed → toggle notifications.
function onBellClick(container: HTMLElement, steamId: string, appId: string): void {
  const followed = container.getAttribute('data-followed') === 'true';
  const notified = container.getAttribute('data-notified') === 'true';
  if (!followed) {
    void runControls(container, { followed: true, notified: true }, () =>
      requestFollow(steamId, appId, true, gameName(), HEADER_IMG(appId)),
    );
    return;
  }
  void runControls(container, { followed: true, notified: !notified }, () =>
    requestSetNotifications(steamId, appId, !notified),
  );
}

function buildControls(steamId: string, appId: string): HTMLElement {
  const container = document.createElement('span');
  container.id = CONTROLS_ID;
  Object.assign(container.style, {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    marginRight: '8px',
    verticalAlign: 'middle',
  });

  const plus = document.createElement('button');
  plus.id = PLUS_ID;
  plus.type = 'button';
  styleControlButton(plus);
  plus.addEventListener('click', (event) => {
    event.preventDefault();
    onPlusClick(container, steamId, appId);
  });

  const bell = document.createElement('button');
  bell.id = BELL_ID;
  bell.type = 'button';
  styleControlButton(bell);
  bell.addEventListener('click', (event) => {
    event.preventDefault();
    onBellClick(container, steamId, appId);
  });

  container.appendChild(plus);
  container.appendChild(bell);
  setControlsState(container, false, false);
  return container;
}

function injectBell(steamId: string): void {
  const appId = detectAppId();
  const existing = document.getElementById(CONTROLS_ID);
  if (existing) {
    // SPA nav to another app within the same web view → refresh a stale control.
    if (existing.getAttribute('data-appid') === appId) {
      return;
    }
    existing.remove();
  }
  if (!appId) {
    logInjectState('skip: not a game page url=' + window.location.pathname);
    return;
  }
  const container = actionsContainer();
  if (!container) {
    // Diagnostic complet : la cause la plus probable d'une cloche absente.
    logInjectState(
      'no anchor for appId=' + appId +
      ' — #queueActionsCtn=' + (document.getElementById('queueActionsCtn') ? 'yes' : 'NO') +
      ' .queue_control_button=' + document.querySelectorAll('.queue_control_button').length,
    );
    return; // action row not in the DOM yet → the observer retries
  }
  const controls = buildControls(steamId, appId);
  controls.setAttribute('data-appid', appId);
  // Placement : JAMAIS en fin de rangée. Vérifié au runtime (Destiny 2 DLC) :
  // le conteneur garde des enfants cachés par Valve (états wishlist, flyouts) et
  // un contrôle appendé après eux est rendu invisible. On s'insère donc avant le
  // premier bouton VISIBLE — l'endroit dont l'affichage est garanti :
  //   1. avant « Suivre » s'il est visible (placement historique) ;
  //   2. sinon avant le premier .queue_control_button visible (ex. DLC : wishlist) ;
  //   3. sinon en tête de rangée.
  const isVisible = (el: HTMLElement): boolean =>
    el.offsetParent !== null && el.offsetWidth > 0;
  const followBtn = container.querySelector<HTMLElement>(
    '.queue_control_button.queue_btn_follow',
  );
  let position: string;
  if (followBtn && isVisible(followBtn)) {
    followBtn.insertAdjacentElement('beforebegin', controls);
    position = 'before-follow';
  } else {
    const firstVisibleBtn = Array.from(
      container.querySelectorAll<HTMLElement>('.queue_control_button'),
    ).find(isVisible);
    if (firstVisibleBtn) {
      firstVisibleBtn.insertAdjacentElement('beforebegin', controls);
      position = 'before-first-visible-btn';
    } else {
      container.prepend(controls);
      position = 'prepended';
    }
  }
  // Mesure post-layout : prouve que le contrôle est réellement AFFICHÉ (rect non
  // nul), pas seulement présent dans le DOM — c'est ce qui a manqué pour
  // diagnostiquer le cas « injecté mais invisible ».
  requestAnimationFrame(() => {
    const r = controls.getBoundingClientRect();
    wlog(
      'controls injected appId=' + appId +
      ' position=' + position +
      ' containerChildren=' + container.childElementCount +
      ' rect=' + Math.round(r.width) + 'x' + Math.round(r.height) +
      '@' + Math.round(r.x) + ',' + Math.round(r.y) +
      ' visible=' + (controls.offsetParent !== null),
    );
  });

  // Reflect the current state ([+] green if followed, bell green if notified).
  void (async () => {
    const state = await fetchFollowState(steamId, appId);
    setControlsState(controls, state.followed, state.notified);
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
  // Boot marker: version + page. Si cette ligne n'apparaît pas dans le log Lua,
  // le webkit ne tourne pas sur cette page (vieux bundle / restart manquant).
  wlog('v1.3.0 boot on ' + window.location.pathname);
  // documentElement always exists; the observer re-injects on late/ SPA DOM.
  const observer = new MutationObserver(() => injectBell(steamId));
  observer.observe(document.documentElement, { childList: true, subtree: true });
  injectBell(steamId);
}
