// Webkit context: runs inside embedded Steam web views (store, community).
// Currently a placeholder — v0.2 reads the SteamID server-side from
// Steam's own `config/loginusers.vdf` via the Lua backend (more reliable
// than DOM scraping the embedded store header, which Steam Desktop
// hides by default). Kept for future webkit-side enhancements.

export default async function WebkitMain(): Promise<void> {
  console.log('[GameNews][webkit] context loaded (v0.2 — no-op)');
}
