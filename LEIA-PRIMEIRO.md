# MMORPG: Vila Inicial

Jogo em `index.html` (arquivo único) com progresso salvo no `localStorage` do navegador. O `server.js` serve esse arquivo e também abre um WebSocket para presença multiplayer em tempo real (outros jogadores, monstros e chat) — e, opcionalmente, contas online via Supabase.

## Rodar o servidor

```
npm install
npm start
```

Abre em `http://localhost:8080`. Para testar o multiplayer, abra a mesma URL em duas abas ou dispositivos da mesma rede.

O cliente descobre o endereço do WebSocket sozinho (`wss://` ou `ws://` + o host atual + `/game`) — não existe mais uma constante `MP_URL` para editar. Funciona igual em local e em produção, sem precisar trocar nada no `index.html`.

## O que o servidor sincroniza

- entrada, saída, posição, direção, animação, classe e nível dos jogadores no mesmo mapa;
- HP, dano, morte e respawn dos monstros — o servidor arbitra o estado real;
- uma autoridade de movimentação dos monstros por mapa (um dos clientes conectados), com troca automática se ela desconectar;
- layout determinístico das masmorras, para todos entrarem no mesmo labirinto;
- projéteis de mago, arqueiro e druida (disparo, trajetória, impacto);
- contador de jogadores online, heartbeat e validação básica de mensagens.

Inventário, progressão, cálculo de dano e parte da IA ainda são calculados no cliente — ainda precisam migrar para o servidor antes de uma versão pública competitiva (hoje um cliente malicioso pode trapacear nesses pontos).

## Login online (Supabase) — opcional

Configure estas variáveis **apenas no servidor** (no Render, nunca no `index.html` ou no GitHub):

```
SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
```

(`SUPABASE_SERVICE_ROLE_KEY` também é aceita, para projetos com a chave legada.) Use `.env.example` como modelo — copie para `.env` localmente (o `.gitignore` já ignora `.env`).

As rotas `/api/auth/register`, `/api/auth/login`, `/api/auth/session` e `/api/auth/logout` gravam contas e sessões no Supabase. Senhas novas usam `scrypt`; hashes `bcrypt` de uma versão anterior continuam válidos e são migrados no próximo login.

Essas rotas leem/gravam nas tabelas `users` e `sessions`, definidas no `schema.sql` junto com `characters`. **Rodar o `schema.sql` atualizado no seu projeto Supabase** (SQL Editor ou `supabase db push`) antes de configurar as variáveis acima — sem essas tabelas as rotas de login vão falhar mesmo com o servidor configurado corretamente.

## Supabase — schema.sql

`schema.sql` cria a tabela `characters` (com RLS, índices e Realtime), pensada para guardar o personagem completo por conta quando o login online estiver liberado. Ela ainda não é lida nem gravada pelo cliente do jogo — hoje o progresso continua só no `localStorage`.

## Produção (Render)

O Render serve o mesmo `server.js` (HTTP + WebSocket na mesma porta, via `PORT`). Sem as variáveis do Supabase configuradas, o jogo e o multiplayer de presença funcionam normalmente — só o login online fica indisponível.
