# Follow-up Board

O quadro de follow-up (`follow-up-board.html`) publicado na internet, trancado
por uma senha única, com os dados no Postgres.

- `server.js` entrega o board, faz o login e lê e grava os dados (`/api/data`).
- O banco tem uma tabela `board` com uma linha só: o JSON inteiro do board.
  O servidor cria a tabela sozinho ao subir.
- **Senha:** variável `APP_PASSWORD`. O login fica lembrado por 1 ano. Trocar
  a senha desloga todos os aparelhos. 10 senhas erradas no mesmo minuto travam
  o login por até 1 minuto, para qualquer pessoa. Sem `APP_PASSWORD` em
  produção, o app se recusa a abrir.
- **Importar / Backup** (barra de cima): *Backup* baixa o `.json` com tudo;
  *Importar* troca tudo pelo conteúdo de um `.json` (backup ou o arquivo
  antigo do PC).
- **Um aparelho por vez:** a última gravação vence. Se editou no celular,
  recarregue a página no PC antes de mexer lá.

## Rodar no PC

```powershell
npm install
$env:DATABASE_URL = "postgres://usuario:senha@localhost:5432/followup"
npm start   # http://localhost:3000 (sem APP_PASSWORD fica aberto no PC)
```

## Publicar na VPS (Hostinger + Easypanel)

Mesmo caminho do FinancialController. O firewall da Hostinger já está pronto
de lá (portas 22, 80, 443 e 3000).

1. **Banco:** no Easypanel, crie um projeto `followup` → **+ Service →
   Postgres**: nome `db`, database `followup`, imagem **`postgres:17`**.
   Copie a **Internal Connection URL**. Não publique a porta do banco.
2. **App:** **+ Service → App**, nome `app`:

   | Aba | O que colocar |
   |---|---|
   | **Source** | Git → `https://github.com/DavidMattar/FollowUpBoard.git`, branch `main` |
   | **Build** | Dockerfile, caminho `Dockerfile` |
   | **Environment** | `DATABASE_URL=<Internal Connection URL>` e `APP_PASSWORD=<sua senha>` |
   | **Domains** | Use o domínio gerado pelo Easypanel (ou o seu), **HTTPS ligado**, porta **3000** |

   **Deploy.** Nos logs deve aparecer `✓ Ready em http://localhost:3000`.
3. **Levar as tarefas:** abra o link, entre, clique em **Importar** e escolha
   o `(DoNotDelete)follow-up-tasks.json`. A partir daí use só o site.
4. **Conferir que está trancado** (numa aba anônima):
   - o link abre a tela de senha, e não o board;
   - `<link>/api/data` responde `{"error":"Não autenticado"}`;
   - o endereço começa com `https://`.
5. **Atualizar:** `git push` e **Deploy** no Easypanel (ou ligue o Auto Deploy).
