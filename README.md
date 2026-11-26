# Currículo — deploy na Cloudflare

Um único Worker serve as páginas (`public/`) e a API; os dados e a foto ficam no Workers KV.

| Rota | O que é |
|---|---|
| `/` | Página inicial com os três estilos |
| `/curriculo#noir` · `#editorial` · `#folha` | Currículo público (o QR code aponta para `/curriculo` por padrão) |
| `/editar` | Área de edição (senha do servidor, sessão de 30 dias em cookie HttpOnly) |
| `/api/*` | Dados (`/api/curriculo`), foto (`/api/foto`), login/sessão |

## Primeiro deploy (≈ 5 min)

```bash
npm install
npx wrangler login
npx wrangler kv namespace create CV        # copie o "id" impresso
#   -> cole em wrangler.jsonc, no lugar de COLE_AQUI_O_ID_DO_KV
npx wrangler secret put EDIT_PASSWORD      # senha da área de edição
npm run deploy                             # publica em https://curriculo.<sua-conta>.workers.dev
```

Depois: abrir `/editar`, entrar com a senha e preencher os dados reais. Tudo salva sozinho no site (aparece "✓ SALVO NO SITE").

Domínio próprio (opcional): Cloudflare → Workers → `curriculo` → Settings → Domains & Routes.

## Desenvolvimento local

```bash
echo 'EDIT_PASSWORD=teste123' > .dev.vars
npm run dev                                # http://localhost:8787
```

## O que mudou em relação ao protótipo do Claude Design

- Dados e foto saem do `localStorage` e vão para o KV — quem escaneia o QR vê o currículo real.
- Senha validada no servidor (secret `EDIT_PASSWORD`), não mais guardada no navegador.
- Os dados vão embutidos no HTML pelo Worker: a página abre já com o conteúdo, sem piscar o texto de exemplo.
- React e o gerador de QR são servidos do próprio site (`public/vendor/`), sem depender de CDN.
- O QR code usa o endereço do site automaticamente quando o campo de link fica vazio.
- Visual, impressão (Folha A4 em 1 página, Noir/Editorial com fundo) e arrastar para reordenar continuam iguais.

Os arquivos originais do design ficam em `project/` como referência.
