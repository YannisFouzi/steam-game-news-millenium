-- Top-of-file print: surfaces issues even if a require fails (which would
-- crash the plugin silently before any logger:info ran).
print("[GameNews] Lua script starting evaluation")

local logger_ok, logger = pcall(require, "logger")
if not logger_ok then
    print("[GameNews] FATAL require('logger'): " .. tostring(logger))
    return {}
end

local millennium_ok, millennium = pcall(require, "millennium")
if not millennium_ok then
    logger:warn("[GameNews] require('millennium') failed: " .. tostring(millennium))
    return {}
end

-- Built-in Millennium modules — discovered by reading Extendium's source.
-- All optional: degrade gracefully if a future version moves/renames them.
local http_ok, http = pcall(require, "http")
local fs_ok, fs = pcall(require, "fs")
local utils_ok, utils = pcall(require, "utils")

logger:info(
    "[GameNews] modules: http=" .. tostring(http_ok)
    .. " fs=" .. tostring(fs_ok)
    .. " utils=" .. tostring(utils_ok)
)

local BACKEND_BASE_URL = "https://gamenews.up.railway.app/api"
local DEFAULT_TIMEOUT_SECONDS = 5

-- ── JSON helpers (manual, no cjson dependency) ─────────────────────────────
local function json_string(value)
    local s = tostring(value)
    s = s:gsub("\\", "\\\\")
    s = s:gsub('"', '\\"')
    s = s:gsub("\n", "\\n")
    s = s:gsub("\r", "\\r")
    s = s:gsub("\t", "\\t")
    return '"' .. s .. '"'
end

local function build_ok_proxy(status, body)
    return "{\"ok\":true,\"status\":" .. tostring(status)
        .. ",\"body\":" .. json_string(body or "") .. "}"
end

local function build_error_proxy(message)
    return "{\"ok\":false,\"error\":" .. json_string(message or "unknown") .. "}"
end

local function build_steam_id_response(steamId, source)
    if steamId == nil or steamId == "" then
        return "{\"steamId\":null,\"source\":" .. json_string(source or "none") .. "}"
    end
    return "{\"steamId\":" .. json_string(steamId)
        .. ",\"source\":" .. json_string(source or "unknown") .. "}"
end

-- ── Steam install root resolution ──────────────────────────────────────────
-- Walk up from this script's location looking for a folder containing
-- config/loginusers.vdf — that's the Steam install root.
local function script_dir()
    if utils_ok and type(utils.get_backend_path) == "function" then
        local backend_path = utils.get_backend_path()
        if backend_path and fs_ok then
            return fs.parent_path(backend_path)
        end
    end
    local source = debug.getinfo(1, "S").source
    local script_path = source:sub(2)
    return script_path:gsub("[\\/]backend[\\/]main%.lua$", "")
end

local function path_join(a, b)
    if fs_ok and type(fs.join) == "function" then
        return fs.join(a, b)
    end
    return a .. "/" .. b
end

local function path_parent(p)
    if fs_ok and type(fs.parent_path) == "function" then
        return fs.parent_path(p)
    end
    return p:gsub("[\\/][^\\/]+$", "")
end

local function file_exists(p)
    if fs_ok and type(fs.is_file) == "function" then
        return fs.is_file(p)
    end
    local f = io.open(p, "r")
    if f then f:close(); return true end
    return false
end

local PLUGIN_DIR = script_dir()
logger:info("[GameNews] plugin dir: " .. tostring(PLUGIN_DIR))

local function find_steam_root()
    local current = PLUGIN_DIR
    for i = 1, 6 do
        local candidate = path_join(current, "config/loginusers.vdf")
        if file_exists(candidate) then
            logger:info("[GameNews] found steam root at depth " .. i .. ": " .. current)
            return current
        end
        local parent = path_parent(current)
        if not parent or parent == current then
            break
        end
        current = parent
    end
    logger:warn("[GameNews] could not locate steam root from " .. tostring(PLUGIN_DIR))
    return nil
end

local STEAM_ROOT = find_steam_root()

-- ── Per-install pairing secret (privacy TOFU) ──────────────────────────────
-- Le plugin prouve son identite via un secret par-installation (le token web
-- Steam est inrecuperable). On le stocke en clair dans un fichier du dossier
-- plugin, on l'envoie en header X-GN-Secret. Le backend ne voit qu'un hash.
local SECRET_FILE = path_join(PLUGIN_DIR, "gn_pair_secret")

local function generate_secret()
    -- 40 hex chars. math.random n'est pas crypto mais suffit pour un secret
    -- par-installation (non devinable a distance, jamais reutilise).
    math.randomseed(os.time() + math.floor(os.clock() * 1000000))
    for _ = 1, 16 do math.random() end -- warmup
    local hex = ""
    for _ = 1, 40 do
        hex = hex .. string.format("%x", math.random(0, 15))
    end
    return hex
end

local function get_or_create_secret()
    local f = io.open(SECRET_FILE, "r")
    if f then
        local s = f:read("*a")
        f:close()
        if s then
            s = s:gsub("%s+", "")
            if #s >= 16 then
                return s
            end
        end
    end
    local secret = generate_secret()
    local wf, werr = io.open(SECRET_FILE, "w")
    if wf then
        wf:write(secret)
        wf:close()
        logger:info("[GameNews] generated new pairing secret")
    else
        logger:warn("[GameNews] could not write secret file: " .. tostring(werr))
    end
    return secret
end

-- Callable exposee au frontend pour recuperer le secret (afin de l'injecter
-- dans l'iframe du feed).
function get_pair_secret()
    return "{\"secret\":" .. json_string(get_or_create_secret()) .. "}"
end

-- ── Callable: fetch_backend ────────────────────────────────────────────────
function fetch_backend(arg1)
    local path = type(arg1) == "table" and arg1.path or arg1

    if type(path) ~= "string" or #path == 0 then
        return build_error_proxy("invalid path: " .. tostring(path))
    end
    if http == nil then
        return build_error_proxy("http module unavailable")
    end

    local url = BACKEND_BASE_URL .. path
    logger:info("[GameNews] GET " .. url)

    -- Secret d'appairage : authentifie le plugin aupres des endpoints proteges.
    -- Millennium v3.1.0 droppe les headers HTTP custom de http.get, donc on
    -- passe le secret en QUERY param (le backend lit aussi req.query.secret).
    -- Toujours ajoute (le callable IPC passe le path positionnellement, donc
    -- arg1 est une string et non une table -> pas de drapeau par appel). Ajoute
    -- APRES le log pour ne jamais ecrire le secret en clair dans les logs ; les
    -- endpoints non proteges ignorent simplement le param.
    -- `url` (sans secret) est conserve pour les logs ; `request_url` (avec
    -- secret) ne sert QU'A http.get et n'est jamais loggue (sinon le secret
    -- fuiterait en clair dans les logs Millennium).
    local sep = url:find("?", 1, true) and "&" or "?"
    local request_url = url .. sep .. "secret=" .. get_or_create_secret()

    local response, err = http.get(request_url, {
        timeout = DEFAULT_TIMEOUT_SECONDS,
        headers = { ["Accept"] = "application/json" },
    })
    if not response then
        logger:warn("[GameNews] http.get failed: " .. tostring(err))
        return build_error_proxy(tostring(err or "unknown error"))
    end
    logger:info("[GameNews] GET " .. url .. " -> " .. tostring(response.status))
    return build_ok_proxy(response.status, response.body)
end

-- NOTE: no POST proxy. Millennium's http.request crashed the native layer in
-- this version, so mutations (follow) go through GET on fetch_backend instead
-- (the backend /api/web/follow accepts GET). Only http.get is used here.

-- ── Callable: get_steam_id (reads from Steam's loginusers.vdf) ─────────────
-- VDF format (excerpt):
--   "users"
--   {
--     "76561198158439485"
--     {
--       "AccountName"   "rapture_fouzi"
--       "MostRecent"    "1"
--       ...
--     }
--   }
--
-- We grep for a 17-digit block that contains "MostRecent" "1". If no
-- MostRecent flag is found, we fall back to the first 17-digit key.

local function parse_loginusers(content)
    -- Pass 1: find a steamId block whose body contains MostRecent "1"
    for steamId, body in content:gmatch('"(%d%d%d%d%d%d%d%d%d%d%d%d%d%d%d%d%d)"%s*{([^}]*)}') do
        if body:match('"MostRecent"%s*"1"') then
            return steamId, "loginusers.vdf:MostRecent"
        end
    end
    -- Pass 2: fallback to first steamId-shaped key
    for steamId in content:gmatch('"(%d%d%d%d%d%d%d%d%d%d%d%d%d%d%d%d%d)"') do
        return steamId, "loginusers.vdf:first"
    end
    return nil, "loginusers.vdf:none"
end

function get_steam_id()
    if STEAM_ROOT == nil then
        return build_steam_id_response(nil, "no-steam-root")
    end

    local vdf_path = path_join(STEAM_ROOT, "config/loginusers.vdf")
    logger:info("[GameNews] get_steam_id reading " .. vdf_path)

    local f, err = io.open(vdf_path, "r")
    if not f then
        logger:warn("[GameNews] io.open failed: " .. tostring(err))
        return build_steam_id_response(nil, "io-error:" .. tostring(err))
    end
    local content = f:read("*a")
    f:close()

    local steamId, source = parse_loginusers(content or "")
    if steamId then
        logger:info("[GameNews] resolved steamId from " .. source)
    else
        logger:warn("[GameNews] no steamId match in vdf")
    end
    return build_steam_id_response(steamId, source)
end

-- ── Callable: relay_log (frontend → Lua log bridge) ───────────────────────
-- JS console.log goes to the CEF devtools console which is hard to access.
-- This relays frontend nav-injection logs into the plugin's Lua log file so
-- they show up in Millennium → Logs.
function relay_log(arg1)
    local msg = type(arg1) == "table" and arg1.msg or arg1
    logger:info("[GameNews][nav] " .. tostring(msg))
    return "{\"ok\":true}"
end

-- ── Lifecycle ──────────────────────────────────────────────────────────────
local function on_load()
    logger:info("[GameNews] plugin loaded (Millennium v" .. millennium.version() .. ")")
    millennium.ready()
end

local function on_frontend_loaded()
    logger:info("[GameNews] frontend ready")
end

local function on_unload()
    logger:info("[GameNews] plugin unloaded")
end

return {
    on_load = on_load,
    on_frontend_loaded = on_frontend_loaded,
    on_unload = on_unload,
}
