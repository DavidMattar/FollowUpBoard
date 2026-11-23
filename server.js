/**
 * Follow-up Board na nuvem: serve o HTML do board, tranca tudo atrás de uma
 * senha única (`APP_PASSWORD`) e guarda os dados no Postgres (`DATABASE_URL`).
 *
 * O board salva o estado inteiro de uma vez (um JSON), então o banco tem uma
 * tabela com uma linha só. Mesmo esquema de senha do FinancialController:
 * cookie derivado da senha com scrypt, lembrado por 1 ano; trocar a senha
 * desloga todos os aparelhos; 10 senhas erradas por minuto travam o login.
 *
 * Sem `APP_PASSWORD`: no PC fica aberto; em produção o app se RECUSA a abrir.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { scryptSync, timingSafeEqual } = require("node:crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 3000);
const PROD = process.env.NODE_ENV === "production";
const PASSWORD = process.env.APP_PASSWORD;
const BOARD_HTML = fs.readFileSync(path.join(__dirname, "follow-up-board.html"));
const MAX_BODY = 10 * 1024 * 1024;

/* ---------- senha ---------- */
const SESSION_COOKIE = "fu_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 365;
const sessionToken = (pw) => scryptSync(pw, "fu-session-v1", 32).toString("hex");
const CURRENT_TOKEN = PASSWORD ? sessionToken(PASSWORD) : "";

/** Compara em tempo constante; os dois lados têm sempre 64 caracteres. */
function sameToken(a, b) {
  const x = Buffer.from(a || ""), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function cookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
}

// ponytail: contador em memória, zera se o container reiniciar; serve porque
// é um processo só. Com mais de uma réplica, mover para o banco.
const MAX_FAILURES = 10, WINDOW_MS = 60_000;
let windowStart = 0, failures = 0;
function isLocked(now) {
  if (now - windowStart >= WINDOW_MS) { windowStart = now; failures = 0; }
  return failures >= MAX_FAILURES;
}

/* ---------- banco ---------- */
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ready = pool.query(
  "CREATE TABLE IF NOT EXISTS board (id int PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())"
);

/* ---------- http ---------- */
function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Cache-Control": "no-store", ...headers });
  res.end(body);
}
const redirect = (res, to, headers = {}) => send(res, 303, "", { Location: to, ...headers });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("grande demais")); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (p === "/login" && req.method === "GET") {
    return send(res, 200, loginPage(url.searchParams.get("erro")), { "Content-Type": "text/html; charset=utf-8" });
  }

  if (p === "/api/login" && req.method === "POST") {
    const typed = new URLSearchParams(await readBody(req)).get("password") || "";
    // Sem `await` entre checar a trava, conferir e contar o erro: tentativas
    // em paralelo não passam todas pela trava antes de alguma ser contada.
    if (isLocked(Date.now())) return redirect(res, "/login?erro=bloqueado");
    if (!PASSWORD || !sameToken(sessionToken(typed), CURRENT_TOKEN)) {
      failures++;
      await new Promise((r) => setTimeout(r, 1000));
      return redirect(res, "/login?erro=1");
    }
    const flags = `HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}${PROD ? "; Secure" : ""}`;
    return redirect(res, "/", { "Set-Cookie": `${SESSION_COOKIE}=${CURRENT_TOKEN}; ${flags}` });
  }

  if (!PASSWORD) {
    if (PROD) return send(res, 500, "APP_PASSWORD não configurada no servidor.");
  } else if (!sameToken(cookie(req, SESSION_COOKIE), CURRENT_TOKEN)) {
    if (p.startsWith("/api/")) return send(res, 401, '{"error":"Não autenticado"}', { "Content-Type": "application/json" });
    return redirect(res, "/login");
  }

  if (p === "/" && req.method === "GET") {
    return send(res, 200, BOARD_HTML, { "Content-Type": "text/html; charset=utf-8" });
  }

  if (p === "/api/data" && req.method === "GET") {
    await ready;
    const { rows } = await pool.query("SELECT data::text AS data FROM board WHERE id = 1");
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    if (url.searchParams.has("download")) {
      headers["Content-Disposition"] = `attachment; filename="follow-up-backup-${new Date().toISOString().slice(0, 10)}.json"`;
    }
    return send(res, 200, rows[0]?.data || "", headers);
  }

  if (p === "/api/data" && req.method === "PUT") {
    let data;
    try { data = JSON.parse(await readBody(req)); } catch { return send(res, 400, "JSON inválido"); }
    if (!data || !Array.isArray(data.tasks)) return send(res, 400, "Formato inválido");
    await ready;
    // ponytail: última gravação vence. Dois aparelhos editando ao mesmo tempo
    // sobrescrevem um ao outro; recarregue a página antes de editar noutro.
    await pool.query(
      "INSERT INTO board (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
      [JSON.stringify(data)]
    );
    return send(res, 204, "");
  }

  send(res, 404, "Não encontrado");
}

function loginPage(erro) {
  const msg = erro === "bloqueado" ? "Muitas tentativas erradas. Espere 1 minuto."
    : erro ? "Senha incorreta." : "";
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Follow-up Board</title>
<style>
:root{--bg:#F7F8F9;--card:#fff;--fg:#172B4D;--muted:#626F86;--border:#DCDFE4;--accent:#0C66E4;--err:#C9372C}
@media (prefers-color-scheme:dark){:root{--bg:#1D2125;--card:#22272B;--fg:#B6C2CF;--muted:#8C9BAB;--border:#38414A;--accent:#579DFF;--err:#F87168}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,sans-serif;padding:16px;box-sizing:border-box}
form{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px;width:100%;max-width:340px;box-sizing:border-box}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 18px;color:var(--muted)}
input,button{width:100%;box-sizing:border-box;font:inherit;padding:10px 12px;border-radius:8px}
input{border:1px solid var(--border);background:var(--bg);color:var(--fg);margin-bottom:12px}
button{border:0;background:var(--accent);color:#fff;font-weight:600;cursor:pointer}
.err{color:var(--err);margin:0 0 12px}
</style></head><body>
<form method="post" action="/api/login">
<h1>Follow-up Board</h1><p>Digite a senha para entrar.</p>
${msg ? `<p class="err" role="alert">${msg}</p>` : ""}
<input type="password" name="password" aria-label="Senha" placeholder="Senha" autocomplete="current-password" autofocus required>
<button type="submit">Entrar</button>
</form></body></html>`;
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) send(res, 500, "Erro no servidor");
  });
}).listen(PORT, () => console.log(`✓ Ready em http://localhost:${PORT}`));
