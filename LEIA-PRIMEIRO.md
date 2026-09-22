# Multiplayer — rodando local primeiro

O progresso de cada jogador continua salvo no próprio navegador. O servidor deixa os jogadores se verem em tempo real e conversarem.

## Rodar o servidor

```
npm install
npm start
```

Localmente ele usa `ws://localhost:8787`. Em produção, o Render fornece a porta via `PORT`.

## Supabase

O arquivo `schema.sql` contém a tabela `characters`, RLS, índices e Realtime para a futura persistência online dos personagens.

## Produção

Use o WebSocket público do Render (por exemplo, `wss://novo-rpg.onrender.com`) no cliente do jogo.
