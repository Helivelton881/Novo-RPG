# MMORPG: Vila Inicial — multiplayer MVP

Este projeto adiciona presença multiplayer real ao protótipo existente.

## Incluído

- servidor HTTP e WebSocket;
- jogadores remotos no mesmo mapa;
- posição, direção, animação, classe e nível sincronizados;
- entrada, saída e reconexão;
- contador de jogadores online;
- validação básica e heartbeat no servidor.
- HP, dano, morte e respawn de monstros compartilhados;
- uma autoridade de movimentação dos monstros por mapa, com troca automática quando ela desconecta;
- posições e estados de IA replicados para os demais jogadores;
- layout determinístico das masmorras para todos entrarem no mesmo labirinto.
- projéteis de mago, arqueiro e druida sincronizados, incluindo disparo, trajetória e impacto.

O servidor já arbitra o HP e a morte dos monstros. Inventário, progressão, cálculo do dano e parte da IA ainda precisam migrar integralmente para o servidor antes de uma versão pública competitiva.

## Executar

```powershell
npm install
npm start
```

## Login online com Supabase

Configure estas variáveis apenas no servidor/Render:

```text
SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
```

Também é aceito `SUPABASE_SERVICE_ROLE_KEY` para projetos que ainda usam a chave legada. Nunca coloque uma dessas chaves no `index.html` ou no GitHub.

As rotas `/api/auth/register`, `/api/auth/login`, `/api/auth/session` e `/api/auth/logout` armazenam contas e sessões no Supabase. Senhas novas usam `scrypt`; hashes `bcrypt` existentes continuam válidos e são atualizados no próximo login.

Abra `http://localhost:8080` em dois navegadores ou dispositivos da mesma rede.

Para publicar, configure `PORT` na hospedagem e use um serviço compatível com WebSocket.
